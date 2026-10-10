/**
 * 对话工具（spec §9，D16）：execute 返回给界面画卡片的完整数据，toModelOutput 只给模型精简摘要。
 * 所有写操作只写草稿；回测与扫描直接跑（受额度限制），用异步生成器先吐出 runId 让卡片显示进度。
 */
import {
  describeExec,
  describeSpec,
  factorsForMarket,
  getFactor,
  type Market,
  type Metrics,
  validateSpec,
} from "@ivan/core";
import { COMPUTE_PAUSED_TEXT } from "@ivan/db";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { worker } from "../lib/worker-client.ts";
import {
  compareRuns,
  enqueueBacktest,
  enqueueSweep,
  getRun,
  listRuns,
  queryRun,
  type RunQuery,
} from "../services/runs.ts";
import {
  getStrategy,
  getVersion,
  listStrategies,
  proposeStrategy,
  versionNOf,
} from "../services/strategies.ts";
import { overview } from "../services/dashboard.ts";
import { getTracking, proposeTracking } from "../services/trackings.ts";

export interface PageRef {
  strategyId?: string;
  versionId?: string;
  runId?: string;
  trackingId?: string;
  range?: { from: string; to: string };
}

export interface AgentContext {
  userId: string;
  threadId: string;
  page: PageRef;
}

const json = (value: unknown) => ({
  type: "json" as const,
  value: JSON.parse(JSON.stringify(value ?? null)),
});
const r2 = (x: number | null | undefined, d = 4) =>
  x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;

function resolveVersionId(ctx: AgentContext, versionId?: string, strategyId?: string): string {
  if (versionId) return versionId;
  const sid = strategyId ?? ctx.page.strategyId;
  if (sid) {
    const s = getStrategy(ctx.userId, sid);
    if (s.current) return s.current.id;
  }
  if (ctx.page.versionId) return ctx.page.versionId;
  throw new Error("不知道是哪个策略：请先调用 list_strategies，或让用户打开一个策略");
}

async function waitRun(userId: string, runId: string, timeoutMs: number) {
  const t0 = Date.now();
  for (;;) {
    const r = getRun(userId, runId);
    if (r.status === "done" || r.status === "failed") return r;
    if (Date.now() - t0 > timeoutMs) return r;
    await new Promise((res) => setTimeout(res, 800));
  }
}

/** 给模型看的回测摘要（数字全部来自存档结果） */
export function runForModel(r: ReturnType<typeof getRun>) {
  const m = r.metrics as Metrics | null;
  if (r.status !== "done" || !m) {
    return {
      runId: r.id,
      status: r.status,
      error: r.error,
      // 夜间更新写库期间回测暂停（D60）：告诉模型在等什么，别让它说「卡住了」
      ...(r.status === "queued" && r.computePaused ? { note: COMPUTE_PAUSED_TEXT } : {}),
    };
  }
  return {
    runId: r.id,
    status: r.status,
    period: `${m.start} ~ ${m.end}`,
    dataAsOf: r.dataAsOf,
    totalReturn: r2(m.totalReturn),
    cagr: r2(m.cagr),
    benchCagr: r2(m.benchCagr),
    excessCagr: r2(m.excessCagr),
    excessTotal: r2(m.excessTotal),
    maxDrawdown: r2(m.maxDrawdown),
    drawdown: m.drawdownPeak
      ? `${m.drawdownPeak} → ${m.drawdownTrough}${m.drawdownRecovery ? `，${m.drawdownRecovery} 修复` : "，尚未修复"}`
      : null,
    sharpe: r2(m.sharpe, 2),
    volatility: r2(m.volatility),
    winRate: r2(m.winRate),
    avgHoldDays: r2(m.avgHoldDays, 0),
    turnover: r2(m.turnover, 2),
    costDragPerYear: r2(m.costDrag),
    buys: m.buys,
    yearly: m.yearly.map((y) => ({ year: y.year, ret: r2(y.ret), bench: r2(y.bench) })),
    inSample: r.segments?.inSample
      ? {
          period: `${r.segments.inSample.start} ~ ${r.segments.inSample.end}`,
          excessCagr: r2(r.segments.inSample.excessCagr),
        }
      : null,
    outOfSample: r.segments?.outOfSample
      ? {
          period: `${r.segments.outOfSample.start} ~ ${r.segments.outOfSample.end}`,
          excessCagr: r2(r.segments.outOfSample.excessCagr),
        }
      : null,
    checks: r.checks.map((c) => ({ level: c.level, title: c.title, detail: c.detail })),
    // 复现信息（D57）：口径不同的回测先说口径
    card: {
      hash: r.cardHash ? r.cardHash.slice(0, 8) : null,
      engine: r.engineVersion,
      dataAsOf: r.dataAsOf,
      exec: r.exec ? describeExec(r.exec) : null,
    },
    note: "百分比字段都是小数（0.123 = 12.3%）。卡片已展示完整报告。",
  };
}

const PatchOp = z.object({
  op: z.enum(["add", "replace", "remove"]),
  path: z.string().describe("JSON Pointer，如 /exits/stopLoss、/filters/0/value、/filters/-"),
  value: z.any().optional(),
});

export function buildTools(ctx: AgentContext): ToolSet {
  const { userId } = ctx;
  return {
    list_factors: tool({
      description: "列出某个市场可用的因子（名字、单位、口径）。只能用这里的因子写策略。",
      inputSchema: z.object({ market: z.enum(["A", "HK"]) }),
      execute: async ({ market }) => ({
        market,
        factors: factorsForMarket(market as Market).map((f) => ({
          key: f.key,
          label: f.label,
          kind: f.kind,
          unit: f.unit ?? null,
          describe: f.describe,
        })),
      }),
      toModelOutput: ({ output }) => json(output),
    }),

    list_strategies: tool({
      description: "列出用户的策略（id、名称、市场、当前版本）。不知道用户说的是哪个策略时先调它。",
      inputSchema: z.object({}),
      execute: async () =>
        listStrategies(userId).map((s) => ({
          id: s.id,
          name: s.name,
          market: s.market,
          versionId: s.current?.id,
          versionN: s.current?.n,
          describe: s.current?.describe,
        })),
      toModelOutput: ({ output }) => json(output),
    }),

    get_strategy: tool({
      description:
        "读取一个策略的当前版本（完整 spec 与人话描述）和版本列表。不给 strategyId 时用当前页面的策略。",
      inputSchema: z.object({ strategyId: z.string().optional() }),
      execute: async ({ strategyId }) => {
        const id = strategyId ?? ctx.page.strategyId;
        if (!id) throw new Error("没有指定策略，先调 list_strategies");
        const s = getStrategy(userId, id);
        return {
          id: s.id,
          name: s.name,
          market: s.market,
          current: s.current,
          versions: s.versions.map((v) => ({
            id: v.id,
            n: v.n,
            createdAt: v.createdAt,
            note: v.note,
          })),
        };
      },
      toModelOutput: ({ output }) =>
        json({
          strategyId: output.id,
          name: output.name,
          market: output.market,
          versionId: output.current?.id,
          versionN: output.current?.n,
          spec: output.current?.spec,
          describe: output.current?.describe,
          versions: output.versions,
        }),
    }),

    propose_strategy: tool({
      description:
        "提议新建或修改策略。新建：给完整 spec（不给 strategyId）。修改：给 strategyId + patch（推荐）或完整 spec。" +
        "只会生成一张待确认的草稿卡片，用户点「确认」后才生效。校验不过会返回错误，改正后重试。",
      inputSchema: z.object({
        strategyId: z.string().optional().describe("修改已有策略时给"),
        spec: z.record(z.string(), z.any()).optional().describe("完整策略 JSON（见 DSL 说明）"),
        patch: z.array(PatchOp).optional().describe("对当前版本的 JSON Patch"),
        note: z.string().optional().describe("这次改动的说明，会记在版本上"),
      }),
      execute: async (input) => {
        const r = proposeStrategy(userId, { ...input, threadId: ctx.threadId });
        let strategyName: string | null = null;
        if (r.ok) strategyName = r.spec.name;
        return { ...r, strategyName };
      },
      toModelOutput: ({ output }) =>
        json(
          output.ok
            ? {
                ok: true,
                draftId: output.draftId,
                changes: output.changes.map(
                  (c) => `${c.label}：${c.before ?? "（无）"} → ${c.after ?? "（删除）"}`,
                ),
                note: "草稿已生成，用户需要在卡片上点「确认」才生效。请提醒用户确认；确认前不要回测。",
              }
            : { ok: false, errors: output.errors },
        ),
    }),

    run_backtest: tool({
      description:
        "回测一个策略版本（默认当前页面策略的当前版本）。默认区间 2018-01-01 至今、100 万、样本外 12 个月。会等回测跑完再返回结果。",
      inputSchema: z.object({
        versionId: z.string().optional(),
        strategyId: z.string().optional(),
        start: z.string().optional().describe("YYYY-MM-DD"),
        end: z.string().optional().describe("YYYY-MM-DD"),
        capital: z.number().optional(),
        oosMonths: z.number().int().optional().describe("样本外月数，0 = 不分"),
      }),
      execute: async function* (input) {
        const versionId = resolveVersionId(ctx, input.versionId, input.strategyId);
        const { runId } = enqueueBacktest(userId, versionId, input);
        yield { runId, status: "queued" as const };
        const r = await waitRun(userId, runId, 120_000);
        yield { runId, status: r.status };
      },
      toModelOutput: ({ output }) => json(runForModel(getRun(userId, output.runId))),
    }),

    get_run: tool({
      description: "读取一次回测的结果与诚实检查（默认当前页面的回测）。",
      inputSchema: z.object({ runId: z.string().optional() }),
      execute: async ({ runId }) => {
        const id = runId ?? ctx.page.runId;
        if (!id) throw new Error("没有指定回测，可先用 list_runs 找");
        const r = getRun(userId, id);
        return { runId: r.id, status: r.status };
      },
      toModelOutput: ({ output }) => json(runForModel(getRun(userId, output.runId))),
    }),

    list_runs: tool({
      description: "列出某个策略最近的回测（id、区间、关键指标），用来找「上个版本的回测」等。",
      inputSchema: z.object({
        strategyId: z.string().optional(),
        limit: z.number().int().optional(),
      }),
      execute: async ({ strategyId, limit }) => {
        const sid = strategyId ?? ctx.page.strategyId;
        return listRuns(userId, { strategyId: sid, limit: limit ?? 10 }).map((r) => {
          const versionN = versionNOf(userId, r.versionId);
          return {
            runId: r.id,
            kind: r.kind,
            label: r.label,
            versionN,
            status: r.status,
            period: `${r.params.start} ~ ${r.params.end}`,
            headline: r.headline,
          };
        });
      },
      toModelOutput: ({ output }) => json(output),
    }),

    query_run: tool({
      description:
        "下钻一次回测：drawdowns 最大几次回撤；period 某区间（from/to）的表现与盈亏最多的股票；holdings_on 某天（date）的持仓；" +
        "trades 交易明细（可按 code、from、to 过滤）；contributors 贡献最多/最少的股票；industry 行业盈亏与仓位；monthly 月度与年度收益。",
      inputSchema: z.object({
        runId: z.string().optional(),
        what: z.enum([
          "drawdowns",
          "period",
          "holdings_on",
          "trades",
          "contributors",
          "industry",
          "monthly",
        ]),
        from: z.string().optional(),
        to: z.string().optional(),
        date: z.string().optional(),
        code: z.string().optional(),
        top: z.number().int().optional(),
        limit: z.number().int().optional(),
      }),
      execute: async (input) => {
        const id = input.runId ?? ctx.page.runId;
        if (!id) throw new Error("没有指定回测");
        const from = input.from ?? ctx.page.range?.from;
        const to = input.to ?? ctx.page.range?.to;
        const q = { ...input, from, to } as RunQuery;
        if (q.what === "period" && (!from || !to)) throw new Error("period 需要 from 和 to");
        if (q.what === "holdings_on" && !input.date) throw new Error("holdings_on 需要 date");
        return { runId: id, result: queryRun(userId, id, q) };
      },
      toModelOutput: ({ output }) => json(output),
    }),

    compare_runs: tool({
      description: "对比 2–4 个回测的关键指标与净值曲线。",
      inputSchema: z.object({ runIds: z.array(z.string()).min(2).max(4) }),
      execute: async ({ runIds }) => ({ runIds }),
      toModelOutput: ({ output }) =>
        json(
          compareRuns(userId, output.runIds).map((r) => ({
            runId: r.id,
            versionN: r.versionN,
            period: `${r.params.start} ~ ${r.params.end}`,
            cagr: r2(r.headline?.cagr),
            excessCagr: r2(r.headline?.excessCagr),
            maxDrawdown: r2(r.headline?.maxDrawdown),
            sharpe: r2(r.headline?.sharpe, 2),
            outOfSampleExcess: r2(
              (r.segments as { outOfSample?: { excessCagr: number } } | null)?.outOfSample
                ?.excessCagr,
            ),
            warnings: r.checks.filter((c) => c.level === "warn").map((c) => c.title),
          })),
        ),
    }),

    run_sensitivity: tool({
      description:
        "参数扫描：把一个参数（JSON Pointer，如 /exits/stopLoss、/rank/top、/filters/0/value、/rebalance/every）取 2–8 个值各回测一次，看结果对参数是否敏感。不产生新版本。",
      inputSchema: z.object({
        versionId: z.string().optional(),
        path: z.string(),
        values: z.array(z.any()).min(2).max(8),
        label: z.string().optional().describe("参数的中文名，如「止损」"),
        start: z.string().optional(),
        end: z.string().optional(),
      }),
      execute: async function* (input) {
        const versionId = resolveVersionId(ctx, input.versionId);
        const { runId } = enqueueSweep(userId, versionId, input, input);
        yield { runId, status: "queued" as const };
        const r = await waitRun(userId, runId, 600_000);
        yield { runId, status: r.status };
      },
      toModelOutput: ({ output }) => {
        const r = getRun(userId, output.runId);
        return json({
          runId: r.id,
          status: r.status,
          variants: r.children.map((c) => ({
            label: c.label,
            excessCagr: r2(c.headline?.excessCagr),
            maxDrawdown: r2(c.headline?.maxDrawdown),
            sharpe: r2(c.headline?.sharpe, 2),
          })),
          checks: r.checks.map((c) => ({ level: c.level, title: c.title, detail: c.detail })),
        });
      },
    }),

    screen_today: tool({
      description:
        "按某个策略版本在最新数据日（或指定 date）选股，返回排名与关键因子。这是按规则算出的结果，不是投资建议。",
      inputSchema: z.object({
        versionId: z.string().optional(),
        date: z.string().optional(),
        limit: z.number().int().optional(),
      }),
      execute: async (input) => {
        const versionId = resolveVersionId(ctx, input.versionId);
        const { version } = getVersion(userId, versionId);
        const res = await worker.post<{
          date: string;
          rows: Array<{
            rank: number;
            code: string;
            name: string | null;
            score: number;
            factors: Record<string, unknown>;
          }>;
        }>("/internal/screen", { spec: version.spec, date: input.date, limit: input.limit ?? 20 });
        return { versionId, market: version.spec.market, ...res };
      },
      toModelOutput: ({ output }) =>
        json({
          date: output.date,
          count: output.rows.length,
          rows: output.rows.slice(0, 15).map((r) => ({
            rank: r.rank,
            code: r.code,
            name: r.name,
            ...Object.fromEntries(
              Object.entries(r.factors).map(([k, v]) => [k, typeof v === "number" ? r2(v, 2) : v]),
            ),
          })),
        }),
    }),

    lookup_security: tool({
      description: "按名称或代码查个股：最新因子、最近几期财报、最近的分红送转。",
      inputSchema: z.object({
        query: z.string().describe("名称或代码，如 贵州茅台、600519、00700"),
      }),
      execute: async ({ query }) => {
        const hits = await worker.get<Array<{ code: string; name: string; market: string }>>(
          `/internal/securities/search?q=${encodeURIComponent(query)}`,
        );
        const exact = hits.find((h) => h.code.startsWith(query) || h.name === query) ?? hits[0];
        if (!exact) return { found: false as const, query, candidates: [] };
        const card = await worker.get<Record<string, unknown>>(
          `/internal/securities/${encodeURIComponent(exact.code)}`,
        );
        return { found: true as const, query, candidates: hits.slice(0, 5), card };
      },
      toModelOutput: ({ output }) => {
        if (!output.found) return json({ found: false, note: "没找到这只股票" });
        const card = output.card as {
          security: Record<string, unknown>;
          factors: Record<string, unknown> | null;
          financials: unknown[];
          actions: unknown[];
        };
        const f = card.factors ?? {};
        const pick = Object.fromEntries(
          Object.entries(f)
            .filter(([k, v]) => v !== null && (k === "date" || k === "close" || getFactor(k)))
            .map(([k, v]) => [k, typeof v === "number" ? r2(v, 2) : v]),
        );
        return json({
          security: card.security,
          factors: pick,
          financials: card.financials.slice(0, 4),
          actions: card.actions.slice(0, 3),
          otherMatches: output.candidates.slice(1),
        });
      },
    }),

    propose_tracking: tool({
      description:
        "提议把一个策略版本上线向前跟踪（模拟盘，每个交易日收盘后结算）。只生成待确认卡片，用户确认后才上线。",
      inputSchema: z.object({ versionId: z.string().optional(), capital: z.number().optional() }),
      execute: async (input) =>
        proposeTracking(userId, {
          versionId: resolveVersionId(ctx, input.versionId),
          capital: input.capital,
          threadId: ctx.threadId,
        }),
      toModelOutput: ({ output }) =>
        json({
          draftId: output.draftId,
          summary: `「${output.strategyName}」v${output.versionN}，${output.startDate} 起，模拟资金 ${output.capital}，成交假设：${output.execText}`,
          hasBaseline: output.hasBaseline,
          legacyBaseline: output.legacyBaseline,
          note: "等待用户在卡片上确认后才上线。",
        }),
    }),

    get_tracking: tool({
      description:
        "读取一个向前跟踪的现状（默认当前页面的跟踪）：跟踪天数、累计超额、跑赢回测同期的百分比（deviationPct）、明日计划。",
      inputSchema: z.object({ trackingId: z.string().optional() }),
      execute: async ({ trackingId }) => {
        const id = trackingId ?? ctx.page.trackingId;
        if (!id) throw new Error("没有指定跟踪");
        const t = getTracking(userId, id);
        return {
          trackingId: t.id,
          strategyName: t.strategyName,
          startDate: t.startDate,
          days: t.days.length,
          lastDate: t.lastDate,
          totalReturn: t.nav !== null ? r2(t.nav - 1) : null,
          benchReturn: t.bench !== null ? r2(t.bench - 1) : null,
          excess: r2(t.excess),
          deviationPct: r2(t.deviationPct, 0),
          orders: t.orders.map((o) => ({
            side: o.side,
            code: o.code,
            name: o.name,
            reason: o.reason,
          })),
        };
      },
      toModelOutput: ({ output }) => json(output),
    }),

    get_overview: tool({
      description:
        "看板概览：用户所有运行中的跟踪（跟踪天数、跟踪超额、跑赢回测同期的百分比）、明日计划买卖、最新简报、数据截至日期。" +
        "用户问「今天怎么样」「我的跟踪」「明天买卖什么」这类问题时先调它；卡片会列出每个跟踪。",
      inputSchema: z.object({}),
      execute: async () => overview(userId),
      toModelOutput: ({ output }) =>
        json({
          dataAsOf: output.dataAsOf,
          failedMarkets: output.failedMarkets,
          brief: output.brief,
          trackings: output.trackings.map((t) => ({
            trackingId: t.id,
            name: t.strategyName,
            market: t.market,
            startDate: t.startDate,
            days: t.days,
            excess: r2(t.excess),
            beatBacktestPct: r2(t.deviationPct, 0),
            backtestExcessCagr: r2(t.baseline?.excessCagr),
          })),
          plans: output.plans,
        }),
    }),

    screen_rules: tool({
      description:
        "按一组条件临时选股，不用先建策略：spec 写法和 propose_strategy 相同，至少给 market 和 filters；" +
        "不给 rank 时按市值从大到小。在最新数据日（或指定 date）算出排名与关键因子。想长期用或回测，再用 propose_strategy 建成策略。" +
        "这是按规则算出的结果，不是投资建议。",
      inputSchema: z.object({
        spec: z
          .record(z.string(), z.any())
          .describe("与 propose_strategy 相同的 spec（name 可省略）"),
        date: z.string().optional(),
        limit: z.number().int().optional().describe("最多返回几只，默认 20，最多 50"),
      }),
      execute: async ({ spec, date, limit }) => {
        const n = Math.min(Math.max(limit ?? 20, 1), 50);
        const v = validateSpec({
          name: "临时选股",
          rank: { terms: [{ factor: "mcap", weight: 1, better: "high" }], top: n },
          ...spec,
        });
        if (!v.spec) return { ok: false as const, errors: v.errors };
        const res = await worker.post<{
          date: string;
          rows: Array<{
            rank: number;
            code: string;
            name: string | null;
            score: number;
            close: number | null;
            factors: Record<string, unknown>;
          }>;
        }>("/internal/screen", { spec: v.spec, date, limit: n });
        const describe = describeSpec(v.spec).filter((l) => !/^(调仓|仓位|退出|基准)/.test(l));
        return { ok: true as const, market: v.spec.market, describe, ...res };
      },
      toModelOutput: ({ output }) =>
        output.ok
          ? json({
              date: output.date,
              count: output.rows.length,
              conditions: output.describe,
              rows: output.rows.slice(0, 15).map((r) => ({
                rank: r.rank,
                code: r.code,
                name: r.name,
                ...Object.fromEntries(
                  Object.entries(r.factors).map(([k, v]) => [
                    k,
                    typeof v === "number" ? r2(v, 2) : v,
                  ]),
                ),
              })),
            })
          : json({ ok: false, errors: output.errors, note: "条件不合法，改正后重试" }),
    }),

    propose_stop_tracking: tool({
      description:
        "提议停止一个运行中的向前跟踪（默认当前页面的跟踪）。只生成一张确认卡片，用户点「确认停止」后才停；停止后不再每日结算，历史保留。",
      inputSchema: z.object({ trackingId: z.string().optional() }),
      execute: async ({ trackingId }) => {
        const id = trackingId ?? ctx.page.trackingId;
        if (!id) throw new Error("没有指定跟踪：先调 get_overview 找到 trackingId");
        const t = getTracking(userId, id);
        if (t.status !== "active") throw new Error("这个跟踪已经停了");
        return {
          trackingId: t.id,
          strategyName: t.strategyName,
          startDate: t.startDate,
          days: t.days.length,
          excess: t.excess,
        };
      },
      toModelOutput: ({ output }) =>
        json({ ...output, excess: r2(output.excess), note: "等待用户在卡片上确认后才会停止。" }),
    }),
  };
}

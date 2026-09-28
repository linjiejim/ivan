/**
 * 回测：排队（worker 执行）、结果读取、下钻、对比、参数扫描。
 * 回测不破坏任何数据，可以直接执行，但受额度与队列限制（spec §9）。
 */
import {
  type Attribution,
  type BacktestParams,
  type Check,
  DEFAULT_PARAMS,
  diffDays,
  isDateStr,
  type HoldingSnapshot,
  type Metrics,
  type PeriodMetrics,
  type SeriesPoint,
  type StrategySpec,
  todayCN,
  validateSpec,
} from "@ivan/core";
import { periodMetrics } from "@ivan/engine";
import { jobs, newId, runs, runTrades, strategies, strategyVersions, unpackJson } from "@ivan/db";
import { and, asc, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { env } from "../env.ts";
import { AppError, notFound } from "../lib/errors.ts";
import { applyPatch } from "../lib/jsonpatch.ts";
import { consume } from "../lib/quota.ts";
import { worker } from "../lib/worker-client.ts";
import { getVersion, versionNOf } from "./strategies.ts";

export const MAX_ACTIVE_JOBS = 3;

export interface RunParamsInput {
  start?: string;
  end?: string;
  capital?: number;
  oosMonths?: number;
}

export function normalizeParams(p: RunParamsInput = {}): BacktestParams {
  const start = p.start ?? DEFAULT_PARAMS.start;
  const end = p.end ?? todayCN();
  if (!isDateStr(start) || !isDateStr(end)) throw new AppError(400, "日期格式要是 YYYY-MM-DD");
  if (start < "2014-01-01")
    throw new AppError(400, "回测起点不能早于 2014-01-01（行情仓从 2013 年开始）");
  if (diffDays(end, start) < 90) throw new AppError(400, "回测区间至少要 3 个月");
  const capital = p.capital ?? DEFAULT_PARAMS.capital;
  if (!(capital >= 10_000 && capital <= 1e10))
    throw new AppError(400, "初始资金要在 1 万到 100 亿之间");
  const oosMonths = p.oosMonths ?? DEFAULT_PARAMS.oosMonths;
  if (!(oosMonths >= 0 && oosMonths <= 60)) throw new AppError(400, "样本外月数要在 0–60 之间");
  return { start, end, capital, oosMonths };
}

function activeJobs(userId: string): number {
  const { db } = env().app;
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(jobs)
      .where(and(eq(jobs.userId, userId), inArray(jobs.status, ["queued", "running"])))
      .get()?.n ?? 0
  );
}

/** 同一策略在同一区间（起点相同、终点相差 31 天内）已回测过的不同版本数 */
export function priorVersionsOnPeriod(
  strategyId: string,
  params: BacktestParams,
  exceptVersion: string,
): number {
  const { db } = env().app;
  const rows = db
    .select({ versionId: runs.versionId, params: runs.params })
    .from(runs)
    .where(and(eq(runs.strategyId, strategyId), eq(runs.kind, "backtest")))
    .all();
  const versions = new Set<string>();
  for (const r of rows) {
    const p = r.params as Partial<BacktestParams>;
    if (r.versionId === exceptVersion || p.start !== params.start || !p.end) continue;
    if (Math.abs(diffDays(p.end, params.end)) <= 31) versions.add(r.versionId);
  }
  return versions.size;
}

export function enqueueBacktest(
  userId: string,
  versionId: string,
  input: RunParamsInput = {},
): { runId: string; jobId: string } {
  const { db } = env().app;
  const { strategy } = getVersion(userId, versionId);
  const params = normalizeParams(input);
  if (activeJobs(userId) >= MAX_ACTIVE_JOBS) {
    throw new AppError(429, `同时排队的任务最多 ${MAX_ACTIVE_JOBS} 个，等前面的跑完再来`);
  }
  consume(userId, "backtests");
  const runId = newId("r_");
  const jobId = newId("j_");
  db.transaction((tx) => {
    tx.insert(runs)
      .values({
        id: runId,
        userId,
        strategyId: strategy.id,
        versionId,
        kind: "backtest",
        params: {
          ...params,
          priorVersions: priorVersionsOnPeriod(strategy.id, params, versionId),
        } as unknown as Record<string, unknown>,
      })
      .run();
    tx.insert(jobs).values({ id: jobId, kind: "backtest", userId, payload: { runId } }).run();
  });
  void worker.kick();
  return { runId, jobId };
}

/** 参数扫描：一个参数取 2–8 个值，各跑一次（不产生新版本），子回测挂在一个父记录下。 */
export function enqueueSweep(
  userId: string,
  versionId: string,
  sweep: { path: string; values: unknown[]; label?: string },
  input: RunParamsInput = {},
): { runId: string; jobId: string; variants: number } {
  const { db } = env().app;
  const { strategy, version } = getVersion(userId, versionId);
  if (!/^\/[\w/-]+$/.test(sweep.path))
    throw new AppError(400, "参数路径要是 JSON Pointer，如 /exits/stopLoss");
  if (sweep.values.length < 2 || sweep.values.length > 8)
    throw new AppError(400, "扫描取值要 2–8 个");
  const params = normalizeParams(input);
  const variants: Array<{ label: string; spec: StrategySpec }> = [];
  for (const value of sweep.values) {
    let candidate: unknown;
    try {
      candidate = applyPatch(version.spec, [{ op: "add", path: sweep.path, value }]);
    } catch (e) {
      throw new AppError(400, e instanceof Error ? e.message : String(e));
    }
    const v = validateSpec(candidate);
    if (!v.spec)
      throw new AppError(400, `取值 ${JSON.stringify(value)} 让策略不合法：${v.errors.join("；")}`);
    variants.push({
      label: `${sweep.label ?? sweep.path} = ${JSON.stringify(value)}`,
      spec: v.spec,
    });
  }
  if (activeJobs(userId) >= MAX_ACTIVE_JOBS) {
    throw new AppError(429, `同时排队的任务最多 ${MAX_ACTIVE_JOBS} 个，等前面的跑完再来`);
  }
  consume(userId, "backtests", variants.length);
  const runId = newId("r_");
  const jobId = newId("j_");
  db.transaction((tx) => {
    tx.insert(runs)
      .values({
        id: runId,
        userId,
        strategyId: strategy.id,
        versionId,
        kind: "sweep",
        label: sweep.label ?? sweep.path,
        params: { ...params, sweep } as unknown as Record<string, unknown>,
      })
      .run();
    tx.insert(jobs)
      .values({
        id: jobId,
        kind: "sweep",
        userId,
        payload: { runId, variants: variants as unknown as Record<string, unknown>[] } as Record<
          string,
          unknown
        >,
      })
      .run();
  });
  void worker.kick();
  return { runId, jobId, variants: variants.length };
}

type RunRow = typeof runs.$inferSelect;

function ownRun(userId: string, runId: string): RunRow {
  const { db } = env().app;
  const r = db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.userId, userId)))
    .get();
  if (!r) throw notFound("回测");
  return r;
}

export function runSummary(r: RunRow) {
  const m = r.metrics as Metrics | null;
  return {
    id: r.id,
    strategyId: r.strategyId,
    versionId: r.versionId,
    kind: r.kind,
    label: r.label,
    parentId: r.parentId,
    status: r.status,
    error: r.error,
    params: r.params,
    dataAsOf: r.dataAsOf,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
    checks: (r.checks ?? []) as Check[],
    headline: m
      ? {
          totalReturn: m.totalReturn,
          cagr: m.cagr,
          benchCagr: m.benchCagr,
          excessCagr: m.excessCagr,
          maxDrawdown: m.maxDrawdown,
          sharpe: m.sharpe,
          winRate: m.winRate,
          buys: m.buys,
        }
      : null,
  };
}

/** 给回测摘要补上策略名与版本号（看板「最近回测」、报告标题用） */
function withNames<T extends { strategyId: string; versionId: string }>(
  rows: T[],
): Array<T & { strategyName: string | null; versionN: number | null }> {
  if (!rows.length) return [];
  const { db } = env().app;
  const sIds = [...new Set(rows.map((r) => r.strategyId))];
  const vIds = [...new Set(rows.map((r) => r.versionId))];
  const names = new Map(
    db
      .select({ id: strategies.id, name: strategies.name })
      .from(strategies)
      .where(inArray(strategies.id, sIds))
      .all()
      .map((x) => [x.id, x.name]),
  );
  const ns = new Map(
    db
      .select({ id: strategyVersions.id, n: strategyVersions.n })
      .from(strategyVersions)
      .where(inArray(strategyVersions.id, vIds))
      .all()
      .map((x) => [x.id, x.n]),
  );
  return rows.map((r) => ({
    ...r,
    strategyName: names.get(r.strategyId) ?? null,
    versionN: ns.get(r.versionId) ?? null,
  }));
}

export function getRun(userId: string, runId: string) {
  const r = ownRun(userId, runId);
  const { db } = env().app;
  const job = db
    .select({ status: jobs.status, progress: jobs.progress, note: jobs.note })
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, r.kind === "sweep" ? "sweep" : "backtest"),
        like(jobs.payload, `%${runId}%`),
      ),
    )
    .orderBy(desc(jobs.createdAt))
    .get();
  const children =
    r.kind === "sweep"
      ? db
          .select()
          .from(runs)
          .where(eq(runs.parentId, r.id))
          .orderBy(asc(runs.createdAt))
          .all()
          .map(runSummary)
      : [];
  return {
    ...withNames([runSummary(r)])[0]!,
    engineVersion: r.engineVersion,
    dataVersion: r.dataVersion,
    metrics: r.metrics as Metrics | null,
    segments: r.segments as { inSample: PeriodMetrics; outOfSample: PeriodMetrics | null } | null,
    attribution: r.attribution,
    final: r.final,
    series: unpackJson<SeriesPoint[]>(r.seriesZ) ?? [],
    job: job ?? null,
    children,
  };
}

export function listRuns(userId: string, opts: { strategyId?: string; limit?: number } = {}) {
  const { db } = env().app;
  const where = opts.strategyId
    ? and(
        eq(runs.userId, userId),
        eq(runs.strategyId, opts.strategyId),
        or(eq(runs.kind, "backtest"), eq(runs.kind, "sweep")),
      )
    : and(eq(runs.userId, userId), or(eq(runs.kind, "backtest"), eq(runs.kind, "sweep")));
  const rows = db
    .select()
    .from(runs)
    .where(where)
    .orderBy(desc(runs.createdAt))
    .limit(opts.limit ?? 20)
    .all()
    .map(runSummary);
  return withNames(rows);
}

export function getTrades(
  userId: string,
  runId: string,
  opts: { code?: string; from?: string; to?: string; limit?: number; offset?: number } = {},
) {
  const run = ownRun(userId, runId);
  // 成交表不存名字，名字取自同一次回测的归因（每只交易过的股票都在里面）
  const names = new Map(
    ((run.attribution as Attribution | null)?.byStock ?? []).map((s) => [s.code, s.name]),
  );
  const { db } = env().app;
  const conds = [eq(runTrades.runId, runId)];
  if (opts.code) conds.push(eq(runTrades.code, opts.code));
  let rows = db
    .select()
    .from(runTrades)
    .where(and(...conds))
    .orderBy(asc(runTrades.seq))
    .all();
  if (opts.from) rows = rows.filter((t) => t.date >= opts.from!);
  if (opts.to) rows = rows.filter((t) => t.date <= opts.to!);
  const total = rows.length;
  const offset = opts.offset ?? 0;
  return {
    total,
    trades: rows
      .slice(offset, offset + (opts.limit ?? 200))
      .map((t) => ({ ...t, name: names.get(t.code) ?? null })),
  };
}

/** 净值序列降采样（图表与对比用），保留首尾与每段极值附近的点 */
export function downsample(series: SeriesPoint[], maxPoints = 400): SeriesPoint[] {
  if (series.length <= maxPoints) return series;
  const step = series.length / maxPoints;
  const out: SeriesPoint[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(series[Math.floor(i * step)]!);
  out.push(series.at(-1)!);
  return out;
}

export function compareRuns(userId: string, runIds: string[]) {
  if (runIds.length < 2 || runIds.length > 4) throw new AppError(400, "对比要 2–4 个回测");
  return runIds.map((id) => {
    const r = getRun(userId, id);
    const versionN = versionNOf(userId, r.versionId);
    return {
      ...runSummary(ownRun(userId, id)),
      versionN,
      segments: r.segments,
      series: downsample(r.series, 300),
    };
  });
}

export type RunQuery =
  | { what: "drawdowns"; top?: number }
  | { what: "period"; from: string; to: string }
  | { what: "holdings_on"; date: string }
  | { what: "trades"; code?: string; from?: string; to?: string; limit?: number }
  | { what: "contributors"; top?: number }
  | { what: "industry" }
  | { what: "monthly" };

/** 下钻（对话工具 query_run 与报告页共用）。返回数据小而准，数字全部来自存档结果。 */
export function queryRun(userId: string, runId: string, q: RunQuery) {
  const r = getRun(userId, runId);
  if (r.status !== "done") throw new AppError(409, "回测还没跑完");
  const series = r.series;
  switch (q.what) {
    case "drawdowns": {
      // 找不重叠的最大几次回撤
      const out: Array<{ peak: string; trough: string; recovery: string | null; depth: number }> =
        [];
      const used = new Set<number>();
      for (let n = 0; n < (q.top ?? 3); n++) {
        let best = { depth: 0, peak: -1, trough: -1 };
        let peak = -1;
        for (let i = 0; i < series.length; i++) {
          if (used.has(i)) {
            peak = -1;
            continue;
          }
          if (peak < 0 || series[i]!.nav > series[peak]!.nav) peak = i;
          const dd = series[i]!.nav / series[peak]!.nav - 1;
          if (dd < best.depth) best = { depth: dd, peak, trough: i };
        }
        if (best.trough < 0) break;
        let rec = -1;
        for (let i = best.trough + 1; i < series.length; i++) {
          if (series[i]!.nav >= series[best.peak]!.nav) {
            rec = i;
            break;
          }
        }
        for (let i = best.peak; i <= (rec < 0 ? series.length - 1 : rec); i++) used.add(i);
        out.push({
          peak: series[best.peak]!.date,
          trough: series[best.trough]!.date,
          recovery: rec < 0 ? null : series[rec]!.date,
          depth: best.depth,
        });
      }
      return { what: q.what, drawdowns: out };
    }
    case "period": {
      const seg = series.filter((p) => p.date >= q.from && p.date <= q.to);
      if (seg.length < 2) throw new AppError(400, "这段区间没有足够的交易日");
      const trades = getTrades(userId, runId, { from: q.from, to: q.to, limit: 1000 }).trades;
      const byCode = new Map<string, number>();
      for (const t of trades)
        if (t.side === "sell") byCode.set(t.code, (byCode.get(t.code) ?? 0) + (t.pnl ?? 0));
      const sorted = [...byCode.entries()].sort((a, b) => a[1] - b[1]);
      return {
        what: q.what,
        metrics: periodMetrics(seg),
        trades: trades.length,
        worstClosed: sorted.slice(0, 5).map(([code, pnl]) => ({ code, pnl })),
        bestClosed: sorted
          .slice(-5)
          .reverse()
          .map(([code, pnl]) => ({ code, pnl })),
      };
    }
    case "holdings_on": {
      const holdings = unpackJson<HoldingSnapshot[]>(ownRun(userId, runId).holdingsZ) ?? [];
      const snap = [...holdings].reverse().find((h) => h.date <= q.date) ?? null;
      return { what: q.what, snapshot: snap };
    }
    case "trades":
      return {
        what: q.what,
        ...getTrades(userId, runId, { ...q, limit: Math.min(q.limit ?? 50, 200) }),
      };
    case "contributors": {
      const attr = r.attribution as {
        byStock: Array<{ code: string; name: string; pnl: number }>;
      } | null;
      const all = attr?.byStock ?? [];
      const n = q.top ?? 10;
      return { what: q.what, best: all.slice(0, n), worst: all.slice(-n).reverse() };
    }
    case "industry":
      return {
        what: q.what,
        byIndustry: (r.attribution as { byIndustry: unknown[] } | null)?.byIndustry ?? [],
      };
    case "monthly":
      return { what: q.what, monthly: r.metrics?.monthly ?? [], yearly: r.metrics?.yearly ?? [] };
  }
}

/** 某个版本上线日前最近一次跑完的回测（跟踪的对照基线） */
export function latestDoneRun(userId: string, versionId: string): RunRow | undefined {
  const { db } = env().app;
  return db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.userId, userId),
        eq(runs.versionId, versionId),
        eq(runs.kind, "backtest"),
        eq(runs.status, "done"),
      ),
    )
    .orderBy(desc(runs.finishedAt))
    .get();
}

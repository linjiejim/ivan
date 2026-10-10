/**
 * 向前跟踪结算（spec §7，D13）：每个运行中的跟踪都从上线日重放到最新交易日——和回测同一个 simulate，
 * 规则只在一处实现；每天整体重写 tracking_days 与明日计划，数据修订（如全收益基准晚到）会自动被修正。
 *
 * 跟踪锁定上线时的成交假设（D55）；重放与上一晚不一致时用前缀指纹归因（D57）：按上一晚的最后结算日、
 * 「执行日 ≤ cut」重算前缀，和上一晚存的比。整窗指纹每晚都会变（窗口变长），不能拿来比。
 *
 * 决策账本（D68）：明日计划连同依据存成只追加的计划快照（plan-snapshot.ts）并记账本；重放的成交与拒单整体重写进
 * tracking_trades；有重放漂移时另记一条 replay_drift。整段写入在 IMMEDIATE 事务里（先拿写锁再读账本链尾），
 * 账本追加在里面是保存点，server 同时追加也不会分叉。
 */
import {
  type Fan,
  type Market,
  nextTradingDay,
  resolveExec,
  type SeriesPoint,
  type StrategySpec,
  validateSpec,
} from "@ivan/core";
import { sha256Canonical } from "@ivan/core/node";
import {
  buildSimInput,
  committedAsOf,
  explainSelection,
  HASH_VERSION,
  hashSimInput,
  lastTradingDay,
  latestDataVersion,
  type SelectionExplain,
} from "@ivan/data";
import {
  attributeDrift,
  BACKTEST_ONLY_CHECKS,
  compareReplay,
  deviationPercentile,
  ENGINE_VERSION,
  fanPercentile,
  rebalanceDays,
} from "@ivan/engine";
import {
  appendLedger,
  runs,
  strategyVersions,
  trackingDays,
  trackingOrders,
  trackings,
  trackingTrades,
  unpackJson,
} from "@ivan/db";
import { and, eq } from "drizzle-orm";
import { env } from "../env.ts";
import type { JobContext } from "../runner.ts";
import { runSimulation } from "../sim-pool.ts";
import {
  bandOf,
  benchCloseAt,
  benchSymOf,
  entryItems,
  explainHashOf,
  itemsFromPending,
  type PlanDraft,
  writePlanSnapshot,
} from "./plan-snapshot.ts";

type TrackingRow = typeof trackings.$inferSelect;

async function settleOne(t: TrackingRow, latest: string, ctx: JobContext): Promise<void> {
  const { db, sqlite } = env().app;
  const { wh } = env();
  const raw = db
    .select()
    .from(strategyVersions)
    .where(eq(strategyVersions.id, t.versionId))
    .get()?.spec;
  const v = validateSpec(raw);
  if (!v.spec) throw new Error(`跟踪 ${t.id} 的策略版本不合法`);
  const spec: StrategySpec = v.spec;

  // 刚上线、还没到第一个交易日：不跑模拟，只给出首日建仓计划（精简快照：输入指纹为空，只有解释指纹与数据版本参与版次判断）
  if (t.startDate > latest) {
    await settleWaiting(t, spec, latest, ctx);
    return;
  }

  const exec = resolveExec(t.execConfig);
  const built = await buildSimInput(
    wh,
    spec,
    { start: t.startDate, end: latest, capital: t.capital, oosMonths: 0, exec },
    { appendNextDay: true },
  );
  const planDate = built.input.calendar.at(-1)!;
  // 上一晚存下的指纹；今晚的指纹都要在转交线程之前算
  const prev = (t.summary ?? {}) as {
    engineVersion?: string;
    execHash?: string;
    prefixHash?: string;
    hashVersion?: number;
    lastDate?: string;
  };
  // 今晚的最后结算日：日历上最后一个 ≤ latest 的交易日（就是重放序列的最后一天）。前缀指纹的 cut 与
  // 存下的 lastDate 必须是同一个字符串，下一晚才能按它原样重算（日历缺 latest 时两者会不同）
  const settleDate = built.input.calendar.findLast((d) => d <= latest) ?? latest;
  const full = hashSimInput(built.input, { cut: latest });
  const prefixTonight = hashSimInput(built.input, { cut: settleDate, rule: "executed" }).inputHash;
  const prefixPrev = prev.lastDate
    ? hashSimInput(built.input, { cut: prev.lastDate, rule: "executed" }).inputHash
    : null;
  const execHash = sha256Canonical(exec);
  // 结算不算可信度（D65）：只读基准回测存下的扇形
  const { result } = await runSimulation(built.input);
  const series = result.series;
  const last = series.at(-1)!;

  // 与回测对照的偏离百分位（按超额）；基准回测有扇形时，再算按绝对净值落在扇形的哪一档（D65，不扣基准，两者不并排放）
  let deviationPct: number | null = null;
  let navFan: ReturnType<typeof fanPercentile> = null;
  if (t.baselineRunId) {
    const baseRun = db
      .select({ seriesZ: runs.seriesZ, validationZ: runs.validationZ })
      .from(runs)
      .where(eq(runs.id, t.baselineRunId))
      .get();
    const baseline = unpackJson<SeriesPoint[]>(baseRun?.seriesZ) ?? [];
    const k = series.length - 1;
    deviationPct = deviationPercentile(baseline, last.nav / last.bench - 1, k);
    // 扇形的第 d 天是从净值 1（投入资金那一刻）起的第 d 个日收益；跟踪的净值 = 资产 ÷ 资金，第 series.length 天
    const fan = unpackJson<Fan>(baseRun?.validationZ);
    if (fan) navFan = fanPercentile(fan, series.length, last.nav);
  }

  const stored = db
    .select({ date: trackingDays.date, nav: trackingDays.nav, bench: trackingDays.bench })
    .from(trackingDays)
    .where(eq(trackingDays.trackingId, t.id))
    .all();
  const replay = compareReplay(stored, series);
  const drift = attributeDrift(
    {
      engineVersion: prev.engineVersion,
      execHash: prev.execHash,
      prefixHash: prev.prefixHash,
      hashVersion: prev.hashVersion,
    },
    {
      engineVersion: result.engineVersion,
      execHash,
      prefixHash: prefixPrev,
      hashVersion: HASH_VERSION,
    },
    replay,
  );
  if (drift.cause !== "none") {
    ctx.log(
      `跟踪 ${t.id} 重放与上次不一致：净值 ${replay.navDrift} 天、基准 ${replay.benchDrift} 天，` +
        `最早 ${replay.firstDrift}（${drift.text}，已按最新数据改写）`,
    );
  }

  // ── 计划快照（D68）：今晚的决策日 = 最后结算日；明天是调仓日（或有买单）时带上候选名单 ──
  const decisionDate = settleDate;
  const pending = result.final.pending;
  const rank = spec.mode === "rules" ? spec.rank : undefined;
  const nextIsRebalance =
    !!rank &&
    ((planDate > settleDate &&
      rebalanceDays(built.input.calendar, built.params, spec.rebalance.every).decisionDates.at(
        -1,
      ) === settleDate) ||
      pending.some((o) => o.side === "buy"));
  let explain: SelectionExplain | null = null;
  if (rank) {
    const codes = [
      ...new Set([...pending.map((o) => o.code), ...result.final.positions.map((p) => p.code)]),
    ];
    explain = await explainSelection(wh, spec, decisionDate, {
      limit: Math.ceil(rank.top * spec.rebalance.buffer) + rank.top,
      codes,
    });
  }
  const candidates = nextIsRebalance && explain ? explain.candidates : [];
  const draft: PlanDraft = {
    content: {
      trackingId: t.id,
      decisionDate,
      planDate,
      versionId: t.versionId,
      specHash: specHashOfVersion(t.versionId),
      regime: explain?.regime ?? null,
      exposureCurrent: result.final.exposure?.current ?? null,
      exposureNext: result.final.exposure?.next ?? null,
      equity: result.final.equity,
      cash: result.final.cash,
      positions: result.final.positions,
      candidates,
    },
    items: itemsFromPending(pending, explain),
    userId: t.userId,
    planDateBasis: built.nextDayBasis ?? "weekday",
    dataVersion: built.dataVersion.id,
    dataAsOf: built.dataVersion.asOf,
    engineVersion: result.engineVersion,
    execHash,
    inputHash: full.inputHash,
    hashVersion: HASH_VERSION,
    explainHash: explain ? explainHashOf(explain, candidates) : null,
    band: bandOf(spec),
    benchSym: benchSymOf(spec),
    benchClose: benchCloseAt(built.input.calendar, built.input.bench, decisionDate),
  };
  // 重放的成交与拒单（D68「重放成交留底」）：上线日起；拒单是 S05 的最近样例
  const names = built.input.securities;
  const replayTrades = [
    ...result.trades
      .filter((x) => x.date >= t.startDate)
      .map((x) => ({
        date: x.date,
        code: x.code,
        name: names.get(x.code)?.name ?? null,
        side: x.side,
        kind: "fill",
        price: x.price,
        shares: x.shares,
        amount: x.amount,
        fee: x.fee,
        reason: x.reason,
        rejectReason: null,
      })),
    ...(result.diagnostics?.samples ?? [])
      .filter((x) => x.date >= t.startDate)
      .map((x) => ({
        date: x.date,
        code: x.code,
        name: names.get(x.code)?.name ?? null,
        side: x.side,
        kind: "reject",
        price: null,
        shares: null,
        // 没成交的金额
        amount: x.wantValue - x.filledValue,
        fee: null,
        reason: null,
        rejectReason: x.reason,
      })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  sqlite
    .transaction(() => {
      const snap = writePlanSnapshot(env().app, draft, ctx.log);
      if (drift.cause !== "none") {
        appendLedger(env().app, {
          userId: t.userId,
          kind: "replay_drift",
          subjectType: "tracking",
          subjectId: t.id,
          asOf: settleDate,
          payloadTable: "inline",
          payload: {
            firstDrift: replay.firstDrift,
            navDrift: replay.navDrift,
            benchDrift: replay.benchDrift,
            maxNavDiff: replay.maxNavDiff,
            cause: drift.cause,
            dataVersion: built.dataVersion.id,
          },
        });
      }
      db.delete(trackingTrades).where(eq(trackingTrades.trackingId, t.id)).run();
      replayTrades.forEach((x, i) =>
        db
          .insert(trackingTrades)
          .values({ trackingId: t.id, seq: i + 1, ...x })
          .run(),
      );
      db.delete(trackingDays).where(eq(trackingDays.trackingId, t.id)).run();
      for (const p of series) {
        db.insert(trackingDays)
          .values({
            trackingId: t.id,
            date: p.date,
            nav: p.nav,
            bench: p.bench,
            cash: p.cash,
            positions: p.positions,
          })
          .run();
      }
      db.delete(trackingOrders).where(eq(trackingOrders.trackingId, t.id)).run();
      for (const o of result.final.pending) {
        db.insert(trackingOrders)
          .values({
            trackingId: t.id,
            planDate,
            code: o.code,
            name: o.name,
            side: o.side,
            reason: o.reason,
            snapshotId: snap.snapshotId,
          })
          .run();
      }
      db.update(trackings)
        .set({
          lastDate: last.date,
          lastNav: last.nav,
          lastBench: last.bench,
          deviationPct,
          summary: {
            dataAsOf: built.dataVersion.asOf,
            equity: result.final.equity,
            cash: result.final.cash,
            positions: result.final.positions,
            exposure: result.final.exposure ?? null,
            metrics: {
              totalReturn: result.metrics.totalReturn,
              excessTotal: result.metrics.excessTotal,
              maxDrawdown: result.metrics.maxDrawdown,
              buys: result.metrics.buys,
            },
            checks: result.checks.filter((c) => !BACKTEST_ONLY_CHECKS.has(c.id)),
            // 按绝对净值在基准回测扇形里的分位（0–100，低于 5 分位记 5、高于 95 记 95）；基准没有扇形或超过一年时为 null
            navFanPercentile: navFan?.percentile ?? null,
            navFanBand: navFan?.band ?? null,
            // 指纹（下一晚归因用）：前缀按今晚的最后结算日、「执行日 ≤ cut」算
            engineVersion: result.engineVersion,
            dataVersion: built.dataVersion.id,
            execHash,
            inputHash: full.inputHash,
            prefixHash: prefixTonight,
            hashVersion: HASH_VERSION,
            lastDate: settleDate,
            replay: { ...replay, at: latest, cause: drift.cause, causeText: drift.text },
            lastSnapshotId: snap.snapshotId,
          },
        })
        .where(eq(trackings.id, t.id))
        .run();
    })
    .immediate();
}

function specHashOfVersion(versionId: string): string {
  const r = env()
    .app.db.select({ h: strategyVersions.specHash })
    .from(strategyVersions)
    .where(eq(strategyVersions.id, versionId))
    .get();
  if (!r) throw new Error(`策略版本 ${versionId} 不存在`);
  return r.h;
}

/**
 * 上线前的首日计划（D68 精简快照）：明日买入 = 选股解释的前 N 名（原因 entry，带名次、得分、分位、因子值），
 * 估算仓位 = min(1 / N, 单只上限)，其余估算为空；输入指纹为空，版次只看解释指纹与数据版本。
 */
async function settleWaiting(
  t: TrackingRow,
  spec: StrategySpec,
  latest: string,
  ctx: JobContext,
): Promise<void> {
  const { db, sqlite } = env().app;
  const { wh } = env();
  const market = spec.market;
  const decisionDate = await lastTradingDay(wh, market, latest);
  const dv = await latestDataVersion(wh, market);
  const top = spec.rank?.top ?? 10;
  const explain =
    spec.mode === "rules" && spec.rank
      ? await explainSelection(wh, spec, decisionDate, { limit: top })
      : null;
  const candidates = explain?.candidates ?? [];
  // 计划日：决策日之后的下一个交易日；上线日更晚（数据还没更新到上线日前一天）时就是上线日
  const next = nextTradingDay(market, decisionDate);
  const planDate = t.startDate > next.date ? t.startDate : next.date;
  const benchSym = benchSymOf(spec);
  const benchClose = await wh.scalar<number>(
    `SELECT close FROM index_bars WHERE sym = $s AND date = $d::DATE`,
    { s: benchSym, d: decisionDate },
  );
  const items = entryItems(spec, candidates);
  const draft: PlanDraft = {
    content: {
      trackingId: t.id,
      decisionDate,
      planDate,
      versionId: t.versionId,
      specHash: specHashOfVersion(t.versionId),
      regime: explain?.regime ?? null,
      exposureCurrent: null,
      exposureNext: null,
      equity: t.capital,
      cash: t.capital,
      positions: [],
      candidates,
    },
    items,
    userId: t.userId,
    planDateBasis: next.basis,
    dataVersion: dv.id,
    dataAsOf: dv.asOf,
    engineVersion: ENGINE_VERSION,
    execHash: sha256Canonical(resolveExec(t.execConfig)),
    inputHash: null,
    hashVersion: HASH_VERSION,
    explainHash: explain ? explainHashOf(explain, candidates) : null,
    band: bandOf(spec),
    benchSym,
    benchClose: benchClose ?? null,
  };
  sqlite
    .transaction(() => {
      const snap = writePlanSnapshot(env().app, draft, ctx.log);
      db.delete(trackingOrders).where(eq(trackingOrders.trackingId, t.id)).run();
      for (const it of items) {
        db.insert(trackingOrders)
          .values({
            trackingId: t.id,
            planDate,
            code: it.code,
            name: it.name,
            side: "buy",
            reason: "entry",
            snapshotId: snap.snapshotId,
          })
          .run();
      }
      db.update(trackings)
        .set({
          summary: {
            waitingForStart: true,
            planFor: t.startDate,
            dataAsOf: dv.asOf,
            lastSnapshotId: snap.snapshotId,
          },
        })
        .where(eq(trackings.id, t.id))
        .run();
    })
    .immediate();
}

export async function settleMarket(
  market: Market,
  ctx: JobContext,
): Promise<{ settled: number; failed: number }> {
  const { db } = env().app;
  // 只结算到最新的已提交版本（D60）：失败那晚写进来的数据不用
  const latest = await committedAsOf(env().wh, market);
  if (!latest) return { settled: 0, failed: 0 };
  const active = db
    .select()
    .from(trackings)
    .where(and(eq(trackings.status, "active"), eq(trackings.market, market)))
    .all();
  let settled = 0;
  let failed = 0;
  for (let i = 0; i < active.length; i++) {
    const t = active[i]!;
    ctx.progress(i / Math.max(1, active.length), `结算 ${i + 1}/${active.length}`);
    try {
      await settleOne(t, latest, ctx);
      settled++;
    } catch (e) {
      failed++;
      ctx.log(`跟踪 ${t.id} 结算失败：${e instanceof Error ? e.message : e}`);
    }
  }
  return { settled, failed };
}

export async function settleJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const market = (ctx.job.payload.market === "HK" ? "HK" : "A") as Market;
  return settleMarket(market, ctx);
}

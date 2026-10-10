/**
 * 向前跟踪（spec §7）：上线只能经草稿确认（D4、验收 6）；结算由 worker 每晚从起点重放（D13）。
 */
import {
  addDays,
  BENCHMARKS,
  benchmarkOf,
  defaultExec,
  describeExec,
  isLegacyExec,
  type Metrics,
  resolveExec,
  todayCN,
  weekday,
} from "@ivan/core";
import {
  drafts,
  newId,
  runs,
  strategies,
  trackingDays,
  trackingOrders,
  trackings,
  unpackJson,
} from "@ivan/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { SeriesPoint } from "@ivan/core";
import { env } from "../env.ts";
import { AppError, notFound } from "../lib/errors.ts";
import { downsample, latestDoneRun } from "./runs.ts";
import { getVersion, trackingExec } from "./strategies.ts";

/** 下一个工作日（节假日由 worker 按真实交易日历顺延） */
function nextWeekday(d: string): string {
  let x = addDays(d, 1);
  while (weekday(x) === 0 || weekday(x) === 6) x = addDays(x, 1);
  return x;
}

export function proposeTracking(
  userId: string,
  input: { versionId: string; capital?: number; threadId?: string },
) {
  const { db } = env().app;
  const { strategy, version } = getVersion(userId, input.versionId);
  if (version.spec.mode === "signals") {
    throw new AppError(400, "信号模式的策略 v1 只能回测，不能上线跟踪");
  }
  const capital = input.capital ?? 1_000_000;
  if (!(capital >= 10_000)) throw new AppError(400, "跟踪资金至少 1 万");
  const baseline = latestDoneRun(userId, version.id);
  const startDate = nextWeekday(todayCN());
  const market = version.spec.market;
  const exec = trackingExec(userId, baseline?.id ?? null, market);
  // 基准回测是旧口径、而这个市场已经有更新的口径（R2 起）：上线后会沿用旧口径，卡片上说清楚
  const legacyBaseline = !!baseline && isLegacyExec(exec) && !isLegacyExec(defaultExec(market));
  const draftId = newId("d_");
  db.insert(drafts)
    .values({
      id: draftId,
      userId,
      kind: "tracking",
      strategyId: strategy.id,
      baseVersionId: version.id,
      payload: { versionId: version.id, startDate, capital, baselineRunId: baseline?.id ?? null },
      summary:
        `上线跟踪「${strategy.name}」v${version.n}，${startDate} 起，模拟资金 ${capital.toLocaleString()}` +
        `，成交假设：${describeExec(exec)}` +
        (legacyBaseline ? "。基准回测用的是旧口径，上线后也会沿用；建议先按新口径重新回测" : ""),
      threadId: input.threadId ?? null,
    })
    .run();
  return {
    draftId,
    strategyId: strategy.id,
    strategyName: strategy.name,
    versionId: version.id,
    versionN: version.n,
    startDate,
    capital,
    baselineRunId: baseline?.id ?? null,
    hasBaseline: !!baseline,
    exec,
    execText: describeExec(exec),
    legacyBaseline,
  };
}

type TrackingRow = typeof trackings.$inferSelect;

/** 跟踪锁定的成交假设与中文摘要；读不懂时给 null，不让整页报错 */
function execView(stored: unknown) {
  try {
    const e = resolveExec(stored);
    return { execConfig: e, execText: describeExec(e) };
  } catch {
    return { execConfig: null, execText: null };
  }
}

function view(t: TrackingRow, name: string) {
  const excess = t.lastNav && t.lastBench ? t.lastNav / t.lastBench - 1 : null;
  return {
    id: t.id,
    strategyId: t.strategyId,
    strategyName: name,
    versionId: t.versionId,
    market: t.market,
    startDate: t.startDate,
    capital: t.capital,
    status: t.status,
    lastDate: t.lastDate,
    nav: t.lastNav,
    bench: t.lastBench,
    excess,
    deviationPct: t.deviationPct,
    baselineRunId: t.baselineRunId,
    summary: t.summary,
    ...execView(t.execConfig),
    createdAt: t.createdAt,
  };
}

export function listTrackings(userId: string, opts: { activeOnly?: boolean } = {}) {
  const { db } = env().app;
  const rows = db
    .select({ t: trackings, name: strategies.name })
    .from(trackings)
    .innerJoin(strategies, eq(strategies.id, trackings.strategyId))
    .where(
      opts.activeOnly
        ? and(eq(trackings.userId, userId), eq(trackings.status, "active"))
        : eq(trackings.userId, userId),
    )
    .orderBy(desc(trackings.createdAt))
    .all();
  return rows.map((r) => view(r.t, r.name));
}

function own(userId: string, id: string) {
  const { db } = env().app;
  const r = db
    .select({ t: trackings, name: strategies.name })
    .from(trackings)
    .innerJoin(strategies, eq(strategies.id, trackings.strategyId))
    .where(and(eq(trackings.id, id), eq(trackings.userId, userId)))
    .get();
  if (!r) throw notFound("跟踪");
  return r;
}

export function getTracking(userId: string, id: string) {
  const { db } = env().app;
  const r = own(userId, id);
  const days = db
    .select()
    .from(trackingDays)
    .where(eq(trackingDays.trackingId, id))
    .orderBy(asc(trackingDays.date))
    .all();
  const orders = db.select().from(trackingOrders).where(eq(trackingOrders.trackingId, id)).all();
  return { ...view(r.t, r.name), days, orders };
}

export function stopTracking(userId: string, id: string): void {
  const { db } = env().app;
  own(userId, id);
  db.update(trackings)
    .set({ status: "stopped", stoppedAt: Date.now() })
    .where(eq(trackings.id, id))
    .run();
}

/**
 * 看板主图：回测段（上线日之前）+ 跟踪段（上线日起），同一条曲线（spec §11）。
 * 回测段按上线日之前的净值归一，跟踪段接在回测段末端上，两段都给基准。
 */
export function trackingChart(userId: string, id: string) {
  const { db } = env().app;
  const t = getTracking(userId, id);
  let backtest: SeriesPoint[] = [];
  if (t.baselineRunId) {
    const run = db.select().from(runs).where(eq(runs.id, t.baselineRunId)).get();
    const series = unpackJson<SeriesPoint[]>(run?.seriesZ) ?? [];
    backtest = downsample(
      series.filter((p) => p.date < t.startDate),
      300,
    );
  }
  const last = backtest.at(-1);
  const baseNav = last?.nav ?? 1;
  const baseBench = last?.bench ?? 1;
  const tracking = t.days.map((d) => ({
    date: d.date,
    nav: d.nav * baseNav,
    bench: d.bench * baseBench,
  }));
  // 看板多策略对照图要按基准分组画灰线：带上市场与基准名
  const { version } = getVersion(userId, t.versionId);
  return {
    id: t.id,
    strategyName: t.strategyName,
    market: t.market,
    benchLabel: BENCHMARKS[benchmarkOf(version.spec)].label,
    startDate: t.startDate,
    backtest: backtest.map((p) => ({ date: p.date, nav: p.nav, bench: p.bench })),
    tracking,
  };
}

/** 各跟踪的「今日信号」（下一个交易日计划买卖） */
export function todaySignals(userId: string) {
  const { db } = env().app;
  const active = listTrackings(userId, { activeOnly: true });
  if (!active.length) return [];
  const orders = db
    .select()
    .from(trackingOrders)
    .where(
      inArray(
        trackingOrders.trackingId,
        active.map((t) => t.id),
      ),
    )
    .all();
  return active
    .map((t) => ({
      trackingId: t.id,
      strategyName: t.strategyName,
      market: t.market,
      orders: orders.filter((o) => o.trackingId === t.id),
    }))
    .filter((x) => x.orders.length);
}

export function baselineHeadline(runId: string | null) {
  if (!runId) return null;
  const { db } = env().app;
  const r = db.select({ metrics: runs.metrics }).from(runs).where(eq(runs.id, runId)).get();
  const m = r?.metrics as Metrics | undefined;
  return m
    ? { cagr: m.cagr, excessCagr: m.excessCagr, maxDrawdown: m.maxDrawdown, sharpe: m.sharpe }
    : null;
}

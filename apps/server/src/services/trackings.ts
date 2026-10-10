/**
 * 向前跟踪（spec §7）：上线只能经草稿确认（D4、验收 6）；结算由 worker 每晚从起点重放（D13）。
 */
import {
  BENCHMARKS,
  benchmarkOf,
  defaultExec,
  describeExec,
  formatPlanReason,
  isLegacyExec,
  type Metrics,
  nextTradingDay,
  resolveExec,
  todayCN,
  type TrackingHealth,
  type Verdict,
} from "@ivan/core";
import { trackingVerdict } from "@ivan/engine";
import {
  appendLedger,
  drafts,
  newId,
  planItems,
  planSnapshots,
  runs,
  strategies,
  trackingDays,
  trackingOrders,
  trackings,
  unpackJson,
} from "@ivan/db";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import type { SeriesPoint } from "@ivan/core";
import { env } from "../env.ts";
import { AppError, notFound } from "../lib/errors.ts";
import type { DataStatus } from "./dashboard.ts";
import { latestSnapshot } from "./plans.ts";
import { downsample, latestDoneRun } from "./runs.ts";
import { getVersion, trackingExec } from "./strategies.ts";

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
  const market = version.spec.market;
  // 上线日 = 下一个交易日：按交易所休市日表推算（D68），表里没有那一年时按工作日
  const startDate = nextTradingDay(market, todayCN()).date;
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

/** 判词与它的依据（D70）：看板、跟踪页、对话共用 */
export interface VerdictView {
  verdict: Verdict;
  health: TrackingHealth | null;
  /** 最近一次结算失败（成功后清掉） */
  lastError: { date: string; message: string } | null;
}

/** 判词要看这个市场今天的状态与最新提交的数据日（D78）：都来自 /internal/data-status；worker 没跑时只看状态与失败 */
export function verdictView(
  t: { market: string; lastDate: string | null; summary: unknown },
  data: Pick<DataStatus, "markets">,
): VerdictView {
  const m = data.markets.find((x) => x.market === t.market);
  const s = (t.summary ?? {}) as {
    health?: TrackingHealth;
    lastError?: { date: string; message: string };
  };
  return {
    verdict: trackingVerdict(t.summary, t.lastDate, {
      marketDay: m?.day ?? null,
      committedAsOf: m?.asOf ?? null,
    }),
    health: s.health ?? null,
    lastError: s.lastError ?? null,
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

/** 跟踪行与策略名；不是自己的一律 404 */
export function own(userId: string, id: string) {
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

/** 跟踪用的策略版本（只查归属，不读逐日记录） */
export function trackingVersionId(userId: string, id: string): string {
  return own(userId, id).t.versionId;
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
  // 明日计划的依据（D68）：最近一晚的最新一版快照；早于账本的跟踪没有
  const plan = latestSnapshot(userId, id);
  return { ...view(r.t, r.name), days, orders, plan };
}

/**
 * 停止跟踪并记账本（D68 tracking_stop）：页面上的停止弹窗与对话卡片确认都走这里。已经停了的再停 409，不重复记账。
 */
export function stopTracking(userId: string, id: string, reason?: string | null): void {
  const h = env().app;
  const { db } = h;
  const t = own(userId, id).t;
  if (t.status !== "active") throw new AppError(409, "这个跟踪已经停了");
  const days = db
    .select({ n: count() })
    .from(trackingDays)
    .where(eq(trackingDays.trackingId, id))
    .get()!.n;
  const at = Date.now();
  const why = reason?.trim() ? reason.trim().slice(0, 500) : null;
  h.sqlite
    .transaction(() => {
      db.update(trackings)
        .set({ status: "stopped", stoppedAt: at })
        .where(eq(trackings.id, id))
        .run();
      appendLedger(h, {
        userId,
        kind: "tracking_stop",
        subjectType: "tracking",
        subjectId: id,
        asOf: t.lastDate,
        payloadTable: "inline",
        payload: {
          reason: why,
          days,
          excess: t.lastNav && t.lastBench ? t.lastNav / t.lastBench - 1 : null,
          beatBacktestPct: t.deviationPct,
          at,
        },
      });
    })
    .immediate();
}

/** 对话提议停止跟踪（D68）：只写一条 tracking_stop 草稿，用户在卡片上确认才停 */
export function proposeStopTracking(
  userId: string,
  input: { trackingId: string; reason?: string | null; threadId?: string },
) {
  const { db } = env().app;
  const r = own(userId, input.trackingId);
  if (r.t.status !== "active") throw new AppError(409, "这个跟踪已经停了");
  const days = db
    .select({ n: count() })
    .from(trackingDays)
    .where(eq(trackingDays.trackingId, r.t.id))
    .get()!.n;
  const excess = r.t.lastNav && r.t.lastBench ? r.t.lastNav / r.t.lastBench - 1 : null;
  const reason = input.reason?.trim() ? input.reason.trim().slice(0, 500) : null;
  const draftId = newId("d_");
  db.insert(drafts)
    .values({
      id: draftId,
      userId,
      kind: "tracking_stop",
      strategyId: r.t.strategyId,
      baseVersionId: r.t.versionId,
      payload: { trackingId: r.t.id, reason },
      summary: `停止跟踪「${r.name}」` + (reason ? `，原因：${reason}` : ""),
      threadId: input.threadId ?? null,
    })
    .run();
  return {
    draftId,
    trackingId: r.t.id,
    strategyName: r.name,
    startDate: r.t.startDate,
    days,
    excess,
    reason,
  };
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

/** 各跟踪的「今日信号」（下一个交易日计划买卖），带快照里的细分原因（D68） */
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
  const snapIds = [...new Set(orders.map((o) => o.snapshotId).filter((x): x is string => !!x))];
  const items = snapIds.length
    ? db
        .select({ i: planItems, band: planSnapshots.band })
        .from(planItems)
        .innerJoin(planSnapshots, eq(planSnapshots.id, planItems.snapshotId))
        .where(inArray(planItems.snapshotId, snapIds))
        .all()
    : [];
  const detail = new Map(
    items.map(({ i, band }) => [
      `${i.snapshotId}|${i.code}|${i.side}`,
      { reasonText: formatPlanReason(i, band), rank: i.rank, estWeight: i.estWeight },
    ]),
  );
  return active
    .map((t) => ({
      trackingId: t.id,
      strategyName: t.strategyName,
      market: t.market,
      orders: orders
        .filter((o) => o.trackingId === t.id)
        .map((o) => ({
          ...o,
          reasonText:
            detail.get(`${o.snapshotId}|${o.code}|${o.side}`)?.reasonText ??
            formatPlanReason(
              { ...o, reasonDetail: null, rank: null, failedConditions: null },
              null,
            ),
          rank: detail.get(`${o.snapshotId}|${o.code}|${o.side}`)?.rank ?? null,
        })),
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

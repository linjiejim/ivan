/**
 * 计划快照（D68）：每晚结算写下的明日计划与依据，按（跟踪, 决策日）分版次只追加；这里只读。
 * 归属按跟踪的 user_id 校验，不是自己的一律 404。计划结果回看（D79）按提交过的数据由 worker 计算。
 */
import { formatPlanReason, isDateStr, PLAN_CAUSE_TEXT, type PlanCause } from "@ivan/core";
import {
  planItems,
  planItemsOf,
  planSnapshots,
  type PlanSnapshotRow,
  trackings,
  unpackJson,
} from "@ivan/db";
import { and, asc, count, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { env } from "../env.ts";
import { AppError, notFound } from "../lib/errors.ts";
import { worker } from "../lib/worker-client.ts";
import { cachedDataStatus } from "./runs.ts";

export interface PlanItemView {
  seq: number;
  code: string;
  name: string | null;
  side: string;
  reason: string;
  reasonDetail: string | null;
  reasonText: string;
  rank: number | null;
  score: number | null;
  estPrice: number | null;
  estShares: number | null;
  estWeight: number | null;
  refClose: number | null;
  curWeight: number | null;
  failedConditions: string[] | null;
  factors: Record<string, number | string | boolean | null> | null;
  termPct: Record<string, number> | null;
}

function ownTracking(userId: string, trackingId: string) {
  const t = env()
    .app.db.select({ id: trackings.id, market: trackings.market })
    .from(trackings)
    .where(and(eq(trackings.id, trackingId), eq(trackings.userId, userId)))
    .get();
  if (!t) throw notFound("跟踪");
  return t;
}

function meta(s: PlanSnapshotRow) {
  return {
    id: s.id,
    trackingId: s.trackingId,
    decisionDate: s.decisionDate,
    planDate: s.planDate,
    planDateBasis: s.planDateBasis,
    edition: s.edition,
    cause: s.cause,
    causeText: PLAN_CAUSE_TEXT[s.cause as PlanCause] ?? s.cause,
    versionId: s.versionId,
    specHash: s.specHash,
    dataVersion: s.dataVersion,
    dataAsOf: s.dataAsOf,
    engineVersion: s.engineVersion,
    execHash: s.execHash,
    inputHash: s.inputHash,
    hashVersion: s.hashVersion,
    explainHash: s.explainHash,
    explainVersion: s.explainVersion,
    regime: s.regime,
    exposure:
      s.exposureCurrent === null && s.exposureNext === null
        ? null
        : { current: s.exposureCurrent, next: s.exposureNext },
    equity: s.equity,
    cash: s.cash,
    band: s.band,
    benchSym: s.benchSym,
    benchClose: s.benchClose,
    contentHash: s.contentHash,
    createdAt: s.createdAt,
  };
}

export type PlanSnapshotMeta = ReturnType<typeof meta>;

function itemViews(s: PlanSnapshotRow): PlanItemView[] {
  return planItemsOf(env().app, s.id).map((i) => ({
    seq: i.seq,
    code: i.code,
    name: i.name,
    side: i.side,
    reason: i.reason,
    reasonDetail: i.reasonDetail,
    reasonText: formatPlanReason(i, s.band),
    rank: i.rank,
    score: i.score,
    estPrice: i.estPrice,
    estShares: i.estShares,
    estWeight: i.estWeight,
    refClose: i.refClose,
    curWeight: i.curWeight,
    failedConditions: i.failedConditions,
    factors: i.factors,
    termPct: i.termPct,
  }));
}

/** 一版快照的完整内容：元信息、计划项、持仓与候选名单 */
function full(s: PlanSnapshotRow) {
  return {
    ...meta(s),
    items: itemViews(s),
    positions: unpackJson<unknown[]>(s.positionsZ) ?? [],
    candidates: unpackJson<unknown[]>(s.candidatesZ) ?? [],
  };
}

export type PlanSnapshotView = ReturnType<typeof full>;

/** 一个跟踪的快照列表（按决策日倒序、同日按版次）；只给元信息与计划项条数 */
export function listSnapshots(
  userId: string,
  trackingId: string,
  range: { from?: string; to?: string } = {},
) {
  ownTracking(userId, trackingId);
  for (const d of [range.from, range.to]) {
    if (d && !isDateStr(d)) throw new AppError(400, "日期格式要是 YYYY-MM-DD");
  }
  const { db } = env().app;
  const rows = db
    .select()
    .from(planSnapshots)
    .where(
      and(
        eq(planSnapshots.trackingId, trackingId),
        range.from ? gte(planSnapshots.decisionDate, range.from) : undefined,
        range.to ? lte(planSnapshots.decisionDate, range.to) : undefined,
      ),
    )
    .orderBy(desc(planSnapshots.decisionDate), asc(planSnapshots.edition))
    .all();
  const counts = new Map(
    rows.length
      ? db
          .select({ id: planItems.snapshotId, n: count() })
          .from(planItems)
          .where(
            inArray(
              planItems.snapshotId,
              rows.map((r) => r.id),
            ),
          )
          .groupBy(planItems.snapshotId)
          .all()
          .map((x) => [x.id, x.n])
      : [],
  );
  return rows.map((r) => ({ ...meta(r), itemCount: counts.get(r.id) ?? 0 }));
}

export function getSnapshot(userId: string, id: string): PlanSnapshotView {
  const s = env().app.db.select().from(planSnapshots).where(eq(planSnapshots.id, id)).get();
  // 别人的快照和不存在一样：404
  if (!s || s.userId !== userId) throw notFound("计划快照");
  ownTracking(userId, s.trackingId);
  return full(s);
}

/**
 * 找一份快照：给日期时按决策日找，找不到再按计划日（成交日）找，都没有就取那天之前最近的一晚；
 * 不给日期取最近一晚。版次缺省 = 最新一版（第 1 版是当晚看到的，edition = 1）。
 */
export function findSnapshot(
  userId: string,
  trackingId: string,
  o: { date?: string; edition?: number } = {},
): PlanSnapshotView | null {
  ownTracking(userId, trackingId);
  if (o.date && !isDateStr(o.date)) throw new AppError(400, "日期格式要是 YYYY-MM-DD");
  const { db } = env().app;
  const pick = (cond: ReturnType<typeof eq> | undefined) =>
    db
      .select({ decisionDate: planSnapshots.decisionDate })
      .from(planSnapshots)
      .where(and(eq(planSnapshots.trackingId, trackingId), cond))
      .orderBy(desc(planSnapshots.decisionDate))
      .get()?.decisionDate;
  const decisionDate = o.date
    ? (pick(eq(planSnapshots.decisionDate, o.date)) ??
      pick(eq(planSnapshots.planDate, o.date)) ??
      pick(lte(planSnapshots.decisionDate, o.date)))
    : pick(undefined);
  if (!decisionDate) return null;
  const s = db
    .select()
    .from(planSnapshots)
    .where(
      and(
        eq(planSnapshots.trackingId, trackingId),
        eq(planSnapshots.decisionDate, decisionDate),
        o.edition ? eq(planSnapshots.edition, o.edition) : undefined,
      ),
    )
    .orderBy(desc(planSnapshots.edition))
    .get();
  return s ? full(s) : null;
}

/** 跟踪最近一晚的最新一版（跟踪页「明日计划」用）；还没有快照时 null */
export function latestSnapshot(userId: string, trackingId: string): PlanSnapshotView | null {
  return findSnapshot(userId, trackingId);
}

/**
 * 某只股票在某晚第 1 版计划里的记录（D68：第 1 版是当晚用户看到的）。不在计划项里但在候选名单里时给候选名次；都不在为 null。
 * decisionDate 精确匹配决策日；给 planDate（成交日）时也按计划日找。
 */
export function planRecordFor(
  userId: string,
  trackingId: string,
  code: string,
  o: { decisionDate?: string | null; planDate?: string | null },
) {
  ownTracking(userId, trackingId);
  const { db } = env().app;
  const first = (cond: ReturnType<typeof eq>) =>
    db
      .select()
      .from(planSnapshots)
      .where(and(eq(planSnapshots.trackingId, trackingId), eq(planSnapshots.edition, 1), cond))
      .get();
  const s =
    (o.decisionDate ? first(eq(planSnapshots.decisionDate, o.decisionDate)) : undefined) ??
    (o.planDate ? first(eq(planSnapshots.planDate, o.planDate)) : undefined);
  if (!s) return null;
  const base = {
    snapshotId: s.id,
    edition: s.edition,
    decisionDate: s.decisionDate,
    planDate: s.planDate,
    dataAsOf: s.dataAsOf,
    dataVersion: s.dataVersion,
    band: s.band,
  };
  const item = itemViews(s).find((i) => i.code === code);
  if (item) {
    return {
      ...base,
      inPlan: true as const,
      side: item.side,
      reason: item.reason,
      reasonDetail: item.reasonDetail,
      reasonText: item.reasonText,
      rank: item.rank,
      score: item.score,
      termPct: item.termPct,
      failedConditions: item.failedConditions,
      factors: item.factors,
      estWeight: item.estWeight,
    };
  }
  const cand = (
    unpackJson<
      Array<{
        code: string;
        rank: number;
        score: number;
        termPct: Record<string, number>;
        factors: Record<string, number | string | boolean | null>;
      }>
    >(s.candidatesZ) ?? []
  ).find((c) => c.code === code);
  if (!cand) return null;
  return {
    ...base,
    inPlan: false as const,
    side: null,
    reason: null,
    reasonDetail: null,
    reasonText: `候选第 ${cand.rank} 名，没进计划`,
    rank: cand.rank,
    score: cand.score,
    termPct: cand.termPct,
    failedConditions: null,
    factors: cand.factors,
    estWeight: null,
  };
}

export type PlanRecord = NonNullable<ReturnType<typeof planRecordFor>>;

export interface PlanOutcome {
  code: string;
  side: string;
  fillDate: string | null;
  fillOpen: number | null;
  estPrice: number | null;
  slipVsEst: number | null;
  ret5: number | null;
  ret20: number | null;
  excess5: number | null;
  excess20: number | null;
}

/** 计划结果回看的缓存：同一版计划、同一个已提交的数据版本，结果不会变（不计额度，所以不让反复刷新压到 worker） */
const outcomesCache = new Map<string, { asOf: string | null; outcomes: PlanOutcome[] }>();
const OUTCOMES_CACHE_MAX = 500;

/** 计划结果回看（D79）：这一版每条计划项后来怎么样；只用提交过的数据，不计额度（只有主人能看、最多 50 条） */
export async function planOutcomes(userId: string, id: string) {
  const s = getSnapshot(userId, id);
  const t = ownTracking(userId, s.trackingId);
  if (!s.benchSym) return { asOf: null, outcomes: [] as PlanOutcome[] };
  return cachedPlanOutcomes(s, t.market);
}

/**
 * 一版计划的结果回看，按（快照、市场当前提交的数据版本）缓存：/api/plans/:id/outcomes 与回溯页的 plan-on 共用。
 * 拿不到数据版本（worker 不在）时不缓存。
 */
export async function cachedPlanOutcomes(
  s: PlanSnapshotView,
  market: string,
): Promise<{ asOf: string | null; outcomes: PlanOutcome[] }> {
  const dv =
    (await cachedDataStatus())?.markets?.find((m) => m.market === market)?.dataVersion ?? null;
  const key = dv === null ? null : `${s.id}:${dv}`;
  const hit = key ? outcomesCache.get(key) : undefined;
  if (hit) return hit;
  const r = await fetchOutcomes(s, market);
  if (key) {
    if (outcomesCache.size >= OUTCOMES_CACHE_MAX)
      outcomesCache.delete(outcomesCache.keys().next().value!);
    outcomesCache.set(key, r);
  }
  return r;
}

function fetchOutcomes(s: PlanSnapshotView, market: string) {
  return worker.post<{ asOf: string | null; outcomes: PlanOutcome[] }>("/internal/plan-outcomes", {
    market,
    benchSym: s.benchSym,
    items: s.items.slice(0, 50).map((i) => ({
      code: i.code,
      side: i.side,
      estPrice: i.estPrice,
      decisionDate: s.decisionDate,
      benchClose: s.benchClose,
    })),
  });
}

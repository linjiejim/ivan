/**
 * 计划快照的内容与内容指纹（D68）。
 *
 * 内容 = 用户当晚看到的计划本身：跟踪、决策日、计划日、策略版本与指纹、大盘状态、仓位系数、资产与现金、持仓、候选名单、计划项。
 * 不含 id、created_at、版次、原因，也不含数据 / 引擎 / 成交假设 / 指纹口径版本——同样的计划换了版本号不算变了；
 * 那些指纹单独存着，只用来判断「为什么变了」。写入与校验都走 planContent，库里读回来的行重算出同一个指纹。
 */
import { sha256Canonical } from "@ivan/core/node";
import { asc, eq } from "drizzle-orm";
import type { AppDbHandle } from "./index.ts";
import { planItems, planSnapshots } from "./schema.ts";
import { unpackJson } from "./util.ts";

type FactorValue = number | string | boolean | null;

/** 一条计划项（不含快照 id） */
export interface PlanItemContent {
  seq: number;
  code: string;
  name: string | null;
  side: string;
  reason: string;
  reasonDetail: string | null;
  rank: number | null;
  score: number | null;
  estPrice: number | null;
  estShares: number | null;
  estWeight: number | null;
  refClose: number | null;
  curWeight: number | null;
  failedConditions: string[] | null;
  factors: Record<string, FactorValue> | null;
  termPct: Record<string, number> | null;
}

/** 参与内容指纹的快照字段（持仓与候选名单是解压后的值） */
export interface PlanSnapshotContent {
  trackingId: string;
  decisionDate: string;
  planDate: string;
  versionId: string;
  specHash: string;
  regime: string | null;
  exposureCurrent: number | null;
  exposureNext: number | null;
  equity: number | null;
  cash: number | null;
  positions: unknown;
  candidates: unknown;
}

const n = (x: number | null | undefined): number | null =>
  x === null || x === undefined || !Number.isFinite(x) ? null : x;

/** 规范化后的内容：缺省值一律 null，和库里读回来的一致 */
export function planContent(s: PlanSnapshotContent, items: readonly PlanItemContent[]) {
  return {
    trackingId: s.trackingId,
    decisionDate: s.decisionDate,
    planDate: s.planDate,
    versionId: s.versionId,
    specHash: s.specHash,
    regime: s.regime ?? null,
    exposure:
      s.exposureCurrent === null && s.exposureNext === null
        ? null
        : { current: n(s.exposureCurrent), next: n(s.exposureNext) },
    equity: n(s.equity),
    cash: n(s.cash),
    positions: s.positions ?? null,
    candidates: s.candidates ?? null,
    items: [...items]
      .sort((a, b) => a.seq - b.seq)
      .map((i) => ({
        seq: i.seq,
        code: i.code,
        name: i.name ?? null,
        side: i.side,
        reason: i.reason,
        reasonDetail: i.reasonDetail ?? null,
        rank: n(i.rank),
        score: n(i.score),
        estPrice: n(i.estPrice),
        estShares: n(i.estShares),
        estWeight: n(i.estWeight),
        refClose: n(i.refClose),
        curWeight: n(i.curWeight),
        failedConditions: i.failedConditions ?? null,
        factors: i.factors ?? null,
        termPct: i.termPct ?? null,
      })),
  };
}

export function planContentHash(s: PlanSnapshotContent, items: readonly PlanItemContent[]): string {
  return sha256Canonical(planContent(s, items));
}

export type PlanSnapshotRow = typeof planSnapshots.$inferSelect;
export type PlanItemRow = typeof planItems.$inferSelect;

/** 库里的一行快照 → 参与指纹的内容 */
export function snapshotContentOf(r: PlanSnapshotRow): PlanSnapshotContent {
  return {
    trackingId: r.trackingId,
    decisionDate: r.decisionDate,
    planDate: r.planDate,
    versionId: r.versionId,
    specHash: r.specHash,
    regime: r.regime,
    exposureCurrent: r.exposureCurrent,
    exposureNext: r.exposureNext,
    equity: r.equity,
    cash: r.cash,
    positions: unpackJson<unknown>(r.positionsZ),
    candidates: unpackJson<unknown>(r.candidatesZ),
  };
}

/** 一个快照的计划项（按 seq） */
export function planItemsOf(h: AppDbHandle, snapshotId: string): PlanItemRow[] {
  return h.db
    .select()
    .from(planItems)
    .where(eq(planItems.snapshotId, snapshotId))
    .orderBy(asc(planItems.seq))
    .all();
}

/** 按库里存的快照与计划项重算内容指纹（账本校验用）；快照不存在时 null */
export function planContentHashOf(h: AppDbHandle, snapshotId: string): string | null {
  const s = h.db.select().from(planSnapshots).where(eq(planSnapshots.id, snapshotId)).get();
  if (!s) return null;
  try {
    return planContentHash(snapshotContentOf(s), planItemsOf(h, snapshotId));
  } catch {
    return null;
  }
}

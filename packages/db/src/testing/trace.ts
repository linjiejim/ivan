/**
 * 测试用：按 server / worker 的写法给一个用户写一段账本——本跟踪的上线、计划（快照 + 计划项）、状态变化、重放差异，
 * 另一个跟踪的上线与一版简报（导出时只能给哈希）。
 */
import { appendLedger } from "../ledger.ts";
import { writeBriefEdition } from "../briefs.ts";
import { planContentHash, type PlanItemContent, type PlanSnapshotContent } from "../plans.ts";
import { planItems, planSnapshots } from "../schema.ts";
import { packJson } from "../util.ts";
import type { AppDbHandle } from "../index.ts";

export const TRACE_ITEM: PlanItemContent = {
  seq: 1,
  code: "600002.SH",
  name: "股2",
  side: "buy",
  reason: "rebalance",
  reasonDetail: "entry",
  rank: 1,
  score: 0.9,
  estPrice: 11.01,
  estShares: 4500,
  estWeight: 0.05,
  refClose: 11,
  curWeight: null,
  failedConditions: null,
  factors: { pe_ttm: 5.5, industry: "银行" },
  termPct: { pe_ttm: 0.95 },
};

export function insertTraceSnapshot(
  h: AppDbHandle,
  o: {
    userId: string;
    trackingId: string;
    decisionDate: string;
    planDate: string;
    edition?: number;
    cause?: string;
    items?: PlanItemContent[];
  },
): { id: string; seq: number } {
  const id = `ps_${o.trackingId}_${o.decisionDate}_${o.edition ?? 1}`;
  const items = o.items ?? [TRACE_ITEM];
  const content: PlanSnapshotContent = {
    trackingId: o.trackingId,
    decisionDate: o.decisionDate,
    planDate: o.planDate,
    versionId: "v_1",
    specHash: "abcd",
    regime: null,
    exposureCurrent: null,
    exposureNext: null,
    equity: 1_000_000,
    cash: 12_345.67,
    positions: [{ code: "600001.SH", weight: 0.5 }],
    candidates: [{ code: "600002.SH", rank: 1, factors: { pe_ttm: 5.5 } }],
  };
  const contentHash = planContentHash(content, items);
  h.db
    .insert(planSnapshots)
    .values({
      id,
      trackingId: o.trackingId,
      userId: o.userId,
      decisionDate: o.decisionDate,
      planDate: o.planDate,
      planDateBasis: "holiday_table",
      edition: o.edition ?? 1,
      cause: o.cause ?? "initial",
      versionId: content.versionId,
      specHash: content.specHash,
      dataVersion: 9,
      dataAsOf: o.decisionDate,
      engineVersion: "1.2.0",
      execHash: "e".repeat(64),
      inputHash: "i".repeat(64),
      hashVersion: 2,
      explainHash: "x".repeat(64),
      equity: content.equity,
      cash: content.cash,
      band: 15,
      benchSym: "csi300_tr",
      benchClose: 3500,
      positionsZ: packJson(content.positions),
      candidatesZ: packJson(content.candidates),
      contentHash,
    })
    .run();
  for (const it of items)
    h.db
      .insert(planItems)
      .values({ ...it, snapshotId: id })
      .run();
  const le = appendLedger(h, {
    userId: o.userId,
    kind: "plan",
    subjectType: "tracking",
    subjectId: o.trackingId,
    asOf: o.decisionDate,
    payloadTable: "plan_snapshots",
    payloadId: id,
    payloadHash: contentHash,
  });
  return { id, seq: le.seq };
}

/** 一段典型的账本：t_own 的 6 条（上线、计划、简报夹在中间、状态变化、第 2 版计划、重放差异）与 t_other 的上线 */
export function seedTrace(h: AppDbHandle, userId = "u_1") {
  const tracking = (id: string, extra: Record<string, unknown> = {}) =>
    appendLedger(h, {
      userId,
      kind: "tracking_start",
      subjectType: "tracking",
      subjectId: id,
      asOf: "2026-03-02",
      payloadTable: "inline",
      payload: { trackingId: id, capital: 1_000_000, startDate: "2026-03-02", ...extra },
    });
  tracking("t_own", { exec: { v: 1 } });
  tracking("t_other", { secret: "别的跟踪的内容" });
  insertTraceSnapshot(h, {
    userId,
    trackingId: "t_own",
    decisionDate: "2026-03-19",
    planDate: "2026-03-20",
  });
  writeBriefEdition(h, userId, {
    date: "2026-03-19",
    facts: { trackings: [{ id: "t_other", name: "简报里的另一个跟踪" }] },
    content: "简报正文：另一个跟踪今天 +1.0%",
    model: null,
    grounding: null,
  });
  appendLedger(h, {
    userId,
    kind: "health_transition",
    subjectType: "tracking",
    subjectId: "t_own",
    asOf: "2026-03-19",
    payloadTable: "inline",
    payload: { from: "warming_up", to: "active", reason: "first_reading", inputs: { days: 20 } },
  });
  insertTraceSnapshot(h, {
    userId,
    trackingId: "t_own",
    decisionDate: "2026-03-19",
    planDate: "2026-03-20",
    edition: 2,
    cause: "data_revision",
    items: [{ ...TRACE_ITEM, rank: 2 }],
  });
  appendLedger(h, {
    userId,
    kind: "replay_drift",
    subjectType: "tracking",
    subjectId: "t_own",
    asOf: "2026-03-23",
    payloadTable: "inline",
    payload: {
      firstDrift: "2026-03-18",
      navDrift: 3,
      benchDrift: 0,
      cause: "data",
      maxNavDiff: 0.001,
    },
  });
}

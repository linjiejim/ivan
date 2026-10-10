/**
 * 计划快照的内容指纹（D68）：只看计划本身，不看 id、版次、原因、时间与各种版本号；库里读回来重算出同一个指纹。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  openAppDb,
  packJson,
  planContentHash,
  planContentHashOf,
  type PlanItemContent,
  planItems,
  planSnapshots,
  type PlanSnapshotContent,
} from "./index.ts";

const snap: PlanSnapshotContent = {
  trackingId: "t_1",
  decisionDate: "2026-03-19",
  planDate: "2026-03-23",
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
const item: PlanItemContent = {
  seq: 1,
  code: "600002.SH",
  name: "股1",
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

describe("计划快照内容指纹", () => {
  it("不看 id、版次、原因、时间与各种版本号；名次变了就变", () => {
    const h = planContentHash(snap, [item]);
    // 多余字段（id、版次、原因、数据与引擎版本）不参与
    const withExtras = {
      ...snap,
      id: "ps_x",
      edition: 2,
      cause: "data_revision",
      createdAt: 1,
      dataVersion: 9,
      engineVersion: "9.9.9",
      execHash: "e",
      inputHash: "i",
      hashVersion: 7,
    } as PlanSnapshotContent;
    expect(planContentHash(withExtras, [{ ...item, snapshotId: "ps_y" } as PlanItemContent])).toBe(
      h,
    );
    // undefined 与 null 一样（库里读回来都是 null）
    expect(planContentHash(snap, [{ ...item, curWeight: undefined as unknown as null }])).toBe(h);
    expect(planContentHash(snap, [{ ...item, rank: 2 }])).not.toBe(h);
    expect(planContentHash({ ...snap, cash: 12_345.68 }, [item])).not.toBe(h);
    expect(
      planContentHash(
        { ...snap, candidates: [{ code: "600002.SH", rank: 1, factors: { pe_ttm: 5.6 } }] },
        [item],
      ),
    ).not.toBe(h);
  });

  it("写进库再读回来重算：同一个指纹；快照与计划项也不许改", () => {
    const dir = mkdtempSync(join(tmpdir(), "ivan-plans-"));
    const h = openAppDb(join(dir, "app.sqlite"));
    try {
      h.db
        .insert(planSnapshots)
        .values({
          id: "ps_1",
          trackingId: snap.trackingId,
          userId: "u1",
          decisionDate: snap.decisionDate,
          planDate: snap.planDate,
          planDateBasis: "holiday_table",
          edition: 1,
          cause: "initial",
          versionId: snap.versionId,
          specHash: snap.specHash,
          engineVersion: "1.2.0",
          execHash: "e",
          hashVersion: 2,
          equity: snap.equity,
          cash: snap.cash,
          positionsZ: packJson(snap.positions),
          candidatesZ: packJson(snap.candidates),
          contentHash: planContentHash(snap, [item]),
        })
        .run();
      h.db
        .insert(planItems)
        .values({ ...item, snapshotId: "ps_1" })
        .run();
      expect(planContentHashOf(h, "ps_1")).toBe(planContentHash(snap, [item]));
      expect(planContentHashOf(h, "ps_none")).toBeNull();
      expect(() => h.sqlite.prepare(`UPDATE plan_snapshots SET edition = 2`).run()).toThrow(
        /append-only/,
      );
      expect(() => h.sqlite.prepare(`DELETE FROM plan_snapshots`).run()).toThrow(/append-only/);
    } finally {
      h.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

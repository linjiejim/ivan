/**
 * 结算写计划快照与决策账本（D68）：同样的数据重跑不加版次；没改名次的因子修订加第 2 版（数据修订），第 1 版不动；
 * 卖出的细分原因（掉出前 N 名 / 不再满足）；上线前的精简快照；重放的成交与拒单整体重写；账本链校验通过。
 */
import { StrategySpecSchema } from "@ivan/core";
import type { EtlContext } from "@ivan/data";
import { beginDataVersion, commitDataVersion } from "@ivan/data";
import { seedSyntheticMarket } from "@ivan/data/testing";
import {
  ledgerEntries,
  planItems,
  planSnapshots,
  trackingOrders,
  trackings,
  trackingTrades,
  verifyUserChain,
} from "@ivan/db";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeJobContext, makeTestEnv, seedTracking } from "../testing/harness.ts";
import { settleMarket } from "./settle.ts";

const spec = StrategySpecSchema.parse({
  name: "周度低估值",
  market: "A",
  filters: [{ factor: "roe_ttm", op: ">=", value: 10 }],
  rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 2 },
  rebalance: { every: "week", buffer: 1 },
});

const FRI = "2026-03-06"; // 下周一（03-09）调仓
const CODES = ["600001.SH", "600002.SH", "600003.SH", "600004.SH", "600005.SH", "600006.SH"];

/**
 * 03-02（周一）… 03-06（周五）。前四天市盈率 5…10、ROE 都是 15：上线（03-03 开盘）买入 S1、S2。
 * 周五：S1 市盈率升到 8.5（排第 3，掉出前 2 名）、S2 的 ROE 跌到 5（不再满足筛选）→ 下周一卖出 S1、S2，买 S3、S4。
 * limitUp：上线日 S1 一字涨停开盘（买不进）。
 */
async function seed(o: { limitUp?: boolean } = {}) {
  await seedSyntheticMarket(t.env.wh, {
    market: "A",
    start: "2026-03-02",
    days: 5,
    stocks: CODES.map((code, k) => ({
      code,
      name: `股${k + 1}`,
      close: (i: number) => (o.limitUp && k === 0 && i >= 1 ? 11 : 10),
      open: (i: number) => (o.limitUp && k === 0 && i >= 1 ? 11 : 10),
      factors: (i: number) => ({
        pe_ttm: i === 4 && k === 0 ? 8.5 : 5 + k,
        roe_ttm: i === 4 && k === 1 ? 5 : 15,
      }),
    })),
  });
}

let t: Awaited<ReturnType<typeof makeTestEnv>>;
beforeEach(async () => {
  t = await makeTestEnv();
});
afterEach(() => t.cleanup());

async function settle() {
  const ctx = fakeJobContext("settle", { market: "A" });
  const r = await settleMarket("A", ctx);
  expect(r).toEqual({ settled: 1, failed: 0 });
  return ctx;
}

const snapshots = (trackingId: string) =>
  t.env.app.db
    .select()
    .from(planSnapshots)
    .where(eq(planSnapshots.trackingId, trackingId))
    .orderBy(asc(planSnapshots.edition))
    .all();
const itemsOf = (id: string) =>
  t.env.app.db
    .select()
    .from(planItems)
    .where(eq(planItems.snapshotId, id))
    .orderBy(asc(planItems.seq))
    .all();
const ledger = (kind?: string) =>
  t.env.app.db
    .select()
    .from(ledgerEntries)
    .where(kind ? and(eq(ledgerEntries.userId, "u_test"), eq(ledgerEntries.kind, kind)) : undefined)
    .all();

describe("计划快照（D68）", () => {
  it("每晚一份快照、一条 plan 账本；同样的数据重跑什么都不加；明日计划指向这份快照", async () => {
    await seed();
    const { trackingId } = seedTracking(t.env.app, { spec, startDate: "2026-03-03" });
    await settle();
    await settle();
    const snaps = snapshots(trackingId);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      decisionDate: FRI,
      planDate: "2026-03-09",
      planDateBasis: "holiday_table",
      edition: 1,
      cause: "initial",
      inputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      explainHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      dataAsOf: FRI,
      band: 2,
      benchSym: "csi300_tr",
    });
    expect(snaps[0]!.benchClose).toBeCloseTo(1000 * 1.0005 ** 4, 6);
    expect(ledger("plan")).toHaveLength(1);
    expect(ledger("plan")[0]).toMatchObject({
      payloadTable: "plan_snapshots",
      payloadId: snaps[0]!.id,
      payloadHash: snaps[0]!.contentHash,
      asOf: FRI,
    });
    const orders = t.env.app.db
      .select()
      .from(trackingOrders)
      .where(eq(trackingOrders.trackingId, trackingId))
      .all();
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((o) => o.snapshotId === snaps[0]!.id)).toBe(true);
    const tr = t.env.app.db.select().from(trackings).where(eq(trackings.id, trackingId)).get()!;
    expect((tr.summary as { lastSnapshotId: string }).lastSnapshotId).toBe(snaps[0]!.id);
    expect(verifyUserChain(t.env.app, "u_test")).toMatchObject({ ok: true, checked: 1 });
  });

  it("卖出的细分原因：掉出前 2 名（带名次）/ 不再满足筛选（带条件）；买入带名次、得分、分位、因子值与估算", async () => {
    await seed();
    const { trackingId } = seedTracking(t.env.app, { spec, startDate: "2026-03-03" });
    await settle();
    const [snap] = snapshots(trackingId);
    const items = itemsOf(snap!.id);
    const by = new Map(items.map((i) => [i.code, i]));
    expect(by.get("600001.SH")).toMatchObject({
      side: "sell",
      reason: "rebalance",
      reasonDetail: "ranked_out",
      rank: 3,
      failedConditions: [],
    });
    expect(by.get("600002.SH")).toMatchObject({
      side: "sell",
      reason: "filtered",
      reasonDetail: "failed_filter",
      rank: null,
    });
    expect(by.get("600002.SH")!.failedConditions![0]).toMatch(/ROE/);
    const buy = by.get("600003.SH")!;
    expect(buy).toMatchObject({ side: "buy", reason: "entry", reasonDetail: "entry", rank: 1 });
    expect(buy.score).toEqual(expect.any(Number));
    expect(buy.termPct).toEqual({ pe_ttm: expect.any(Number) });
    expect(buy.factors).toMatchObject({ pe_ttm: 7, roe_ttm: 15 });
    expect(buy.estWeight).toBeGreaterThan(0);
    expect(buy.refClose).toBe(10);
    expect(by.get("600004.SH")).toMatchObject({ side: "buy", rank: 2 });
    // 明天调仓：候选名单（前 top × buffer + top = 4 名）一起存下
    expect(snap!.candidatesZ).not.toBeNull();
  });

  it("没改名次的因子修订（没选中的候选）+ 新数据版本 → 第 2 版、数据修订；第 1 版原样不动", async () => {
    await seed();
    const { trackingId } = seedTracking(t.env.app, { spec, startDate: "2026-03-03" });
    await settle();
    const [first] = snapshots(trackingId);
    const firstItems = itemsOf(first!.id);
    // S5（市盈率 9，候选第 4 名，没被选中）修订成 9.2：仍在 S1（8.5）与 S6（10）之间，名次不变
    const ctx = { wh: t.env.wh } as EtlContext;
    const id = await beginDataVersion(ctx, "A", "daily");
    await t.env.wh.run(
      `UPDATE factors_daily SET pe_ttm = 9.2 WHERE code = '600005.SH' AND date = $d::DATE`,
      { d: FRI },
    );
    await commitDataVersion(ctx, id, { status: "ok" });
    await settle();
    const snaps = snapshots(trackingId);
    expect(snaps.map((s) => [s.edition, s.cause])).toEqual([
      [1, "initial"],
      [2, "data_revision"],
    ]);
    expect(snaps[0]).toEqual(first);
    expect(itemsOf(first!.id)).toEqual(firstItems);
    expect(snaps[1]!.dataVersion).toBe(id);
    expect(snaps[1]!.explainHash).not.toBe(first!.explainHash);
    // 计划项本身没变（名次、方向都一样）
    expect(itemsOf(snaps[1]!.id).map((i) => [i.code, i.side, i.rank])).toEqual(
      firstItems.map((i) => [i.code, i.side, i.rank]),
    );
    expect(ledger("plan")).toHaveLength(2);
    expect(verifyUserChain(t.env.app, "u_test")).toMatchObject({ ok: true, checked: 2 });
  });

  it("上线前：精简快照（前 N 名买入、估算仓位 = min(1 / N, 单只上限)、输入指纹为空）；同样的数据重跑不加版次", async () => {
    await seed();
    const { trackingId } = seedTracking(t.env.app, { spec, startDate: "2026-03-09" });
    await settle();
    await settle();
    const snaps = snapshots(trackingId);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      decisionDate: FRI,
      planDate: "2026-03-09",
      planDateBasis: "holiday_table",
      inputHash: null,
      explainHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      dataVersion: expect.any(Number),
      equity: 1_000_000,
    });
    const items = itemsOf(snaps[0]!.id);
    expect(items.map((i) => [i.code, i.side, i.reasonDetail, i.rank, i.estWeight])).toEqual([
      ["600003.SH", "buy", "entry", 1, 0.5],
      ["600004.SH", "buy", "entry", 2, 0.5],
    ]);
    expect(items[0]).toMatchObject({
      estPrice: null,
      estShares: null,
      curWeight: null,
      refClose: 10,
    });
    expect(items[0]!.factors).toMatchObject({ pe_ttm: 7 });
    const orders = t.env.app.db
      .select()
      .from(trackingOrders)
      .where(eq(trackingOrders.trackingId, trackingId))
      .all();
    expect(orders.map((o) => [o.code, o.planDate, o.snapshotId])).toEqual([
      ["600003.SH", "2026-03-09", snaps[0]!.id],
      ["600004.SH", "2026-03-09", snaps[0]!.id],
    ]);
    expect(ledger("plan")).toHaveLength(1);
  });

  it("重放的成交与拒单整体重写进 tracking_trades（旧口径的涨停拒单也在）；漂移记一条 replay_drift", async () => {
    await seed({ limitUp: true });
    const { trackingId } = seedTracking(t.env.app, { spec, startDate: "2026-03-03" });
    await settle();
    const rows = () =>
      t.env.app.db
        .select()
        .from(trackingTrades)
        .where(eq(trackingTrades.trackingId, trackingId))
        .orderBy(asc(trackingTrades.seq))
        .all();
    const first = rows();
    expect(first.find((r) => r.kind === "reject")).toMatchObject({
      date: "2026-03-03",
      code: "600001.SH",
      side: "buy",
      rejectReason: "limit_up",
      price: null,
    });
    expect(first.find((r) => r.kind === "fill")).toMatchObject({
      date: "2026-03-03",
      code: "600002.SH",
      side: "buy",
      reason: "entry",
      name: "股2",
    });
    expect(first.every((r) => r.date >= "2026-03-03")).toBe(true);
    // 重跑：整体重写，不重复
    await settle();
    expect(rows()).toEqual(first);
    expect(ledger("replay_drift")).toHaveLength(0);

    // 过去的收盘被修订 → 重放漂移，记一条 replay_drift（内容在账本行里）
    await t.env.wh.run(`UPDATE bars_daily SET close = close * 1.05 WHERE date = '2026-03-04'`);
    await settle();
    const drift = ledger("replay_drift");
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ payloadTable: "inline", subjectId: trackingId });
    expect(verifyUserChain(t.env.app, "u_test").ok).toBe(true);
  });
});

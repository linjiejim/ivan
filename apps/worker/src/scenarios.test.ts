/**
 * 用户路径的场景测试（验收 17）：从种好的行情出发，走完真实的任务代码，再断言模型实际看到的摘要。
 * （a）跟踪一晚结算 → 计划快照 → get_plan 的模型输出带原因、名次与数据版本。
 */
import { planForModel } from "@ivan/ai";
import { StrategySpecSchema } from "@ivan/core";
import { seedSyntheticMarket } from "@ivan/data/testing";
import { planItemsOf, planSnapshots } from "@ivan/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settleMarket } from "./jobs/settle.ts";
import { fakeJobContext, makeTestEnv, seedTracking } from "./testing/harness.ts";

let t: Awaited<ReturnType<typeof makeTestEnv>>;
beforeEach(async () => {
  t = await makeTestEnv();
});
afterEach(() => t.cleanup());

describe("场景（验收 17）", () => {
  it("（a）跟踪一晚结算 → 计划快照 → get_plan 的模型输出带原因文字、名次与数据版本", async () => {
    // 03-02 … 03-06：周五 S1 市盈率升到 9.5（掉出前 2 名），下周一调仓
    await seedSyntheticMarket(t.env.wh, {
      market: "A",
      start: "2026-03-02",
      days: 5,
      stocks: ["600001.SH", "600002.SH", "600003.SH", "600004.SH"].map((code, k) => ({
        code,
        name: `股${k + 1}`,
        close: () => 10,
        factors: (i: number) => ({ pe_ttm: i === 4 && k === 0 ? 9.5 : 5 + k }),
      })),
    });
    const spec = StrategySpecSchema.parse({
      name: "周度低估值",
      market: "A",
      rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 2 },
      rebalance: { every: "week", buffer: 1 },
    });
    const { trackingId } = seedTracking(t.env.app, { spec, startDate: "2026-03-03" });
    const r = await settleMarket("A", fakeJobContext("settle", { market: "A" }));
    expect(r).toEqual({ settled: 1, failed: 0 });

    const snap = t.env.app.db
      .select()
      .from(planSnapshots)
      .where(eq(planSnapshots.trackingId, trackingId))
      .get()!;
    const m = planForModel(snap, planItemsOf(t.env.app, snap.id));
    expect(m).toMatchObject({
      decisionDate: "2026-03-06",
      planDate: "2026-03-09",
      planDateBasis: "holiday_table",
      edition: 1,
      cause: "initial",
      dataAsOf: "2026-03-06",
      dataVersion: expect.any(Number),
    });
    const sell = m.items.find((i) => i.side === "sell")!;
    expect(sell).toMatchObject({ name: "股1", reasonText: "掉出前 2 名（排第 4）", rank: 4 });
    const buy = m.items.find((i) => i.side === "buy")!;
    expect(buy).toMatchObject({ name: "股3", reasonText: "建仓", rank: 2 });
    expect(buy.keyFactors[0]).toMatchObject({ value: 7, unit: "x" });
    expect(m.note).toMatch(/不构成投资建议/);
  });
});

/**
 * 用户路径的场景测试（验收 17）：从种好的行情出发，走完真实的任务代码，再断言模型实际看到的摘要。
 * （a）跟踪一晚结算 → 计划快照 → get_plan 的模型输出带原因、名次与数据版本。
 * （b）默认成交假设的小盘回测 → get_run 的模型输出带容量提示、区间与行情来源。
 */
import { planForModel, type RunModelInput, runForModel } from "@ivan/ai";
import { defaultExec, type Metrics, StrategySpecSchema } from "@ivan/core";
import { specHashOf } from "@ivan/core/node";
import { seedSyntheticMarket } from "@ivan/data/testing";
import { newId, planItemsOf, planSnapshots, runs, strategies, strategyVersions } from "@ivan/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backtestJob } from "./jobs/backtest.ts";
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

  it("（b）默认成交假设的小盘回测 → get_run 的模型输出带容量提示、超额区间与行情来源", async () => {
    await seedSyntheticMarket(t.env.wh, {
      market: "A",
      start: "2025-01-06",
      days: 120,
      stocks: ["600001.SH", "600002.SH", "600003.SH", "600004.SH"].map((code, k) => ({
        code,
        name: `股${k}`,
        close: (i: number) => 10 + k + Math.sin(i / 5 + k) * 2,
        // 股0、股2 是小盘：20 日均成交额只有 50 万
        factors: (i: number) => ({
          pe_ttm: 5 + ((i + k * 7) % 11),
          turnover_20d: k % 2 === 0 ? 0.005 : 5 + k,
          volatility_60d: 30,
        }),
      })),
    });
    // 行级来源：前段东财、后段腾讯报价，其余来源未记录
    await t.env.wh.run(`UPDATE bars_daily SET src = 'em' WHERE date < DATE '2025-04-01'`);
    await t.env.wh.run(`UPDATE bars_daily SET src = 'txq' WHERE date >= DATE '2025-06-01'`);
    const spec = StrategySpecSchema.parse({
      name: "小盘低估值",
      market: "A",
      rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 2 },
    });
    const strategyId = newId("s_");
    const versionId = newId("v_");
    const runId = newId("r_");
    const { db } = t.env.app;
    db.insert(strategies)
      .values({
        id: strategyId,
        userId: "u_test",
        name: spec.name,
        market: "A",
        currentVersionId: versionId,
      })
      .run();
    db.insert(strategyVersions)
      .values({
        id: versionId,
        strategyId,
        n: 1,
        spec: spec as unknown as Record<string, unknown>,
        specHash: specHashOf(spec),
      })
      .run();
    db.insert(runs)
      .values({
        id: runId,
        userId: "u_test",
        strategyId,
        versionId,
        kind: "backtest",
        params: {
          start: "2025-02-03",
          end: "2025-06-20",
          capital: 1_000_000,
          oosMonths: 0,
          exec: defaultExec("A"),
          priorVersions: 0,
        },
      })
      .run();
    await backtestJob(fakeJobContext("backtest", { runId }));
    const r = db.select().from(runs).where(eq(runs.id, runId)).get()!;
    expect(r.status).toBe("done");
    // 和 server getRun 给模型的字段同形
    const input: RunModelInput = {
      id: r.id,
      status: r.status,
      error: r.error,
      dataAsOf: r.dataAsOf,
      engineVersion: r.engineVersion,
      cardHash: r.cardHash,
      exec: defaultExec("A"),
      metrics: r.metrics as unknown as Metrics,
      segments: r.segments as unknown as RunModelInput["segments"],
      diagnostics: r.diagnostics as unknown as RunModelInput["diagnostics"],
      validation: r.validation as unknown as RunModelInput["validation"],
      checks: r.checks as unknown as RunModelInput["checks"],
      card: r.card,
    };
    const m = runForModel(input) as Record<string, unknown> & {
      checks: Array<{ title: string; detail: string }>;
      dataSources: { bySource: Record<string, number>; rows: number; gapDays: number };
    };
    expect(m.checks.some((c) => /容量/.test(c.title))).toBe(true);
    expect(m.capacityEstimate).toEqual(expect.any(Number));
    const ci = m.excessCagrCi as [number, number];
    expect(ci).toHaveLength(2);
    expect(ci[0]).toBeLessThanOrEqual(ci[1]);
    expect(Object.keys(m.dataSources.bySource).sort()).toEqual(["东方财富", "来源未记录", "腾讯"]);
    const shares = Object.values(m.dataSources.bySource);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    expect(m.dataSources.rows).toBeGreaterThan(0);
    expect(m.dataSources.gapDays).toBe(0);
  });
});

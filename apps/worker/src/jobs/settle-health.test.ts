/**
 * 结算写健康度（D70）：上线第一晚按历史补算、同一晚重跑不加读数也不记账本、第二晚只加一个读数；
 * 某个跟踪结算失败时错误写进 summary.lastError，其余跟踪照常结算，下次成功后清掉。
 */
import { type SeriesPoint, StrategySpecSchema } from "@ivan/core";
import { seedSyntheticMarket } from "@ivan/data/testing";
import {
  ledgerEntries,
  newId,
  packJson,
  runs,
  strategyVersions,
  trackingHealth,
  trackings,
  unpackJson,
  verifyUserChain,
} from "@ivan/db";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeJobContext, makeTestEnv, seedTracking } from "../testing/harness.ts";
import { settleMarket } from "./settle.ts";

const spec = StrategySpecSchema.parse({
  name: "低估值",
  market: "A",
  rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 2 },
});

const CODES = ["600001.SH", "600002.SH", "600003.SH", "600004.SH"];
const DAYS = 40;

let t: Awaited<ReturnType<typeof makeTestEnv>>;
let calendar: string[];
beforeEach(async () => {
  t = await makeTestEnv();
  ({ calendar } = await seedSyntheticMarket(t.env.wh, {
    market: "A",
    start: "2026-03-02",
    days: DAYS,
    stocks: CODES.map((code, k) => ({
      code,
      name: `股${k + 1}`,
      close: (i: number) => 10 + k + Math.sin(i / 3 + k),
      factors: () => ({ pe_ttm: 5 + k }),
    })),
  }));
  // 第一晚只提交到倒数第二天，第二晚再多一天
  await t.env.wh.run(`UPDATE data_versions SET as_of = $d::DATE`, { d: calendar.at(-2)! });
});
afterEach(() => t.cleanup());

/** 一条基准回测：每天跑赢基准 0.5%，任何窗口的超额都远高于跟踪 */
function baselineRun(trackingId: string): string {
  const id = newId("r_");
  const series: SeriesPoint[] = Array.from({ length: 300 }, (_, i) => ({
    date: `2024-01-${String(i).padStart(3, "0")}`,
    nav: 1.006 ** i,
    bench: 1.001 ** i,
    cash: 0,
    positions: 2,
  }));
  const tr = t.env.app.db.select().from(trackings).where(eq(trackings.id, trackingId)).get()!;
  t.env.app.db
    .insert(runs)
    .values({
      id,
      userId: tr.userId,
      strategyId: tr.strategyId,
      versionId: tr.versionId,
      params: {},
      status: "done",
      seriesZ: packJson(series),
      metrics: { maxDrawdown: -0.1 } as Record<string, unknown>,
    })
    .run();
  t.env.app.db
    .update(trackings)
    .set({ baselineRunId: id })
    .where(eq(trackings.id, trackingId))
    .run();
  return id;
}

const healthRows = (trackingId: string) =>
  t.env.app.db
    .select()
    .from(trackingHealth)
    .where(eq(trackingHealth.trackingId, trackingId))
    .orderBy(asc(trackingHealth.date))
    .all();
const transitions = (trackingId: string) =>
  t.env.app.db
    .select()
    .from(ledgerEntries)
    .where(
      and(eq(ledgerEntries.subjectId, trackingId), eq(ledgerEntries.kind, "health_transition")),
    )
    .orderBy(asc(ledgerEntries.seq))
    .all();
const summaryOf = (trackingId: string) =>
  t.env.app.db.select().from(trackings).where(eq(trackings.id, trackingId)).get()!
    .summary as Record<string, unknown> & {
    health?: { state: string; signal: string; version: number };
    lastError?: { date: string; message: string };
    staleCodes?: string[];
  };

async function settle(expected = { settled: 1, failed: 0 }) {
  const ctx = fakeJobContext("settle", { market: "A" });
  expect(await settleMarket("A", ctx)).toEqual(expected);
  return ctx;
}

describe("结算写健康度（D70）", () => {
  it("第一晚：落后很久的跟踪按历史补算，状态直接是偏离或可能失效，记一条「按历史补算」", async () => {
    const { trackingId } = seedTracking(t.env.app, { spec, startDate: calendar[1]! });
    baselineRun(trackingId);
    await settle();
    const rows = healthRows(trackingId);
    const lastDate = calendar.at(-2)!;
    // 上线日（日历第 2 天）到倒数第二天共 DAYS - 2 个点，第 20 天起每天一个读数
    expect(rows.length).toBe(DAYS - 2 - 20);
    expect(rows.every((r) => (r.inputs as { backfilled?: boolean }).backfilled)).toBe(true);
    expect(rows.at(-1)!.date).toBe(lastDate);
    expect(rows.some((r) => r.state === "active")).toBe(false);
    const s = summaryOf(trackingId);
    expect(["monitoring", "decayed"]).toContain(s.health!.state);
    expect(s.health!.version).toBe(1);
    expect(s.staleCodes).toEqual([]);
    const tr = transitions(trackingId);
    expect(tr).toHaveLength(1);
    const payload = unpackJson<{ from: string; to: string; reason: string }>(tr[0]!.payloadZ)!;
    expect(payload).toMatchObject({
      from: "warming_up",
      to: s.health!.state,
      reason: "按历史补算",
    });
    expect(tr[0]!.asOf).toBe(lastDate);

    // 同一晚重跑（管理员重跑或自动重跑）：不加读数、不判变化、不记账本，沿用那一行的状态
    await settle();
    expect(healthRows(trackingId)).toHaveLength(rows.length);
    expect(transitions(trackingId)).toHaveLength(1);
    expect(summaryOf(trackingId).health).toEqual(s.health);

    // 第二晚：多一天数据，只加一个读数
    await t.env.wh.run(`UPDATE data_versions SET as_of = $d::DATE`, { d: calendar.at(-1)! });
    await settle();
    const after = healthRows(trackingId);
    expect(after).toHaveLength(rows.length + 1);
    expect(after.at(-1)!.date).toBe(calendar.at(-1)!);
    expect((after.at(-1)!.inputs as { backfilled?: boolean }).backfilled).toBeUndefined();
    expect(verifyUserChain(t.env.app, "u_test").ok).toBe(true);
  });

  it("不到 20 天的跟踪：写样本不足的读数，状态是观察期，不记账本", async () => {
    const { trackingId } = seedTracking(t.env.app, { spec, startDate: calendar.at(-10)! });
    baselineRun(trackingId);
    await settle();
    const rows = healthRows(trackingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ signal: "insufficient_data", state: "warming_up" });
    expect(summaryOf(trackingId).health).toMatchObject({ state: "warming_up" });
    expect(transitions(trackingId)).toHaveLength(0);
  });

  it("一个跟踪的策略版本不合法：错误写进 summary.lastError，其余跟踪照常结算；修好后清掉", async () => {
    const good = seedTracking(t.env.app, { spec, startDate: calendar[1]! });
    const bad = seedTracking(t.env.app, { spec, startDate: calendar[1]! });
    await settle({ settled: 2, failed: 0 });
    const original = t.env.app.db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.id, bad.versionId))
      .get()!.spec;
    t.env.app.db
      .update(strategyVersions)
      .set({ spec: { name: "坏的" } })
      .where(eq(strategyVersions.id, bad.versionId))
      .run();
    await settle({ settled: 1, failed: 1 });
    const s = summaryOf(bad.trackingId);
    expect(s.lastError).toEqual({
      date: calendar.at(-2)!,
      message: `跟踪 ${bad.trackingId} 的策略版本不合法`,
    });
    // 只合并了 lastError，上一晚的摘要还在
    expect(s.health).toBeDefined();
    expect(summaryOf(good.trackingId).lastError).toBeUndefined();

    t.env.app.db
      .update(strategyVersions)
      .set({ spec: original })
      .where(eq(strategyVersions.id, bad.versionId))
      .run();
    await settle({ settled: 2, failed: 0 });
    expect(summaryOf(bad.trackingId).lastError).toBeUndefined();
  });
});

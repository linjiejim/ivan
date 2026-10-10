/**
 * 结算的指纹与漂移归因（D57）：每晚存前缀指纹，下一晚按上一晚的最后结算日重算再比；
 * 「周五休市、周四是本周最后一个交易日」的边界上前缀也稳定。
 */
import { StrategySpecSchema } from "@ivan/core";
import { HASH_VERSION } from "@ivan/data";
import { seedSyntheticMarket } from "@ivan/data/testing";
import { trackingDays, trackings } from "@ivan/db";
import { ENGINE_VERSION } from "@ivan/engine";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeJobContext, makeTestEnv, seedTracking } from "../testing/harness.ts";
import { settleMarket } from "./settle.ts";

const spec = StrategySpecSchema.parse({
  name: "周度低估值",
  market: "A",
  rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 2 },
  rebalance: { every: "week", buffer: 1 },
});

const THU = "2026-03-19"; // 周五 03-20 休市
const MON = "2026-03-23";

let t: Awaited<ReturnType<typeof makeTestEnv>>;
let trackingId: string;
beforeEach(async () => {
  t = await makeTestEnv();
  await seedSyntheticMarket(t.env.wh, {
    market: "A",
    start: "2026-03-02",
    days: 16, // 03-02 … 03-23，去掉 03-20
    skipDates: ["2026-03-20"],
    stocks: ["600001.SH", "600002.SH", "600003.SH", "600004.SH"].map((code, k) => ({
      code,
      name: `股${k}`,
      close: (i: number) => 10 + k + i * 0.1 * (k + 1),
      factors: (i: number) => ({ pe_ttm: 5 + ((i + k * 3) % 7) }),
    })),
  });
  // 第一晚：数据只到周四（周一的因子还没算出来、版本也只提交到周四）
  await t.env.wh.run(
    `CREATE TEMP TABLE held AS SELECT * FROM factors_daily WHERE date > $d::DATE`,
    {
      d: THU,
    },
  );
  await t.env.wh.run(`DELETE FROM factors_daily WHERE date > $d::DATE`, { d: THU });
  // 结算只读到已提交的截至日（D60）：第一晚提交到周四
  await t.env.wh.run(`UPDATE data_versions SET as_of = $d::DATE`, { d: THU });
  ({ trackingId } = seedTracking(t.env.app, { spec, startDate: "2026-03-03" }));
});
afterEach(() => t.cleanup());

type Summary = Record<string, unknown> & {
  replay: { cause: string; causeText: string; navDrift: number; firstDrift: string | null };
};
const summary = () =>
  t.env.app.db.select().from(trackings).where(eq(trackings.id, trackingId)).get()!
    .summary as Summary;

async function settle() {
  const ctx = fakeJobContext("settle", { market: "A" });
  const r = await settleMarket("A", ctx);
  expect(r).toEqual({ settled: 1, failed: 0 });
  return ctx;
}

/** 第二晚：周一的数据到了 */
async function nextNight() {
  await t.env.wh.run(`INSERT INTO factors_daily SELECT * FROM held`);
  await t.env.wh.run(
    `INSERT INTO data_versions (id, market, as_of, kind, status)
     VALUES (nextval('data_version_seq'), 'A', $d::DATE, 'daily', 'ok')`,
    { d: MON },
  );
}

describe("结算指纹与漂移归因", () => {
  it("每晚存下指纹；多一个交易日（跨过休市的周五）重放一致 → none", async () => {
    await settle();
    const s1 = summary();
    expect(s1).toMatchObject({
      engineVersion: ENGINE_VERSION,
      hashVersion: HASH_VERSION,
      lastDate: THU,
    });
    expect(s1.dataVersion).toEqual(expect.any(Number));
    expect(String(s1.execHash)).toHaveLength(64);
    expect(String(s1.inputHash)).toHaveLength(64);
    expect(String(s1.prefixHash)).toHaveLength(64);
    expect(s1.replay.cause).toBe("none");

    await nextNight();
    await settle();
    const s2 = summary();
    expect(s2.lastDate).toBe(MON);
    expect(s2.replay).toMatchObject({ cause: "none", navDrift: 0 });
    expect(s2.prefixHash).not.toBe(s1.prefixHash);
  });

  it("前缀在周五休市的边界上稳定：存下的历史被改动（不是数据问题）→ 原因不明", async () => {
    await settle();
    await nextNight();
    t.env.app.db
      .update(trackingDays)
      .set({ nav: 1.5 })
      .where(and(eq(trackingDays.trackingId, trackingId), eq(trackingDays.date, "2026-03-10")))
      .run();
    const ctx = await settle();
    expect(summary().replay.cause).toBe("unexplained");
    expect(ctx.logs.join("\n")).toMatch(/原因不明/);
  });

  it("过去的收盘被修订 → data，写明从哪天起", async () => {
    await settle();
    await nextNight();
    await t.env.wh.run(`UPDATE bars_daily SET close = close * 1.1 WHERE date = '2026-03-12'`);
    const ctx = await settle();
    const s = summary();
    expect(s.replay.cause).toBe("data");
    expect(s.replay.causeText).toBe(`数据被修订过（${s.replay.firstDrift} 起）`);
    expect(s.replay.firstDrift! <= "2026-03-12").toBe(true);
    expect(ctx.logs.join("\n")).toMatch(/数据被修订过/);
  });

  it("上一晚的指纹口径版本不同 → unrecorded（不误报数据修订）", async () => {
    await settle();
    await nextNight();
    const s = summary();
    t.env.app.db
      .update(trackings)
      .set({ summary: { ...s, hashVersion: 0 } })
      .where(eq(trackings.id, trackingId))
      .run();
    await t.env.wh.run(`UPDATE bars_daily SET close = close * 1.1 WHERE date = '2026-03-12'`);
    await settle();
    expect(summary().replay.cause).toBe("unrecorded");
  });

  it("上线早于指纹记录（summary 里没有指纹）且有漂移 → unrecorded", async () => {
    await settle();
    await nextNight();
    t.env.app.db
      .update(trackings)
      .set({ summary: { replay: {} } })
      .where(eq(trackings.id, trackingId))
      .run();
    await t.env.wh.run(`UPDATE bars_daily SET close = close * 1.1 WHERE date = '2026-03-12'`);
    await settle();
    expect(summary().replay.cause).toBe("unrecorded");
  });

  it("现有跟踪的成交假设默认是旧口径", () => {
    const row = t.env.app.db.select().from(trackings).where(eq(trackings.id, trackingId)).get()!;
    expect(row.execConfig).toEqual({ v: 1 });
  });
});

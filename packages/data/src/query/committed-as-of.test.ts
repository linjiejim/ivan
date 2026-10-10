/**
 * 「读到哪一天」只看提交过的版本（D60）：最后一个 ok 版本之后写进来的日线、因子、日历，回测都不读——
 * 终点截在已提交的截至日；跟踪补的「下一个交易日」只是计划日期，不读那天的行情与基准。
 * （结算与 /internal/screen 的同类测试在 apps/worker/src/committed-as-of.test.ts）
 */
import { StrategySpecSchema } from "@ivan/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedSyntheticMarket } from "../testing/seed.ts";
import { Warehouse } from "../warehouse/db.ts";
import { buildSimInput, committedAsOf } from "./backtest.ts";

let wh: Warehouse;
beforeEach(async () => {
  wh = await Warehouse.open(":memory:");
});
afterEach(() => wh.close());

const spec = StrategySpecSchema.parse({
  name: "合成",
  market: "A",
  rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 1 },
});

/** 30 个交易日都写了日线与因子，但只提交到第 28 天（第 29、30 天是失败那晚写进来的） */
async function seedWithUncommittedTail() {
  const { calendar } = await seedSyntheticMarket(wh, {
    market: "A",
    start: "2026-03-02",
    days: 30,
    dataVersion: false,
    stocks: [
      { code: "600001.SH", name: "甲", close: (i) => 10 + i, factors: () => ({ pe_ttm: 8 }) },
      { code: "600002.SH", name: "乙", close: (i) => 20 + i, factors: () => ({ pe_ttm: 5 }) },
    ],
  });
  const committed = calendar[27]!;
  await wh.run(
    `INSERT INTO data_versions (id, market, as_of, kind, status)
     VALUES (nextval('data_version_seq'), 'A', $d::DATE, 'daily', 'ok')`,
    { d: committed },
  );
  await wh.run(
    `INSERT INTO data_versions (id, market, as_of, kind, status)
     VALUES (nextval('data_version_seq'), 'A', NULL, 'daily', 'failed')`,
  );
  return { calendar, committed };
}

describe("committedAsOf 与 buildSimInput", () => {
  it("终点截到已提交的截至日，之后的日子不进日历", async () => {
    const { calendar, committed } = await seedWithUncommittedTail();
    expect(await committedAsOf(wh, "A")).toBe(committed);
    const built = await buildSimInput(wh, spec, {
      start: calendar[5]!,
      end: calendar.at(-1)!,
      capital: 1e6,
      oosMonths: 0,
    });
    expect(built.params.end).toBe(committed);
    expect(built.input.calendar.at(-1)).toBe(committed);
    expect(built.dataVersion.asOf).toBe(committed);
  });

  it("跟踪补的「下一个交易日」锚在已提交的截至日上，那天的行情与基准不读", async () => {
    const { calendar, committed } = await seedWithUncommittedTail();
    const built = await buildSimInput(
      wh,
      spec,
      { start: calendar[5]!, end: calendar.at(-1)!, capital: 1e6, oosMonths: 0 },
      { appendNextDay: true },
    );
    const cal = built.input.calendar;
    expect(cal.at(-2)).toBe(committed);
    expect(cal.at(-1)).toBe(calendar[28]);
    for (const s of built.input.prices.values()) {
      const x = cal.length - 1 - s.from;
      expect(Number.isNaN(s.close[x]!)).toBe(true);
      expect(Number.isNaN(s.close[x - 1]!)).toBe(false);
    }
    expect(Number.isNaN(built.input.bench[cal.length - 1]!)).toBe(true);
  });

  it("一个提交过的版本都没有：报错让人先回填", async () => {
    await seedSyntheticMarket(wh, {
      market: "A",
      start: "2026-03-02",
      days: 5,
      dataVersion: false,
      stocks: [{ code: "600001.SH", name: "甲", close: () => 10 }],
    });
    await expect(
      buildSimInput(wh, spec, { start: "2026-03-02", end: "2026-03-06", capital: 1e6, oosMonths: 0 }),
    ).rejects.toThrow("还没有提交过的数据");
  });
});

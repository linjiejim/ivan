import { StrategySpecSchema } from "@ivan/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSimInput } from "../query/backtest.ts";
import { compileSelection, runSelection } from "../query/selection.ts";
import { Warehouse } from "../warehouse/db.ts";
import { seedSyntheticMarket } from "./seed.ts";

let wh: Warehouse;
beforeEach(async () => {
  wh = await Warehouse.open(":memory:");
});
afterEach(() => wh.close());

const spec = (extra: Record<string, unknown> = {}) =>
  StrategySpecSchema.parse({
    name: "合成",
    market: "A",
    rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 2 },
    ...extra,
  });

describe("合成市场", () => {
  it("3 只股票 × 30 天：选股按种下的因子排出前几名；NaN 收盘不写日线", async () => {
    const { calendar } = await seedSyntheticMarket(wh, {
      market: "A",
      start: "2026-03-02",
      days: 30,
      stocks: [
        { code: "600001.SH", name: "甲", industry_l1: "银行", close: () => 10, factors: () => ({ pe_ttm: 8 }) },
        { code: "600002.SH", name: "乙", industry_l1: "银行", close: () => 20, factors: () => ({ pe_ttm: 5 }) },
        {
          code: "000003.SZ",
          name: "丙",
          industry_l1: "医药",
          // 第 3 天停牌
          close: (i) => (i === 3 ? NaN : 30),
          factors: () => ({ pe_ttm: 12 }),
        },
      ],
    });
    expect(calendar).toHaveLength(30);
    const d = calendar[10]!;
    const sel = await runSelection(wh, spec(), [d], 3);
    expect(sel.get(d)).toEqual(["600002.SH", "600001.SH", "000003.SZ"]);
    expect(await wh.all(compileSelection(spec(), [d], 1))).toEqual([
      { date: d, code: "600002.SH", score: 1 },
    ]);

    const bars = await wh.scalar<number>(`SELECT count(*) FROM bars_daily WHERE code = '000003.SZ'`);
    expect(bars).toBe(29);
    const missing = await wh.scalar<number>(
      `SELECT count(*) FROM bars_daily WHERE code = '000003.SZ' AND date = $d::DATE`,
      { d: calendar[3]! },
    );
    expect(missing).toBe(0);
    // 高低价取开收的较大 / 较小值，成交额 = 收盘 × 成交量
    const bar = await wh.one<{ high: number; low: number; amount: number; adj: number }>(
      `SELECT high, low, amount, adj FROM bars_daily WHERE code = '600001.SH' LIMIT 1`,
    );
    expect(bar).toEqual({ high: 10, low: 10, amount: 1e7, adj: 1 });
    // 指数与数据版本
    expect(await wh.scalar(`SELECT count(DISTINCT sym) FROM index_bars`)).toBe(3);
    expect(
      await wh.one(`SELECT market, as_of::VARCHAR AS as_of, kind FROM data_versions`),
    ).toEqual({ market: "A", as_of: calendar.at(-1), kind: "backfill" });

    // 能直接组装回测输入
    const built = await buildSimInput(wh, spec(), {
      start: calendar[5]!,
      end: calendar.at(-1)!,
      capital: 1e6,
      oosMonths: 0,
    });
    expect(built.input.prices.size).toBeGreaterThan(0);
    expect(built.dataVersion.asOf).toBe(calendar.at(-1));
  });

  it("板块抄进 factors_daily：只选科创板时只选到种下的科创板股票", async () => {
    const { calendar } = await seedSyntheticMarket(wh, {
      market: "A",
      start: "2026-03-02",
      days: 5,
      stocks: [
        { code: "600001.SH", name: "甲", close: () => 10, factors: () => ({ pe_ttm: 5 }) },
        {
          code: "688001.SH",
          name: "星",
          board: "star",
          close: () => 50,
          factors: () => ({ pe_ttm: 40 }),
        },
      ],
    });
    const d = calendar[2]!;
    const sel = await runSelection(wh, spec({ universe: { boards: ["star"] } }), [d], 5);
    expect(sel.get(d)).toEqual(["688001.SH"]);
    // 不限板块时两只都在
    expect((await runSelection(wh, spec(), [d], 5)).get(d)).toEqual(["600001.SH", "688001.SH"]);
  });

  it("同一行业最多 N 只按种下的一级行业分组；因子可以逐日覆盖行业", async () => {
    const { calendar } = await seedSyntheticMarket(wh, {
      market: "A",
      start: "2026-03-02",
      days: 5,
      stocks: [
        { code: "600001.SH", name: "甲", industry_l1: "银行", close: () => 10, factors: () => ({ pe_ttm: 4 }) },
        { code: "600002.SH", name: "乙", industry_l1: "银行", close: () => 10, factors: () => ({ pe_ttm: 5 }) },
        {
          code: "600003.SH",
          name: "丙",
          industry_l1: "医药",
          close: () => 10,
          // 第 4 天起改归银行
          factors: (i) => ({ pe_ttm: 6, ...(i >= 4 ? { industry_l1: "银行" } : {}) }),
        },
      ],
    });
    const s = spec({ rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 2, maxPerIndustry: 1 } });
    const sel = await runSelection(wh, s, [calendar[1]!, calendar[4]!], 2);
    expect(sel.get(calendar[1]!)).toEqual(["600001.SH", "600003.SH"]);
    expect(sel.get(calendar[4]!)).toEqual(["600001.SH"]);
  });

  it("skipDates 去掉一个工作日（模拟节假日）；不写数据版本时没有版本", async () => {
    const { calendar } = await seedSyntheticMarket(wh, {
      market: "HK",
      start: "2026-09-28",
      days: 5,
      skipDates: ["2026-10-01"],
      dataVersion: false,
      stocks: [{ code: "00700.HK", name: "腾讯", lotSize: 100, close: () => 400 }],
    });
    expect(calendar).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-02"]);
    const cal = await wh.all<{ d: string }>(
      `SELECT date::VARCHAR AS d FROM trade_calendar WHERE market = 'HK' ORDER BY d`,
    );
    expect(cal.map((r) => r.d)).toEqual(calendar);
    expect(await wh.scalar(`SELECT count(*) FROM data_versions`)).toBe(0);
    expect(await wh.scalar(`SELECT board FROM factors_daily LIMIT 1`)).toBe("hk_main");
    expect(await wh.scalar(`SELECT count(DISTINCT sym) FROM index_bars`)).toBe(2);
  });

  it("不在注册表里的因子直接报错", async () => {
    await expect(
      seedSyntheticMarket(wh, {
        market: "A",
        start: "2026-03-02",
        days: 2,
        stocks: [{ code: "600001.SH", name: "甲", close: () => 10, factors: () => ({ nope: 1 }) }],
      }),
    ).rejects.toThrow(/不在注册表/);
  });
});

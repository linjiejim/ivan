/**
 * 规则表版本进引擎（D62）：同一份输入，exec.rules 不同，涨跌停判断不同；第 1 版的行为由金标准守着。
 */
import {
  type DateStr,
  LEGACY_EXEC,
  type PriceSeries,
  type SecurityInfo,
  type SimInput,
  StrategySpecSchema,
} from "@ivan/core";
import { describe, expect, it } from "vitest";
import { simulate } from "./simulate.ts";
import { seriesOn, weekdays } from "./testing/fixtures.ts";

const spec = StrategySpecSchema.parse({
  name: "规则表",
  market: "A",
  rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 1 },
  rebalance: { every: "month", buffer: 1 },
});

/** 一只股票、决策日 decision 的下一天开盘 openPct 高开；rules 决定按哪版规则表 */
function oneStock(o: {
  calendar: DateStr[];
  decision: DateStr;
  openPct: number;
  st?: boolean;
  board?: string;
  listDate?: DateStr;
  firstIdx?: number;
  rules: 1 | 2;
}): SimInput {
  const { calendar } = o;
  const exec = calendar[calendar.indexOf(o.decision) + 1]!;
  const closes = calendar.map((_, i) => (i < (o.firstIdx ?? 0) ? NaN : 10));
  const p: PriceSeries = seriesOn(calendar, "600001.SH", closes, {
    open: { [exec]: 10 * (1 + o.openPct) },
    st: o.st ? calendar : [],
  });
  const sec: SecurityInfo = {
    code: "600001.SH",
    name: "甲",
    board: o.board ?? "main",
    lotSize: 100,
    industry: null,
    listDate: o.listDate ?? null,
  };
  return {
    spec,
    params: {
      start: exec,
      end: calendar.at(-1)!,
      capital: 100_000,
      oosMonths: 0,
      exec: { ...LEGACY_EXEC, rules: o.rules },
    },
    calendar,
    prices: new Map([["600001.SH", p]]),
    securities: new Map([["600001.SH", sec]]),
    selections: new Map([[o.decision, ["600001.SH"]]]),
    bench: new Float64Array(calendar.length).fill(1000),
    benchLabel: "测试基准",
    benchWithDividends: true,
  };
}

const bought = (input: SimInput) => simulate(input).trades.some((t) => t.side === "buy");

describe("规则表版本进引擎", () => {
  it("主板 ST 股 2025-07-08 高开 8%：第 2 版（10%）买得进，第 1 版（5%）买不进", () => {
    const calendar = weekdays("2025-07-01", 10);
    expect(calendar).toContain("2025-07-08");
    const base = { calendar, decision: "2025-07-07", openPct: 0.08, st: true };
    expect(bought(oneStock({ ...base, rules: 2 }))).toBe(true);
    expect(bought(oneStock({ ...base, rules: 1 }))).toBe(false);
  });

  it("2025-07-07 之前的 ST 股：两版都按 5%", () => {
    const calendar = weekdays("2025-06-23", 10);
    const base = { calendar, decision: "2025-06-27", openPct: 0.08, st: true };
    expect(bought(oneStock({ ...base, rules: 2 }))).toBe(false);
    expect(bought(oneStock({ ...base, rules: 1 }))).toBe(false);
  });

  it("注册制主板新股前 5 个交易日不设涨跌幅：第 2 版上市第 3 天高开 15% 买得进，第 1 版买不进", () => {
    const calendar = weekdays("2023-05-01", 12);
    const listIdx = calendar.indexOf("2023-05-04");
    const base = {
      calendar,
      decision: calendar[listIdx + 2]!,
      openPct: 0.15,
      listDate: "2023-05-04",
      firstIdx: listIdx,
    };
    expect(bought(oneStock({ ...base, rules: 2 }))).toBe(true);
    expect(bought(oneStock({ ...base, rules: 1 }))).toBe(false);
    // 第 5 个交易日（上市后第 5 天）起恢复 10%
    const later = { ...base, decision: calendar[listIdx + 4]! };
    expect(bought(oneStock({ ...later, rules: 2 }))).toBe(false);
  });

  it("费用按规则表版本：2022-04-28 之前过户费第 2 版是第 1 版的两倍", () => {
    const calendar = weekdays("2022-04-18", 8);
    const base = { calendar, decision: "2022-04-20", openPct: 0 };
    const fee = (rules: 1 | 2) =>
      simulate(oneStock({ ...base, rules })).trades.find((t) => t.side === "buy")!.fee;
    const r1 = simulate(oneStock({ ...base, rules: 1 })).trades[0]!;
    expect(fee(2) - fee(1)).toBeCloseTo(r1.amount * 0.00001, 8);
  });
});

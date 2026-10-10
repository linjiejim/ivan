/**
 * 规则表第 2 版（D62）：每个日期边界两侧各测一次；第 1 版逐项不变。
 */
import { describe, expect, it } from "vitest";
import {
  A_TRANSFER_FEE,
  effective,
  HK_TRADING_FEE,
  priceLimitPct,
  ST_MAIN_LIMIT,
  tickSize,
  tradeFees,
} from "./rules.ts";

describe("effective：按日期取生效的一行", () => {
  it("当天起生效，前一天还是旧值", () => {
    expect(effective("2025-07-04", ST_MAIN_LIMIT)).toBe(0.05);
    expect(effective("2025-07-07", ST_MAIN_LIMIT)).toBe(0.1);
    expect(effective("1980-01-01", ST_MAIN_LIMIT)).toBe(0.05);
  });
  it("每行都写了出处", () => {
    for (const rows of [ST_MAIN_LIMIT, A_TRANSFER_FEE, HK_TRADING_FEE]) {
      for (const r of rows) expect(r.cite.length).toBeGreaterThan(4);
    }
  });
});

describe("涨跌幅限制", () => {
  const v2 = { rules: 2 as const };
  it.each([
    // [说明, 板块, ST, 日期, 选项, 第 2 版, 第 1 版]
    ["主板 ST 2025-07-04", "main", true, "2025-07-04", {}, 0.05, 0.05],
    ["主板 ST 2025-07-07", "main", true, "2025-07-07", {}, 0.1, 0.05],
    ["主板非 ST", "main", false, "2025-07-07", {}, 0.1, 0.1],
    ["科创板", "star", true, "2025-07-07", {}, 0.2, 0.2],
    ["创业板 2020-08-21 ST", "gem", true, "2020-08-21", {}, 0.05, 0.05],
    ["创业板 2020-08-24", "gem", true, "2020-08-24", {}, 0.2, 0.2],
    ["北交所", "bse", false, "2024-01-02", {}, 0.3, 0.1],
    [
      "科创板 2024-01-10 上市第 4 天",
      "star",
      false,
      "2024-01-16",
      { listDate: "2024-01-10", daysSinceList: 4 },
      null,
      0.2,
    ],
    [
      "科创板 2024-01-10 上市第 5 天",
      "star",
      false,
      "2024-01-17",
      { listDate: "2024-01-10", daysSinceList: 5 },
      0.2,
      0.2,
    ],
    [
      "主板 2023-05-04 上市第 3 天",
      "main",
      false,
      "2023-05-09",
      { listDate: "2023-05-04", daysSinceList: 3 },
      null,
      0.1,
    ],
    [
      "主板 2023-04-07 上市第 1 天（注册制之前）",
      "main",
      false,
      "2023-04-10",
      { listDate: "2023-04-07", daysSinceList: 1 },
      0.1,
      0.1,
    ],
    [
      "主板 2022-06-01 上市第 1 天",
      "main",
      false,
      "2022-06-02",
      { listDate: "2022-06-01", daysSinceList: 1 },
      0.1,
      0.1,
    ],
    [
      "主板 2022-06-01 上市当天",
      "main",
      false,
      "2022-06-01",
      { listDate: "2022-06-01", daysSinceList: 0 },
      null,
      0.1,
    ],
    [
      "创业板 2020-08-24 上市第 4 天",
      "gem",
      false,
      "2020-08-28",
      { listDate: "2020-08-24", daysSinceList: 4 },
      null,
      0.2,
    ],
    [
      "创业板 2020-08-21 上市第 1 天",
      "gem",
      false,
      "2020-08-24",
      { listDate: "2020-08-21", daysSinceList: 1 },
      0.2,
      0.2,
    ],
  ] as const)("%s", (_name, board, st, date, o, want2, want1) => {
    expect(priceLimitPct("A", board, st, date, { ...o, ...v2 })).toBe(want2);
    expect(priceLimitPct("A", board, st, date, o)).toBe(want1);
    expect(priceLimitPct("A", board, st, date, { ...o, rules: 1 })).toBe(want1);
  });
  it("港股不设涨跌停", () => {
    expect(priceLimitPct("HK", "hk_main", false, "2025-07-07", v2)).toBeNull();
    expect(priceLimitPct("HK", "hk_main", false, "2025-07-07")).toBeNull();
  });
});

describe("费用", () => {
  it("过户费：2022-04-29 起下调一半（第 1 版一直按 0.001%）", () => {
    const fee = (d: string, rules: 1 | 2) => tradeFees("A", "buy", 100_000, d, {}, rules).other;
    expect(fee("2022-04-28", 2)).toBeCloseTo(2, 10);
    expect(fee("2022-04-29", 2)).toBeCloseTo(1, 10);
    expect(fee("2022-04-28", 1)).toBeCloseTo(1, 10);
    expect(fee("2022-04-29", 1)).toBeCloseTo(1, 10);
  });

  it("港股交易费：2023-01-01 起 0.00565%，之前 0.005%（第 1 版一直按 0.00565%）", () => {
    const amount = 1_000_000;
    // other = 交易费 + 证监会征费 + 会财局征费 + 结算费（上限 100）
    const rest = (d: string) =>
      amount * 0.000027 + (d >= "2022-01-01" ? amount * 0.0000015 : 0) + 20;
    const other = (d: string, rules: 1 | 2) => tradeFees("HK", "buy", amount, d, {}, rules).other;
    expect(other("2022-12-30", 2) - rest("2022-12-30")).toBeCloseTo(50, 8);
    expect(other("2023-01-03", 2) - rest("2023-01-03")).toBeCloseTo(56.5, 8);
    expect(other("2022-12-30", 1) - rest("2022-12-30")).toBeCloseTo(56.5, 8);
  });

  it("港股印花税按整港元向上取整（第 2 版）", () => {
    expect(tradeFees("HK", "sell", 10_001, "2024-01-02", {}, 2).tax).toBe(
      Math.ceil(10_001 * 0.001),
    );
    expect(tradeFees("HK", "sell", 10_001, "2024-01-02", {}, 2).tax).toBe(11);
    expect(tradeFees("HK", "sell", 10_001, "2024-01-02", {}, 1).tax).toBeCloseTo(10.001, 10);
    // 刚好整数时不多进一元（10000 × 0.0013 的浮点结果略大于 13）
    expect(tradeFees("HK", "sell", 10_000, "2022-06-01", {}, 2).tax).toBe(13);
  });

  it("第 1 版与不传版本完全相同", () => {
    for (const [m, side, d] of [
      ["A", "sell", "2021-03-01"],
      ["A", "buy", "2024-03-01"],
      ["HK", "sell", "2021-09-01"],
      ["HK", "buy", "2023-12-01"],
    ] as const) {
      expect(tradeFees(m, side, 123_456.78, d, {}, 1)).toEqual(tradeFees(m, side, 123_456.78, d));
    }
  });
});

describe("最小价位", () => {
  it("A 股 0.01；港股按价位表", () => {
    expect(tickSize("A", 3.21, "2025-01-02")).toBe(0.01);
    expect(tickSize("HK", 0.42, "2025-01-02")).toBe(0.005);
    expect(tickSize("HK", 15, "2025-01-02")).toBe(0.02);
    expect(tickSize("HK", 0.25, "2025-01-02")).toBe(0.001);
    expect(tickSize("HK", 10, "2025-01-02")).toBe(0.01);
    expect(tickSize("HK", 450, "2025-01-02")).toBe(0.2);
    expect(tickSize("HK", 9000, "2025-01-02")).toBe(5);
  });
});

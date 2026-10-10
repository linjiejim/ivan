/**
 * 仓位控制（D52）：每周最后一个交易日收盘按持仓近 N 日的年化波动定下周的仓位系数，下一交易日开盘按比例增减。
 */
import { describe, expect, it } from "vitest";
import { simulate } from "./simulate.ts";
import { calmClose, choppyClose, exposureInput } from "./testing/fixtures.ts";

// 夹具在 testing/fixtures.ts（与 1.1.0 金标准共用）：2025-01-06（周一）起 80 个工作日
const calendar = exposureInput("000001.SZ", choppyClose).calendar;

function run(code: string, closeAt: (i: number) => number, volTarget?: number) {
  return simulate(exposureInput(code, closeAt, volTarget));
}

// 10 / 10.6 来回跳（不碰 10% 涨跌停）：日波动约 5.8%，年化约 90%
const choppy = choppyClose;

describe("仓位控制：按波动控制仓位", () => {
  it("波动远超目标：够 20 天数据后的第一个周五收盘定系数 0.2（= 20% ÷ 90% 向下取整），下周一开盘按比例减仓", () => {
    const r = run("000001.SZ", choppy, 0.2);
    const cut = r.trades.filter((t) => t.reason === "exposure");
    expect(cut.length).toBeGreaterThan(0);
    const first = cut[0]!;
    expect(first.side).toBe("sell");
    // 决策在周五收盘，成交在下一个交易日（周一）开盘，不偷看
    expect(new Date(`${first.date}T00:00:00Z`).getUTCDay()).toBe(1);
    const i = calendar.indexOf(first.date);
    expect(i).toBeGreaterThanOrEqual(21);
    // 减掉约 80%：剩下的股票市值约占总资产 20%
    const day = r.series.find((p) => p.date === first.date)!;
    const equity = day.nav * 1_000_000;
    expect(1 - day.cash / equity).toBeGreaterThan(0.15);
    expect(1 - day.cash / equity).toBeLessThan(0.25);
    expect(r.final.exposure).toEqual({ current: 0.2, next: 0.2 });
    expect(r.metrics.avgExposure!).toBeLessThan(0.5);
  });

  it("波动很低：一直满仓，不产生仓位控制的交易", () => {
    const r = run("000002.SZ", calmClose, 0.2);
    expect(r.trades.filter((t) => t.reason === "exposure")).toEqual([]);
    expect(r.final.exposure).toEqual({ current: 1, next: 1 });
    expect(r.metrics.avgExposure!).toBeGreaterThan(0.95);
  });

  it("不设仓位控制：行为和以前一样（满仓，没有仓位系数）", () => {
    const r = run("000001.SZ", choppy);
    expect(r.trades.filter((t) => t.reason === "exposure")).toEqual([]);
    expect(r.final.exposure).toBeUndefined();
  });

  it("减仓的盈亏按卖出部分的成本算，剩下的持仓成本同比例减少", () => {
    const r = run("000001.SZ", choppy, 0.2);
    const buy = r.trades.find((t) => t.side === "buy" && t.reason === "entry")!;
    const cut = r.trades.find((t) => t.reason === "exposure" && t.side === "sell")!;
    const costPerShare = (buy.amount + buy.fee) / buy.shares;
    expect(cut.pnl!).toBeCloseTo(cut.amount - cut.fee - costPerShare * cut.shares, 4);
    const pos = r.final.positions[0]!;
    expect(pos.cost!).toBeCloseTo(costPerShare * (buy.shares - cut.shares), 4);
  });
});

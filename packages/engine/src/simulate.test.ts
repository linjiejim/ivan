/**
 * 引擎手算夹具（验收 2）：3 只股票、24 个交易日，覆盖涨停买不进、停牌顺延、分红、止损、
 * 整手、最低佣金。每个数字都按 spec §5 的规则手算。
 */
import { tradeFees } from "@ivan/core";
import { describe, expect, it } from "vitest";
import { compareReplay } from "./replay.ts";
import { rebalanceDays, simulate } from "./simulate.ts";
import { baseData, baseFixture, delistFixture, monthlyFixture } from "./testing/fixtures.ts";

// 夹具在 testing/fixtures.ts（与 1.1.0 金标准共用）：2025-06-02（周一）起 24 个工作日，回测从 06-03 开始
const { calendar } = baseData();
const idx = (d: string) => calendar.indexOf(d);

function run(extra: Parameters<typeof baseFixture>[0] = {}) {
  return simulate(baseFixture(extra));
}

describe("引擎夹具（验收 2）", () => {
  const r = run();
  const buys = r.trades.filter((t) => t.side === "buy");
  const sells = r.trades.filter((t) => t.side === "sell");

  it("调仓日：区间第一天 + 每个月第一个交易日，决策日是前一个交易日", () => {
    const { execIdx, decisionDates } = rebalanceDays(
      calendar,
      { start: "2025-06-03", end: calendar.at(-1)!, capital: 1, oosMonths: 0 },
      "month",
    );
    expect(execIdx[0]).toBe(idx("2025-06-03"));
    expect(decisionDates[0]).toBe("2025-06-02");
    expect(execIdx.map((i) => calendar[i])).toContain("2025-07-01");
  });

  it("涨停开盘买不进，名单顺延到下一只；整手买入、最低佣金 5 元", () => {
    expect(buys.map((t) => t.code)).toEqual(["000001.SZ", "000002.SZ"]);
    // 预算 = min(100000 / 3, 100000 / 3) = 33333.33 × 0.998 → 10 元整百股：3300 股
    const a = buys[0]!;
    expect(a.shares).toBe(3300);
    expect(a.amount).toBe(33_000);
    // 佣金 33000 × 万 2.5 = 8.25 元（> 5 元最低）+ 过户费 0.33
    expect(a.fee).toBeCloseTo(8.25 + 0.33, 6);
    // 乙：20 元 → 1600 股 = 32000 元
    const b = buys[1]!;
    expect(b.shares).toBe(1600);
    expect(b.fee).toBeCloseTo(tradeFees("A", "buy", 32_000, "2025-06-03").total, 6);
  });

  it("止损：06-05 收盘跌 12.5% 触发，次日停牌顺延，06-09 开盘卖出", () => {
    const s = sells.find((t) => t.code === "000002.SZ")!;
    expect(s.reason).toBe("stop_loss");
    expect(s.date).toBe("2025-06-09");
    expect(s.price).toBe(17.5);
    const amount = 1600 * 17.5;
    const fee = tradeFees("A", "sell", amount, "2025-06-09").total;
    expect(s.pnl).toBeCloseTo(amount - fee - (32_000 + b0fee()), 6);
    function b0fee() {
      return tradeFees("A", "buy", 32_000, "2025-06-03").total;
    }
  });

  it("除息：持仓按等比因子计价，分红再投入，净值不因除息下跌", () => {
    const before = r.series.find((p) => p.date === "2025-06-09")!;
    const after = r.series.find((p) => p.date === "2025-06-10")!;
    // 甲的价值：3300 × 9.5 × (10 / 9.5) = 33000，与除息前相同；乙已卖出，现金不变
    expect(after.nav).toBeCloseTo(before.nav, 10);
  });

  it("逐日净值与手算一致到分", () => {
    const cashAfterBuys = 100_000 - (33_000 + buys[0]!.fee) - (32_000 + buys[1]!.fee);
    // 06-04：甲 33000 + 乙 1600 × 20
    const d4 = r.series.find((p) => p.date === "2025-06-04")!;
    expect(d4.nav * 100_000).toBeCloseTo(cashAfterBuys + 33_000 + 32_000, 2);
    // 06-05：乙跌到 17.5
    const d5 = r.series.find((p) => p.date === "2025-06-05")!;
    expect(d5.nav * 100_000).toBeCloseTo(cashAfterBuys + 33_000 + 28_000, 2);
    // 06-06：乙停牌，按最后收盘价计
    const d6 = r.series.find((p) => p.date === "2025-06-06")!;
    expect(d6.nav * 100_000).toBeCloseTo(cashAfterBuys + 33_000 + 28_000, 2);
  });

  it("月初调仓：7 月第一个交易日按 6 月最后一天的名单补位（缓冲 1 = 严格前 3）", () => {
    const july = calendar.find((d) => d >= "2025-07-01")!;
    // 6 月 30 日（7 月第一个交易日的前一天）的名单：乙、丙
    const withJuly = simulate(monthlyFixture());
    // 甲掉出名单 → 7 月初卖出；乙重新买入；丙 6 月 30 日前收 11、开盘 11 不再涨停，买入
    const julyTrades = withJuly.trades.filter((t) => t.date === july);
    expect(julyTrades.filter((t) => t.side === "sell").map((t) => [t.code, t.reason])).toEqual([
      ["000001.SZ", "filtered"],
    ]);
    expect(
      julyTrades
        .filter((t) => t.side === "buy")
        .map((t) => t.code)
        .sort(),
    ).toEqual(["000002.SZ", "000003.SZ"]);
  });

  it("同样输入重复运行结果完全一致（验收 4 的引擎部分）", () => {
    const r2 = run();
    expect(JSON.stringify(r2.trades)).toBe(JSON.stringify(r.trades));
    expect(JSON.stringify(r2.metrics)).toBe(JSON.stringify(r.metrics));
  });

  it("跟踪重放：数据每多一天，之前每一天的净值与基准都不变（验收 4 的跟踪部分）", () => {
    for (const end of ["2025-06-04", "2025-06-06", "2025-06-10", "2025-06-30", "2025-07-01"]) {
      const part = run({ params: { start: "2025-06-03", end, capital: 100_000, oosMonths: 0 } });
      const c = compareReplay(part.series, r.series);
      expect(c.compared).toBe(part.series.length);
      expect(c).toMatchObject({ navDrift: 0, benchDrift: 0, firstDrift: null });
    }
  });

  it("重放对照能认出被修订的日子", () => {
    const stored = r.series.map((p) => ({ ...p }));
    stored[5] = { ...stored[5]!, nav: stored[5]!.nav + 0.001 };
    stored[9] = { ...stored[9]!, bench: stored[9]!.bench * 1.01 };
    const c = compareReplay(stored, r.series);
    expect(c).toMatchObject({ navDrift: 1, benchDrift: 1, firstDrift: stored[5]!.date });
    expect(c.maxNavDiff).toBeCloseTo(0.001, 9);
    // 上次有、这次没有的日子也算不一致
    expect(compareReplay(r.series, r.series.slice(0, -2)).navDrift).toBe(2);
  });

  it("持仓到退市日按最后收盘价清出，空出的名额下次调仓能补", () => {
    // 甲的退市日 06-20，06-16 起没有行情
    const r2 = simulate(delistFixture());
    const s = r2.trades.find((t) => t.code === "000001.SZ" && t.side === "sell")!;
    expect(s.reason).toBe("delisted");
    expect(s.date).toBe("2025-06-20");
    // 按 06-13 的最后收盘价 9.5、含分红再投入的股数清出
    expect(s.price).toBe(9.5);
    expect(s.shares).toBeCloseTo(3300 * (10 / 9.5), 6);
  });
});

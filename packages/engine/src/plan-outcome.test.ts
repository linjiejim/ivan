import { describe, expect, it } from "vitest";
import { evaluatePlanItem } from "./plan-outcome.ts";

/** 决策日 2026-03-02（周一）之后 25 个交易日；第 0 根是决策日本身 */
function days(n: number): string[] {
  const out: string[] = [];
  let d = new Date(Date.UTC(2026, 2, 2));
  while (out.length < n) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86_400_000);
  }
  return out;
}

const D = days(26);
const bars = (n = 26) => ({
  dates: D.slice(0, n),
  open: Float64Array.from({ length: n }, (_, i) => 10 + i * 0.1),
  close: Float64Array.from({ length: n }, (_, i) => 10.05 + i * 0.1),
  adj: Float64Array.from({ length: n }, () => 1),
});
const bench = { dates: D, close: Float64Array.from(D, (_, i) => 1000 + i * 2) };
const snap = { decisionDate: D[0]!, benchClose: 1000 };

describe("计划结果回看（D79）", () => {
  it("买入：次日开盘成交、与估算价的差、5 / 20 天收益与超额（手算）", () => {
    const o = evaluatePlanItem({ code: "x", side: "buy", estPrice: 10.05 }, snap, bars(), bench);
    // 第 1 根（决策日次日）开盘 10.1
    expect(o.fillDate).toBe(D[1]);
    expect(o.fillOpen).toBeCloseTo(10.1, 10);
    expect(o.slipVsEst).toBeCloseTo(10.1 / 10.05 - 1, 12);
    // 第 5 根 K 线 = 下标 5：收盘 10.55；基准 1010 ÷ 1000
    expect(o.ret5).toBeCloseTo(10.55 / 10.1 - 1, 12);
    expect(o.excess5).toBeCloseTo(10.55 / 10.1 / 1.01 - 1, 12);
    // 第 20 根 = 下标 20：收盘 12.05；基准 1040
    expect(o.ret20).toBeCloseTo(12.05 / 10.1 - 1, 12);
    expect(o.excess20).toBeCloseTo(12.05 / 10.1 / 1.04 - 1, 12);
  });

  it("复权：除权日之后按复权价算", () => {
    const b = bars();
    for (let i = 3; i < b.adj.length; i++) b.adj[i] = 2; // 第 3 根起 1 拆 2（价格减半、因子翻倍）
    for (let i = 3; i < b.close.length; i++) b.close[i] = b.close[i]! / 2;
    const o = evaluatePlanItem({ code: "x", side: "buy", estPrice: null }, snap, b, bench);
    expect(o.ret5).toBeCloseTo(10.55 / 10.1 - 1, 12);
    expect(o.slipVsEst).toBeNull();
  });

  it("天数不够时为 null；还没有成交时全空", () => {
    const short = evaluatePlanItem({ code: "x", side: "buy", estPrice: 10 }, snap, bars(8), bench);
    expect(short.ret5).not.toBeNull();
    expect(short.ret20).toBeNull();
    expect(short.excess20).toBeNull();
    const none = evaluatePlanItem({ code: "x", side: "buy", estPrice: 10 }, snap, bars(1), bench);
    expect(none).toMatchObject({ fillDate: null, fillOpen: null, ret5: null, ret20: null });
  });

  it("卖出：看卖出之后这只股票的涨跌；没有基准收盘时超额为 null", () => {
    const b = bars();
    for (let i = 0; i < b.close.length; i++) b.close[i] = 10.1 - i * 0.05;
    const o = evaluatePlanItem(
      { code: "x", side: "sell", estPrice: 10 },
      { decisionDate: D[0]!, benchClose: null },
      b,
      bench,
    );
    expect(o.side).toBe("sell");
    expect(o.ret5).toBeCloseTo((10.1 - 5 * 0.05) / 10.1 - 1, 12);
    expect(o.ret5! < 0).toBe(true);
    expect(o.excess5).toBeNull();
  });

  it("停牌：决策日之后第一根有开盘价的 K 线才算成交", () => {
    const b = bars();
    b.open[1] = NaN;
    const o = evaluatePlanItem({ code: "x", side: "buy", estPrice: 10 }, snap, b, bench);
    expect(o.fillDate).toBe(D[2]);
  });
});

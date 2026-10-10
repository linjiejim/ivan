/**
 * 口径归一（D72）：参考前收、仿射后复权（含只派现金的加法复权）、复权因子都换成「不复权 + 等比因子」；
 * 换不成的口径和不合理的因子在接口处拒收（CaliberError）。
 */
import { addDays } from "@ivan/core";
import { describe, expect, it } from "vitest";
import { emKline } from "../sources/emkline.ts";
import { type KBar, klineRange } from "../sources/tencent.ts";
import type { SourceBars } from "../sources/types.ts";
import { FakeHttp, loadFixture } from "../testing/fake-http.ts";
import { adjFromRefPrices, type PriceBar } from "./adjust.ts";
import { CaliberError, toIvanBars } from "./normalize.ts";

const finitePositive = (adj: number[]) => adj.every((x) => Number.isFinite(x) && x > 0);

describe("toIvanBars", () => {
  it("参考前收（东财 A 股夹具）：与 adjFromRefPrices 完全一致，认出 2025-06-26 除息", async () => {
    const http = new FakeHttp([{ match: /push2his/, reply: loadFixture("em-kline-a-raw.json") }]);
    const { bars } = await emKline(http, "600519.SH", "raw", "2025-06-19", "2025-06-30");
    const sb: SourceBars = { bars, caliber: "raw+ref_prev_close", volumeUnit: "infer", currency: "CNY" };
    const out = toIvanBars("600519.SH", sb);
    const ref = adjFromRefPrices(bars);
    expect(out.adj).toEqual(ref.adj);
    expect(out.actions).toEqual(ref.actions);
    expect(out.actions.map((a) => [a.date, a.refPrice])).toEqual([["2025-06-26", 1408.24]]);
    expect(out.adj[0]).toBe(1);
  });

  it("仿射后复权（腾讯茅台夹具）：分解出有限、为正的因子与一次分红", async () => {
    const http = new FakeHttp([
      { match: /,640,$/, reply: loadFixture("tx-kline-raw.json") },
      { match: /,640,hfq$/, reply: loadFixture("tx-kline-hfq.json") },
    ]);
    const raw = await klineRange(http, "600519.SH", "raw", "2025-06-19", "2025-06-30");
    const hfq = await klineRange(http, "600519.SH", "hfq", "2025-06-19", "2025-06-30");
    const out = toIvanBars("600519.SH", {
      bars: raw.map((b) => ({ ...b, amount: null })),
      caliber: "raw+hfq_affine",
      hfq,
      decimals: 3,
      volumeUnit: "infer",
      currency: "CNY",
    });
    expect(finitePositive(out.adj)).toBe(true);
    expect(out.adj[0]).toBe(1);
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0]!.date).toBe("2025-06-26");
    expect(out.actions[0]!.cash).toBeCloseTo(27.624, 1);
    expect(out.adj[5]! / out.adj[4]!).toBeCloseTo(1435.86 / (1435.86 - 27.624), 3);
  });

  it("只派现金的股票（后复权 = 不复权 + 阶梯常数，加法复权）：正常分解成现金事件，不拒收", () => {
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const raw: PriceBar[] = [];
    const hfq: KBar[] = [];
    let b = 0;
    for (let i = 0; i < 90; i++) {
      if (i === 30) b += 0.3;
      if (i === 60) b += 0.25;
      const c = r2(10 + Math.sin(i / 4) * 0.6 - (i >= 30 ? 0.3 : 0) - (i >= 60 ? 0.25 : 0));
      const bar = {
        date: addDays("2024-01-01", i),
        open: r2(c - 0.04),
        close: c,
        high: r2(c + 0.09),
        low: r2(c - 0.11),
      };
      raw.push(bar);
      hfq.push({
        date: bar.date,
        open: r2(bar.open + b),
        close: r2(bar.close + b),
        high: r2(bar.high + b),
        low: r2(bar.low + b),
        volume: 1000,
      });
    }
    const out = toIvanBars("000001.SZ", {
      bars: raw.map((x) => ({ ...x, volume: 1000, amount: null })),
      caliber: "raw+hfq_affine",
      hfq,
      decimals: 2,
      volumeUnit: "infer",
      currency: "CNY",
    });
    expect(finitePositive(out.adj)).toBe(true);
    expect(out.actions.map((a) => [a.date, a.split])).toEqual([
      [raw[30]!.date, 0],
      [raw[60]!.date, 0],
    ]);
    expect(out.actions[0]!.cash).toBeCloseTo(0.3, 2);
    expect(out.actions[1]!.cash).toBeCloseTo(0.25, 2);
  });

  it("复权因子口径：因子归一到首日 1，跳变那天生成除权事实（参考价 = 前收 × 旧因子 / 新因子）", () => {
    const bar = (date: string, close: number) => ({ date, open: close, high: close, low: close, close, volume: 1, amount: null });
    const out = toIvanBars("600000.SH", {
      bars: [bar("2025-06-24", 10), bar("2025-06-25", 10.2), bar("2025-06-26", 9.8), bar("2025-06-27", 9.9)],
      caliber: "raw+adj_factor",
      adjFactor: [2, 2, 2.1, 2.1],
      volumeUnit: "lots",
      currency: "CNY",
    });
    expect(out.adj).toEqual([1, 1, 1.05, 1.05]);
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0]).toMatchObject({ date: "2025-06-26", prevClose: 10.2, cash: null, split: null });
    expect(out.actions[0]!.refPrice).toBeCloseTo((10.2 * 2) / 2.1, 10);
  });

  it("换不成的口径与不合理的因子都抛 CaliberError", () => {
    const bars = [
      { date: "2025-06-24", open: 1, high: 1, low: 1, close: 1, volume: 1, amount: null },
      { date: "2025-06-25", open: 1, high: 1, low: 1, close: 1, volume: 1, amount: null },
    ];
    const base = { bars, volumeUnit: "infer", currency: "CNY" } as const;
    expect(() => toIvanBars("399300.SZ", { ...base, caliber: "total_return" })).toThrow(CaliberError);
    expect(() => toIvanBars("399300.SZ", { ...base, caliber: "price_index" })).toThrow(
      "399300.SZ 的价格口径「price_index」换不成不复权 + 等比因子，拒收",
    );
    expect(() => toIvanBars("600000.SH", { ...base, caliber: "raw+adj_factor", adjFactor: [1, 0] })).toThrow(
      "600000.SH 反推出的复权因子不合理，拒收",
    );
    expect(() => toIvanBars("600000.SH", { ...base, caliber: "raw+adj_factor", adjFactor: [-1, -2] })).toThrow(
      CaliberError,
    );
    expect(() => toIvanBars("600000.SH", { ...base, caliber: "raw+adj_factor", adjFactor: [1] })).toThrow(
      CaliberError,
    );
    expect(() => toIvanBars("00700.HK", { ...base, caliber: "raw+hfq_affine" })).toThrow(CaliberError);
    // 空批次不算不合理
    expect(toIvanBars("600000.SH", { ...base, bars: [], caliber: "raw+ref_prev_close" }).adj).toEqual([]);
  });
});

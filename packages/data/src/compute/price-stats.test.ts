import { describe, expect, it } from "vitest";
import {
  annualVol,
  cagrOf,
  downsample,
  drawdownOf,
  indexOnOrBefore,
  median,
  percentileOf,
  periodStart,
  rangeStats,
  relativeStats,
  vsMovingAverage,
  windowReturns,
} from "./price-stats.ts";

describe("行情区间统计（D99）", () => {
  it("窗口起点：月末对齐、今年以来从上年 12-31 起", () => {
    expect(periodStart("2026-03-31", "1m")).toBe("2026-02-28");
    expect(periodStart("2024-03-31", "1m")).toBe("2024-02-29");
    expect(periodStart("2026-10-20", "ytd")).toBe("2025-12-31");
    expect(periodStart("2026-10-20", "1y")).toBe("2025-10-20");
    expect(periodStart("2026-10-20", "1w")).toBe("2026-10-13");
  });

  it("≤ date 的最后一个下标", () => {
    const d = ["2026-01-02", "2026-01-05", "2026-01-06"];
    expect(indexOnOrBefore(d, "2026-01-01")).toBe(-1);
    expect(indexOnOrBefore(d, "2026-01-04")).toBe(0);
    expect(indexOnOrBefore(d, "2026-01-05")).toBe(1);
    expect(indexOnOrBefore(d, "2027-01-01")).toBe(2);
  });

  it("最大回撤带峰谷与修复日；当前回撤相对区间最高点", () => {
    const d = ["d1", "d2", "d3", "d4", "d5", "d6"];
    const v = [100, 120, 90, 110, 125, 100];
    const r = drawdownOf(d, v);
    expect(r.maxDrawdown).toBeCloseTo(-0.25, 10);
    expect(r.peakDate).toBe("d2");
    expect(r.troughDate).toBe("d3");
    expect(r.recoveryDate).toBe("d5");
    expect(r.currentDrawdown).toBeCloseTo(100 / 125 - 1, 10);
    expect(drawdownOf(["a", "b"], [1, 2]).maxDrawdown).toBe(0);
  });

  it("年化：不足一年不年化", () => {
    expect(cagrOf(0.21, 364)).toBeNull();
    expect(cagrOf(0.21, 730)).toBeCloseTo(0.1, 10);
  });

  it("年化波动：样本太少为 null；常数收益为 0", () => {
    expect(annualVol([0.01, 0.02])).toBeNull();
    expect(annualVol(Array(30).fill(0.01))).toBeCloseTo(0, 12);
  });

  it("β 与相关系数：完全同步时 β = 2、相关 = 1", () => {
    const dates = Array.from({ length: 40 }, (_, i) => `2026-01-${String(i + 1).padStart(2, "0")}`);
    const b: number[] = [100];
    const a: number[] = [100];
    for (let i = 1; i < 40; i++) {
      const r = (i % 3) * 0.01 - 0.01;
      b.push(b[i - 1]! * (1 + r));
      a.push(a[i - 1]! * (1 + 2 * r));
    }
    const rel = relativeStats({ dates, values: a }, { dates, values: b });
    expect(rel.beta).toBeCloseTo(2, 8);
    expect(rel.correlation).toBeCloseTo(1, 8);
    expect(rel.commonDays).toBe(40);
    // 共同日子太少
    expect(relativeStats({ dates: dates.slice(0, 5), values: a }, { dates, values: b }).beta).toBeNull();
  });

  it("多窗口涨跌：历史不够的窗口为 null，不拿短区间冒充", () => {
    const dates = ["2026-09-18", "2026-09-30", "2026-10-13", "2026-10-20"];
    const v = [80, 100, 110, 121];
    const w = windowReturns(dates, v, ["1w", "1m", "1y"]);
    expect(w["1w"]).toBeCloseTo(0.1, 10);
    expect(w["1m"]).toBeCloseTo(121 / 80 - 1, 10);
    expect(w["1y"]).toBeNull();
  });

  it("均线位置、分位、中位数", () => {
    expect(vsMovingAverage([1, 2, 3, 4], 4)).toBeCloseTo(4 / 2.5 - 1, 10);
    expect(vsMovingAverage([1, 2], 4)).toBeNull();
    expect(percentileOf([1, 2, 3, 4], 3)).toBe(62.5);
    expect(percentileOf([], 3)).toBeNull();
    expect(median([3, 1, 2, NaN])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it("降采样保留首尾", () => {
    const xs = Array.from({ length: 1000 }, (_, i) => i);
    const d = downsample(xs, 10);
    expect(d).toHaveLength(10);
    expect(d[0]).toBe(0);
    expect(d.at(-1)).toBe(999);
    expect(downsample([1, 2], 10)).toEqual([1, 2]);
  });

  it("区间统计：起点取起点日当天或之前最后一个交易日；数据更晚开始时标出截断", () => {
    const dates = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"];
    const v = [10, 11, 9.9, 12.1];
    const r = rangeStats(dates, v, "2026-01-06")!;
    expect(r.startIndex).toBe(1);
    expect(r.stats.start).toBe("2026-01-06");
    expect(r.stats.ret).toBeCloseTo(0.1, 10);
    expect(r.stats.startClamped).toBe(false);
    expect(r.stats.upDaysRatio).toBeCloseTo(0.5, 10);
    const c = rangeStats(dates, v, "2025-12-01")!;
    expect(c.stats.startClamped).toBe(true);
    expect(c.stats.start).toBe("2026-01-05");
    expect(rangeStats([], [], null)).toBeNull();
  });
});

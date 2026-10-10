import type { Fan, SeriesPoint } from "@ivan/core";
import { describe, expect, it } from "vitest";
import { weekdays } from "../testing/fixtures.ts";
import { fanPercentile, forwardFan } from "./fan.ts";
import { mulberry32 } from "./prng.ts";

function series(n: number, seed: number, mu = 0.0004, sd = 0.012): SeriesPoint[] {
  const r = mulberry32(seed);
  const dates = weekdays("2016-01-04", n + 1);
  let nav = 1;
  return dates.map((date, i) => {
    if (i > 0) {
      const z = Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
      nav *= 1 + mu + sd * z;
    }
    return { date, nav, bench: 1, cash: 0, positions: 0 };
  });
}

const cfg = { B: 500, blockMean: 21, seed: 99, checkpoints: 60 };

describe("净值扇形", () => {
  it("60 个时点，每个时点 p5 ≤ p25 ≤ p50 ≤ p75 ≤ p95；亏损占比在 [0, 1]", () => {
    const f = forwardFan(series(1200, 1), cfg)!;
    expect(f.horizon).toBe(243);
    expect(f.days).toHaveLength(60);
    expect(f.days.at(-1)).toBe(243);
    for (const k of ["p5", "p25", "p50", "p75", "p95"] as const) expect(f[k]).toHaveLength(60);
    for (let c = 0; c < 60; c++) {
      if (c > 0) expect(f.days[c]).toBeGreaterThan(f.days[c - 1]!);
      expect(f.p5[c]).toBeLessThanOrEqual(f.p25[c]!);
      expect(f.p25[c]).toBeLessThanOrEqual(f.p50[c]!);
      expect(f.p50[c]).toBeLessThanOrEqual(f.p75[c]!);
      expect(f.p75[c]).toBeLessThanOrEqual(f.p95[c]!);
    }
    // 扇形越往后越宽
    expect(f.p95[59]! - f.p5[59]!).toBeGreaterThan(f.p95[0]! - f.p5[0]!);
    expect(f.probLoss).toBeGreaterThanOrEqual(0);
    expect(f.probLoss).toBeLessThanOrEqual(1);
    expect(f.mdd.p5).toBeLessThanOrEqual(f.mdd.p50);
    expect(f.mdd.p50).toBeLessThanOrEqual(f.mdd.p95);
    expect(f.mdd.p95).toBeLessThanOrEqual(0);
  });

  it("历史不到一年：扇形只到历史的长度；同一种子相同", () => {
    const s = series(100, 2);
    const f = forwardFan(s, cfg)!;
    expect(f.horizon).toBe(100);
    expect(f.days).toHaveLength(60);
    expect(JSON.stringify(forwardFan(s, cfg))).toBe(JSON.stringify(f));
    expect(forwardFan(series(59, 2), cfg)).toBeNull();
  });
});

describe("跟踪净值在扇形里的分位", () => {
  const fan: Fan = {
    horizon: 20,
    days: [10, 20],
    p5: [0.9, 0.8],
    p25: [0.95, 0.9],
    p50: [1, 1],
    p75: [1.05, 1.1],
    p95: [1.1, 1.2],
    mdd: { p5: -0.2, p50: -0.1, p95: -0.05 },
    probLoss: 0.4,
  };

  it("时点上：分位线之间线性插值；超出两端记 <5 / >95", () => {
    expect(fanPercentile(fan, 20, 1)).toEqual({ percentile: 50, band: "25-50" });
    expect(fanPercentile(fan, 20, 1.15)).toEqual({ percentile: 85, band: "75-95" });
    expect(fanPercentile(fan, 20, 0.85)).toEqual({ percentile: 15, band: "5-25" });
    expect(fanPercentile(fan, 20, 0.7)).toEqual({ percentile: 5, band: "<5" });
    expect(fanPercentile(fan, 20, 1.3)).toEqual({ percentile: 95, band: ">95" });
  });

  it("时点之间与第一个时点之前（起点净值 1）按天插值；超过一年为 null", () => {
    // 第 15 天：p5 = 0.85，p25 = 0.925
    expect(fanPercentile(fan, 15, 0.8875)!.percentile).toBeCloseTo(15, 9);
    // 第 5 天：p5 = 0.95，p95 = 1.05
    expect(fanPercentile(fan, 5, 1.05)!.percentile).toBeCloseTo(95, 9);
    expect(fanPercentile(fan, 5, 0.94)!.band).toBe("<5");
    expect(fanPercentile(fan, 21, 1)).toBeNull();
    expect(fanPercentile(fan, 0, 1)).toEqual({ percentile: 50, band: "25-50" });
  });
});

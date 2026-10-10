import type { SeriesPoint, StrategySpec, Trade } from "@ivan/core";
import { StrategySpecSchema } from "@ivan/core";
import { describe, expect, it } from "vitest";
import { weekdays } from "../testing/fixtures.ts";
import { confidence, stationaryIndices } from "./bootstrap.ts";
import { mulberry32 } from "./prng.ts";
import { blockMeanFor, validationChecks } from "./validation.ts";

/** 按日收益拼一条序列（起点净值 1） */
function seriesOf(rs: readonly number[], rb: (i: number) => number = () => 0): SeriesPoint[] {
  const dates = weekdays("2018-01-02", rs.length + 1);
  const out: SeriesPoint[] = [{ date: dates[0]!, nav: 1, bench: 1, cash: 0, positions: 0 }];
  for (let i = 0; i < rs.length; i++) {
    const p = out[i]!;
    out.push({
      date: dates[i + 1]!,
      nav: p.nav * (1 + rs[i]!),
      bench: p.bench * (1 + rb(i)),
      cash: 0,
      positions: 0,
    });
  }
  return out;
}

/** 可复现的独立同分布正态日收益 */
function gaussian(n: number, sd: number, seed: number, mu = 0): number[] {
  const r = mulberry32(seed);
  const out: number[] = [];
  while (out.length < n) {
    const u = 1 - r();
    const v = r();
    out.push(mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
  }
  return out;
}

const cfg = { B: 300, maxT: 4000, blockMean: 21, seed: 12345 };

describe("平稳块自助法下标", () => {
  it("都在 [0, T) 内；平均段长约为 L", () => {
    const out = new Int32Array(20_000);
    stationaryIndices(100, 10, mulberry32(1), out);
    let jumps = 0;
    for (let k = 0; k < out.length; k++) {
      expect(out[k]).toBeGreaterThanOrEqual(0);
      expect(out[k]).toBeLessThan(100);
      if (k > 0 && out[k] !== (out[k - 1]! + 1) % 100) jumps++;
    }
    const avgBlock = out.length / (jumps + 1);
    expect(avgBlock).toBeGreaterThan(8);
    expect(avgBlock).toBeLessThan(12.5);
  });
});

describe("可信度区间", () => {
  it("常数日收益：区间退化成一个点", () => {
    const c = confidence(
      seriesOf(Array(300).fill(0.001), () => 0.0005),
      cfg,
    )!;
    for (const k of ["cagr", "excessCagr", "sharpe", "ir", "maxDrawdown"] as const) {
      expect(c[k].lo).toBe(c[k].est);
      expect(c[k].hi).toBe(c[k].est);
    }
    expect(c.maxDrawdown.est).toBe(0);
    expect(c.probExcessPositive).toBe(1);
    expect(c.n).toBe(300);
  });

  it("均值为 0 的 1000 天随机序列：年化超额区间包含 0，PSR 在中间", () => {
    const c = confidence(seriesOf(gaussian(1000, 0.01, 7)), { ...cfg, B: 1000 })!;
    expect(c.excessCagr.lo).toBeLessThan(0);
    expect(c.excessCagr.hi).toBeGreaterThan(0);
    expect(c.excessCagr.lo).toBeLessThanOrEqual(c.excessCagr.est);
    expect(c.excessCagr.hi).toBeGreaterThanOrEqual(c.excessCagr.est);
    expect(c.psrActive).toBeGreaterThan(0.02);
    expect(c.psrActive).toBeLessThan(0.98);
    expect(c.probExcessPositive).toBeGreaterThan(0.02);
    expect(c.probExcessPositive).toBeLessThan(0.98);
    expect(c.actualMddPercentile).toBeGreaterThanOrEqual(0);
    expect(c.actualMddPercentile).toBeLessThanOrEqual(100);
  });

  it("点估计与指标同口径：年化按自然日，最大回撤从起点算", () => {
    const s = seriesOf(gaussian(500, 0.012, 3, 0.0005), (i) => (i % 2 ? 0.001 : -0.0005));
    const c = confidence(s, cfg)!;
    const years = (Date.parse(s.at(-1)!.date) - Date.parse(s[0]!.date)) / 86_400_000 / 365.25;
    expect(c.cagr.est).toBeCloseTo(s.at(-1)!.nav ** (1 / years) - 1, 12);
    expect(c.excessCagr.est).toBeCloseTo((s.at(-1)!.nav / s.at(-1)!.bench) ** (1 / years) - 1, 12);
    let peak = 1;
    let mdd = 0;
    for (const p of s) {
      peak = Math.max(peak, p.nav);
      mdd = Math.min(mdd, p.nav / peak - 1);
    }
    expect(c.maxDrawdown.est).toBeCloseTo(mdd, 12);
  });

  it("同一种子结果完全相同；换种子不同", () => {
    const s = seriesOf(gaussian(400, 0.01, 11, 0.0003));
    expect(JSON.stringify(confidence(s, cfg))).toBe(JSON.stringify(confidence(s, cfg)));
    expect(confidence(s, { ...cfg, seed: 1 })!.excessCagr).not.toEqual(
      confidence(s, cfg)!.excessCagr,
    );
  });

  it("日收益不到 60 个时为 null；只用最近 maxT 个", () => {
    expect(confidence(seriesOf(Array(59).fill(0.001)), cfg)).toBeNull();
    expect(confidence(seriesOf(Array(60).fill(0.001)), cfg)).not.toBeNull();
    expect(confidence(seriesOf(gaussian(300, 0.01, 2)), { ...cfg, maxT: 100 })!.n).toBe(100);
  });
});

describe("平均段长与检查", () => {
  const rules = (every: "week" | "month" | "quarter"): StrategySpec =>
    StrategySpecSchema.parse({
      name: "x",
      market: "A",
      rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 5 },
      rebalance: { every, buffer: 1.5 },
    });
  const trade = (code: string, side: "buy" | "sell", date: string, holdDays?: number): Trade => ({
    date,
    code,
    side,
    price: 10,
    shares: 100,
    amount: 1000,
    fee: 1,
    reason: side === "buy" ? "signal" : "max_hold",
    ...(holdDays !== undefined ? { pnl: 5, holdDays } : {}),
  });

  it("规则模式按调仓周期：周 5、月 21、季 63", () => {
    expect(blockMeanFor(rules("week"), [])).toBe(5);
    expect(blockMeanFor(rules("month"), [])).toBe(21);
    expect(blockMeanFor(rules("quarter"), [])).toBe(63);
  });

  it("信号模式取完整持仓天数中位数，夹在 5–63", () => {
    const sig = { ...rules("month"), mode: "signals" } as StrategySpec;
    const trips = (days: number[]) =>
      days.flatMap((d, i) => [
        trade(`00000${i}.SZ`, "buy", "2020-01-02"),
        trade(`00000${i}.SZ`, "sell", "2020-03-02", d),
      ]);
    expect(blockMeanFor(sig, trips([10, 12, 30]))).toBe(12);
    expect(blockMeanFor(sig, trips([2, 3, 1]))).toBe(5);
    expect(blockMeanFor(sig, trips([100, 200]))).toBe(63);
    expect(blockMeanFor(sig, [])).toBe(21);
  });

  it("超额为正但区间下沿 ≤ 0 → low_confidence；回撤比 75% 的路径都轻 → optimistic_drawdown", () => {
    const base = confidence(seriesOf(gaussian(300, 0.01, 5)), cfg)!;
    const v = {
      ...base,
      excessCagr: { est: 0.042, lo: -0.018, hi: 0.099 },
      actualMddPercentile: 80,
      mddMedian: -0.25,
    };
    const checks = validationChecks(v, { maxDrawdown: -0.12 } as never);
    expect(checks.map((c) => [c.id, c.level])).toEqual([
      ["low_confidence", "warn"],
      ["optimistic_drawdown", "info"],
    ]);
    expect(checks[0]!.detail).toBe(
      "年化超额 +4.2%，但按历史重抽样的 95% 区间是 -1.8% ~ +9.9%，不能排除是运气。",
    );
    expect(checks[1]!.detail).toBe(
      "回测最大回撤 -12.0%，比 80% 的重抽样路径都轻；重抽样中位数 -25.0%。",
    );
    // 下沿 > 0 或超额本身 ≤ 0：不提示
    expect(
      validationChecks(
        { ...v, excessCagr: { est: 0.04, lo: 0.001, hi: 0.08 }, actualMddPercentile: 50 },
        { maxDrawdown: -0.1 } as never,
      ),
    ).toEqual([]);
    expect(
      validationChecks(
        { ...v, excessCagr: { est: -0.01, lo: -0.05, hi: 0.03 }, actualMddPercentile: 74.9 },
        { maxDrawdown: -0.1 } as never,
      ),
    ).toEqual([]);
  });
});

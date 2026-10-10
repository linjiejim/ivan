/**
 * 未来一年的净值扇形（D65）：用同一套平稳块自助法把历史日收益接成 B 条一年（最多 243 个交易日）的路径，
 * 按**绝对净值**（起点 1，不扣基准）取 60 个时点的 5 / 25 / 50 / 75 / 95 分位。这是区间，不是预测。
 * 跟踪结算时用 fanPercentile 看跟踪净值落在扇形的哪一档。
 */
import type { Fan, SeriesPoint } from "@ivan/core";
import { dailyPairs, stationaryIndices } from "./bootstrap.ts";
import { quantile7 } from "./moments.ts";
import { mulberry32 } from "./prng.ts";

/** 一年按 243 个交易日算 */
export const FAN_HORIZON = 243;

export function forwardFan(
  series: readonly SeriesPoint[],
  cfg: {
    B: number;
    blockMean: number;
    seed: number;
    checkpoints: number;
    horizon?: number;
    maxT?: number;
  },
): Fan | null {
  const pairs = dailyPairs(series, cfg.maxT ?? Number.POSITIVE_INFINITY);
  if (!pairs) return null;
  const { rs } = pairs;
  const T = rs.length;
  const H = Math.min(cfg.horizon ?? FAN_HORIZON, T);
  const K = Math.min(cfg.checkpoints, H);
  const days = Array.from({ length: K }, (_, k) => Math.round(((k + 1) * H) / K));
  // 与区间用不同的随机流，免得两者的抽样一模一样
  const rng = mulberry32((cfg.seed ^ 0x9e3779b9) >>> 0);
  const idx = new Int32Array(H);
  const at = days.map(() => new Float64Array(cfg.B));
  const mdd = new Float64Array(cfg.B);
  let loss = 0;
  for (let b = 0; b < cfg.B; b++) {
    stationaryIndices(T, cfg.blockMean, rng, idx);
    let nav = 1;
    let peak = 1;
    let dd = 0;
    let c = 0;
    for (let d = 1; d <= H; d++) {
      nav *= 1 + rs[idx[d - 1]!]!;
      if (nav > peak) peak = nav;
      const x = nav / peak - 1;
      if (x < dd) dd = x;
      if (d === days[c]) at[c++]![b] = nav;
    }
    mdd[b] = dd;
    if (nav < 1) loss++;
  }
  const q = (p: number) => at.map((xs) => quantile7(xs, p));
  for (const xs of at) xs.sort();
  mdd.sort();
  return {
    horizon: H,
    days,
    p5: q(0.05),
    p25: q(0.25),
    p50: q(0.5),
    p75: q(0.75),
    p95: q(0.95),
    mdd: { p5: quantile7(mdd, 0.05), p50: quantile7(mdd, 0.5), p95: quantile7(mdd, 0.95) },
    probLoss: loss / cfg.B,
  };
}

export type FanBand = "<5" | "5-25" | "25-50" | "50-75" | "75-95" | ">95";

const LEVELS = [5, 25, 50, 75, 95] as const;
const BANDS: FanBand[] = ["5-25", "25-50", "50-75", "75-95"];

/**
 * 第 day 个交易日（0 = 起点，净值 1）的净值 nav 落在扇形的第几百分位：在相邻时点之间线性插值出五条分位线，
 * 在分位线之间再线性插值（保留一位小数）；低于 5 分位记 5（band「<5」），高于 95 分位记 95（band「>95」）。
 * 超出扇形的一年（day > horizon）或参数不合法时返回 null。
 */
export function fanPercentile(
  fan: Fan,
  day: number,
  nav: number,
): { percentile: number; band: FanBand } | null {
  if (!(day >= 0) || day > fan.horizon || !Number.isFinite(nav) || !fan.days.length) return null;
  const lines = [fan.p5, fan.p25, fan.p50, fan.p75, fan.p95];
  // 时点前后两格（起点 day 0 的五条线都是 1）
  let c = fan.days.findIndex((d) => d >= day);
  if (c < 0) c = fan.days.length - 1;
  const d1 = fan.days[c]!;
  const d0 = c > 0 ? fan.days[c - 1]! : 0;
  const w = d1 > d0 ? (day - d0) / (d1 - d0) : 1;
  const v = lines.map((l) => {
    const a = c > 0 ? l[c - 1]! : 1;
    return a + w * (l[c]! - a);
  });
  // 起点（五条线都是 1）没有区分度
  if (v[4]! - v[0]! <= 0) return { percentile: 50, band: "25-50" };
  if (nav < v[0]!) return { percentile: 5, band: "<5" };
  if (nav > v[4]!) return { percentile: 95, band: ">95" };
  for (let k = 0; k < 4; k++) {
    if (nav <= v[k + 1]!) {
      const span = v[k + 1]! - v[k]!;
      const f = span > 0 ? (nav - v[k]!) / span : 0.5;
      const pc = LEVELS[k]! + f * (LEVELS[k + 1]! - LEVELS[k]!);
      return { percentile: Math.round(pc * 10) / 10, band: BANDS[k]! };
    }
  }
  return { percentile: 95, band: "75-95" };
}

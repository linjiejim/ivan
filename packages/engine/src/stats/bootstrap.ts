/**
 * 可信度区间（D65）：（策略, 基准）日收益成对做平稳块自助法（Politis–Romano 1994）。
 * 段长服从均值 L 的几何分布，保留日收益的自相关；成对抽样保留策略与基准的相关。
 * 年化按自然日：每年观测数 = 收益个数 ÷（末日 − 首日）/ 365.25，与指标一致。
 */
import type { Confidence, Interval, SeriesPoint } from "@ivan/core";
import { diffDays } from "@ivan/core";
import { kurtosis, mean, quantile7, sampleSd, skewness } from "./moments.ts";
import { mulberry32 } from "./prng.ts";
import { psr } from "./psr.ts";

/** 至少要这么多个日收益才算区间 */
export const MIN_RETURNS = 60;

/**
 * 平稳块自助法的下标：起点均匀抽；之后每一步以 1 − 1/L 的概率接着下一天（到末尾绕回开头），否则重新均匀抽。
 * 填满 out（长度可以不等于 T）。
 */
export function stationaryIndices(
  T: number,
  L: number,
  rng: () => number,
  out: Int32Array,
): Int32Array {
  const pJump = 1 / L;
  let i = Math.floor(rng() * T);
  for (let k = 0; k < out.length; k++) {
    if (k > 0) i = rng() < pJump ? Math.floor(rng() * T) : (i + 1) % T;
    out[k] = i;
  }
  return out;
}

/** 日收益序列（策略与基准对齐）、用到的日历跨度 */
export interface DailyPairs {
  rs: Float64Array;
  rb: Float64Array;
  /** 每年观测数 */
  perYear: number;
  years: number;
}

/** 取最后 min(收益个数, maxT) 个成对日收益；不够 MIN_RETURNS 个时返回 null */
export function dailyPairs(series: readonly SeriesPoint[], maxT: number): DailyPairs | null {
  const n = series.length - 1;
  if (n < MIN_RETURNS) return null;
  const T = Math.min(n, maxT);
  const off = series.length - 1 - T;
  const rs = new Float64Array(T);
  const rb = new Float64Array(T);
  for (let k = 0; k < T; k++) {
    const a = series[off + k]!;
    const b = series[off + k + 1]!;
    rs[k] = b.nav / a.nav - 1;
    rb[k] = b.bench / a.bench - 1;
  }
  if (![...rs, ...rb].every(Number.isFinite)) return null;
  const years = diffDays(series.at(-1)!.date, series[off]!.date) / 365.25;
  if (!(years > 0)) return null;
  return { rs, rb, perYear: T / years, years };
}

/** 波动小到这个程度就当作 0（全现金、常数收益）：避免浮点误差除出一个巨大的夏普 */
const SD_EPS = 1e-12;

/** 年化的均值 ÷ 标准差（夏普、信息比率）；标准差为 0 时记 0，与指标一致 */
function annRatio(m: number, sd: number, perYear: number): number {
  return sd > SD_EPS ? (m / sd) * Math.sqrt(perYear) : 0;
}

/** 一组下标（或全部）上的各项统计量 */
function stats(
  rs: Float64Array,
  rb: Float64Array,
  idx: Int32Array | null,
  perYear: number,
): { cagr: number; excess: number; sharpe: number; ir: number; mdd: number } {
  const T = idx ? idx.length : rs.length;
  let gs = 1;
  let gb = 1;
  let peak = 1;
  let mdd = 0;
  let sumS = 0;
  let sumA = 0;
  for (let k = 0; k < T; k++) {
    const j = idx ? idx[k]! : k;
    const s = rs[j]!;
    const b = rb[j]!;
    gs *= 1 + s;
    gb *= 1 + b;
    if (gs > peak) peak = gs;
    const dd = gs / peak - 1;
    if (dd < mdd) mdd = dd;
    sumS += s;
    sumA += s - b;
  }
  const mS = sumS / T;
  const mA = sumA / T;
  let ssS = 0;
  let ssA = 0;
  for (let k = 0; k < T; k++) {
    const j = idx ? idx[k]! : k;
    const s = rs[j]!;
    ssS += (s - mS) ** 2;
    ssA += (s - rb[j]! - mA) ** 2;
  }
  const sdS = Math.sqrt(ssS / Math.max(1, T - 1));
  const sdA = Math.sqrt(ssA / Math.max(1, T - 1));
  const e = perYear / T;
  return {
    cagr: gs > 0 ? gs ** e - 1 : -1,
    excess: gs > 0 && gb > 0 ? (gs / gb) ** e - 1 : -1,
    sharpe: annRatio(mS, sdS, perYear),
    ir: annRatio(mA, sdA, perYear),
    mdd,
  };
}

function interval(est: number, xs: Float64Array): Interval {
  xs.sort();
  return { est, lo: quantile7(xs, 0.025), hi: quantile7(xs, 0.975) };
}

/**
 * 各项统计量的 95% 区间、超额为正的重抽样占比、主动收益的 PSR、实际回撤在重抽样里的位置。
 * series 是带锚点的序列（指标第 2 版：从投入第一笔钱算起）；日收益少于 60 个时返回 null。
 */
export function confidence(
  series: readonly SeriesPoint[],
  cfg: { B: number; maxT: number; blockMean: number; seed: number },
): Confidence | null {
  const pairs = dailyPairs(series, cfg.maxT);
  if (!pairs) return null;
  const { rs, rb, perYear } = pairs;
  const T = rs.length;
  const actual = stats(rs, rb, null, perYear);
  const rng = mulberry32(cfg.seed);
  const idx = new Int32Array(T);
  const cagr = new Float64Array(cfg.B);
  const excess = new Float64Array(cfg.B);
  const sharpe = new Float64Array(cfg.B);
  const ir = new Float64Array(cfg.B);
  const mdd = new Float64Array(cfg.B);
  let positive = 0;
  let deeper = 0;
  for (let b = 0; b < cfg.B; b++) {
    stationaryIndices(T, cfg.blockMean, rng, idx);
    const s = stats(rs, rb, idx, perYear);
    cagr[b] = s.cagr;
    excess[b] = s.excess;
    sharpe[b] = s.sharpe;
    ir[b] = s.ir;
    mdd[b] = s.mdd;
    if (s.excess > 0) positive++;
    if (s.mdd < actual.mdd) deeper++;
  }
  const active = Array.from(rs, (x, k) => x - rb[k]!);
  const sdA = sampleSd(active);
  const mddI = interval(actual.mdd, mdd);
  return {
    method: "stationary_bootstrap",
    version: 1,
    B: cfg.B,
    blockMean: cfg.blockMean,
    seed: cfg.seed,
    n: T,
    cagr: interval(actual.cagr, cagr),
    excessCagr: interval(actual.excess, excess),
    sharpe: interval(actual.sharpe, sharpe),
    ir: interval(actual.ir, ir),
    maxDrawdown: mddI,
    mddMedian: quantile7(mdd, 0.5),
    probExcessPositive: positive / cfg.B,
    psrActive: sdA > SD_EPS ? psr(mean(active) / sdA, T, skewness(active), kurtosis(active)) : null,
    actualMddPercentile: (100 * deeper) / cfg.B,
  };
}

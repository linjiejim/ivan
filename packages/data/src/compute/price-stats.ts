/**
 * 行情区间统计（纯函数，对话分析工具用，spec 20261020 D99）：区间收益、年化、最大回撤（含峰谷与修复日）、年化波动、
 * 相对基准的超额 / β / 相关系数、多窗口涨跌、均线位置、分位与降采样。
 *
 * 口径：收益、回撤、波动都按「复权价」算（个股 = 不复权收盘 × 等比复权因子，分红再投入；指数 = 点位），
 * 区间收益从「起点当天或之前最后一个交易日」的收盘算到终点收盘；年化按自然日 365 天，波动按每年 250 个交易日。
 */
import type { DrawdownStats, PeriodKey, RangeStats } from "@ivan/core";
import { addDays, addMonths, type DateStr, diffDays } from "@ivan/core";

/** 一年按多少个交易日年化波动（A 股、港股都按 250，和因子 volatility_60d 同口径） */
export const TRADING_DAYS_PER_YEAR = 250;

/** 多窗口涨跌固定看这几个（卡片一行、模型一份） */
export const WINDOW_KEYS: readonly PeriodKey[] = ["1w", "1m", "3m", "6m", "ytd", "1y", "3y", "5y"];

/**
 * 窗口的「起点日」：区间收益从这天（或之前最后一个交易日）的收盘算起。
 * ytd 的起点是上一年的 12-31（今年第一个交易日的涨跌也算进去）。
 */
export function periodStart(end: DateStr, period: PeriodKey): DateStr {
  switch (period) {
    case "1w":
      return addDays(end, -7);
    case "1m":
      return addMonths(end, -1);
    case "3m":
      return addMonths(end, -3);
    case "6m":
      return addMonths(end, -6);
    case "ytd":
      return `${Number(end.slice(0, 4)) - 1}-12-31`;
    case "1y":
      return addMonths(end, -12);
    case "2y":
      return addMonths(end, -24);
    case "3y":
      return addMonths(end, -36);
    case "5y":
      return addMonths(end, -60);
    case "10y":
      return addMonths(end, -120);
  }
}

/** 有序日期里 ≤ date 的最后一个下标；没有为 -1 */
export function indexOnOrBefore(dates: readonly DateStr[], date: DateStr): number {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (dates[mid]! <= date) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** 年化：区间收益 r、跨 days 个自然日；不足 1 年不年化（返回 null，年化会把短期波动放大成误导性的数） */
export function cagrOf(r: number, days: number): number | null {
  if (!(days >= 365) || !Number.isFinite(r) || r <= -1) return null;
  return (1 + r) ** (365 / days) - 1;
}

/** 逐日简单收益 */
export function dailyReturns(values: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const a = values[i - 1]!;
    const b = values[i]!;
    if (a > 0 && Number.isFinite(b)) out.push(b / a - 1);
  }
  return out;
}

function mean(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** 样本标准差；少于 2 个为 NaN */
export function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

/** 年化波动；少于 20 个收益样本时为 null（太短的波动没有意义） */
export function annualVol(rets: readonly number[]): number | null {
  if (rets.length < 20) return null;
  return stdev(rets) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/** 最大回撤：峰值从区间第一天起算 */
export function drawdownOf(dates: readonly DateStr[], values: readonly number[]): DrawdownStats {
  let peak = -Infinity;
  let peakAt = -1;
  let mdd = 0;
  let mddPeak = -1;
  let mddTrough = -1;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) continue;
    if (v > peak) {
      peak = v;
      peakAt = i;
    }
    const dd = v / peak - 1;
    if (dd < mdd) {
      mdd = dd;
      mddPeak = peakAt;
      mddTrough = i;
    }
  }
  let recovery = -1;
  if (mddTrough >= 0) {
    const level = values[mddPeak]!;
    for (let i = mddTrough + 1; i < values.length; i++) {
      if (values[i]! >= level) {
        recovery = i;
        break;
      }
    }
  }
  const last = values.at(-1);
  return {
    maxDrawdown: mdd,
    peakDate: mddPeak >= 0 ? dates[mddPeak]! : null,
    troughDate: mddTrough >= 0 ? dates[mddTrough]! : null,
    recoveryDate: recovery >= 0 ? dates[recovery]! : null,
    currentDrawdown: last !== undefined && peak > 0 ? last / peak - 1 : 0,
  };
}

/**
 * 两条序列在共同交易日上的相对表现：β（对基准）、相关系数、各自区间收益与超额。
 * 只用两边都有收盘的日子；共同日子少于 20 天时 β 与相关系数为 null。
 */
export function relativeStats(
  a: { dates: readonly DateStr[]; values: readonly number[] },
  b: { dates: readonly DateStr[]; values: readonly number[] },
): { beta: number | null; correlation: number | null; commonDays: number } {
  const bm = new Map<DateStr, number>();
  b.dates.forEach((d, i) => bm.set(d, b.values[i]!));
  const xa: number[] = [];
  const xb: number[] = [];
  for (let i = 0; i < a.dates.length; i++) {
    const v = bm.get(a.dates[i]!);
    if (v !== undefined && Number.isFinite(v) && Number.isFinite(a.values[i]!)) {
      xa.push(a.values[i]!);
      xb.push(v);
    }
  }
  const ra: number[] = [];
  const rb: number[] = [];
  for (let i = 1; i < xa.length; i++) {
    if (xa[i - 1]! > 0 && xb[i - 1]! > 0) {
      ra.push(xa[i]! / xa[i - 1]! - 1);
      rb.push(xb[i]! / xb[i - 1]! - 1);
    }
  }
  if (ra.length < 20) return { beta: null, correlation: null, commonDays: xa.length };
  const ma = mean(ra);
  const mb = mean(rb);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < ra.length; i++) {
    cov += (ra[i]! - ma) * (rb[i]! - mb);
    va += (ra[i]! - ma) ** 2;
    vb += (rb[i]! - mb) ** 2;
  }
  return {
    beta: vb > 0 ? cov / vb : null,
    correlation: va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : null,
    commonDays: xa.length,
  };
}

/**
 * 截至 end 的多窗口涨跌：起点是窗口起点日当天或之前最后一个交易日的收盘。
 * 历史不够（序列从窗口起点之后才开始）的窗口为 null，不拿更短的区间冒充。
 */
export function windowReturns(
  dates: readonly DateStr[],
  values: readonly number[],
  keys: readonly PeriodKey[] = WINDOW_KEYS,
): Partial<Record<PeriodKey, number | null>> {
  const out: Partial<Record<PeriodKey, number | null>> = {};
  const n = values.length;
  if (!n) return out;
  const end = dates[n - 1]!;
  const last = values[n - 1]!;
  for (const k of keys) {
    const i = indexOnOrBefore(dates, periodStart(end, k));
    out[k] = i >= 0 && values[i]! > 0 ? last / values[i]! - 1 : null;
  }
  return out;
}

/** 终点相对 n 日均线的位置（收盘 / 均线 − 1）；样本不足为 null */
export function vsMovingAverage(values: readonly number[], n: number): number | null {
  if (values.length < n) return null;
  let s = 0;
  for (let i = values.length - n; i < values.length; i++) s += values[i]!;
  const ma = s / n;
  return ma > 0 ? values.at(-1)! / ma - 1 : null;
}

/** x 在样本里的百分位（0–100）：严格小于 x 的比例 + 相同值的一半，和因子的 5 年分位同口径 */
export function percentileOf(sample: readonly number[], x: number): number | null {
  const xs = sample.filter((v) => Number.isFinite(v));
  if (!xs.length || !Number.isFinite(x)) return null;
  let lt = 0;
  let eq = 0;
  for (const v of xs) {
    if (v < x) lt++;
    else if (v === x) eq++;
  }
  return ((lt + eq / 2) / xs.length) * 100;
}

export function median(sample: readonly number[]): number | null {
  const xs = sample.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = xs.length >>> 1;
  return xs.length % 2 ? xs[m]! : (xs[m - 1]! + xs[m]!) / 2;
}

/** 等距抽样到最多 max 个点，首尾一定保留（画图用，统计一律用全量） */
export function downsample<T>(xs: readonly T[], max: number): T[] {
  if (xs.length <= max) return [...xs];
  const out: T[] = [];
  const step = (xs.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(xs[Math.round(i * step)]!);
  return out;
}

/**
 * 一条复权序列在 [from, end] 上的统计。from 为 null 时从第一天起。
 * 返回 null：区间里没有数据。
 */
export function rangeStats(
  dates: readonly DateStr[],
  values: readonly number[],
  from: DateStr | null,
): { stats: RangeStats; startIndex: number } | null {
  if (!dates.length) return null;
  let s = from ? indexOnOrBefore(dates, from) : 0;
  const startClamped = from !== null && s < 0;
  if (s < 0) s = 0;
  const d = dates.slice(s);
  const v = values.slice(s);
  if (!v.length || !(v[0]! > 0)) return null;
  const ret = v.at(-1)! / v[0]! - 1;
  const rets = dailyReturns(v);
  const up = rets.filter((r) => r > 0).length;
  return {
    startIndex: s,
    stats: {
      start: d[0]!,
      end: d.at(-1)!,
      startClamped,
      tradingDays: v.length,
      ret,
      cagr: cagrOf(ret, diffDays(d.at(-1)!, d[0]!)),
      volatility: annualVol(rets),
      upDaysRatio: rets.length ? up / rets.length : null,
      drawdown: drawdownOf(d, v),
    },
  };
}

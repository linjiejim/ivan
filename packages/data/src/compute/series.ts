/**
 * 时间序列小工具（纯函数）：滚动分位、均线、滚动极值与标准差。
 */
import type { DateStr } from "@ivan/core";

/** 滚动窗口分位：窗口内维护有序数组，插入/删除 O(w)，查询 O(log w)。 */
export class SortedWindow {
  private sorted: number[] = [];

  get size(): number {
    return this.sorted.length;
  }

  private lowerBound(x: number): number {
    let lo = 0;
    let hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.sorted[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  add(x: number): void {
    this.sorted.splice(this.lowerBound(x), 0, x);
  }

  remove(x: number): void {
    const i = this.lowerBound(x);
    if (i < this.sorted.length && this.sorted[i] === x) this.sorted.splice(i, 1);
  }

  /** x 在窗口中的百分位（0–100）：严格小于 x 的比例，相同值取一半。 */
  percentile(x: number): number {
    if (!this.sorted.length) return NaN;
    const lo = this.lowerBound(x);
    let hi = lo;
    while (hi < this.sorted.length && this.sorted[hi] === x) hi++;
    return ((lo + (hi - lo) / 2) / this.sorted.length) * 100;
  }
}

/**
 * 按「交易日序号」滚动的分位：只收正值（PE/PB 只算 >0 的日子），窗口 = 最近 window 个交易日。
 * 返回每天的分位；样本数不足 minSamples 时为 NaN。
 */
export function rollingPercentile(
  values: ArrayLike<number>,
  window: number,
  minSamples: number,
): Float64Array {
  const out = new Float64Array(values.length).fill(NaN);
  const w = new SortedWindow();
  for (let t = 0; t < values.length; t++) {
    const old = t - window;
    if (old >= 0) {
      const v = values[old]!;
      if (v > 0) w.remove(v);
    }
    const v = values[t]!;
    if (v > 0) {
      w.add(v);
      if (w.size >= minSamples) out[t] = w.percentile(v);
    }
  }
  return out;
}

/** 简单移动平均；不足 n 个时为 NaN。 */
export function sma(xs: ArrayLike<number>, n: number): Float64Array {
  const out = new Float64Array(xs.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < xs.length; i++) {
    sum += xs[i]!;
    if (i >= n) sum -= xs[i - n]!;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** 滚动最大值（单调队列）。 */
export function rollingMax(xs: ArrayLike<number>, n: number): Float64Array {
  const out = new Float64Array(xs.length).fill(NaN);
  const dq: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    while (dq.length && xs[dq[dq.length - 1]!]! <= xs[i]!) dq.pop();
    dq.push(i);
    if (dq[0]! <= i - n) dq.shift();
    if (i >= n - 1) out[i] = xs[dq[0]!]!;
  }
  return out;
}

/** 滚动标准差（样本标准差）。 */
export function rollingStd(xs: ArrayLike<number>, n: number): Float64Array {
  const out = new Float64Array(xs.length).fill(NaN);
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!;
    s += x;
    s2 += x * x;
    if (i >= n) {
      const o = xs[i - n]!;
      s -= o;
      s2 -= o * o;
    }
    if (i >= n - 1) out[i] = Math.sqrt(Math.max(0, (s2 - (s * s) / n) / (n - 1)));
  }
  return out;
}

export interface ShareChange {
  eff_date: DateStr;
  total_shares: number;
  reason: string | null;
}

/** 送转/拆并股的原因关键词：这些变动会让复权因子跳，但不是现金分红。 */
export const SPLIT_REASON_RE = /送|转增|红股|拆细|拆股|合并|合股|分拆/;

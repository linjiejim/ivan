/**
 * 描述统计（纯函数，指标第 2 版用，D63）。空数组或分母为 0 时返回 NaN，由调用方决定怎么显示。
 */

export function mean(xs: readonly number[]): number {
  if (!xs.length) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** 样本标准差（除以 n − 1） */
export function sampleSd(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (n - 1));
}

/** 样本协方差（除以 n − 1） */
export function sampleCov(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return NaN;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let s = 0;
  for (let i = 0; i < n; i++) s += (xs[i]! - mx) * (ys[i]! - my);
  return s / (n - 1);
}

/** 第 k 阶中心矩（除以 n） */
function centralMoment(xs: readonly number[], k: number): number {
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** k;
  return s / xs.length;
}

/** 偏度 = m3 / m2^1.5 */
export function skewness(xs: readonly number[]): number {
  if (!xs.length) return NaN;
  const m2 = centralMoment(xs, 2);
  return m2 > 0 ? centralMoment(xs, 3) / m2 ** 1.5 : NaN;
}

/** 峰度（非超额，正态为 3）= m4 / m2² */
export function kurtosis(xs: readonly number[]): number {
  if (!xs.length) return NaN;
  const m2 = centralMoment(xs, 2);
  return m2 > 0 ? centralMoment(xs, 4) / m2 ** 2 : NaN;
}

/** 分位数（R 的 type 7：线性插值，h = (n − 1)p）；sorted 必须升序 */
export function quantile7(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (!n) return NaN;
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, n - 1);
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}

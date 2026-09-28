/**
 * 跟踪 vs 回测的偏离百分位（spec §7）：跟踪期（k 个交易日）的累计超额，放到回测里所有长度为 k 的
 * 窗口超额里看排第几。例：「跟踪 40 天超额 −3.2%，处于回测同长度窗口的第 18 百分位」。
 */
import type { SeriesPoint } from "@ivan/core";

export function windowExcesses(series: readonly SeriesPoint[], k: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + k < series.length; i++) {
    const a = series[i]!;
    const b = series[i + k]!;
    out.push(b.nav / a.nav / (b.bench / a.bench) - 1);
  }
  return out;
}

/** 返回 0–100；样本太少（跟踪不足 5 天或回测窗口不足 20 个）返回 null。 */
export function deviationPercentile(
  baseline: readonly SeriesPoint[],
  trackingExcess: number,
  k: number,
): number | null {
  if (k < 5) return null;
  const xs = windowExcesses(baseline, k);
  if (xs.length < 20) return null;
  let below = 0;
  let equal = 0;
  for (const x of xs) {
    if (x < trackingExcess) below++;
    else if (x === trackingExcess) equal++;
  }
  return ((below + equal / 2) / xs.length) * 100;
}

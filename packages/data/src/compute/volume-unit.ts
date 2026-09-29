/**
 * A 股成交量单位（D51）：入库一律是「股」。
 * - 腾讯日 K 与实时报价：主板、创业板、北交所是「手」（×100），科创板（688/689）本来就是「股」（2026-09 实测）。
 * - 有成交额时不看来源口径：成交额 ÷（价格 × 成交量）≈ 100 说明是「手」，≈ 1 说明是「股」。
 * 港股两家都是「股」。
 */
import { marketOf } from "@ivan/core";

export const STAR_RE = /^68[89]\d{3}\.SH$/;

/** 按板块的默认单位：科创板与港股 1，其余 A 股 100。 */
export function boardVolumeMultiplier(code: string): number {
  if (marketOf(code) !== "A") return 1;
  return STAR_RE.test(code) ? 1 : 100;
}

/** 由成交额反推单位；数据不够判断时返回 null。 */
export function inferVolumeMultiplier(
  bars: ReadonlyArray<{ close: number; volume: number; amount?: number | null }>,
): 1 | 100 | null {
  const ratios: number[] = [];
  for (const b of bars) {
    const a = b.amount;
    if (a && a > 0 && b.volume > 0 && b.close > 0) ratios.push(a / (b.close * b.volume));
  }
  if (!ratios.length) return null;
  ratios.sort((x, y) => x - y);
  const med = ratios[Math.floor(ratios.length / 2)]!;
  if (med > 20) return 100;
  if (med > 0.2 && med < 5) return 1;
  return null;
}

/** 一段 K 线的单位：能从成交额判断就用判断结果，否则按板块。 */
export function volumeMultiplier(
  code: string,
  bars: ReadonlyArray<{ close: number; volume: number; amount?: number | null }> = [],
): number {
  if (marketOf(code) !== "A") return 1;
  return inferVolumeMultiplier(bars) ?? boardVolumeMultiplier(code);
}

/**
 * 一次性修正已入库的 A 股成交量（D51）。旧代码对 A 股一律 ×100，科创板因此被放大了 100 倍：
 * 1. 有成交额的行（东财日 K、实时报价）：价格 × 成交量 远大于成交额（比值 < 0.05，正常 ≈ 1）→ 除以 100；
 * 2. 没有成交额的科创板行（腾讯日 K，本来就是「股」）→ 一律除以 100。
 * 第 2 条不是幂等的，所以由行情仓按 meta 键只跑一次（见 warehouse/schema.ts 的 DATA_FIXES）。
 */
export const FIX_A_VOLUME_SQL = [
  `UPDATE bars_daily SET volume = volume / 100
   WHERE code NOT LIKE '%.HK' AND amount > 0 AND volume > 0 AND close > 0 AND amount / (close * volume) < 0.05`,
  `UPDATE bars_daily SET volume = volume / 100
   WHERE amount IS NULL AND volume > 0 AND regexp_matches(code, '^68[89][0-9]{3}\\.SH$')`,
];

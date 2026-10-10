/**
 * 口径归一（D72）：把各来源的价格口径换成 Ivan 的「不复权 + 等比因子（分红再投入）」与除权事实。
 * - raw+ref_prev_close → adjFromRefPrices（东财 A 股单请求路径，D31）
 * - raw+hfq_affine → decomposeHfq：后复权 = a × 不复权 + b。加法复权（只派现金）是 a = 1 的仿射，同样能还原，
 *   所以**不另做加法口径检测**——检测器反而会把只派现金的股票误判（D74）
 * - raw+adj_factor → 因子归一到首日 = 1，因子跳变处生成除权事实（给以后接的复权因子来源用）
 * - 其他口径（总收益、价格指数）→ CaliberError，这只股票拒收
 * 每条路径最后都查一遍：因子全部有限、> 0、首日 = 1，否则 CaliberError（S13 记缺失原因 rejected:caliber）。
 */
import type { KBar } from "../sources/tencent.ts";
import type { SourceBar, SourceBars } from "../sources/types.ts";
import { adjFromRefPrices, type CorpAction, decomposeHfq, type RefAction } from "./adjust.ts";

/** 口径换算失败：这只股票的这批日线不入库 */
export class CaliberError extends Error {}

/** 后复权反推出来的事件 → 除权事实（前收、参考价） */
export function toRefActions(raw: readonly KBar[], events: readonly CorpAction[]): RefAction[] {
  const idx = new Map(raw.map((b, i) => [b.date, i]));
  return events.map((e) => {
    const i = idx.get(e.date) ?? 0;
    const prev = i > 0 ? raw[i - 1]!.close : raw[i]!.close;
    return {
      date: e.date,
      prevClose: prev,
      refPrice: (prev - e.cash) / (1 + e.split),
      cash: e.cash,
      split: e.split,
    };
  });
}

/**
 * 复权因子口径：adj[i] = f[i] / f[0]；f 在 t 天变了就是一次除权，参考价 = 前收 × f[t−1] / f[t]
 * （现金与送转比例要等股本变动到了再拆，和东财 A 股路径一样）。
 */
export function adjFromFactors(
  bars: readonly KBar[],
  f: readonly number[],
): { adj: number[]; actions: RefAction[] } {
  const adj = f.map((x) => x / f[0]!);
  const actions: RefAction[] = [];
  for (let t = 1; t < bars.length; t++) {
    if (Math.abs(f[t]! / f[t - 1]! - 1) <= 1e-9) continue;
    const prevClose = bars[t - 1]!.close;
    actions.push({
      date: bars[t]!.date,
      prevClose,
      refPrice: (prevClose * f[t - 1]!) / f[t]!,
      cash: null,
      split: null,
    });
  }
  return { adj, actions };
}

function caliberError(code: string, caliber: string): CaliberError {
  return new CaliberError(`${code} 的价格口径「${caliber}」换不成不复权 + 等比因子，拒收`);
}

export function toIvanBars(
  code: string,
  sb: SourceBars,
): { raw: SourceBar[]; adj: number[]; actions: RefAction[] } {
  const raw = sb.bars;
  let adj: number[];
  let actions: RefAction[];
  switch (sb.caliber) {
    case "raw+ref_prev_close":
      ({ adj, actions } = adjFromRefPrices(raw.map((b) => ({ ...b, chg: b.chg ?? Number.NaN }))));
      break;
    case "raw+hfq_affine": {
      if (!sb.hfq) throw caliberError(code, sb.caliber);
      const { adj: a, events } = decomposeHfq(raw, sb.hfq, sb.decimals ?? 3);
      adj = a;
      actions = toRefActions(raw, events);
      break;
    }
    case "raw+adj_factor": {
      const f = sb.adjFactor;
      if (!f || f.length !== raw.length) throw caliberError(code, sb.caliber);
      if (!f.every((x) => Number.isFinite(x) && x > 0)) {
        throw new CaliberError(`${code} 反推出的复权因子不合理，拒收`);
      }
      ({ adj, actions } = adjFromFactors(raw, f));
      break;
    }
    default:
      throw caliberError(code, sb.caliber);
  }
  if (raw.length && (adj[0] !== 1 || !adj.every((x) => Number.isFinite(x) && x > 0))) {
    throw new CaliberError(`${code} 反推出的复权因子不合理，拒收`);
  }
  return { raw, adj, actions };
}

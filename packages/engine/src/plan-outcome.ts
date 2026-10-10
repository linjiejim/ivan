/**
 * 计划结果回看（DEC-3 的最小版，D79，纯函数）：一条计划后来怎么样。
 *
 * - 成交：决策日之后这只股票的第一根 K 线（停牌就顺延）的开盘价；和快照里的估算价比（slipVsEst = 开盘 ÷ 估算 − 1）；
 * - 收益：从那天开盘起第 h 根 K 线收盘（复权）的涨跌，h = 5、20；
 * - 超额：基准从决策日收盘（快照里存的 benchClose）起算到同一天收盘，excess = (1 + 收益) ÷ (1 + 基准) − 1；
 * - 卖出看的是这只股票卖出之后的涨跌（卖得对不对）；
 * - 天数不够（还没到第 h 根 K 线）或缺基准时为 null。
 */
import type { DateStr } from "@ivan/core";

export interface PlanOutcome {
  code: string;
  side: string;
  fillDate: DateStr | null;
  fillOpen: number | null;
  estPrice: number | null;
  slipVsEst: number | null;
  ret5: number | null;
  ret20: number | null;
  excess5: number | null;
  excess20: number | null;
}

export interface OutcomeBars {
  dates: readonly DateStr[];
  open: ArrayLike<number>;
  close: ArrayLike<number>;
  adj: ArrayLike<number>;
}

export interface OutcomeBench {
  dates: readonly DateStr[];
  close: ArrayLike<number>;
}

const finite = (x: number | null | undefined): x is number =>
  x !== null && x !== undefined && Number.isFinite(x);

export const OUTCOME_HORIZONS = [5, 20] as const;

export function evaluatePlanItem(
  item: { code: string; side: string; estPrice: number | null },
  snap: { decisionDate: DateStr; benchClose: number | null },
  bars: OutcomeBars,
  bench: OutcomeBench,
): PlanOutcome {
  const out: PlanOutcome = {
    code: item.code,
    side: item.side,
    fillDate: null,
    fillOpen: null,
    estPrice: finite(item.estPrice) ? item.estPrice : null,
    slipVsEst: null,
    ret5: null,
    ret20: null,
    excess5: null,
    excess20: null,
  };
  let f = -1;
  for (let i = 0; i < bars.dates.length; i++) {
    if (bars.dates[i]! > snap.decisionDate && finite(bars.open[i]) && bars.open[i]! > 0) {
      f = i;
      break;
    }
  }
  if (f < 0) return out;
  const open = bars.open[f]!;
  out.fillDate = bars.dates[f]!;
  out.fillOpen = open;
  if (out.estPrice !== null && out.estPrice > 0) out.slipVsEst = open / out.estPrice - 1;
  const base = open * (finite(bars.adj[f]) ? bars.adj[f]! : 1);
  const benchAt = new Map<DateStr, number>();
  for (let i = 0; i < bench.dates.length; i++) benchAt.set(bench.dates[i]!, bench.close[i]!);
  for (const h of OUTCOME_HORIZONS) {
    const k = f + h - 1;
    if (k >= bars.dates.length) continue;
    const c = bars.close[k]!;
    const a = finite(bars.adj[k]) ? bars.adj[k]! : 1;
    if (!finite(c)) continue;
    const ret = (c * a) / base - 1;
    const b = benchAt.get(bars.dates[k]!);
    const benchRet =
      finite(b) && finite(snap.benchClose) && snap.benchClose > 0 ? b / snap.benchClose - 1 : null;
    const excess = benchRet === null ? null : (1 + ret) / (1 + benchRet) - 1;
    if (h === 5) {
      out.ret5 = ret;
      out.excess5 = excess;
    } else {
      out.ret20 = ret;
      out.excess20 = excess;
    }
  }
  return out;
}

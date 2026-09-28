/**
 * 诚实检查（spec §6）：确定性计算，阈值集中在这里。LLM 只负责解释，不负责判断。
 */
import type { Attribution, Check, Metrics, PeriodMetrics, SimInput, Trade } from "@ivan/core";

export const CHECK_THRESHOLDS = {
  /** 样本外年化超额低于样本内的这个比例 → 衰减 */
  oosDecayRatio: 0.5,
  minBuys: 30,
  /** 盈利最多的两只占总盈利的比例 */
  top2Share: 0.5,
  /** 单一行业平均权重 */
  industryWeight: 0.4,
  tuningInfo: 10,
  tuningWarn: 20,
  /** 费用占毛超额收益的比例 */
  costShare: 0.2,
} as const;

/**
 * 统计类检查判断的是「回测证据够不够」，对刚上线几周的跟踪没有意义（交易必然太少、收益必然集中），
 * 跟踪只保留数据局限类提示（幸存者偏差、基准不含分红、ST 近似）。
 */
export const BACKTEST_ONLY_CHECKS: ReadonlySet<string> = new Set([
  "oos_decay",
  "few_trades",
  "concentration",
  "tuning_count",
  "cost_drag",
]);

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function runChecks(ctx: {
  input: SimInput;
  metrics: Metrics;
  segments: { inSample: PeriodMetrics; outOfSample: PeriodMetrics | null };
  attribution: Attribution;
  trades: readonly Trade[];
}): Check[] {
  const { input, metrics, segments, attribution } = ctx;
  const T = CHECK_THRESHOLDS;
  const out: Check[] = [];

  const is = segments.inSample;
  const oos = segments.outOfSample;
  if (oos) {
    const decayed =
      (is.excessCagr > 0 && oos.excessCagr < is.excessCagr * T.oosDecayRatio) ||
      (is.excessCagr > 0 && oos.excessCagr < 0);
    if (decayed) {
      out.push({
        id: "oos_decay",
        level: "warn",
        title: "样本外明显变差",
        detail: `样本内年化超额 ${pct(is.excessCagr)}，样本外（${oos.start} 起）只有 ${pct(oos.excessCagr)}。回测里的好成绩可能来自对历史的拟合。`,
      });
    }
  }

  if (metrics.buys < T.minBuys) {
    out.push({
      id: "few_trades",
      level: "warn",
      title: "交易太少",
      detail: `整个区间只买入 ${metrics.buys} 次，结果受少数几笔交易影响大，统计上不可靠。`,
    });
  }

  const winners = attribution.byStock.filter((s) => s.pnl > 0);
  const gross = winners.reduce((s, x) => s + x.pnl, 0);
  if (gross > 0 && winners.length >= 2) {
    const top2 = winners[0]!.pnl + winners[1]!.pnl;
    if (top2 / gross > T.top2Share) {
      out.push({
        id: "concentration",
        level: "warn",
        title: "收益集中在少数股票",
        detail: `${winners[0]!.name}、${winners[1]!.name} 两只贡献了 ${pct(top2 / gross)} 的盈利，换个时间点可能就选不中它们。`,
      });
    }
  }
  const topInd = attribution.byIndustry
    .filter((x) => x.industry !== "未分类")
    .sort((a, b) => b.avgWeight - a.avgWeight)[0];
  if (topInd && topInd.avgWeight > T.industryWeight) {
    out.push({
      id: "concentration",
      level: "warn",
      title: "行业过于集中",
      detail: `「${topInd.industry}」平均占仓位 ${pct(topInd.avgWeight)}，收益很大程度是这个行业的行情。`,
    });
  }

  const n = input.priorVersionsOnPeriod ?? 0;
  if (n >= T.tuningInfo) {
    out.push({
      id: "tuning_count",
      level: n >= T.tuningWarn ? "warn" : "info",
      title: "调参次数多",
      detail: `这个策略在同一区间已经回测过 ${n} 个版本。调得越多，越可能是在拟合历史，建议用样本外或向前跟踪来验证。`,
    });
  }

  const grossExcess = metrics.finalEquity - input.params.capital * (1 + metrics.benchReturn);
  if (grossExcess > 0 && metrics.fees / grossExcess > T.costShare) {
    out.push({
      id: "cost_drag",
      level: "info",
      title: "交易成本吃掉不少超额",
      detail: `费用合计 ${metrics.fees.toFixed(0)}，占超额收益的 ${pct(metrics.fees / grossExcess)}；年化换手 ${metrics.turnover.toFixed(1)} 倍。`,
    });
  }

  if (!input.benchWithDividends) {
    out.push({
      id: "bench_no_div",
      level: "info",
      title: "基准不含分红",
      detail: `基准「${input.benchLabel}」是价格指数，策略收益含分红，比较会偏向策略（每年约 2%）。`,
    });
  }

  for (const c of input.dataCaveats ?? []) out.push({ ...c });
  return out;
}

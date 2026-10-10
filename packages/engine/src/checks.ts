/**
 * 诚实检查（spec §6）：确定性计算，阈值集中在这里。LLM 只负责解释，不负责判断。
 */
import type {
  Attribution,
  Check,
  Metrics,
  PeriodMetrics,
  SimDiagnostics,
  SimInput,
  Trade,
} from "@ivan/core";

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
  /** 各年表现不一致（指标第 2 版）：至少这么多年、跑赢基准的年份占比低于这个比例 */
  inconsistentYearsMin: 3,
  inconsistentShare: 0.5,
  /** 按流动性成交（D64）：被单笔上限截小的买单占比超过它 → 容量受限（warn） */
  cappedBuyShareWarn: 0.1,
  /** 容量估计不到当前资金的这个倍数 → 容量提示（info） */
  capacityMultipleInfo: 5,
  /** 买入参与率的 90 分位超过它 → 流动性差（info） */
  participationP90Info: 0.05,
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
  "inconsistent_years",
  "capacity_limit",
  "illiquid_holdings",
  "low_confidence",
  "optimistic_drawdown",
]);

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
/** 比例的简写：10% 而不是 10.0% */
const pctShort = (x: number) => `${Number((x * 100).toFixed(1))}%`;
/** 金额缩写到万 / 亿（本币） */
const money = (x: number) =>
  x >= 1e8
    ? `${Number((x / 1e8).toFixed(1))} 亿`
    : x >= 1e4
      ? `${Math.round(x / 1e4)} 万`
      : `${Math.round(x)}`;

export function runChecks(ctx: {
  input: SimInput;
  metrics: Metrics;
  segments: { inSample: PeriodMetrics; outOfSample: PeriodMetrics | null };
  attribution: Attribution;
  trades: readonly Trade[];
  diagnostics?: SimDiagnostics;
}): Check[] {
  const { input, metrics, segments, attribution, diagnostics } = ctx;
  const T = CHECK_THRESHOLDS;
  const out: Check[] = [];
  const version = metrics.metricsVersion ?? 1;

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
      // 第 1 版的文字原样（旧回测的提示逐字节不变）；第 2 版补一句计数从哪来
      detail:
        `这个策略在重叠的区间里试过 ${n} 种不同设置（含参数扫描）。调得越多，越可能是在拟合历史，建议看可信度和样本外或向前跟踪。` +
        (version === 1 ? "" : "新建一个策略会从零算。"),
    });
  }

  // 毛超额：第 1 版原样（其实是扣费后的超额）；第 2 版把费用与滑点成本（D64）加回去
  const slip = version === 1 ? 0 : (metrics.slippageCost ?? 0);
  const cost = metrics.fees + slip;
  const grossExcess =
    version === 1
      ? metrics.finalEquity - input.params.capital * (1 + metrics.benchReturn)
      : metrics.finalEquity + cost - input.params.capital * (1 + metrics.benchReturn);
  if (grossExcess > 0 && cost / grossExcess > T.costShare) {
    out.push({
      id: "cost_drag",
      level: "info",
      title: "交易成本吃掉不少超额",
      detail:
        metrics.slippageCost === undefined || version === 1
          ? `费用合计 ${metrics.fees.toFixed(0)}，占超额收益的 ${pct(metrics.fees / grossExcess)}；年化换手 ${metrics.turnover.toFixed(1)} 倍。`
          : `费用合计 ${metrics.fees.toFixed(0)}、滑点与冲击 ${slip.toFixed(0)}，占超额收益的 ${pct(cost / grossExcess)}；年化换手 ${metrics.turnover.toFixed(1)} 倍。`,
    });
  }

  // 按流动性成交（D64）：容量与流动性
  const cap = input.params.exec?.participation ?? null;
  if (diagnostics?.cappedBuyShare !== undefined && cap !== null) {
    const est = diagnostics.capacityEstimate ?? null;
    if (diagnostics.cappedBuyShare > T.cappedBuyShareWarn) {
      out.push({
        id: "capacity_limit",
        level: "warn",
        title: "容量受限",
        detail: `有 ${pct(diagnostics.cappedBuyShare)} 的买单因为超过日均成交额的 ${pctShort(cap)} 只买到一部分；资金再大，结果会更差。`,
      });
    } else if (est !== null && est < T.capacityMultipleInfo * input.params.capital) {
      out.push({
        id: "capacity_limit",
        level: "info",
        title: "资金容量有限",
        detail: `按单笔不超过日均成交额 ${pctShort(cap)} 估算，这个策略大约能容纳 ${money(est)}的资金。`,
      });
    }
  }
  const p90 = diagnostics?.participation?.p90;
  if (p90 !== undefined && p90 > T.participationP90Info) {
    out.push({
      id: "illiquid_holdings",
      level: "info",
      title: "流动性差",
      detail: `买单常常占到当天日均成交额的 ${pct(p90)} 以上，实际成交可能更差。`,
    });
  }

  const cons = version === 2 ? metrics.risk?.consistency : undefined;
  if (
    cons &&
    cons.years >= T.inconsistentYearsMin &&
    cons.positiveYears / cons.years < T.inconsistentShare &&
    metrics.excessCagr > 0
  ) {
    out.push({
      id: "inconsistent_years",
      level: "info",
      title: "各年表现不一致",
      detail: `${cons.years} 年里只有 ${cons.positiveYears} 年跑赢基准，超额主要来自少数年份。`,
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

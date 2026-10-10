/**
 * 可信度（D65）：把回测结果变成区间、PSR 与一年净值扇形，并给出两条诚实检查。只对指标第 2 版的新回测做
 * （旧运行重跑要和当初逐字节一致）；种子由调用方从输入指纹算（同样的输入 → 同样的种子 → 同样的区间）。
 */
import type {
  Check,
  Confidence,
  Metrics,
  SimResult,
  StrategySpec,
  Trade,
  ValidationResult,
} from "@ivan/core";
import { roundTrips } from "../metrics.ts";
import { confidence } from "./bootstrap.ts";
import { forwardFan } from "./fan.ts";
import { quantile7 } from "./moments.ts";

/** 方法或参数一变就加一：种子里含它，区间随之重算 */
export const VALIDATION_VERSION = 1;

export const VALIDATION_DEFAULTS = { B: 1000, maxT: 4000, checkpoints: 60 } as const;

const BLOCK_BY_EVERY = { week: 5, month: 21, quarter: 63 } as const;

/**
 * 平均段长：规则模式按调仓周期（周 5、月 21、季 63 个交易日）；信号模式取完整持仓天数的中位数，
 * 夹在 5–63（没有完整持仓时按月 21）。
 */
export function blockMeanFor(spec: StrategySpec, trades: readonly Trade[]): number {
  if (spec.mode !== "signals") return BLOCK_BY_EVERY[spec.rebalance.every];
  const holds = roundTrips(trades)
    .map((t) => t.holdDays)
    .filter((d) => Number.isFinite(d))
    .sort((a, b) => a - b);
  const med = holds.length ? quantile7(holds, 0.5) : BLOCK_BY_EVERY.month;
  return Math.min(63, Math.max(5, Math.round(med)));
}

/** 区间与扇形；日收益不到 60 个时返回 null */
export function runValidation(
  result: SimResult,
  spec: StrategySpec,
  seed: number,
): ValidationResult | null {
  const series = result.anchor ? [result.anchor, ...result.series] : result.series;
  const blockMean = blockMeanFor(spec, result.trades);
  const { B, maxT, checkpoints } = VALIDATION_DEFAULTS;
  const c = confidence(series, { B, maxT, blockMean, seed });
  if (!c) return null;
  return { confidence: c, fan: forwardFan(series, { B, blockMean, seed, checkpoints, maxT }) };
}

/** 回撤比这个分位以上的重抽样路径都轻 → 回撤可能偏乐观 */
export const OPTIMISTIC_MDD_PERCENTILE = 75;

const pct = (x: number) => `${x > 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

/** 可信度的两条检查（只用于回测，进 reportHash） */
export function validationChecks(v: Confidence, metrics: Metrics): Check[] {
  const out: Check[] = [];
  const x = v.excessCagr;
  if (x.est > 0 && x.lo <= 0) {
    out.push({
      id: "low_confidence",
      level: "warn",
      title: "超额可能是运气",
      detail: `年化超额 ${pct(x.est)}，但按历史重抽样的 95% 区间是 ${pct(x.lo)} ~ ${pct(x.hi)}，不能排除是运气。`,
    });
  }
  if (v.actualMddPercentile >= OPTIMISTIC_MDD_PERCENTILE) {
    out.push({
      id: "optimistic_drawdown",
      level: "info",
      title: "回撤可能偏乐观",
      detail: `回测最大回撤 ${pct(metrics.maxDrawdown)}，比 ${Math.round(v.actualMddPercentile)}% 的重抽样路径都轻；重抽样中位数 ${pct(v.mddMedian)}。`,
    });
  }
  return out;
}

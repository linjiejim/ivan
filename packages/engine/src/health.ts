/**
 * 跟踪健康度与判词（D70，纯函数）。
 *
 * - 每晚一个读数，指标取最差的那个：跑赢回测同期（偏离百分位，越高越好）、回撤比（跟踪最大回撤 ÷ 基准回测最大回撤，越低越好）；
 *   跟踪不足 20 天或没有可用指标 = 样本不足，从不算正常。
 * - 状态带滞回（transition）：第一个够样本的读数不正常就不会先报正常；永不自动停止。
 * - 上线第一晚按已存的逐日净值补算（backfillHealth），已经落后很久的跟踪第一晚就是偏离或可能失效。
 * - 判词（verdictOf）在状态之上再看结算失败与数据没更新。
 *
 * 阈值与文字在 @ivan/core 的 health.ts（网页的 ⓘ 也要读）；阈值以 health-calibration.test.ts 为准。
 */
import {
  type DateStr,
  HEALTH_THRESHOLDS,
  type TrackingHealth,
  HEALTH_VERSION,
  type HealthReading,
  type HealthSignal,
  type HealthState,
  type PerMetric,
  type SeriesPoint,
  type Verdict,
} from "@ivan/core";
import { deviationPercentile } from "./deviation.ts";

export { HEALTH_THRESHOLDS, HEALTH_VERSION };

const RANK: Record<HealthSignal, number> = { healthy: 0, warning: 1, decayed: 2, critical: 3 };

/** 越高越好：≥ healthy 正常，≥ warning 注意，≥ decayed 衰减，再低严重 */
function higherBetter(v: number, t: { healthy: number; warning: number; decayed: number }) {
  if (v >= t.healthy) return "healthy";
  if (v >= t.warning) return "warning";
  if (v >= t.decayed) return "decayed";
  return "critical";
}

/** 越低越好：≤ healthy 正常，≤ warning 注意，≤ decayed 衰减，再高严重 */
function lowerBetter(v: number, t: { healthy: number; warning: number; decayed: number }) {
  if (v <= t.healthy) return "healthy";
  if (v <= t.warning) return "warning";
  if (v <= t.decayed) return "decayed";
  return "critical";
}

export interface ClassifyInput {
  /** 跟踪的天数（逐日序列长度 − 1，和偏离百分位的窗口长度一致） */
  days: number;
  beatBacktestPct: number | null;
  /** 最大回撤（负数，0 表示没有回撤） */
  trackingMaxDD: number | null;
  baselineMaxDD: number | null;
}

/** 一个读数：各指标分级，整体取最差；天数不够或没有可用指标为样本不足 */
export function classify(i: ClassifyInput): { signal: HealthReading; perMetric: PerMetric } {
  const T = HEALTH_THRESHOLDS;
  const perMetric: PerMetric = {};
  if (i.beatBacktestPct !== null && Number.isFinite(i.beatBacktestPct)) {
    perMetric.beatBacktestPct = {
      value: i.beatBacktestPct,
      signal: higherBetter(i.beatBacktestPct, T.beatBacktestPct),
    };
  }
  if (
    i.trackingMaxDD !== null &&
    i.baselineMaxDD !== null &&
    Number.isFinite(i.trackingMaxDD) &&
    i.baselineMaxDD < 0
  ) {
    const ratio = i.trackingMaxDD / i.baselineMaxDD;
    perMetric.ddRatio = { value: ratio, signal: lowerBetter(ratio, T.ddRatio) };
  }
  const readings = Object.values(perMetric);
  if (i.days < T.minDays || !readings.length) return { signal: "insufficient_data", perMetric };
  let worst: HealthSignal = "healthy";
  for (const r of readings) if (RANK[r.signal] > RANK[worst]) worst = r.signal;
  return { signal: worst, perMetric };
}

const lastN = <T>(xs: readonly T[], n: number): T[] | null =>
  xs.length >= n ? xs.slice(-n) : null;
const bad = (s: HealthSignal) => s === "decayed" || s === "critical";

/**
 * 状态机（滞回）：history 是按时间排的读数（最新的在最后，含今晚），只看够样本的读数。
 * 最新读数样本不足时状态不变。
 */
export function transition(
  prev: HealthState,
  history: readonly HealthReading[],
): { next: HealthState; reason: string } {
  const P = HEALTH_THRESHOLDS.persist;
  const latest = history.at(-1);
  if (!latest || latest === "insufficient_data") return { next: prev, reason: "" };
  const s = history.filter((x): x is HealthSignal => x !== "insufficient_data");
  switch (prev) {
    case "warming_up": {
      if (latest === "healthy") return { next: "active", reason: "第一个够样本的读数正常" };
      const tail = lastN(s, P.toDecayed);
      if (tail?.every(bad)) {
        return { next: "decayed", reason: `最近 ${P.toDecayed} 个读数都是衰减或严重` };
      }
      return { next: "monitoring", reason: "第一个够样本的读数不正常" };
    }
    case "active": {
      const tail = lastN(s, P.toMonitoring);
      if (tail?.every((x) => x !== "healthy")) {
        return { next: "monitoring", reason: `连续 ${P.toMonitoring} 个读数不正常` };
      }
      return { next: "active", reason: "" };
    }
    case "monitoring": {
      if (latest === "healthy") return { next: "active", reason: "最新读数正常" };
      const tail = lastN(s, P.toDecayed);
      if (tail?.every(bad)) {
        return { next: "decayed", reason: `连续 ${P.toDecayed} 个读数衰减或严重` };
      }
      return { next: "monitoring", reason: "" };
    }
    case "decayed": {
      const tail = lastN(s, P.decayedToMonitoring);
      if (tail?.every((x) => !bad(x))) {
        return { next: "monitoring", reason: `连续 ${P.decayedToMonitoring} 个读数正常或注意` };
      }
      return { next: "decayed", reason: "" };
    }
  }
}

/** 序列前 upto + 1 天的最大回撤（负数）；峰值从净值 1（投入资金那一刻）起算，补算与每晚同一口径 */
export function maxDrawdownOf(series: readonly SeriesPoint[], upto = series.length - 1): number {
  let peak = 1;
  let mdd = 0;
  for (let i = 0; i <= upto && i < series.length; i++) {
    const nav = series[i]!.nav;
    peak = Math.max(peak, nav);
    mdd = Math.min(mdd, nav / peak - 1);
  }
  return mdd;
}

/** 一晚读数的输入（存进 tracking_health.inputs，任何人都能重算） */
export interface HealthInputs {
  days: number;
  beatBacktestPct: number | null;
  trackingMaxDD: number | null;
  baselineMaxDD: number | null;
  backfilled?: boolean;
}

/** 某一天的读数输入：偏离百分位对基准回测、到那天为止的最大回撤 */
export function healthInputsAt(
  tracking: readonly SeriesPoint[],
  baseline: readonly SeriesPoint[],
  baselineMaxDD: number | null,
  d: number,
): HealthInputs {
  const p = tracking[d]!;
  return {
    days: d,
    beatBacktestPct: baseline.length ? deviationPercentile(baseline, p.nav / p.bench - 1, d) : null,
    trackingMaxDD: maxDrawdownOf(tracking, d),
    baselineMaxDD,
  };
}

export interface HealthRow {
  date: DateStr;
  signal: HealthReading;
  state: HealthState;
  perMetric: PerMetric;
  inputs: HealthInputs;
  /** 这一天状态变了时的原因 */
  reason: string;
}

/**
 * 按已存的逐日净值补算（上线第一晚）：第 minDays 天起每天一个读数，带着累积的历史走状态机。
 * 最后一行就是今晚的读数。
 */
export function backfillHealth(
  tracking: readonly SeriesPoint[],
  baseline: readonly SeriesPoint[],
  baselineMaxDD: number | null,
): HealthRow[] {
  const out: HealthRow[] = [];
  const history: HealthReading[] = [];
  let state: HealthState = "warming_up";
  for (let d = HEALTH_THRESHOLDS.minDays; d < tracking.length; d++) {
    const inputs = { ...healthInputsAt(tracking, baseline, baselineMaxDD, d), backfilled: true };
    const { signal, perMetric } = classify(inputs);
    history.push(signal);
    const t = transition(state, history);
    state = t.next;
    out.push({ date: tracking[d]!.date, signal, state, perMetric, inputs, reason: t.reason });
  }
  return out;
}

export interface VerdictInput {
  state: HealthState;
  /** 跟踪最后结算到的交易日；还没开始结算为空 */
  lastDate: DateStr | null;
  /** 这个市场最新提交的数据日 */
  committedAsOf: DateStr | null;
  /** 最近一次结算失败（结算成功时清掉，所以有就是这次的） */
  settleError: { date: DateStr } | null;
  marketDay: "traded" | "closed" | "stale" | "pending" | null;
  /** 持仓股在今晚缺失名单里的代码（S13 起才有） */
  staleCodes: readonly string[];
}

/** 判词：结算失败 → 数据未更新 → 观察期 → 可能失效 → 偏离 → 正常 */
export function verdictOf(i: VerdictInput): Verdict {
  if (i.settleError) return "SETTLE_FAILED";
  if (
    (i.lastDate !== null && i.committedAsOf !== null && i.lastDate < i.committedAsOf) ||
    i.marketDay === "stale" ||
    i.staleCodes.length > 0
  ) {
    return "STALE_DATA";
  }
  if (i.state === "warming_up") return "WARMING_UP";
  if (i.state === "decayed") return "DECAYED";
  if (i.state === "monitoring") return "DRIFTING";
  return "ON_TRACK";
}

/** settle 写在 summary 里、判词要用的那几项（旧跟踪没有就按观察期、没失败、没有缺失） */
interface SummaryForVerdict {
  health?: TrackingHealth | null;
  lastDate?: DateStr | null;
  lastError?: { date: DateStr; message?: string } | null;
  staleCodes?: string[] | null;
}

/**
 * 从跟踪摘要与市场当日状态得出判词：worker 的简报与 server 的看板 / 跟踪页 / 对话共用这一处。
 * lastDate 优先用 summary.lastDate（结算日），没有时用 trackings.last_date。
 */
export function trackingVerdict(
  summary: unknown,
  lastDate: DateStr | null,
  market: { marketDay: VerdictInput["marketDay"]; committedAsOf: DateStr | null },
): Verdict {
  const s = (summary ?? {}) as SummaryForVerdict;
  return verdictOf({
    state: s.health?.state ?? "warming_up",
    lastDate: s.lastDate ?? lastDate,
    committedAsOf: market.committedAsOf,
    settleError: s.lastError ?? null,
    marketDay: market.marketDay,
    staleCodes: s.staleCodes ?? [],
  });
}

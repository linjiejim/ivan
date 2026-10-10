/**
 * 跟踪健康度与判词（D70）的共用定义：取值、阈值、给人看的文字。
 * 计算（分级、状态机、补算、判词）在 @ivan/engine 的 health.ts；这里只放网页也要读的常量，
 * 免得网页（ⓘ 里的阈值）和引擎各写一份。
 */

/** 改阈值或状态机就加 1：存下的读数带着版本，历史读数不改写 */
export const HEALTH_VERSION = 1;

/** 单个读数的分级：正常 / 注意 / 衰减 / 严重 */
export type HealthSignal = "healthy" | "warning" | "decayed" | "critical";
/** 读数不够（跟踪不足 20 天或没有可用指标）：从不算正常 */
export type HealthReading = HealthSignal | "insufficient_data";
/** 带滞回的状态：观察期 / 正常 / 偏离 / 可能失效 */
export type HealthState = "warming_up" | "active" | "monitoring" | "decayed";

export type HealthMetric = "beatBacktestPct" | "ddRatio";

/**
 * 阈值以校准测试为准（packages/engine/src/health-calibration.test.ts）：改了要让它保持通过，并加 HEALTH_VERSION。
 * 跑赢回测同期越高越好（低于 decayed 为严重）；回撤比 = 跟踪最大回撤 ÷ 基准回测最大回撤，越低越好（高于 decayed 为严重）。
 * persist：正常 → 偏离要连续 5 个不正常；偏离 → 可能失效要连续 5 个衰减或严重；可能失效 → 偏离要连续 3 个正常或注意。
 */
export const HEALTH_THRESHOLDS = {
  beatBacktestPct: { healthy: 5, warning: 1, decayed: 0.5 },
  ddRatio: { healthy: 1.2, warning: 1.5, decayed: 2.0 },
  minDays: 20,
  persist: { toMonitoring: 5, toDecayed: 5, decayedToMonitoring: 3 },
} as const;

export interface MetricReading {
  value: number;
  signal: HealthSignal;
}

export type PerMetric = Partial<Record<HealthMetric, MetricReading>>;

/** 跟踪摘要里的健康度（settle 写在 summary.health） */
export interface TrackingHealth {
  state: HealthState;
  signal: HealthReading;
  perMetric: PerMetric;
  version: number;
}

/** 判词：按这个顺序判，前面的优先 */
export type Verdict =
  "SETTLE_FAILED" | "STALE_DATA" | "WARMING_UP" | "DECAYED" | "DRIFTING" | "ON_TRACK";

export const VERDICT_TEXT: Record<Verdict, string> = {
  ON_TRACK: "正常",
  DRIFTING: "偏离",
  DECAYED: "可能失效",
  WARMING_UP: "观察期",
  STALE_DATA: "数据未更新",
  SETTLE_FAILED: "结算失败",
};

export const HEALTH_STATE_TEXT: Record<HealthState, string> = {
  warming_up: "观察期",
  active: "正常",
  monitoring: "偏离",
  decayed: "可能失效",
};

export const SIGNAL_TEXT: Record<HealthReading, string> = {
  healthy: "正常",
  warning: "注意",
  decayed: "衰减",
  critical: "严重",
  insufficient_data: "样本不足",
};

export const HEALTH_METRIC_TEXT: Record<HealthMetric, string> = {
  beatBacktestPct: "跑赢回测同期",
  ddRatio: "回撤比",
};

/** 判词「可能失效」统一的说法：只建议复核，不说停止或卖出 */
export const DECAYED_ADVICE = "建议复核规则是否仍然有效";

/** ⓘ 里的诚实说明：阈值来自合成数据校准，检出率有限 */
export const HEALTH_HONESTY = "健康度是提醒，不是检验：超额消失后一年内大约只有一半的跟踪会被标出";

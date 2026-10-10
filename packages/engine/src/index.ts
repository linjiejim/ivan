export { ENGINE_VERSION, periodIndexes, rebalanceDays, SimError, simulate } from "./simulate.ts";
export {
  FillLog,
  lotFloor,
  type Quote,
  quote,
  type QuoteCtx,
  type RejectReason,
  SAMPLE_LIMIT,
  SIGMA_FALLBACK,
} from "./fill.ts";
export {
  annualDrag,
  attribution,
  computeMetrics,
  oosStart,
  periodMetrics,
  type RoundTrip,
  riskMetrics,
  roundTrips,
} from "./metrics.ts";
export { kurtosis, mean, quantile7, sampleCov, sampleSd, skewness } from "./stats/moments.ts";
export { mulberry32 } from "./stats/prng.ts";
export { erfc, normCdf, normInv } from "./stats/normal.ts";
export { psr } from "./stats/psr.ts";
export { confidence, MIN_RETURNS, stationaryIndices } from "./stats/bootstrap.ts";
export { FAN_HORIZON, type FanBand, fanPercentile, forwardFan } from "./stats/fan.ts";
export {
  blockMeanFor,
  runValidation,
  VALIDATION_DEFAULTS,
  VALIDATION_VERSION,
  validationChecks,
} from "./stats/validation.ts";
export { BACKTEST_ONLY_CHECKS, CHECK_THRESHOLDS, runChecks } from "./checks.ts";
export { deviationPercentile, windowExcesses } from "./deviation.ts";
export { compareReplay, type ReplayCheck } from "./replay.ts";
export {
  attributeDrift,
  changeCause,
  type ChangeCause,
  type DriftCause,
  type DriftCur,
  type DriftPrev,
  type Fingerprint,
} from "./drift.ts";
export {
  evaluatePlanItem,
  OUTCOME_HORIZONS,
  type OutcomeBars,
  type OutcomeBench,
  type PlanOutcome,
} from "./plan-outcome.ts";
export {
  backfillHealth,
  classify,
  type ClassifyInput,
  HEALTH_THRESHOLDS,
  HEALTH_VERSION,
  type HealthInputs,
  healthInputsAt,
  type HealthRow,
  maxDrawdownOf,
  trackingVerdict,
  transition,
  verdictOf,
  type VerdictInput,
} from "./health.ts";
export {
  diffPlans,
  type PlanDiff,
  type PlanDiffChange,
  type PlanDiffField,
  type PlanItemLite,
  WEIGHT_EPS,
} from "./plan-diff.ts";

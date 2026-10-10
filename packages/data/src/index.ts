export * from "./http.ts";
export * from "./probe.ts";
export * as eastmoney from "./sources/eastmoney.ts";
export * as tencent from "./sources/tencent.ts";
export * as emkline from "./sources/emkline.ts";
export * as exchanges from "./sources/exchanges.ts";
export * as csindex from "./sources/csindex.ts";
export * as chinamoney from "./sources/chinamoney.ts";
export {
  MAINTENANCE_V3,
  Warehouse,
  sqlCodeList,
  sqlDateList,
  type WarehouseOptions,
} from "./warehouse/db.ts";
export {
  FACTOR_COLUMNS,
  PROVENANCE_TABLES,
  SCHEMA_VERSION,
  SOURCE_LABEL,
} from "./warehouse/schema.ts";
export type { EtlContext, LogFn, SecurityRow } from "./etl/context.ts";
export { loadSecurities } from "./etl/context.ts";
export {
  backfill,
  BACKFILL_STEPS,
  type BackfillStep,
  beginDataVersion,
  commitDataVersion,
  compareAdjVolume,
  daily,
  type DailyOptions,
  type DailyResult,
  type DataVersionKind,
  type DataVersionStatus,
  DEFAULT_SINCE,
  weeklyCheck,
} from "./etl/pipeline.ts";
export {
  ATTR_LABEL,
  type AttrCapture,
  attrAsOf,
  attrFirstDate,
  CAPTURE_ATTRS,
  type CaptureStatus,
  captureStatus,
  type SnapshotResult,
  upsertSnapshot,
} from "./etl/snapshots.ts";
export { computeFactors } from "./etl/factors.ts";
export {
  fillProvisionalTr,
  INDEXES,
  latestTradeDates,
  PROVISIONAL_PAIRS,
  updateIndexes,
} from "./etl/reference.ts";
export { HK_CONNECT_SH_COLUMN } from "./etl/securities.ts";
export * from "./compute/adjust.ts";
export { adjFromFactors, CaliberError, toIvanBars, toRefActions } from "./compute/normalize.ts";
export * from "./sources/types.ts";
export {
  ADAPTERS,
  chainOf,
  DEFAULT_CHAINS,
  INVALID_CHAIN_TEXT,
  resolveChain,
  type ResolvedChain,
} from "./sources/registry.ts";
export {
  type Attempt,
  attemptsOf,
  ChainError,
  type ChainResult,
  FetchLedger,
  fetchWithChain,
  type LedgerFailure,
  type SourcesLedger,
  summarizeAttempts,
} from "./sources/chain.ts";
export * from "./compute/financials.ts";
export * from "./compute/series.ts";
export * from "./compute/names.ts";
export * from "./compute/stock-factors.ts";
export {
  compileSelection,
  conditionSql,
  type HkConnectList,
  loadHkConnect,
  REGIME_INDEX,
  runRegimeSelection,
  runSelection,
  runSelectionScored,
  type SelectionContext,
  selectionContext,
  SelectionDataError,
  selectionSql,
  type SelectionSqlOptions,
  specForRegime,
  weakRegimeDates,
  type WherePart,
  whereParts,
  whereSql,
} from "./query/selection.ts";
export {
  type CandidateTrace,
  type CodeExplain,
  explainSelection,
  EXPLAIN_VERSION,
  type FactorValue,
  type ScreenRow,
  screenOn,
  type SelectionExplain,
} from "./query/explain.ts";
export {
  DEFAULT_EVIDENCE_FACTORS,
  type EvidenceCaveat,
  EvidenceError,
  type EvidenceGroup,
  type EvidenceItem,
  EVIDENCE_VERSION,
  type SecurityDossier,
  securityDossier,
  verifyDossier,
} from "./query/evidence.ts";
export {
  type BuildOptions,
  type BuiltInput,
  buildSimInput,
  committedAsOf,
  type DataVersionInfo,
  dataVersionState,
  lastTradingDay,
  type FetchSourcesSummary,
  lastFetchSources,
  latestDataVersion,
} from "./query/backtest.ts";
export {
  BENCH_MISMATCH,
  benchFirstDate,
  benchFirstDates,
  benchMismatchCaveat,
  dividendWeightShare,
  selectedMedianMcapRank,
} from "./query/bench.ts";
export {
  HASH_VERSION,
  type HashRule,
  hashSimInput,
  type InputHashes,
} from "./query/input-hash.ts";
export {
  acceptMissingFromEnv,
  assessCompleteness,
  type Completeness,
  type CompletenessInput,
  IncompleteDataError,
  type MissingReason,
  missingThreshold,
  RetryableEtlError,
  SOFT_STEP_LABEL,
  type SoftOutcome,
  type SoftStep,
  type SoftStepStatus,
} from "./etl/completeness.ts";
export {
  type HygieneCtx,
  type Issue,
  type IssueRule,
  type IssueSeverity,
  validateBars,
} from "./compute/hygiene.ts";
export {
  committedMissingCritical,
  type DataIssueRow,
  type DataQuality,
  dataQuality,
  resolveDataIssue,
  runProvenance,
  softStepStatus,
} from "./query/data-health.ts";

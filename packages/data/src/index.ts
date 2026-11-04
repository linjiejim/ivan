export * from "./http.ts";
export * from "./probe.ts";
export * as eastmoney from "./sources/eastmoney.ts";
export * as tencent from "./sources/tencent.ts";
export * as emkline from "./sources/emkline.ts";
export * as exchanges from "./sources/exchanges.ts";
export * as csindex from "./sources/csindex.ts";
export * as chinamoney from "./sources/chinamoney.ts";
export {
  INTERRUPTED_TEXT,
  InterruptedError,
  MAINTENANCE_V3,
  MAINTENANCE_V5,
  Warehouse,
  sqlCodeList,
  sqlDateList,
  type WarehouseOptions,
} from "./warehouse/db.ts";
export {
  DOWN_TO_V4_SQL,
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
  runPitSyncs,
  weeklyCheck,
} from "./etl/pipeline.ts";
export {
  estimatePitBackfill,
  finishPitBatch,
  MARGIN_PARTIAL_SESSIONS,
  openPitBatch,
  pitBackfillProgress,
  PIT_DEFAULT_SINCE,
  PIT_SECONDS_PER_REQUEST,
  type PitDatasetStatus,
  pitDatasetStatus,
  type PitEstimate,
  type PitMode,
  type PitSource,
  type PitSyncOptions,
  type PitSyncResult,
  syncPitDataset,
} from "./etl/pit-runner.ts";
export {
  BLOCKS,
  HOLDERS,
  LOCKUPS,
  lockupRuleDate,
  MARGIN,
  monthChunks,
  PIT_DATASET_SPECS,
  type PitDataset,
  sequenceBlocks,
  yearChunks,
} from "./etl/datasets.ts";
export { type AvailBasis, type AvailEnv, availEnvOf, buildAvailEnv } from "./etl/trading-days.ts";
export {
  assertColumns,
  CANARY_SAMPLE_ROWS,
  EM_EVENT_DEFS,
  GLOBAL_FORBIDDEN_RE,
} from "./sources/adapters/eastmoney-events.ts";
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
  eventFactorSelect,
  type EventSyncState,
  type EventTarget,
  fillEventColumns,
  loadEventSyncState,
} from "./compute/event-factors.ts";
export {
  backfillEventColumns,
  type EventColumnsResult,
  type EventColumnsStatus,
  eventColsTask,
  eventColumnsStatus,
  type EventFactorsMeta,
  EVENT_FACTORS_META,
  eventSig,
  readEventFactorsMeta,
} from "./etl/event-columns.ts";
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
  DEFAULT_EVENT_CHAINS,
  INVALID_CHAIN_TEXT,
  resolveChain,
  resolveEventChain,
  type ResolvedChain,
} from "./sources/registry.ts";
export {
  type Attempt,
  attemptsOf,
  ChainError,
  type ChainResult,
  type DatasetLedger,
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
  dossierHash,
  type EvidenceCaveat,
  EvidenceError,
  type EvidenceGroup,
  type EvidenceItem,
  type EvidenceOptions,
  EVIDENCE_VERSION,
  EVIDENCE_VERSIONS,
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
  panelTooLargeText,
} from "./query/backtest.ts";
export {
  type BlockRowView,
  type EventCoverage,
  EVENTS_A_ONLY_TEXT,
  type HolderRowView,
  type LockupRowView,
  type MarginRowView,
  type SecurityEvents,
  securityEvents,
} from "./query/events.ts";
export { eventCoverage, type EventCoverageResult, eventFactorsUsed } from "./query/event-coverage.ts";
export * from "./compute/price-stats.ts";
export * from "./query/analytics/index.ts";
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
  type DatasetCompleteness,
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
  DEFAULT_RATE_LIMIT_WAIT_MS,
  RateLimitBudgetError,
  RateLimitWaitBudget,
  rateLimitWaitMsFromEnv,
} from "./etl/rate-limit.ts";
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

/** 服务端接口的返回形状（与 apps/server/src/services 保持一致）。 */
import type {
  Check,
  Confidence,
  ExecConfig,
  Fan,
  FactorDef,
  Interval,
  Market,
  Metrics,
  OpenPosition,
  PendingOrder,
  PeriodMetrics,
  RejectReason,
  RunCard,
  SeriesPoint,
  SimDiagnostics,
  StrategySpec,
  Trade,
  TrackingHealth,
  Verdict,
} from "@ivan/core";

export type {
  Check,
  Confidence,
  ExecConfig,
  Fan,
  FactorDef,
  Interval,
  Market,
  Metrics,
  RejectReason,
  RunCard,
  SeriesPoint,
  SimDiagnostics,
  StrategySpec,
  Trade,
  TrackingHealth,
  Verdict,
};

export interface Me {
  user: { id: string; email: string; name: string; role: string };
  quota: { chatMessages: number; backtests: number; analyses: number };
  usage: {
    chatMessages: number;
    backtests: number;
    analyses: number;
    tokensIn: number;
    tokensOut: number;
  };
}

export interface VersionView {
  id: string;
  n: number;
  spec: StrategySpec;
  specHash: string;
  note: string | null;
  source: string;
  createdAt: number;
  describe: string[];
}

export interface StrategyView {
  id: string;
  name: string;
  market: Market;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  current: VersionView | null;
}

export interface RunHeadline {
  totalReturn: number;
  cagr: number;
  benchCagr: number;
  excessCagr: number;
  maxDrawdown: number;
  sharpe: number;
  winRate: number | null;
  buys: number;
  /** 信息比率、索提诺（指标第 2 版才有，D63）；旧口径与 S04 之前的摘要没有 */
  ir?: number | null;
  sortino?: number | null;
}

export interface RunSummary {
  id: string;
  strategyId: string;
  versionId: string;
  kind: string;
  label: string | null;
  parentId: string | null;
  status: "queued" | "running" | "done" | "failed";
  error: string | null;
  params: {
    start: string;
    end: string;
    capital: number;
    oosMonths: number;
    exec?: ExecConfig;
    sweep?: { path: string; values: unknown[]; label?: string };
    /** 完整重跑指向的原运行 */
    reproOf?: string;
  };
  dataAsOf: string | null;
  createdAt: number;
  finishedAt: number | null;
  checks: Check[];
  headline: RunHeadline | null;
  /** 看板「最近回测」和回测报告的标题用 */
  strategyName?: string | null;
  versionN?: number | null;
}

/**
 * 复核结果（写在原运行上，D57）：kind = input 是「复核数据」（只比输入指纹），full 是「完整重跑」（比结果指纹）。
 */
export interface RunVerify {
  status: "queued" | "running" | "done" | "failed";
  kind: "input" | "full";
  requestedAt?: number | null;
  at?: number;
  error?: string;
  /** 早于指纹记录 */
  reason?: "unrecorded";
  sameInput?: boolean | null;
  sameResult?: boolean;
  reportSame?: boolean;
  engineSame?: boolean;
  hashVersionSame?: boolean;
  /** 完整重跑结果不同的原因（与跟踪漂移归因同一个判断） */
  cause?: "none" | "unrecorded" | "engine" | "exec" | "data" | "unexplained";
  reproRunId?: string;
  dataVersionThen?: number | null;
  dataVersionNow?: number | null;
}

export interface RunDetail extends RunSummary {
  market: Market | null;
  engineVersion: string | null;
  dataVersion: number | null;
  /** 运行卡（早于运行卡记录的回测没有） */
  card: RunCard | null;
  cardHash: string | null;
  inputHash: string | null;
  verify: RunVerify | null;
  /** 成交假设（旧运行按旧口径解析）；读不懂时为 null */
  exec: ExecConfig | null;
  /** 成交诊断（D64）：拒单统计、参与率、容量估计；早于 S05 的回测没有 */
  diagnostics: SimDiagnostics | null;
  /** 可信度（D65）：各项 95% 区间、跑赢基准的把握与一年净值扇形；只有指标第 2 版的新回测有 */
  validation: Confidence | null;
  fan: Fan | null;
  metrics: Metrics | null;
  segments: { inSample: PeriodMetrics; outOfSample: PeriodMetrics | null } | null;
  attribution: {
    byStock: Array<{
      code: string;
      name: string;
      industry: string | null;
      pnl: number;
      trades: number;
    }>;
    byIndustry: Array<{ industry: string; pnl: number; avgWeight: number }>;
  } | null;
  final: {
    date: string;
    cash: number;
    equity: number;
    positions: OpenPosition[];
    pending: PendingOrder[];
    variants?: Array<{ label: string; runId: string; excessCagr: number | null; error?: string }>;
  } | null;
  series: SeriesPoint[];
  job: { status: string; progress: number; note: string | null } | null;
  children: RunSummary[];
  /** 夜间更新写库期间回测与复核暂停（D60）：排队中的回测或复核在等它；reason = etl | check */
  computePaused?: { reason: string; since: number } | null;
}

export interface TrackingView {
  id: string;
  strategyId: string;
  strategyName: string;
  versionId: string;
  market: Market;
  startDate: string;
  capital: number;
  status: string;
  lastDate: string | null;
  nav: number | null;
  bench: number | null;
  excess: number | null;
  deviationPct: number | null;
  baselineRunId: string | null;
  summary: TrackingSummary | null;
  /** 锁定的成交假设（D55）与中文摘要 */
  execConfig: ExecConfig | null;
  execText: string | null;
  createdAt: number;
}

/** 判词与依据（D70）：看板、跟踪页才有（要看市场今天的状态） */
export interface TrackingVerdictView {
  verdict: Verdict;
  health: TrackingHealth | null;
  /** 最近一次结算失败；成功后清掉 */
  lastError: { date: string; message: string } | null;
}

/** 结算写的跟踪摘要（只列界面用到的字段） */
export type TrackingSummary = Record<string, unknown> & {
  /** 按绝对净值（不扣基准）在基准回测重抽样扇形里的分位（D65）；基准没有扇形或跟踪超过一年时为 null */
  navFanPercentile?: number | null;
  navFanBand?: "<5" | "5-25" | "25-50" | "50-75" | "75-95" | ">95" | null;
  replay?: {
    compared: number;
    navDrift: number;
    benchDrift: number;
    firstDrift: string | null;
    maxNavDiff: number;
    at: string;
    /** 漂移归因（S02 起才有） */
    cause?: "none" | "unrecorded" | "engine" | "exec" | "data" | "unexplained";
    causeText?: string;
  };
};

export interface StrategyDetail extends StrategyView {
  versions: VersionView[];
  runs: RunSummary[];
  trackings: TrackingView[];
}

export interface PresetView {
  id: string;
  market: Market;
  title: string;
  blurb: string;
  describe: string[];
}

export interface DataStatus {
  markets: Array<{
    market: string;
    asOf: string | null;
    dataVersion: number | null;
    /**
     * 最近一次 etl 任务。排着队等自动重跑时（D73）：status = queued，retryAt 是重跑时间（毫秒），
     * attempt 是第几次，error 是上一次失败的原因
     */
    lastEtl: {
      status: string;
      finishedAt: number | null;
      error: string | null;
      attempt?: number;
      retryAt?: number | null;
    } | null;
    /** 今天的状态（D78）：已更新 / 休市 / 没更新 / 进行中 */
    day?: "traded" | "closed" | "stale" | "pending";
    /** 正在写的数据版本（D60）；startedAt 是毫秒时间戳 */
    openVersion?: { id: number; startedAt: number | null } | null;
    /** 上一个结束的版本：ok | incomplete | failed | skipped */
    lastVersionStatus?: string | null;
    /** 点时数据的采集情况（D61） */
    capture?: DataCapture;
    /** 最近一晚的取数来源（D72） */
    sources?: DataSources | null;
    /** 辅助数据最近成功的日子与连续失败的晚数（D73） */
    soft?: Array<{
      step: string;
      lastOkDate: string | null;
      failingNights: number;
      firstFailDate: string | null;
    }>;
  }>;
  /** 行情仓维护中（还没升级，D76）：非空时 worker 不排任务、不认领 */
  maintenance?: string | null;
  /** 夜间更新写库期间回测暂停（D60）：reason = etl | check */
  computePaused?: { reason: string; since: number } | null;
  workerUp: boolean;
  /** 这个用户的跟踪最近一次结算失败的（D70，只有看板给） */
  settleFailures?: Array<{ trackingId: string; name: string; date: string; message: string }>;
}

/** 管理页「数据质量」卡（D74） */
export interface DataQuality {
  days: number;
  /** 近 N 天新出现的问题：按规则与级别计，open = 其中还没解决的 */
  byRule: Array<{ rule: string; severity: string; n: number; open: number }>;
  topCodes: Array<{ code: string; name: string | null; n: number }>;
  /** 最新 50 条未解决的问题 */
  open: Array<{
    id: number;
    code: string;
    name: string | null;
    date: string;
    rule: string;
    severity: string;
    detail: string | null;
  }>;
  lastVersions: Array<{
    id: number;
    market: string;
    status: string;
    date: string | null;
    expected: number | null;
    updated: number | null;
    noTrade: number | null;
    missing: number;
    missingCritical: number;
    accepted: number;
    reasons: string[];
  }>;
}

/** 最近一晚夜间增量的取数来源（D72）：served 的键是行级来源代码 em 东财、tx 腾讯日 K、txq 腾讯报价 */
export interface DataSources {
  versionId: number;
  status: string;
  /** 这一晚的日期 */
  date: string | null;
  served: Record<string, number>;
  /** 首选来源没给、换下一家才拿到的次数 */
  fallbacks: number;
  /** 整条链都没拿到的股票数 */
  failed: number;
  empty: number;
  index: Record<string, string>;
}

/** 点时数据的采集情况（D61）：属性快照与财报首见留底 */
export interface DataCapture {
  attrs: Array<{
    attr: string;
    firstDate: string | null;
    openRows: number;
    changes7d: number;
    lastSkipped: { date: string; pct: number } | null;
  }>;
  financialsSeen: { rows: number; new7d: number };
}

/** 简报存下的事实（简报卡 ⓘ「依据」逐条列出；旧简报没有判词等第 2 版字段） */
export interface BriefFactsView {
  factsVersion?: number;
  date: string;
  trackings: Array<{
    trackingId?: string;
    name: string;
    market: string;
    days: number;
    lastDate: string | null;
    dayReturn: number | null;
    dayBench: number | null;
    excessTotal: number | null;
    deviationPct: number | null;
    buys: string[];
    sells: string[];
    warnings: string[];
    verdict?: Verdict;
    prevVerdict?: Verdict | null;
  }>;
}

export interface Dashboard {
  brief: { date: string; content: string | null; facts: BriefFactsView | null } | null;
  trackings: Array<
    TrackingView &
      TrackingVerdictView & {
        days: number;
        spark: number[];
        baseline: { cagr: number; excessCagr: number; maxDrawdown: number; sharpe: number } | null;
      }
  >;
  signals: Array<{
    trackingId: string;
    strategyName: string;
    market: Market;
    orders: Array<{
      planDate: string;
      code: string;
      name: string | null;
      side: string;
      reason: string;
      /** 快照里的细分原因文字（D68）：「掉出前 15 名（排第 31）」；早于账本的计划只有粗原因 */
      reasonText?: string;
      rank?: number | null;
    }>;
  }>;
  recentRuns: RunSummary[];
  data: DataStatus;
  presets: PresetView[];
}

export interface TrackingChart {
  id: string;
  strategyName: string;
  market: Market;
  benchLabel: string;
  startDate: string;
  backtest: Array<{ date: string; nav: number; bench: number }>;
  tracking: Array<{ date: string; nav: number; bench: number }>;
}

export interface ScreenResult {
  date: string;
  /** 按大盘状态切换排序的策略：这天用的是哪套排序（D53） */
  regime?: "strong" | "weak" | null;
  rows: Array<{
    rank: number;
    code: string;
    name: string | null;
    score: number;
    close: number | null;
    factors: Record<string, unknown>;
  }>;
  /** 今日选股可追溯（D67）：读的数据版本与名单指纹 */
  dataVersion?: { id: number | null; asOf: string | null };
  listHash?: string;
}

// ── 个股证据（D67）：决策日当时可得的数据，每项带出处与数据日 ──

export interface EvidenceItem {
  group: "price" | "valuation" | "financial" | "status" | "quality";
  key: string;
  label: string;
  value: number | string | boolean | null;
  unit?: string;
  asOf: string;
  availDate: string;
  ref: {
    table: string;
    key: Record<string, string | number>;
    src: string | null;
    ver: number | null;
  };
  note?: string;
}

export interface EvidenceCaveat {
  id: string;
  level: "info" | "warn";
  title: string;
}

export interface SecurityEvidence {
  /** 那晚第 1 版计划里这只股票的记录（带跟踪与日期且那晚有快照时，D68）；旧接口没有这个字段 */
  planRecord?: PlanRecord | null;
  dossier: {
    evidenceVersion: number;
    code: string;
    name: string | null;
    market: "A" | "HK";
    asOf: string;
    dataDate: string;
    dataVersion: { id: number | null; asOf: string | null };
    items: EvidenceItem[];
    caveats: EvidenceCaveat[];
    hash: string;
  };
  decision: { decisionDate: string; tradeDate: string | null };
  strategy: {
    source: "run" | "version" | "tracking";
    versionId: string;
    name: string;
    date: string;
    regime: "strong" | "weak" | null;
    passed: boolean;
    failed: string[];
    rank: number | null;
    score: number | null;
    termPct: Record<string, number> | null;
    band: "top" | "buffer" | "out" | null;
    top: number;
    hold: number;
  } | null;
  caveats: EvidenceCaveat[];
}

export interface SpecChange {
  label: string;
  before: string | null;
  after: string | null;
}

export type ProposeResult =
  | {
      ok: true;
      draftId: string;
      strategyId: string | null;
      baseVersionId: string | null;
      spec: StrategySpec;
      describe: string[];
      changes: SpecChange[];
    }
  | { ok: false; errors: string[] };

export type { FactorDef as Factor };

// ── 计划快照（D68） ──

export type PlanDateBasis = "holiday_table" | "weekday";

export interface PlanItem {
  seq: number;
  code: string;
  name: string | null;
  side: string;
  reason: string;
  reasonDetail: string | null;
  reasonText: string;
  rank: number | null;
  score: number | null;
  estPrice: number | null;
  estShares: number | null;
  estWeight: number | null;
  refClose: number | null;
  curWeight: number | null;
  failedConditions: string[] | null;
  factors: Record<string, number | string | boolean | null> | null;
  termPct: Record<string, number> | null;
}

export interface PlanSnapshot {
  id: string;
  trackingId: string;
  decisionDate: string;
  planDate: string;
  planDateBasis: PlanDateBasis | string;
  edition: number;
  cause: string;
  causeText: string;
  versionId: string;
  dataVersion: number | null;
  dataAsOf: string | null;
  engineVersion: string;
  regime: string | null;
  exposure: { current: number | null; next: number | null } | null;
  equity: number | null;
  cash: number | null;
  band: number | null;
  benchSym: string | null;
  benchClose: number | null;
  contentHash: string;
  createdAt: number;
  items: PlanItem[];
}

export interface PlanRecord {
  snapshotId: string;
  edition: number;
  decisionDate: string;
  planDate: string;
  dataAsOf: string | null;
  dataVersion: number | null;
  band: number | null;
  inPlan: boolean;
  side: string | null;
  reason: string | null;
  reasonDetail: string | null;
  reasonText: string;
  rank: number | null;
  score: number | null;
  termPct: Record<string, number> | null;
  failedConditions: string[] | null;
  factors: Record<string, number | string | boolean | null> | null;
  estWeight: number | null;
}

// ── 决策回溯（D71） ──

export type LedgerKind =
  "plan" | "replay_drift" | "tracking_start" | "tracking_stop" | "health_transition" | "brief";

export interface LedgerEntry {
  seq: number;
  kind: LedgerKind;
  asOf: string | null;
  hash8: string;
  summary: string;
  refId: string | null;
  edition: number | null;
}

export interface LedgerPage {
  entries: LedgerEntry[];
  hasMore: boolean;
}

export interface LedgerVerify {
  ok: boolean;
  checked: number;
  firstBreak: { seq: number; reason: string } | null;
}

export interface PlanItemLite {
  code: string;
  name: string | null;
  side: string;
  rank: number | null;
  estWeight: number | null;
  reasonDetail: string | null;
}

export interface PlanDiff {
  added: PlanItemLite[];
  removed: PlanItemLite[];
  changed: Array<{
    code: string;
    name: string | null;
    field: "side" | "rank" | "estWeight" | "reasonDetail";
    before: string | number | null;
    after: string | number | null;
  }>;
}

/** 第 1 版的一项按现在的数据重放执行得怎样（tracking_trades 在计划日的成交或拒单） */
export interface ReplayView {
  code: string;
  side: string;
  outcome: "filled" | "rejected" | "not_executed";
  price: number | null;
  rejectReason: string | null;
}

/** 计划结果回看（D79）：与 @ivan/engine 的 PlanOutcome 同形 */
export interface PlanOutcome {
  code: string;
  side: string;
  fillDate: string | null;
  fillOpen: number | null;
  estPrice: number | null;
  slipVsEst: number | null;
  ret5: number | null;
  ret20: number | null;
  excess5: number | null;
  excess20: number | null;
}

/** GET /api/trackings/:id/plan-on：那天看到的计划；没有那么早的计划时接口返回 null */
export interface PlanOn {
  decisionDate: string;
  planDate: string;
  edition1: PlanSnapshot;
  latest: PlanSnapshot;
  diff: PlanDiff;
  cause: string;
  causeText: string;
  /** 计划日还没结算时为空 */
  replay: ReplayView[] | null;
  revisedAfter: boolean;
  /** 决策日之后不满 5 个交易日、或 worker 不在时为空；与 edition1.items 按顺序对应 */
  outcomes: PlanOutcome[] | null;
}

/** 对话回复的数字核对结果（D69，`data-grounding` 片段；与 @ivan/ai 的 GroundingResult 同形） */
export interface GroundingResult {
  version: number;
  checked: number;
  exempt: number;
  unverified: Array<{
    raw: string;
    value: number;
    kind: "percent" | "points" | "money" | "ratio" | "count" | "plain";
    reason: "no_match" | "sign_mismatch";
    nearest?: { path: string; value: number };
  }>;
}

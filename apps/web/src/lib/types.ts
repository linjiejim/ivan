/** 服务端接口的返回形状（与 apps/server/src/services 保持一致）。 */
import type {
  Check,
  ExecConfig,
  FactorDef,
  Market,
  Metrics,
  OpenPosition,
  PendingOrder,
  PeriodMetrics,
  RunCard,
  SeriesPoint,
  StrategySpec,
  Trade,
} from "@ivan/core";

export type {
  Check,
  ExecConfig,
  FactorDef,
  Market,
  Metrics,
  RunCard,
  SeriesPoint,
  StrategySpec,
  Trade,
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

/** 结算写的跟踪摘要（只列界面用到的字段） */
export type TrackingSummary = Record<string, unknown> & {
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
    lastEtl: { status: string; finishedAt: number | null; error: string | null } | null;
    /** 今天的状态（D78）：已更新 / 休市 / 没更新 / 进行中 */
    day?: "traded" | "closed" | "stale" | "pending";
    /** 正在写的数据版本（D60）；startedAt 是毫秒时间戳 */
    openVersion?: { id: number; startedAt: number | null } | null;
    /** 上一个结束的版本：ok | incomplete | failed | skipped */
    lastVersionStatus?: string | null;
    /** 点时数据的采集情况（D61） */
    capture?: DataCapture;
  }>;
  /** 行情仓维护中（还没升级，D76）：非空时 worker 不排任务、不认领 */
  maintenance?: string | null;
  /** 夜间更新写库期间回测暂停（D60）：reason = etl | check */
  computePaused?: { reason: string; since: number } | null;
  workerUp: boolean;
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

export interface Dashboard {
  brief: { date: string; content: string | null; facts: unknown } | null;
  trackings: Array<
    TrackingView & {
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

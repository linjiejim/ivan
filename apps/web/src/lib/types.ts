/** 服务端接口的返回形状（与 apps/server/src/services 保持一致）。 */
import type {
  Check,
  FactorDef,
  Market,
  Metrics,
  OpenPosition,
  PendingOrder,
  PeriodMetrics,
  SeriesPoint,
  StrategySpec,
  Trade,
} from "@ivan/core";

export type { Check, FactorDef, Market, Metrics, SeriesPoint, StrategySpec, Trade };

export interface Me {
  user: { id: string; email: string; name: string; role: string };
  quota: { chatMessages: number; backtests: number };
  usage: { chatMessages: number; backtests: number; tokensIn: number; tokensOut: number };
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
    sweep?: { path: string; values: unknown[]; label?: string };
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

export interface RunDetail extends RunSummary {
  engineVersion: string | null;
  dataVersion: number | null;
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
  summary: Record<string, unknown> | null;
  createdAt: number;
}

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
  }>;
  workerUp: boolean;
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

/**
 * 回测/跟踪的输入输出类型：引擎产出、数据层组装、服务端存储、前端渲染共用。
 */
import type { DateStr } from "./dates.ts";
import type { StrategySpec } from "./strategy.ts";

export interface BacktestParams {
  start: DateStr;
  end: DateStr;
  /** 初始资金（本币） */
  capital: number;
  /** 样本外月数（最后 N 个月单独算指标）；0 = 不分段 */
  oosMonths: number;
}

export const DEFAULT_PARAMS: Omit<BacktestParams, "end"> = {
  start: "2018-01-01",
  capital: 1_000_000,
  oosMonths: 12,
};

/** 一只股票在日历上的价格序列（从 calendar[from] 开始，缺行情的日子为 NaN = 停牌或未上市）。 */
export interface PriceSeries {
  code: string;
  from: number;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  /** 等比复权因子（分红再投入） */
  adj: Float64Array;
  /** 当日是否 ST（涨跌幅 5%） */
  st: Uint8Array;
}

export interface SecurityInfo {
  code: string;
  name: string;
  board: string | null;
  lotSize: number | null;
  industry: string | null;
  /** 退市日（之后没有行情）；持仓到这天按最后收盘价清出 */
  delistDate?: DateStr | null;
}

export interface Signal {
  date: DateStr;
  code: string;
}

export interface SimInput {
  spec: StrategySpec;
  params: BacktestParams;
  /** 交易日历（至少覆盖 start 前一个交易日到 end） */
  calendar: DateStr[];
  prices: Map<string, PriceSeries>;
  securities: Map<string, SecurityInfo>;
  /** 决策日（收盘后）→ 通过条件的股票按得分排序（只需前 top × buffer 名左右） */
  selections: Map<DateStr, string[]>;
  signals?: Signal[];
  /** 基准收盘，对齐 calendar；缺值 NaN */
  bench: Float64Array;
  benchLabel: string;
  benchWithDividends: boolean;
  /** 同一策略在同一区间已经回测过的版本数 */
  priorVersionsOnPeriod?: number;
  /** 数据层给出的已知局限，转成检查项 */
  dataCaveats?: Array<{ id: string; level: CheckLevel; title: string; detail: string }>;
}

export type TradeReason =
  | "rebalance"
  | "filtered"
  | "take_profit"
  | "stop_loss"
  | "max_hold"
  | "signal"
  | "delisted"
  | "entry";

export interface Trade {
  date: DateStr;
  code: string;
  side: "buy" | "sell";
  price: number;
  /** 股数（卖出时是含分红再投入折算后的股数，可有小数） */
  shares: number;
  amount: number;
  fee: number;
  reason: TradeReason;
  /** 卖出才有：这笔持仓的盈亏（扣费）与持有交易日数 */
  pnl?: number;
  holdDays?: number;
}

export interface SeriesPoint {
  date: DateStr;
  /** 策略净值（起点 1） */
  nav: number;
  /** 基准净值（起点 1） */
  bench: number;
  cash: number;
  positions: number;
}

export interface HoldingSnapshot {
  date: DateStr;
  items: Array<{ code: string; weight: number }>;
}

export interface PeriodMetrics {
  start: DateStr;
  end: DateStr;
  days: number;
  totalReturn: number;
  benchReturn: number;
  cagr: number;
  benchCagr: number;
  /** 年化超额 = (1 + 年化) / (1 + 基准年化) − 1 */
  excessCagr: number;
  /** 累计超额 = (1 + 总收益) / (1 + 基准总收益) − 1 */
  excessTotal: number;
  maxDrawdown: number;
  volatility: number;
  sharpe: number;
}

export interface Metrics extends PeriodMetrics {
  drawdownPeak: DateStr | null;
  drawdownTrough: DateStr | null;
  drawdownRecovery: DateStr | null;
  calmar: number;
  winRate: number | null;
  avgHoldDays: number | null;
  /** 年化单边换手（倍） */
  turnover: number;
  /** 费用合计（本币）与年化费用拖累（占平均资产） */
  fees: number;
  costDrag: number;
  buys: number;
  sells: number;
  monthly: Array<{ month: string; ret: number; bench: number }>;
  yearly: Array<{ year: string; ret: number; bench: number }>;
  finalEquity: number;
}

export type CheckLevel = "info" | "warn";

export interface Check {
  id: string;
  level: CheckLevel;
  title: string;
  detail: string;
}

export interface Attribution {
  byStock: Array<{
    code: string;
    name: string;
    industry: string | null;
    pnl: number;
    trades: number;
  }>;
  byIndustry: Array<{ industry: string; pnl: number; avgWeight: number }>;
}

export interface OpenPosition {
  code: string;
  name: string;
  shares: number;
  value: number;
  weight: number;
  entryDate: DateStr;
  entryPrice: number;
  /** 含分红的持仓收益 */
  ret: number;
}

export interface PendingOrder {
  code: string;
  name: string;
  side: "buy" | "sell";
  reason: TradeReason;
}

export interface SimResult {
  engineVersion: string;
  series: SeriesPoint[];
  trades: Trade[];
  holdings: HoldingSnapshot[];
  metrics: Metrics;
  segments: { inSample: PeriodMetrics; outOfSample: PeriodMetrics | null };
  attribution: Attribution;
  checks: Check[];
  final: {
    date: DateStr;
    cash: number;
    equity: number;
    positions: OpenPosition[];
    /** 下一个交易日开盘要执行的单（向前跟踪的「今日信号」） */
    pending: PendingOrder[];
  };
}

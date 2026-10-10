/**
 * 回测/跟踪的输入输出类型：引擎产出、数据层组装、服务端存储、前端渲染共用。
 */
import type { DateStr } from "./dates.ts";
import type { ExecConfig } from "./exec.ts";
import type { StrategySpec } from "./strategy.ts";

export interface BacktestParams {
  start: DateStr;
  end: DateStr;
  /** 初始资金（本币） */
  capital: number;
  /** 样本外月数（最后 N 个月单独算指标）；0 = 不分段 */
  oosMonths: number;
  /** 成交假设（D55）；缺省按旧口径 LEGACY_EXEC */
  exec?: ExecConfig;
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
  /**
   * 按流动性成交（D64）才加载：第 k 格是第 k 天的 20 日均成交额（元）与日波动（60 日年化波动 ÷ 100 ÷ √250），
   * 缺值 NaN。第 k 格含第 k 天自己的成交量，第 k 天开盘成交只能用 k − 1（决策日）及以前的值。
   */
  adv?: Float32Array;
  sigma?: Float32Array;
}

export interface SecurityInfo {
  code: string;
  name: string;
  board: string | null;
  lotSize: number | null;
  industry: string | null;
  /** 退市日（之后没有行情）；持仓到这天按最后收盘价清出 */
  delistDate?: DateStr | null;
  /** 上市日（规则表第 2 版判断新股不设涨跌幅的窗口，D62）；进输入指纹 */
  listDate?: DateStr | null;
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
  /** 试错次数（D66）：同一策略在重叠 ≥ 50% 的区间里试过的其他设置数（含参数扫描，按策略内容去重） */
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
  | "entry"
  /** 仓位控制按比例增减（D52） */
  | "exposure";

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
  // ── 按流动性成交（D64）才有；旧办法成交（开盘价、不计滑点）没有这些键 ──
  /** 参考价（当日开盘） */
  ref?: number;
  /** 价差与冲击金额 = |成交价 − 参考价| × 股数 */
  slip?: number;
  /** 成交金额 ÷ 决策日的日均成交额（不知道日均成交额时没有） */
  part?: number;
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

/**
 * 风险指标（指标第 2 版，D63）。收益分布类（索提诺到峰度）在日收益观测少于 30 个时为 null；
 * 年化沿用样本估计的每年交易日数；VaR / ES 是单日、历史法，损失记正数。
 */
export interface RiskMetrics {
  sortino: number | null;
  trackingError: number | null;
  infoRatio: number | null;
  beta: number | null;
  alpha: number | null;
  var95: number | null;
  es95: number | null;
  var99: number | null;
  es99: number | null;
  /** 偏度 */
  skew: number | null;
  /** 峰度（非超额，正态为 3） */
  kurtosis: number | null;
  /** 溃疡指数 = sqrt(回撤平方的均值) */
  ulcer: number;
  /** 最长 / 当前（到区间末）低于前高的连续交易日数 */
  maxUnderwaterDays: number;
  currentUnderwaterDays: number;
  /** 跑赢基准的月份占比 */
  monthlyHitRate: number | null;
  /** 滚动 12 个月（243 个交易日）超额 */
  rolling12m: { min: number; median: number; max: number; positiveShare: number } | null;
  /** 逐年一致性：年数、跑赢基准的年数、最差年份的超额 */
  consistency: {
    years: number;
    positiveYears: number;
    worstYear: { year: string; excess: number } | null;
  };
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
  /** 平均股票仓位（股票市值 ÷ 总资产的日均值） */
  avgExposure?: number;
  monthly: Array<{ month: string; ret: number; bench: number }>;
  yearly: Array<{ year: string; ret: number; bench: number }>;
  finalEquity: number;
  // ── 指标第 2 版（D63）才有；第 1 版的结果没有这些键 ──
  /** 指标版本；缺省 = 1 */
  metricsVersion?: 1 | 2;
  /** 完整持仓数（建仓到最后一笔卖出合成一笔，仓位控制的增减算在里面） */
  roundTrips?: number;
  /** 盈利合计 ÷ 亏损合计的绝对值（扣费，按完整持仓）；没有亏损时 null */
  profitFactor?: number | null;
  /** 平均盈利 / 平均亏损（亏损为负数），按完整持仓 */
  avgWin?: number | null;
  avgLoss?: number | null;
  /** 盈亏比 = 平均盈利 ÷ 平均亏损的绝对值 */
  payoff?: number | null;
  risk?: RiskMetrics;
  // ── 按流动性成交（D64）才有：费用拖累拆成费用与滑点两部分，costDrag = feeDrag + slipDrag ──
  /** 价差与冲击合计（本币） */
  slippageCost?: number;
  feeDrag?: number;
  slipDrag?: number;
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
  /** 剩余持仓成本（买入金额 + 费用，仓位控制减仓后按比例扣掉） */
  cost?: number;
}

export interface PendingOrder {
  code: string;
  name: string;
  side: "buy" | "sell";
  reason: TradeReason;
  // ── 估算（D64，给决策账本用）：按最后收盘价和同一套报价、预算规则估，不是真实成交 ──
  /** 估计成交价；买不进（没有日均成交额等）时 null */
  estPrice?: number | null;
  estShares?: number;
  /** 估计成交金额 ÷ 当前总资产 */
  estWeight?: number;
  /** 估算用的最后收盘价 */
  refClose?: number;
  /** 卖单：这只现在的仓位 */
  curWeight?: number;
}

/** 拒单原因（D64）：停牌、涨停开盘、跌停开盘、超过成交额上限、不够一手、现金不足、没有成交额数据 */
export type RejectReason =
  "suspended" | "limit_up" | "limit_down" | "capacity" | "lot_zero" | "cash" | "no_liquidity";

export interface RejectSample {
  date: DateStr;
  code: string;
  side: "buy" | "sell";
  reason: RejectReason;
  /** 想成交的金额（买：预算；卖：按开盘或最后收盘估的市值） */
  wantValue: number;
  filledValue: number;
}

/**
 * 成交诊断（D64）：拒单统计与最近的样例旧口径也有（只是新增字段，金标准不看）；
 * 参与率、容量这些只在按流动性成交时有。
 */
export interface SimDiagnostics {
  /** 键 = 「方向:原因」（如 buy:capacity）；value = 没成交的金额 */
  rejections: Record<string, { count: number; value: number }>;
  /** 最近的 500 条（跟踪回溯要看最近的），按日期排 */
  samples: RejectSample[];
  /** 买入（建仓 / 信号）成交金额 ÷ 决策日日均成交额的分布 */
  participation?: { p50: number; p90: number; max: number } | null;
  /** 被单笔上限截小（含截到 0）的买单占比 */
  cappedBuyShare?: number;
  /** 不知道日均成交额的买单数 */
  advUnknownBuys?: number;
  /** 不知道波动率、冲击按 2.5% 日波动估的次数 */
  sigmaFallbacks?: number;
  /** 价差与冲击合计（本币） */
  slippageCost?: number;
  /** 容量估计 = 资金 × 单笔上限 ÷ 买入参与率的 90 分位；不设上限或没有成交时 null */
  capacityEstimate?: number | null;
}

export interface SimResult {
  engineVersion: string;
  /** 实际使用的成交假设（缺省字段已按旧口径补齐） */
  exec: ExecConfig;
  series: SeriesPoint[];
  /**
   * 指标第 2 版的虚拟起点（决策日，净值 1，基准按决策日收盘归一，D63）：只在指标里加，不进 series。
   * 第 1 版没有。
   */
  anchor?: SeriesPoint;
  trades: Trade[];
  holdings: HoldingSnapshot[];
  metrics: Metrics;
  segments: { inSample: PeriodMetrics; outOfSample: PeriodMetrics | null };
  attribution: Attribution;
  checks: Check[];
  /** 成交诊断（D64）；引擎 1.2.0 起都有，存档里更早的结果没有 */
  diagnostics?: SimDiagnostics;
  final: {
    date: DateStr;
    cash: number;
    equity: number;
    positions: OpenPosition[];
    /** 下一个交易日开盘要执行的单（向前跟踪的「今日信号」） */
    pending: PendingOrder[];
    /** 仓位控制（D52）：当前的仓位系数，和下一个交易日开盘要调到的系数（相同表示不调） */
    exposure?: { current: number; next: number };
  };
}

// ── 可信度（D65）：按历史日收益成段重抽样的区间与净值扇形。只对指标第 2 版的新回测算 ──

/** 一个统计量的点估计（实际序列上算的）与 95% 区间（重抽样的 2.5 / 97.5 分位） */
export interface Interval {
  est: number;
  lo: number;
  hi: number;
}

/**
 * 区间摘要（存 runs.validation，进 coreHash）。年化按自然日；最大回撤是负数；
 * psrActive = 主动收益（策略日收益 − 基准日收益）的 PSR，日收益少于 30 个时为 null。
 */
export interface Confidence {
  method: "stationary_bootstrap";
  version: 1;
  /** 重抽样次数 */
  B: number;
  /** 平均段长（交易日） */
  blockMean: number;
  seed: number;
  /** 用到的日收益个数（最多最近 4000 个） */
  n: number;
  cagr: Interval;
  excessCagr: Interval;
  sharpe: Interval;
  ir: Interval;
  maxDrawdown: Interval;
  /** 重抽样里最大回撤的中位数（回撤偏乐观的检查用） */
  mddMedian: number;
  /** 年化超额为正的重抽样占比 */
  probExcessPositive: number;
  psrActive: number | null;
  /** 重抽样路径里回撤比实际更深的占比（0–100） */
  actualMddPercentile: number;
}

/** 未来一年的净值扇形（按绝对净值，起点 1）：days[k] 个交易日后的 5 / 25 / 50 / 75 / 95 分位 */
export interface Fan {
  horizon: number;
  days: number[];
  p5: number[];
  p25: number[];
  p50: number[];
  p75: number[];
  p95: number[];
  /** 一年内最大回撤（负数）的分位：p5 是较深的 5% 情形 */
  mdd: { p5: number; p50: number; p95: number };
  /** 一年后净值低于起点的路径占比 */
  probLoss: number;
}

/** 回测线程算出的可信度：区间摘要 + 扇形（扇形压缩存 runs.validation_z） */
export interface ValidationResult {
  confidence: Confidence;
  fan: Fan | null;
}

/** 夜间更新写库期间暂停回测（D60）时给用户与模型看的一句话（worker 的 jobs 闸门、server、模型摘要共用） */
export const COMPUTE_PAUSED_TEXT = "行情正在更新，回测会在更新完成后开始";

/**
 * 一次运行的行情来源（S13，D73）：面板（入选过的股票、回测区间）里各来源的日线行数、缺失与数据问题。
 * 写进运行卡 data.provenance；只是报告，不进输入指纹。
 */
export interface RunProvenance {
  /** 按行级来源代码（em / tx / txq …；来源未记录的行记在 unknown）计的日线行数 */
  bySource: Record<string, number>;
  total: number;
  /** 来源未记录的行数（第 3 版之前写进来的） */
  unknownRows: number;
  /** 面板代码在区间里记为缺失（整条链没拿到、被体检拒收）的天数（按代码 × 日期计） */
  gapDays: number;
  gapCodes: number;
  /** 入选过的股票在区间里未解决的数据问题 */
  issues: { reject: number; flag: number };
  /** 被 ETL_ACCEPT_MISSING 放行过的面板代码 */
  accepted: string[];
}

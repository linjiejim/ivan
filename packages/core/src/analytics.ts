/**
 * 对话分析工具的结果类型（spec 20261020，D99–D104）：worker 算、server 给模型看、web 画卡片，三处共用一份形状。
 * 收益类是比例（0.123 = 12.3%）；Pct 结尾、percentile 是百分数（0–100）；价格、点位是不复权收盘；金额是元（港股港元）。
 */
import type { DateStr } from "./dates.ts";
import type { Market } from "./market.ts";

export type PeriodKey = "1w" | "1m" | "3m" | "6m" | "ytd" | "1y" | "2y" | "3y" | "5y" | "10y";

export interface DrawdownStats {
  /** 最大回撤（≤ 0） */
  maxDrawdown: number;
  peakDate: DateStr | null;
  troughDate: DateStr | null;
  /** 回到前高的日子；还没回到为 null */
  recoveryDate: DateStr | null;
  /** 终点相对区间内最高点的回撤（≤ 0） */
  currentDrawdown: number;
}

export interface RangeStats {
  /** 区间真正的起止交易日（起点 = 起点日当天或之前最后一个交易日；序列更晚才开始时就是第一天） */
  start: DateStr;
  end: DateStr;
  /** 起点日早于数据起点（比如上市晚于起点），区间被截到了第一天 */
  startClamped: boolean;
  tradingDays: number;
  /** 区间收益（复权） */
  ret: number;
  /** 年化（不足 1 年为 null） */
  cagr: number | null;
  volatility: number | null;
  /** 上涨日占比（0–1） */
  upDaysRatio: number | null;
  drawdown: DrawdownStats;
}

export interface IndexInstrument {
  kind: "index";
  /** 行情仓里的指数代号（index_bars.sym） */
  sym: string;
  label: string;
  market: Market;
  /** 同一指数的全收益序列（含分红）；没有为 null */
  trSym: string | null;
  /** 本身就是全收益序列 */
  isTotalReturn: boolean;
}

export interface StockInstrument {
  kind: "stock";
  code: string;
  name: string;
  market: Market;
  board: string | null;
  industryL1: string | null;
  industry: string | null;
  listDate: DateStr | null;
  delistDate: DateStr | null;
}

export type Instrument = IndexInstrument | StockInstrument;

export type PeriodInput = PeriodKey | "since_listing" | "max";

export const PERIOD_INPUTS: readonly PeriodInput[] = [
  "1w",
  "1m",
  "3m",
  "6m",
  "ytd",
  "1y",
  "2y",
  "3y",
  "5y",
  "10y",
  "since_listing",
  "max",
];

export function periodLabel(p: PeriodInput): string {
  const map: Record<PeriodInput, string> = {
    "1w": "近 1 周",
    "1m": "近 1 月",
    "3m": "近 3 月",
    "6m": "近 6 月",
    ytd: "今年以来",
    "1y": "近 1 年",
    "2y": "近 2 年",
    "3y": "近 3 年",
    "5y": "近 5 年",
    "10y": "近 10 年",
    since_listing: "上市以来",
    max: "全部历史",
  };
  return map[p];
}

export interface ChartPoint {
  d: DateStr;
  /** 归一到区间起点 = 1 */
  v: number;
  /** 基准（同样归一）；没有基准为 null */
  b: number | null;
}

export interface PriceHistory {
  instrument: Instrument;
  market: Market;
  currency: "CNY" | "HKD" | null;
  dataAsOf: DateStr;
  dataVersion: number | null;
  period: { from: DateStr | null; to: DateStr; label: string };
  stats: RangeStats;
  /** 不复权：起点、终点收盘与区间最高、最低收盘（指数是点位） */
  levels: {
    startClose: number;
    endClose: number;
    highClose: number;
    highDate: DateStr;
    lowClose: number;
    lowDate: DateStr;
  };
  /** 截至终点的多窗口涨跌（复权） */
  windows: Partial<Record<PeriodKey, number | null>>;
  /** 终点相对 20 / 60 / 250 日均线（复权价）的位置 */
  trend: { vsMa20: number | null; vsMa60: number | null; vsMa250: number | null };
  /** 指数：同期全收益（含分红）收益 */
  totalReturn: { sym: string; label: string; ret: number } | null;
  benchmark: {
    key: string;
    label: string;
    ret: number;
    excess: number;
    beta: number | null;
    correlation: number | null;
  } | null;
  /** 个股：上市信息与第一根 K 线（发行价不在行情仓里） */
  listing: {
    listDate: DateStr | null;
    /** 第一根 K 线就是上市首日（行情仓 2013 年起，更早上市的不是） */
    firstIsListingDay: boolean;
    firstDate: DateStr;
    firstOpen: number | null;
    firstClose: number;
    /** 从上市首日收盘、开盘算到终点的复权收益 */
    retFromFirstClose: number;
    retFromFirstOpen: number | null;
  } | null;
  /** 个股：区间内没有行情的交易日（停牌） */
  suspendedDays: number | null;
  /** 个股：区间最后 20 个交易日的日均成交额（元 / 港元） */
  avgDailyAmount20d: number | null;
  series: ChartPoint[];
  notes: string[];
}

export interface CompareItem {
  instrument: Instrument;
  market: Market;
  stats: RangeStats | null;
  windows: Partial<Record<PeriodKey, number | null>>;
  /** 个股：终点当天（或之前最近一天）的关键因子 */
  factors: Record<string, number | null> | null;
  factorDate: DateStr | null;
  series: Array<{ d: DateStr; v: number }>;
}

export interface CompareResult {
  end: DateStr;
  period: { from: DateStr | null; label: string };
  items: CompareItem[];
  /** 两两相关系数（日收益，共同交易日）；共同日子不足 20 天为 null */
  correlation: Array<{ a: string; b: string; value: number | null; commonDays: number }>;
  notes: string[];
}

export interface MarketOverview {
  market: Market;
  date: DateStr;
  prevDate: DateStr | null;
  dataAsOf: DateStr;
  indices: Array<{
    sym: string;
    label: string;
    close: number;
    chg1d: number | null;
    windows: Partial<Record<PeriodKey, number | null>>;
    vsMa60: number | null;
    vsMa250: number | null;
  }>;
  breadth: {
    /** 有成交的股票数 */
    traded: number;
    up: number;
    down: number;
    flat: number;
    /** 涨跌幅中位数（复权） */
    medianChg: number | null;
    /** 涨跌幅分布：≤ −7%、−7% ~ −3%、−3% ~ 0、0、0 ~ 3%、3% ~ 7%、≥ 7% */
    buckets: Array<{ label: string; count: number }>;
    /** A 股：按收盘价封在涨停 / 跌停价上的只数（新股上市前几天不算） */
    limitUp: number | null;
    limitDown: number | null;
    /** 站上 60 日均线的比例（0–1） */
    aboveMa60Ratio: number | null;
    /** 收盘创近 250 个交易日新高 / 新低（复权，至少有 120 天行情的股票） */
    newHigh250: number;
    newLow250: number;
  };
  turnover: {
    /** 全市场成交额（元 / 港元；缺成交额的股票按 收盘 × 成交量 估算） */
    amount: number;
    /** 之前 20 个交易日的日均成交额 */
    avg20dAmount: number | null;
    /** 今天 / 20 日均 */
    ratioTo20d: number | null;
  };
  /** 一级行业当日涨跌幅中位数：最强、最弱各 5 个（至少 5 只股票的行业） */
  industries: {
    top: Array<{ industry: string; medianChg: number; count: number; upRatio: number }>;
    bottom: Array<{ industry: string; medianChg: number; count: number; upRatio: number }>;
  };
  /** 全市场估值中位数与它在近 5 年（每周取一天）里的分位 */
  valuation: {
    pe_ttm: number | null;
    pb: number | null;
    dividend_yield_ttm: number | null;
    pePercentile5y: number | null;
    pbPercentile5y: number | null;
    dividendYieldPercentile5y: number | null;
    samples: number;
  };
  notes: string[];
}

export interface IndustryRow {
  industry: string;
  /** 区间起点有行情、能算收益的股票数 / 行业里的股票数 */
  count: number;
  members: number;
  /** 市值加权收益（权重 = 起点总市值） */
  capWeightedRet: number | null;
  medianRet: number | null;
  /** 区间上涨的比例（0–1） */
  upRatio: number | null;
  /** 终点行业总市值（亿） */
  mcap: number;
  median: {
    pe_ttm: number | null;
    pb: number | null;
    roe_ttm: number | null;
    dividend_yield_ttm: number | null;
  };
}

export interface IndustryMember {
  code: string;
  name: string;
  industry: string | null;
  ret: number | null;
  mcap: number | null;
  pe_ttm: number | null;
  pb: number | null;
  roe_ttm: number | null;
  dividend_yield_ttm: number | null;
  rev_yoy: number | null;
  np_yoy: number | null;
}

export interface IndustryPerformance {
  market: Market;
  level: "l1" | "l2";
  start: DateStr;
  end: DateStr;
  period: { label: string };
  /** 同期市场基准（价格指数）收益 */
  benchmark: { sym: string; label: string; ret: number } | null;
  industries: IndustryRow[];
  /** 指定了行业时：成分股（按 sort 排） */
  focus: { industry: string; members: IndustryMember[]; total: number } | null;
  notes: string[];
}

export interface FactorHistoryRow {
  key: string;
  label: string;
  unit: string | null;
  current: number | null;
  currentDate: DateStr | null;
  startValue: number | null;
  min: number | null;
  minDate: DateStr | null;
  max: number | null;
  maxDate: DateStr | null;
  median: number | null;
  /** 当前值在区间历史里的分位（0–100）；PE、PB、PEG 只算正值 */
  percentile: number | null;
  observations: number;
  crossSection: {
    /** 在全市场（同一天、有值的股票）里的分位（0–100） */
    marketPercentile: number | null;
    marketMedian: number | null;
    marketCount: number;
    industry: string | null;
    industryPercentile: number | null;
    industryMedian: number | null;
    industryCount: number;
  } | null;
  series: Array<{ d: DateStr; v: number }>;
}

export interface FactorHistory {
  instrument: StockInstrument;
  period: { from: DateStr | null; to: DateStr; label: string };
  factors: FactorHistoryRow[];
  notes: string[];
}

export interface FinancialRow {
  reportDate: DateStr;
  /** Q1 / H1 / Q3 / FY（报告期累计口径） */
  period: string | null;
  noticeDate: DateStr | null;
  /** 回测里从这天起可用（A 股公告日；港股按法定期限推算，D22） */
  effDate: DateStr;
  currency: string | null;
  revenue: number | null;
  np: number | null;
  deducted_np: number | null;
  revenue_yoy: number | null;
  np_yoy: number | null;
  deducted_np_yoy: number | null;
  roe: number | null;
  gross_margin: number | null;
  debt_ratio: number | null;
  ocf: number | null;
  /** 单季（港股是半年）：Q1–Q4 / H1、H2 */
  single: {
    label: string;
    revenue: number | null;
    np: number | null;
    /** 单季同比（百分数） */
    revenueYoyPct: number | null;
    npYoyPct: number | null;
  } | null;
  /** 截至这个报告期的近四季（TTM）营收与归母净利 */
  revenueTtm: number | null;
  npTtm: number | null;
}

export interface DividendRow {
  date: DateStr;
  /** 每股现金分红（交易币种） */
  cash: number | null;
  /** 送转拆合：1 股变几股（1 = 无） */
  split: number | null;
  /** 现金分红 / 除权前收盘（百分数） */
  yieldPct: number | null;
}

export interface FinancialHistory {
  instrument: StockInstrument;
  rows: FinancialRow[];
  dividends: DividendRow[];
  /** 按自然年合计的每股现金分红 */
  dividendsByYear: Array<{ year: string; cash: number; count: number }>;
  /** 最新一天的股息率 TTM（百分数） */
  dividend_yield_ttm: number | null;
  notes: string[];
}

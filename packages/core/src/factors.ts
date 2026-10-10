/**
 * 因子注册表：策略 DSL 只能引用这里的 key（白名单），行情仓 `factors_daily` 的列也由它生成。
 * 改**核心因子**口径时把 FACTOR_CORE_VERSION 加 1（夜间全量重算）；改**事件因子**口径时把
 * EVENT_FACTOR_VERSION 加 1（只按列补算事件列，D83）；FACTOR_REGISTRY_VERSION 只是记录。
 * 新因子只能加在数组末尾：已有行情仓靠 ALTER TABLE 在表尾补列，列顺序必须和注册表一致。
 */
import { addDays, type DateStr } from "./dates.ts";
import type { Market } from "./market.ts";
import type { PitDatasetId } from "./pit.ts";

/** 注册表版本：只记进运行卡与数据版本，不触发重算、也不是漂移原因（D83）。3 = S15b 加 7 个事件因子 */
export const FACTOR_REGISTRY_VERSION = 3;
/**
 * 核心因子（逐股计算与横截面那些）的口径版本：变了夜间全量重算。行情仓里仍记在 `factor_registry_version:<市场>`，
 * 所以回滚到 R4（它认的是注册表第 2 版）也不会触发重算。
 */
export const FACTOR_CORE_VERSION = 2;
/** 事件因子（两融与筹码，S15b）的口径版本：变了只按列按年补算事件列（etl/event-columns.ts） */
export const EVENT_FACTOR_VERSION = 1;

export type FactorGroup =
  | "valuation"
  | "quality"
  | "growth"
  | "size"
  | "technical"
  | "category"
  | "flag"
  // 两融与筹码（S15b，D84）：由点时事件数据集按 SQL 算，不在逐股计算里
  | "event";
export type FactorKind = "number" | "bool" | "category";

export interface FactorDef {
  key: string;
  label: string;
  group: FactorGroup;
  kind: FactorKind;
  unit?: "%" | "亿" | "x" | "天" | "名" | "年";
  markets: readonly Market[];
  describe: string;
  /** 事件因子来自哪个点时数据集（有它就是事件因子） */
  dataset?: PitDatasetId;
  /** 数据起点 = 数据集的覆盖起点 + 这么多自然日（预热：20 日变化要先有 20 个交易日、环比要先有上一季） */
  warmupDays?: number;
}

const BOTH = ["A", "HK"] as const;
const A_ONLY = ["A"] as const;

export const FACTORS = [
  // ── 估值 ──
  {
    key: "pe_ttm",
    label: "市盈率 TTM",
    group: "valuation",
    kind: "number",
    unit: "x",
    markets: BOTH,
    describe:
      "总市值 / 近四季归母净利。近四季亏损时为空（不会被「PE < N」这类条件选中）。港股财报金额按人民币中间价换成港币。",
  },
  {
    key: "pb",
    label: "市净率",
    group: "valuation",
    kind: "number",
    unit: "x",
    markets: BOTH,
    describe: "总市值 / 最新报告期归母净资产；净资产为负时为空。",
  },
  {
    key: "mcap",
    label: "总市值",
    group: "size",
    kind: "number",
    unit: "亿",
    markets: BOTH,
    describe: "不复权收盘价 × 当日有效总股本，单位亿（A 股人民币，港股港币）。",
  },
  {
    key: "dividend_yield_ttm",
    label: "股息率 TTM",
    group: "valuation",
    kind: "number",
    unit: "%",
    markets: BOTH,
    describe: "近 12 个月除息的现金分红 / 当前股价。分红由复权因子跳变与送转比例推导。",
  },
  {
    key: "pe_pct_5y",
    label: "PE 5 年分位",
    group: "valuation",
    kind: "number",
    unit: "%",
    markets: BOTH,
    describe:
      "当前 PE 在近 5 年（只算 PE>0 的交易日）里的百分位，0 = 历史最便宜。样本不足 3 年时为空。",
  },
  {
    key: "pb_pct_5y",
    label: "PB 5 年分位",
    group: "valuation",
    kind: "number",
    unit: "%",
    markets: BOTH,
    describe: "当前 PB 在近 5 年里的百分位，0 = 历史最便宜。样本不足 3 年时为空。",
  },
  {
    key: "pe_rel_industry",
    label: "PE / 行业中位数",
    group: "valuation",
    kind: "number",
    unit: "x",
    markets: BOTH,
    describe: "本股 PE 除以同日同行业（只算 PE>0 的股票）PE 中位数；< 1 表示比同行便宜。",
  },
  {
    key: "industry_mcap_rank",
    label: "行业市值排名",
    group: "size",
    kind: "number",
    unit: "名",
    markets: BOTH,
    describe: "同日同行业按总市值从大到小的排名，1 = 行业最大（≤3 常被视为龙头）。",
  },
  {
    key: "turnover_20d",
    label: "20 日均成交额",
    group: "size",
    kind: "number",
    unit: "亿",
    markets: BOTH,
    describe:
      "近 20 个交易日平均成交额（成交量 × 收盘价估算），单位亿本币；用来排除流动性差的股票。",
  },
  // ── 质量 ──
  {
    key: "roe_ttm",
    label: "ROE（TTM）",
    group: "quality",
    kind: "number",
    unit: "%",
    markets: BOTH,
    describe:
      "近四季净资产收益率 ≈ 本期累计 ROE + 上年年报 ROE − 上年同期累计 ROE（年报直接取年报）。",
  },
  {
    key: "gross_margin",
    label: "毛利率",
    group: "quality",
    kind: "number",
    unit: "%",
    markets: BOTH,
    describe: "最新报告期毛利率；银行等金融企业没有这项。",
  },
  {
    key: "debt_ratio",
    label: "资产负债率",
    group: "quality",
    kind: "number",
    unit: "%",
    markets: BOTH,
    describe: "最新报告期资产负债率。",
  },
  {
    key: "ocf_to_profit",
    label: "现金流 / 净利",
    group: "quality",
    kind: "number",
    unit: "x",
    markets: BOTH,
    describe: "报告期累计经营现金流净额 / 归母净利，衡量利润含金量；净利 ≤ 0 时为空。",
  },
  // ── 成长 ──
  {
    key: "rev_yoy",
    label: "营收同比",
    group: "growth",
    kind: "number",
    unit: "%",
    markets: BOTH,
    describe: "最新报告期累计营收同比增速。",
  },
  {
    key: "np_yoy",
    label: "归母净利同比",
    group: "growth",
    kind: "number",
    unit: "%",
    markets: BOTH,
    describe: "最新报告期累计归母净利同比增速。",
  },
  {
    key: "deducted_np_yoy",
    label: "扣非净利同比",
    group: "growth",
    kind: "number",
    unit: "%",
    markets: A_ONLY,
    describe: "最新报告期累计扣非归母净利同比增速（港股没有扣非口径）。",
  },
  {
    key: "rev_cagr_2y",
    label: "营收两年复合",
    group: "growth",
    kind: "number",
    unit: "%",
    markets: BOTH,
    describe: "最新报告期累计营收相对两年前同期的年化增速；两期都为正才有值。",
  },
  {
    key: "np_cagr_2y",
    label: "净利两年复合",
    group: "growth",
    kind: "number",
    unit: "%",
    markets: BOTH,
    describe: "最新报告期累计归母净利相对两年前同期的年化增速；两期都为正才有值，能识破低基数。",
  },
  // ── 技术 ──
  {
    key: "chg_20d",
    label: "20 日涨跌",
    group: "technical",
    kind: "number",
    unit: "%",
    markets: BOTH,
    describe: "近 20 个交易日涨跌幅（后复权，含分红）。",
  },
  {
    key: "chg_60d",
    label: "60 日涨跌",
    group: "technical",
    kind: "number",
    unit: "%",
    markets: BOTH,
    describe: "近 60 个交易日涨跌幅（后复权）。",
  },
  {
    key: "chg_250d",
    label: "250 日涨跌",
    group: "technical",
    kind: "number",
    unit: "%",
    markets: BOTH,
    describe: "近 250 个交易日（约一年）涨跌幅（后复权）。",
  },
  {
    key: "dist_high_60d",
    label: "距 60 日高点",
    group: "technical",
    kind: "number",
    unit: "%",
    markets: BOTH,
    describe: "收盘价相对近 60 日最高价的回撤，≤ 0；-20 表示比高点低 20%。",
  },
  {
    key: "dist_high_250d",
    label: "距 250 日高点",
    group: "technical",
    kind: "number",
    unit: "%",
    markets: BOTH,
    describe: "收盘价相对近 250 日最高价的回撤，≤ 0。",
  },
  {
    key: "ma20_slope",
    label: "MA20 斜率",
    group: "technical",
    kind: "number",
    unit: "%",
    markets: BOTH,
    describe: "20 日均线 5 个交易日的变化率；> 0 表示均线向上。",
  },
  {
    key: "ma60_slope",
    label: "MA60 斜率",
    group: "technical",
    kind: "number",
    unit: "%",
    markets: BOTH,
    describe: "60 日均线 5 个交易日的变化率。",
  },
  {
    key: "above_ma60",
    label: "站上 60 日线",
    group: "technical",
    kind: "bool",
    markets: BOTH,
    describe: "收盘价在 60 日均线之上。",
  },
  {
    key: "vol_ratio_20d",
    label: "量比（5/20 日）",
    group: "technical",
    kind: "number",
    unit: "x",
    markets: BOTH,
    describe: "近 5 日平均成交量 / 近 20 日平均成交量。",
  },
  {
    key: "volatility_60d",
    label: "60 日波动率",
    group: "technical",
    kind: "number",
    unit: "%",
    markets: BOTH,
    describe: "近 60 个交易日日收益率标准差 × √250（年化）。",
  },
  // ── 分类 ──
  {
    key: "industry",
    label: "行业",
    group: "category",
    kind: "category",
    markets: BOTH,
    describe: "A 股为东财二级行业，港股为东财港股行业。用的是当前行业，不是历史行业。",
  },
  {
    key: "industry_l1",
    label: "一级行业",
    group: "category",
    kind: "category",
    markets: BOTH,
    describe: "A 股为东财一级行业；港股与「行业」相同。",
  },
  {
    key: "board",
    label: "板块",
    group: "category",
    kind: "category",
    markets: BOTH,
    describe: "A 股：main 主板 / gem 创业板 / star 科创板；港股：hk_main 主板 / hk_gem 创业板。",
  },
  // ── 标记 ──
  {
    key: "flag_st",
    label: "ST",
    group: "flag",
    kind: "bool",
    markets: A_ONLY,
    describe:
      "当日简称含 ST。深市按深交所官方简称变更；沪市 2018 年起按每日简称；更早的沪市与沪市退市股用「最近两期年报归母净利都为负」近似。",
  },
  {
    key: "flag_new_listing",
    label: "次新股",
    group: "flag",
    kind: "bool",
    markets: BOTH,
    describe: "上市不满 365 天。",
  },
  {
    key: "flag_loss",
    label: "亏损",
    group: "flag",
    kind: "bool",
    markets: BOTH,
    describe: "近四季归母净利 ≤ 0。",
  },
  {
    key: "flag_value_trap",
    label: "价值陷阱",
    group: "flag",
    kind: "bool",
    markets: BOTH,
    describe:
      "PE 5 年分位 < 30，但利润连续两期同比下滑（A 股看扣非，港股看归母）。便宜可能是因为在变差。",
  },
  {
    key: "flag_deducted_decline",
    label: "扣非连降",
    group: "flag",
    kind: "bool",
    markets: A_ONLY,
    describe: "扣非净利连续两期同比下滑。",
  },
  {
    key: "flag_low_base",
    label: "低基数",
    group: "flag",
    kind: "bool",
    markets: BOTH,
    describe: "净利同比 > 100% 但两年复合 < 20%：高增长主要来自去年基数低。",
  },
  {
    key: "flag_high_debt",
    label: "高负债",
    group: "flag",
    kind: "bool",
    markets: BOTH,
    describe: "资产负债率 > 70%（银行、保险、证券等金融行业不判）。",
  },
  {
    key: "flag_chasing",
    label: "短期涨幅大",
    group: "flag",
    kind: "bool",
    markets: BOTH,
    describe: "近 20 日涨幅 > 15%，追高风险。",
  },
  {
    key: "flag_downtrend",
    label: "下跌通道",
    group: "flag",
    kind: "bool",
    markets: BOTH,
    describe: "收盘价在 60 日均线下方且 60 日均线向下。",
  },
  // ── 以下为注册表第 2 版新增（D47–D49）。只能往末尾加，见文件头 ──
  {
    key: "mcap_rank",
    label: "市值排名（全市场）",
    group: "size",
    kind: "number",
    unit: "名",
    markets: BOTH,
    describe:
      "同日同市场按总市值从大到小的排名，1 = 最大。「市值排名 ≤ 800」就是当时的大中盘股票池，不会拿今天的大公司去回测过去。行情仓只回填了部分股票时排名偏高（只在已回填的股票里排）。",
  },
  {
    key: "roe_min_3y",
    label: "ROE 三年最低",
    group: "quality",
    kind: "number",
    unit: "%",
    markets: BOTH,
    describe:
      "当前、约一年前、约两年前三个时点的 ROE（TTM）里最低的一个（缺的时点跳过）。只有连续几年都赚钱的公司才高，能筛掉周期顶点「一年暴利」的假便宜。",
  },
  {
    key: "payout_ratio",
    label: "派息率",
    group: "quality",
    kind: "number",
    unit: "%",
    markets: BOTH,
    describe:
      "近 12 个月现金分红 ÷ 近四季归母净利（= 股息率 × 市盈率）。超过 100% 表示分得比赚得多，分红难以持续；亏损时为空。",
  },
  {
    key: "dividend_years_3y",
    label: "近三年分红年数",
    group: "quality",
    kind: "number",
    unit: "年",
    markets: BOTH,
    describe: "当前、约一年前、约两年前三个时点，近 12 个月里有没有现金分红，数一数有几个（0–3）。",
  },
  {
    key: "peg",
    label: "PEG",
    group: "valuation",
    kind: "number",
    unit: "x",
    markets: BOTH,
    describe:
      "市盈率 TTM ÷ 净利两年复合增速（%）；两者都为正才有值。< 1 表示按增速看不贵，常用来找「估值不高的成长股」。",
  },
  {
    key: "mom_12_1",
    label: "12-1 月动量",
    group: "technical",
    kind: "number",
    unit: "%",
    markets: BOTH,
    describe:
      "约一年前到约一个月前（第 250 到第 20 个交易日前）的涨幅（后复权，含分红）；跳过最近一个月，避开短期反转。",
  },
  // ── 以下为注册表第 3 版新增（S15b，D83、D84）：两融与筹码，只有 A 股。只能往末尾加，见文件头 ──
  {
    key: "margin_ratio",
    label: "融资余额占流通市值",
    group: "event",
    kind: "number",
    unit: "%",
    markets: A_ONLY,
    dataset: "margin",
    warmupDays: 7,
    describe:
      "最近一条两融记录的融资余额 ÷ 同一行的流通市值 × 100。融资数据按 T+1 可得：决策日用的是前一个交易日的两融数据。不是两融标的、最近一条早于 5 个交易日、或两融数据同步落后超过 5 个交易日时为空。",
  },
  {
    key: "margin_chg_20d",
    label: "融资余额 20 日变化",
    group: "event",
    kind: "number",
    unit: "%",
    markets: A_ONLY,
    dataset: "margin",
    warmupDays: 40,
    describe:
      "最近一条融资余额 ÷ 正好 20 个交易日前那条 − 1（%）。按 T+1 可得；20 个交易日前没有记录，或两融数据同步落后超过 5 个交易日时为空。",
  },
  {
    key: "margin_eligible",
    label: "两融标的",
    group: "event",
    kind: "bool",
    markets: A_ONLY,
    dataset: "margin",
    warmupDays: 7,
    describe:
      "最近 5 个交易日内有融资余额 > 0 的两融记录（按 T+1 可得）。两融数据覆盖起点后 7 天之前、或同步落后超过 5 个交易日时为空（不知道），不是两融标的为「否」。",
  },
  {
    key: "holder_num_qoq",
    label: "股东户数环比",
    group: "event",
    kind: "number",
    unit: "%",
    markets: A_ONLY,
    dataset: "holders",
    warmupDays: 200,
    describe:
      "决策日已公告的最新一个季末户数 ÷ 上一季末户数 − 1（%），上一季末那条也必须当时已公告。按公告日可得，不是截至日；户数减少常被看作筹码集中。最新季末的公告超过 200 天、上一季末没有、或户数同步落后 30 天以上时为空。",
  },
  {
    key: "unlock_days",
    label: "距下次解禁",
    group: "event",
    kind: "number",
    unit: "天",
    markets: A_ONLY,
    dataset: "lockups",
    warmupDays: 0,
    describe:
      "决策日已知的下一次限售解禁日 − 决策日（自然日，只看 180 天内）；180 天内没有已知解禁记为 181。解禁的可得日在每晚同步开始之前是按规则推算的（首发按上市日，其他按解禁前几个交易日的提示性公告）。解禁数据同步落后 3 天以上时为空。",
  },
  {
    key: "unlock_ratio_30d",
    label: "30 天内解禁占流通股",
    group: "event",
    kind: "number",
    unit: "%",
    markets: A_ONLY,
    dataset: "lockups",
    warmupDays: 0,
    describe:
      "未来 30 个自然日内已知解禁的股数占流通股比例之和（%）；没有已知解禁为 0，有已知解禁但缺比例时为空（不知道）。可得日规则同「距下次解禁」；解禁数据同步落后 3 天以上时为空。",
  },
  {
    key: "block_premium_20d",
    label: "大宗交易折溢价（20 日）",
    group: "event",
    kind: "number",
    unit: "%",
    markets: A_ONLY,
    dataset: "blocks",
    warmupDays: 40,
    describe:
      "近 20 个交易日（按可得日）大宗交易成交价 ÷ 当日收盘 − 1，按成交额加权（%）；负数是折价。大宗交易按 T+1 可得。没有大宗交易、或大宗数据没同步到决策日的前一个交易日时为空。",
  },
] as const satisfies readonly FactorDef[];

export type FactorKey = (typeof FACTORS)[number]["key"];

export const FACTOR_MAP: ReadonlyMap<string, FactorDef> = new Map(
  FACTORS.map((f) => [f.key, f as FactorDef]),
);

export function getFactor(key: string): FactorDef | undefined {
  return FACTOR_MAP.get(key);
}

export function factorsForMarket(market: Market): FactorDef[] {
  return FACTORS.filter((f) => (f.markets as readonly Market[]).includes(market));
}

export function isFactorAvailable(key: string, market: Market): boolean {
  const f = FACTOR_MAP.get(key);
  return !!f && (f.markets as readonly Market[]).includes(market);
}

/** 事件因子（带 dataset 的，S15b）：按注册表顺序 */
export const EVENT_FACTOR_KEYS: readonly string[] = (FACTORS as readonly FactorDef[])
  .filter((f) => f.dataset)
  .map((f) => f.key);

export function isEventFactor(key: string): boolean {
  return !!FACTOR_MAP.get(key)?.dataset;
}

/** 用到事件因子、而历史还没补算完时的提示（server 提交前与 worker 建输入时同一句，D83） */
export function eventNotReadyText(doneYears: number, totalYears: number): string {
  return totalYears > 0
    ? `两融与筹码类因子的历史还在补算（${doneYears}/${totalYears} 年），补完后才能回测；今天的选股可以先用`
    : "两融与筹码类因子的历史数据还在补齐，补完后才能回测；今天的选股可以先用";
}

/** 回测起点早于事件因子的数据起点 */
export function eventStartTooEarlyText(label: string, from: DateStr): string {
  return `因子「${label}」从 ${from} 起才有数据，请把起点设在这之后`;
}

/** 事件因子的数据起点 = 数据集的覆盖起点 + 预热天数；数据集还没补完（没有覆盖起点）为 null */
export function eventCoverageFrom(def: FactorDef, coveredFrom: DateStr | null): DateStr | null {
  return coveredFrom ? addDays(coveredFrom, def.warmupDays ?? 0) : null;
}

/** 行业里不判高负债的金融类（A 股一级行业 / 港股行业名里含这些字即算）。 */
export const FINANCIAL_INDUSTRY_RE = /银行|保险|证券|金融|信托|多元金融|期货/;

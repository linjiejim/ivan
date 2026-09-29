/**
 * 因子注册表：策略 DSL 只能引用这里的 key（白名单），行情仓 `factors_daily` 的列也由它生成。
 * 改任何因子的口径都要把 FACTOR_REGISTRY_VERSION 加 1，夜间更新会全量重算。
 * 新因子只能加在数组末尾：已有行情仓靠 ALTER TABLE 在表尾补列，列顺序必须和注册表一致。
 */
import type { Market } from "./market.ts";

export const FACTOR_REGISTRY_VERSION = 2;

export type FactorGroup =
  "valuation" | "quality" | "growth" | "size" | "technical" | "category" | "flag";
export type FactorKind = "number" | "bool" | "category";

export interface FactorDef {
  key: string;
  label: string;
  group: FactorGroup;
  kind: FactorKind;
  unit?: "%" | "亿" | "x" | "天" | "名" | "年";
  markets: readonly Market[];
  describe: string;
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

/** 行业里不判高负债的金融类（A 股一级行业 / 港股行业名里含这些字即算）。 */
export const FINANCIAL_INDUSTRY_RE = /银行|保险|证券|金融|信托|多元金融|期货/;

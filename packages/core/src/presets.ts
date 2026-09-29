/**
 * 预设模板（spec §4）：新用户点一下就能建策略并回测；也是 LLM 起草策略时的参考样例。
 */
import type { Market } from "./market.ts";
import type { StrategySpecInput } from "./strategy.ts";

export interface Preset {
  id: string;
  market: Market;
  title: string;
  blurb: string;
  spec: StrategySpecInput;
}

/** 价值组合三条策略共用的纪律（D50）：当时市值前 N、流动性、不接飞刀、每季调仓、缓冲 2 倍、同一行业最多 3 只 */
const VALUE_DISCIPLINE = {
  universe: { exclude: ["st", "new_listing", "loss"] as Array<"st" | "new_listing" | "loss"> },
  rebalance: { every: "quarter" as const, buffer: 2 },
  exits: { dropWhenFiltered: true },
};
const liquidAndNotFalling = [
  { factor: "turnover_20d", op: ">=" as const, value: 0.5 },
  { factor: "chg_250d", op: ">=" as const, value: -30 },
];

export const PRESETS: Preset[] = [
  {
    id: "a-quality-value",
    market: "A",
    title: "价值组合·质量价值",
    blurb:
      "当时市值前 800 里，同行中最便宜、利润含金量最高、股价已企稳的 30 家；每季调仓。价值组合里占 40%。",
    spec: {
      name: "价值组合·质量价值",
      market: "A",
      ...VALUE_DISCIPLINE,
      filters: [
        { factor: "mcap_rank", op: "<=", value: 800 },
        ...liquidAndNotFalling,
        { factor: "roe_min_3y", op: ">=", value: 5 },
        { factor: "ocf_to_profit", op: ">=", value: 0.5 },
      ],
      rank: {
        terms: [
          { factor: "pe_ttm", weight: 1, better: "low", neutral: true },
          { factor: "pb", weight: 1, better: "low", neutral: true },
          { factor: "dividend_yield_ttm", weight: 1, better: "high", neutral: true },
          { factor: "ocf_to_profit", weight: 3, better: "high", neutral: true },
          { factor: "dist_high_250d", weight: 1.5, better: "high" },
          { factor: "mom_12_1", weight: 1.5, better: "high" },
        ],
        top: 30,
        maxPerIndustry: 3,
      },
    },
  },
  {
    id: "a-quality-value-regime",
    market: "A",
    title: "价值组合·质量价值（大势切换·实验）",
    blurb:
      "质量价值的实验版：沪深300 在 200 日均线上方时偏重股价强度和业绩增长，下方时偏重便宜、现金流和低波动。建议先模拟跟踪，和原版对照。",
    spec: {
      name: "价值组合·质量价值（大势切换·实验）",
      market: "A",
      ...VALUE_DISCIPLINE,
      filters: [
        { factor: "mcap_rank", op: "<=", value: 800 },
        ...liquidAndNotFalling,
        { factor: "roe_min_3y", op: ">=", value: 5 },
        { factor: "ocf_to_profit", op: ">=", value: 0.5 },
      ],
      rank: {
        terms: [
          { factor: "pe_ttm", weight: 0.5, better: "low", neutral: true },
          { factor: "pb", weight: 0.5, better: "low", neutral: true },
          { factor: "dividend_yield_ttm", weight: 0.5, better: "high", neutral: true },
          { factor: "ocf_to_profit", weight: 3, better: "high", neutral: true },
          { factor: "dist_high_250d", weight: 3, better: "high" },
          { factor: "mom_12_1", weight: 3, better: "high" },
          { factor: "np_yoy", weight: 1.5, better: "high" },
        ],
        top: 30,
        maxPerIndustry: 3,
        regime: {
          ma: 200,
          weak: {
            terms: [
              { factor: "pe_ttm", weight: 2, better: "low", neutral: true },
              { factor: "pb", weight: 2, better: "low", neutral: true },
              { factor: "dividend_yield_ttm", weight: 2, better: "high", neutral: true },
              { factor: "ocf_to_profit", weight: 4.5, better: "high", neutral: true },
              { factor: "volatility_60d", weight: 1.5, better: "low" },
            ],
          },
        },
      },
    },
  },
  {
    id: "a-dividend-value",
    market: "A",
    title: "价值组合·红利价值",
    blurb:
      "当时市值前 300 的大公司里，分红可持续（派息率 ≤ 80%、有现金流、市盈率 ≤ 20）的 20 家；每季调仓。价值组合里占 30%。",
    spec: {
      name: "价值组合·红利价值",
      market: "A",
      ...VALUE_DISCIPLINE,
      filters: [
        { factor: "mcap_rank", op: "<=", value: 300 },
        ...liquidAndNotFalling,
        { factor: "dividend_yield_ttm", op: ">=", value: 2 },
        { factor: "payout_ratio", op: "<=", value: 80 },
        { factor: "dividend_years_3y", op: ">=", value: 2 },
        { factor: "ocf_to_profit", op: ">=", value: 0.5 },
        { factor: "pe_ttm", op: "<=", value: 20 },
      ],
      rank: {
        terms: [
          { factor: "dividend_yield_ttm", weight: 3, better: "high" },
          { factor: "ocf_to_profit", weight: 1, better: "high", neutral: true },
          { factor: "dist_high_250d", weight: 0.75, better: "high" },
          { factor: "mom_12_1", weight: 0.75, better: "high" },
        ],
        top: 20,
        maxPerIndustry: 3,
      },
    },
  },
  {
    id: "a-garp-value",
    market: "A",
    title: "价值组合·合理价格成长",
    blurb:
      "当时市值前 800 里，还在增长（两年复合 ≥ 10%）、按增速看不贵（PEG ≤ 1.5）、连续三年 ROE ≥ 10% 的 30 家；每季调仓。价值组合里占 30%。",
    spec: {
      name: "价值组合·合理价格成长",
      market: "A",
      ...VALUE_DISCIPLINE,
      filters: [
        { factor: "mcap_rank", op: "<=", value: 800 },
        ...liquidAndNotFalling,
        { factor: "rev_cagr_2y", op: ">=", value: 10 },
        { factor: "np_cagr_2y", op: ">=", value: 10 },
        { factor: "peg", op: "<=", value: 1.5 },
        { factor: "roe_ttm", op: ">=", value: 10 },
        { factor: "roe_min_3y", op: ">=", value: 10 },
        { factor: "ocf_to_profit", op: ">=", value: 0.5 },
      ],
      rank: {
        terms: [
          { factor: "pe_ttm", weight: 1, better: "low", neutral: true },
          { factor: "pb", weight: 1, better: "low", neutral: true },
          { factor: "ocf_to_profit", weight: 2, better: "high", neutral: true },
          { factor: "dist_high_250d", weight: 1.5, better: "high" },
          { factor: "mom_12_1", weight: 1.5, better: "high" },
        ],
        top: 30,
        maxPerIndustry: 3,
      },
    },
  },
  {
    id: "a-value-leaders",
    market: "A",
    title: "低估值高 ROE 龙头",
    blurb: "ROE 高、估值处在自己历史低位、行业前三的龙头，每月调仓。",
    spec: {
      name: "低估值高 ROE 龙头",
      market: "A",
      universe: { exclude: ["st", "new_listing", "loss"], minMcap: 100 },
      filters: [
        { factor: "roe_ttm", op: ">=", value: 12 },
        { factor: "pe_ttm", op: "<=", value: 30 },
        { factor: "industry_mcap_rank", op: "<=", value: 3 },
        { factor: "flag_value_trap", op: "not" },
      ],
      rank: {
        terms: [
          { factor: "pe_pct_5y", weight: 3, better: "low" },
          { factor: "roe_ttm", weight: 2, better: "high" },
          { factor: "np_cagr_2y", weight: 1, better: "high" },
        ],
        top: 15,
      },
      rebalance: { every: "month", buffer: 1.5 },
      exits: { dropWhenFiltered: true },
    },
  },
  {
    id: "a-dividend",
    market: "A",
    title: "高股息",
    blurb: "股息率高、利润不在下滑、负债可控，每季调仓，追求稳定现金回报。",
    spec: {
      name: "高股息",
      market: "A",
      universe: { exclude: ["st", "new_listing", "loss"], minMcap: 50 },
      filters: [
        { factor: "dividend_yield_ttm", op: ">=", value: 3 },
        { factor: "flag_deducted_decline", op: "not" },
        { factor: "turnover_20d", op: ">=", value: 0.5 },
      ],
      rank: {
        terms: [
          { factor: "dividend_yield_ttm", weight: 3, better: "high" },
          { factor: "roe_ttm", weight: 1, better: "high" },
        ],
        top: 20,
      },
      rebalance: { every: "quarter", buffer: 1.5 },
      exits: { dropWhenFiltered: true },
    },
  },
  {
    id: "a-garp",
    market: "A",
    title: "GARP 成长",
    blurb: "营收与利润两年复合都在增长、估值相对行业不贵，每月调仓，止损 15%。",
    spec: {
      name: "GARP 成长",
      market: "A",
      universe: { exclude: ["st", "new_listing", "loss"], minMcap: 80 },
      filters: [
        { factor: "rev_cagr_2y", op: ">=", value: 15 },
        { factor: "np_cagr_2y", op: ">=", value: 15 },
        { factor: "pe_rel_industry", op: "<=", value: 1.2 },
        { factor: "flag_low_base", op: "not" },
      ],
      rank: {
        terms: [
          { factor: "np_cagr_2y", weight: 2, better: "high" },
          { factor: "pe_rel_industry", weight: 2, better: "low" },
          { factor: "roe_ttm", weight: 1, better: "high" },
        ],
        top: 15,
      },
      rebalance: { every: "month", buffer: 1.5 },
      exits: { stopLoss: 0.15, dropWhenFiltered: true },
    },
  },
  {
    id: "a-momentum",
    market: "A",
    title: "中期动量",
    blurb: "过去一年涨得好、站上 60 日线、不在短期暴涨的股票，每周调仓。",
    spec: {
      name: "中期动量",
      market: "A",
      universe: { exclude: ["st", "new_listing", "loss"], minMcap: 100 },
      filters: [
        { factor: "above_ma60", op: "is" },
        { factor: "flag_chasing", op: "not" },
        { factor: "turnover_20d", op: ">=", value: 1 },
      ],
      rank: {
        terms: [
          { factor: "chg_250d", weight: 2, better: "high" },
          { factor: "volatility_60d", weight: 1, better: "low" },
        ],
        top: 20,
      },
      rebalance: { every: "week", buffer: 2 },
      exits: { stopLoss: 0.12, dropWhenFiltered: true },
    },
  },
  {
    id: "hk-dividend",
    market: "HK",
    title: "港股高股息",
    blurb: "港股里股息率高、有流动性的公司，每季调仓。",
    spec: {
      name: "港股高股息",
      market: "HK",
      universe: { exclude: ["new_listing", "loss"], minMcap: 200 },
      filters: [
        { factor: "dividend_yield_ttm", op: ">=", value: 5 },
        { factor: "turnover_20d", op: ">=", value: 0.3 },
      ],
      rank: {
        terms: [
          { factor: "dividend_yield_ttm", weight: 3, better: "high" },
          { factor: "pb", weight: 1, better: "low" },
        ],
        top: 15,
      },
      rebalance: { every: "quarter", buffer: 1.5 },
      exits: { dropWhenFiltered: true },
    },
  },
  {
    id: "hk-value-leaders",
    market: "HK",
    title: "港股低估值龙头",
    blurb: "行业前三、ROE 高、估值在自身历史低位的港股，每月调仓。",
    spec: {
      name: "港股低估值龙头",
      market: "HK",
      universe: { exclude: ["new_listing", "loss"], minMcap: 300 },
      filters: [
        { factor: "roe_ttm", op: ">=", value: 10 },
        { factor: "industry_mcap_rank", op: "<=", value: 3 },
        { factor: "turnover_20d", op: ">=", value: 0.5 },
      ],
      rank: {
        terms: [
          { factor: "pe_pct_5y", weight: 2, better: "low" },
          { factor: "roe_ttm", weight: 2, better: "high" },
        ],
        top: 12,
      },
      rebalance: { every: "month", buffer: 1.5 },
      exits: { dropWhenFiltered: true },
    },
  },
  {
    id: "hk-garp",
    market: "HK",
    title: "港股 GARP 成长",
    blurb: "港股里利润两年复合增长、估值不贵的公司，每月调仓，止损 15%。",
    spec: {
      name: "港股 GARP 成长",
      market: "HK",
      universe: { exclude: ["new_listing", "loss"], minMcap: 150 },
      filters: [
        { factor: "np_cagr_2y", op: ">=", value: 15 },
        { factor: "pe_ttm", op: "<=", value: 25 },
        { factor: "turnover_20d", op: ">=", value: 0.3 },
      ],
      rank: {
        terms: [
          { factor: "np_cagr_2y", weight: 2, better: "high" },
          { factor: "pe_ttm", weight: 1, better: "low" },
        ],
        top: 12,
      },
      rebalance: { every: "month", buffer: 1.5 },
      exits: { stopLoss: 0.15, dropWhenFiltered: true },
    },
  },
  {
    id: "hk-momentum",
    market: "HK",
    title: "港股中期动量",
    blurb: "过去一年涨幅领先、站上 60 日线、流动性好的港股，每周调仓。",
    spec: {
      name: "港股中期动量",
      market: "HK",
      universe: { exclude: ["new_listing"], minMcap: 200 },
      filters: [
        { factor: "above_ma60", op: "is" },
        { factor: "turnover_20d", op: ">=", value: 1 },
      ],
      rank: {
        terms: [
          { factor: "chg_250d", weight: 2, better: "high" },
          { factor: "volatility_60d", weight: 1, better: "low" },
        ],
        top: 15,
      },
      rebalance: { every: "week", buffer: 2 },
      exits: { stopLoss: 0.12, dropWhenFiltered: true },
    },
  },
];

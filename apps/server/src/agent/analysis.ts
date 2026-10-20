/**
 * 对话分析工具（spec 20261020，D99–D105）：个股与指数走势、多只对比、大盘、行业、因子历史、财报，以及计算器。
 *
 * 和其他工具一样：execute 返回给卡片画图的完整结果，toModelOutput 只给模型精简、四舍五入过的摘要（也是数字核对的证据）。
 * 行情类工具要 worker 组装数据，计入每日「数据查询」额度（D59）：先挡住超额的，拿到结果再扣；计算器不计。
 */
import { r2 } from "@ivan/ai";
import {
  BENCHMARKS,
  type CompareResult,
  type FactorHistory,
  type FinancialHistory,
  type IndustryPerformance,
  type Instrument,
  type MarketOverview,
  PERIOD_INPUTS,
  type PeriodInput,
  type PriceHistory,
} from "@ivan/core";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { consume, ensureQuota } from "../lib/quota.ts";
import { worker } from "../lib/worker-client.ts";
import { CALC_FUNCTIONS, CALC_UNITS, calculate, type CalcItem } from "./calc.ts";

const json = (value: unknown) => ({
  type: "json" as const,
  value: JSON.parse(JSON.stringify(value ?? null)),
});

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式要是 YYYY-MM-DD");
const Period = z
  .enum(PERIOD_INPUTS as unknown as [PeriodInput, ...PeriodInput[]])
  .describe(
    "区间：1w 1m 3m 6m ytd（今年以来）1y 2y 3y 5y 10y since_listing（上市以来）max（全部）",
  );
const BenchKey = z.enum(Object.keys(BENCHMARKS) as [string, ...string[]]);

/** 比例（收益、回撤、超额…）保留 4 位小数，百分数与倍数保留 2 位，价格保留 3 位 */
const ratio = (x: number | null | undefined) => r2(x, 4);
const two = (x: number | null | undefined) => r2(x, 2);
const price = (x: number | null | undefined) => r2(x, 3);
const roundMap = (o: Record<string, number | null | undefined>, f = ratio) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));

function target(i: Instrument) {
  return i.kind === "stock"
    ? { kind: "stock", code: i.code, name: i.name, industry: i.industryL1, listDate: i.listDate }
    : { kind: "index", sym: i.sym, name: i.label };
}

/** 行情类工具：先挡住超额的，worker 返回了再扣 1 次「数据查询」 */
async function analysis<T>(userId: string, path: string, body: unknown): Promise<T> {
  ensureQuota(userId, "analyses");
  const r = await worker.post<T>(path, body);
  consume(userId, "analyses");
  return r;
}

// ── 给模型看的摘要（导出给测试与数字核对用） ──

export function priceHistoryForModel(p: PriceHistory) {
  const s = p.stats;
  return {
    target: target(p.instrument),
    market: p.market,
    currency: p.currency,
    dataAsOf: p.dataAsOf,
    period: {
      label: p.period.label,
      start: s.start,
      end: s.end,
      tradingDays: s.tradingDays,
      startClamped: s.startClamped,
    },
    ret: ratio(s.ret),
    cagr: ratio(s.cagr),
    volatility: ratio(s.volatility),
    upDaysRatio: ratio(s.upDaysRatio),
    maxDrawdown: ratio(s.drawdown.maxDrawdown),
    drawdownPeakDate: s.drawdown.peakDate,
    drawdownTroughDate: s.drawdown.troughDate,
    recoveryDate: s.drawdown.recoveryDate,
    currentDrawdown: ratio(s.drawdown.currentDrawdown),
    levels: {
      startClose: price(p.levels.startClose),
      endClose: price(p.levels.endClose),
      highClose: price(p.levels.highClose),
      highDate: p.levels.highDate,
      lowClose: price(p.levels.lowClose),
      lowDate: p.levels.lowDate,
    },
    windows: roundMap(p.windows),
    trend: roundMap(p.trend),
    totalReturn: p.totalReturn
      ? { label: p.totalReturn.label, ret: ratio(p.totalReturn.ret) }
      : null,
    benchmark: p.benchmark
      ? {
          label: p.benchmark.label,
          ret: ratio(p.benchmark.ret),
          excess: ratio(p.benchmark.excess),
          beta: two(p.benchmark.beta),
          correlation: two(p.benchmark.correlation),
        }
      : null,
    listing: p.listing
      ? {
          listDate: p.listing.listDate,
          firstIsListingDay: p.listing.firstIsListingDay,
          firstDate: p.listing.firstDate,
          firstOpen: price(p.listing.firstOpen),
          firstClose: price(p.listing.firstClose),
          retFromFirstClose: ratio(p.listing.retFromFirstClose),
          retFromFirstOpen: ratio(p.listing.retFromFirstOpen),
        }
      : null,
    suspendedDays: p.suspendedDays,
    avgDailyAmount20d: p.avgDailyAmount20d === null ? null : Math.round(p.avgDailyAmount20d),
    notes: p.notes,
    note: "收益类是比例（0.1234 = 12.34%）；ret 是区间收益（复权），levels 是不复权的价格或点位；currentDrawdown 是终点距区间最高点的回撤（说「距高点回撤 x%」）。卡片已画出走势图与多窗口涨跌，文字只说结论和一两个关键数。",
  };
}

export function compareForModel(c: CompareResult) {
  return {
    end: c.end,
    period: c.period.label,
    items: c.items.map((i) => ({
      target: target(i.instrument),
      start: i.stats?.start ?? null,
      ret: ratio(i.stats?.ret),
      cagr: ratio(i.stats?.cagr),
      volatility: ratio(i.stats?.volatility),
      maxDrawdown: ratio(i.stats?.drawdown.maxDrawdown),
      windows: roundMap({ "1m": i.windows["1m"], ytd: i.windows.ytd, "1y": i.windows["1y"] }),
      factors: i.factors ? roundMap(i.factors, two) : null,
      factorDate: i.factorDate,
    })),
    correlation: c.correlation.map((x) => ({ a: x.a, b: x.b, correlation: two(x.value) })),
    notes: c.notes,
    note: "factors 里 PE、PB 是倍数，ROE、股息率、增速、毛利率、负债率、PE 分位是百分数，市值、成交额是亿。卡片已画出对比图和表格。",
  };
}

export function marketForModel(m: MarketOverview) {
  return {
    market: m.market,
    date: m.date,
    prevDate: m.prevDate,
    indices: m.indices.map((i) => ({
      label: i.label,
      close: two(i.close),
      chg1d: ratio(i.chg1d),
      ...roundMap({ "1m": i.windows["1m"], ytd: i.windows.ytd, "1y": i.windows["1y"] }),
      vsMa250: ratio(i.vsMa250),
    })),
    breadth: {
      ...m.breadth,
      medianChg: ratio(m.breadth.medianChg),
      aboveMa60Ratio: ratio(m.breadth.aboveMa60Ratio),
    },
    turnover: {
      amount: Math.round(m.turnover.amount),
      avg20dAmount: m.turnover.avg20dAmount === null ? null : Math.round(m.turnover.avg20dAmount),
      ratioTo20d: two(m.turnover.ratioTo20d),
    },
    industries: {
      top: m.industries.top.map((i) => ({
        ...i,
        medianChg: ratio(i.medianChg),
        upRatio: ratio(i.upRatio),
      })),
      bottom: m.industries.bottom.map((i) => ({
        ...i,
        medianChg: ratio(i.medianChg),
        upRatio: ratio(i.upRatio),
      })),
    },
    valuation: {
      pe_ttm: two(m.valuation.pe_ttm),
      pb: two(m.valuation.pb),
      dividend_yield_ttm: two(m.valuation.dividend_yield_ttm),
      pePercentile5y: r2(m.valuation.pePercentile5y, 0),
      pbPercentile5y: r2(m.valuation.pbPercentile5y, 0),
      dividendYieldPercentile5y: r2(m.valuation.dividendYieldPercentile5y, 0),
      weeklySamples: m.valuation.samples,
    },
    notes: m.notes,
    note: "涨跌、比例是比例（0.012 = 1.2%）；成交额是元（港股港元）；估值是全市场中位数，percentile 是近 5 年分位（0–100）。卡片已列出全部指数与分布。",
  };
}

export function industryForModel(r: IndustryPerformance) {
  const row = (i: IndustryPerformance["industries"][number]) => ({
    industry: i.industry,
    capWeightedRet: ratio(i.capWeightedRet),
    medianRet: ratio(i.medianRet),
    upRatio: ratio(i.upRatio),
    count: i.count,
    mcap: Math.round(i.mcap),
    median: roundMap(i.median, two),
  });
  const n = r.industries.length;
  return {
    market: r.market,
    level: r.level === "l1" ? "一级行业" : "二级行业",
    start: r.start,
    end: r.end,
    period: r.period.label,
    benchmark: r.benchmark ? { label: r.benchmark.label, ret: ratio(r.benchmark.ret) } : null,
    industryCount: n,
    strongest: r.industries.slice(0, Math.min(10, n)).map(row),
    // 最弱的几个：和最强的 10 个不重叠的部分（11–15 个行业时也要给，否则问「最弱」没有数）
    weakest:
      n > 10
        ? r.industries
            .slice(Math.max(10, n - 5))
            .reverse()
            .map(row)
        : [],
    focus: r.focus
      ? {
          industry: r.focus.industry,
          total: r.focus.total,
          members: r.focus.members.slice(0, 15).map((m) => ({
            code: m.code,
            name: m.name,
            ret: ratio(m.ret),
            mcap: two(m.mcap),
            pe_ttm: two(m.pe_ttm),
            pb: two(m.pb),
            roe_ttm: two(m.roe_ttm),
            dividend_yield_ttm: two(m.dividend_yield_ttm),
            rev_yoy: two(m.rev_yoy),
            np_yoy: two(m.np_yoy),
          })),
        }
      : null,
    notes: r.notes,
    note: "收益是比例；mcap 是亿；median 里 PE、PB 是倍数，ROE、股息率是百分数。卡片已列出全部行业。",
  };
}

export function factorHistoryForModel(f: FactorHistory) {
  return {
    target: target(f.instrument),
    period: f.period.label,
    from: f.period.from,
    to: f.period.to,
    factors: f.factors.map((x) => ({
      key: x.key,
      label: x.label,
      unit: x.unit ?? "",
      current: two(x.current),
      currentDate: x.currentDate,
      startValue: two(x.startValue),
      min: two(x.min),
      minDate: x.minDate,
      max: two(x.max),
      maxDate: x.maxDate,
      median: two(x.median),
      percentile: r2(x.percentile, 0),
      observations: x.observations,
      crossSection: x.crossSection
        ? {
            unit: x.unit ?? "",
            marketPercentile: r2(x.crossSection.marketPercentile, 0),
            marketMedian: two(x.crossSection.marketMedian),
            marketCount: x.crossSection.marketCount,
            industry: x.crossSection.industry,
            industryPercentile: r2(x.crossSection.industryPercentile, 0),
            industryMedian: two(x.crossSection.industryMedian),
            industryCount: x.crossSection.industryCount,
          }
        : null,
    })),
    notes: f.notes,
    note: "数值的单位见 unit（% 是百分数，x 是倍数，亿是亿元）；percentile 是 0–100 的分位。卡片已画出每个因子的历史。",
  };
}

export function financialsForModel(f: FinancialHistory) {
  return {
    target: target(f.instrument),
    rows: f.rows.map((r) => ({
      reportDate: r.reportDate,
      period: r.period,
      noticeDate: r.noticeDate,
      currency: r.currency,
      revenue: r.revenue,
      np: r.np,
      deducted_np: r.deducted_np,
      revenue_yoy: two(r.revenue_yoy),
      np_yoy: two(r.np_yoy),
      deducted_np_yoy: two(r.deducted_np_yoy),
      roe: two(r.roe),
      gross_margin: two(r.gross_margin),
      debt_ratio: two(r.debt_ratio),
      ocf: r.ocf,
      single: r.single
        ? {
            label: r.single.label,
            revenue: r.single.revenue,
            np: r.single.np,
            revenueYoyPct: two(r.single.revenueYoyPct),
            npYoyPct: two(r.single.npYoyPct),
          }
        : null,
      revenueTtm: r.revenueTtm,
      npTtm: r.npTtm,
    })),
    dividendsByYear: f.dividendsByYear.map((d) => ({ ...d, cash: r2(d.cash, 4) })),
    dividends: f.dividends.slice(0, 6).map((d) => ({ ...d, yieldPct: two(d.yieldPct) })),
    dividend_yield_ttm: two(f.dividend_yield_ttm),
    notes: f.notes,
    note: "金额是元（报表币种）；*_yoy、roe、gross_margin、debt_ratio、*Pct 是百分数；cash 是每股现金分红。卡片已列出全部报告期。",
  };
}

export function calcForModel(items: CalcItem[]) {
  return {
    items: items.map((i) =>
      i.error
        ? { label: i.label, error: i.error }
        : { label: i.label, value: i.value, unit: i.unit },
    ),
    note: "unit 为 % 时 value 已是百分数（23 = 23%）。",
  };
}

// ── 工具 ──

export function analysisTools(userId: string): ToolSet {
  return {
    get_price_history: tool({
      description:
        "个股或指数在一段时间里的走势与统计：区间涨跌（复权）、年化、最大回撤（峰谷日期与是否修复）、年化波动、区间最高最低价、" +
        "近 1 周 / 1 月 / 3 月 / 6 月 / 今年 / 1 年 / 3 年 / 5 年的涨跌、相对 20 / 60 / 250 日均线的位置；个股默认和市场基准比（超额、β、相关系数），" +
        "指数同时给含分红的全收益；上市以来（since_listing）给首日开盘与收盘。query 可以是名称、代码，或指数：上证指数、沪深300、中证500、中证1000、" +
        "创业板指、中证红利、恒生指数（恒指）、国企指数。问「涨了多少、走势、回撤、波动、上市以来、离高点多远」都用它。",
      inputSchema: z.object({
        query: z.string().describe("名称、代码或指数名，如 腾讯控股、600519、恒指、沪深300"),
        period: Period.optional().describe("默认 1y；与 from 二选一"),
        from: DateStr.optional().describe("自定义起点 YYYY-MM-DD"),
        to: DateStr.optional().describe("终点，默认最新数据日"),
        benchmark: BenchKey.optional().describe(
          "对比基准：csi300 / sse / csi500 / csi1000 / csi_div / hsi / hscei；个股默认市场默认基准，指数默认不比",
        ),
      }),
      execute: async (input) =>
        analysis<PriceHistory>(userId, "/internal/analytics/price-history", input),
      toModelOutput: ({ output }) => json(priceHistoryForModel(output)),
    }),

    compare_securities: tool({
      description:
        "把 2–6 只股票或指数放在一起比：同一区间的涨跌、年化、波动、最大回撤、两两相关系数，个股再给 PE、PB、PE 5 年分位、股息率、ROE、营收与净利增速、" +
        "毛利率、负债率、市值、成交额。问「A 和 B 哪个好、谁更便宜、谁波动大、走势像不像」用它。",
      inputSchema: z.object({
        queries: z.array(z.string()).min(2).max(6).describe("名称、代码或指数名"),
        period: Period.optional().describe("默认 1y"),
        from: DateStr.optional(),
        to: DateStr.optional(),
      }),
      execute: async (input) =>
        analysis<CompareResult>(userId, "/internal/analytics/compare", input),
      toModelOutput: ({ output }) => json(compareForModel(output)),
    }),

    get_market_overview: tool({
      description:
        "大盘某一天（默认最新数据日）的全貌：主要指数涨跌与近 1 月 / 今年 / 1 年表现、相对年线位置；涨跌家数与涨跌幅分布、涨停跌停（A 股）、" +
        "站上 60 日线的比例、创 250 日新高新低的只数；成交额与 20 日均量之比；当天最强最弱的行业；全市场 PE、PB、股息率中位数与近 5 年分位。" +
        "问「今天大盘 / 市场怎么样、情绪、放量缩量、市场贵不贵」用它。",
      inputSchema: z.object({
        market: z.enum(["A", "HK"]),
        date: DateStr.optional().describe("YYYY-MM-DD，默认最新数据日"),
      }),
      execute: async (input) =>
        analysis<MarketOverview>(userId, "/internal/analytics/market", input),
      toModelOutput: ({ output }) => json(marketForModel(output)),
    }),

    get_industry_performance: tool({
      description:
        "行业在一段时间里的表现排行：市值加权与中位数涨跌、上涨比例、行业总市值、PE / PB / ROE / 股息率中位数，附同期大盘；" +
        "给 industry 时再列出这个行业的成分股（按 sort 排：mcap 市值、ret 涨跌、pe_ttm、pb、roe_ttm、dividend_yield_ttm）。" +
        "问「最近哪些行业强 / 弱、某行业估值、某行业的龙头 / 最便宜的」用它。",
      inputSchema: z.object({
        market: z.enum(["A", "HK"]),
        period: Period.optional().describe("默认 1m；since_listing / max 不适用"),
        from: DateStr.optional(),
        to: DateStr.optional(),
        level: z.enum(["l1", "l2"]).optional().describe("l1 一级行业（默认）、l2 二级行业"),
        industry: z.string().optional().describe("要看成分股的行业名，如 银行、白酒、半导体"),
        sort: z.enum(["mcap", "ret", "pe_ttm", "pb", "roe_ttm", "dividend_yield_ttm"]).optional(),
        limit: z.number().int().min(1).max(50).optional().describe("成分股最多列几只，默认 20"),
      }),
      execute: async (input) =>
        analysis<IndustryPerformance>(userId, "/internal/analytics/industries", input),
      toModelOutput: ({ output }) => json(industryForModel(output)),
    }),

    get_factor_history: tool({
      description:
        "个股的因子（估值、质量等，默认 PE、PB、股息率、ROE）在一段时间里的历史：当前值、最低最高（带日期）、中位数、当前在历史里的分位；" +
        "以及当天在全市场、同一级行业里的分位与中位数。问「现在估值贵不贵、在历史什么位置、比同行便宜吗、ROE 趋势」用它。因子名见 list_factors。",
      inputSchema: z.object({
        query: z.string().describe("名称或代码"),
        factors: z
          .array(z.string())
          .max(6)
          .optional()
          .describe("数值因子键，如 pe_ttm、pb、dividend_yield_ttm、roe_ttm、mcap、turnover_20d"),
        period: Period.optional().describe("默认 5y"),
        from: DateStr.optional(),
        to: DateStr.optional(),
      }),
      execute: async (input) =>
        analysis<FactorHistory>(userId, "/internal/analytics/factor-history", input),
      toModelOutput: ({ output }) => json(factorHistoryForModel(output)),
    }),

    get_financials: tool({
      description:
        "个股的财报历史（默认最近 8 期，最多 20）：营收、归母净利、扣非净利、同比、ROE、毛利率、负债率、经营现金流；" +
        "另算好单季（港股是半年）数值与单季同比、近四季（TTM）营收与净利；以及分红送转记录、每年每股分红合计与当前股息率。" +
        "问「业绩趋势、单季增速、利润质量、分红历史」用它；lookup_security 只看最近几期。",
      inputSchema: z.object({
        query: z.string().describe("名称或代码"),
        periods: z.number().int().min(1).max(20).optional(),
        annualOnly: z.boolean().optional().describe("只看年报"),
      }),
      execute: async (input) =>
        analysis<FinancialHistory>(userId, "/internal/analytics/financials", input),
      toModelOutput: ({ output }) => json(financialsForModel(output)),
    }),

    calculate: tool({
      description:
        "计算器：要换算、相减、相乘、算金额、算年化或涨跌幅时调用它，不要心算。一次最多 12 条。" +
        "数字只能用工具结果里的数或用户给的数。表达式支持 + - * / ^、括号、% 后缀（25% = 0.25）、万 / 亿 后缀，" +
        `函数：${CALC_FUNCTIONS.join("、")}（cagr(起点值, 终点值, 年数)、annualize(区间收益, 自然日数)、change(从, 到) = 到 / 从 − 1）。` +
        "要百分比时 unit 写 %，表达式算出比例（0.23）即可，不要自己乘 100。",
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              label: z
                .string()
                .max(40)
                .describe("这一项是什么，如「超额收益」「100 万现在值多少」"),
              expr: z.string().max(300),
              unit: z
                .enum(CALC_UNITS)
                .optional()
                .describe("结果的单位：% 元 港元 亿 万 x（倍）天 年；不写 = 纯数"),
            }),
          )
          .min(1)
          .max(12),
      }),
      execute: async ({ items }) => ({ items: calculate(items) }),
      toModelOutput: ({ output }) => json(calcForModel(output.items)),
    }),
  };
}

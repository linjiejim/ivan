/**
 * 对话分析工具（spec 20261020）：额度只在拿到结果后扣、超额不调 worker；模型摘要能让照抄的数字通过数字核对，编的数通不过。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkGrounding, collectEvidence } from "@ivan/ai";
import type { FactorHistory, IndustryPerformance, MarketOverview, PriceHistory } from "@ivan/core";
import { loadConfig } from "@ivan/core/config";
import { openAppDb, usageDaily, userQuotas } from "@ivan/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setEnvForTest } from "../env.ts";
import {
  calcForModel,
  factorHistoryForModel,
  industryForModel,
  marketForModel,
  priceHistoryForModel,
} from "./analysis.ts";
import { calculate } from "./calc.ts";
import { buildTools } from "./tools.ts";

const dir = mkdtempSync(join(tmpdir(), "ivan-analysis-test-"));
const cfg = { ...loadConfig(), dataDir: dir, appDbPath: join(dir, "app.sqlite"), workerPort: 1 };
const handle = openAppDb(cfg.appDbPath);
const USER = "u_analysis";
const opts = { toolCallId: "t", messages: [] } as never;

beforeAll(() => {
  setEnvForTest(cfg, handle);
});
afterEach(() => {
  vi.unstubAllGlobals();
  handle.db.delete(usageDaily).run();
  handle.db.delete(userQuotas).run();
});

const used = () =>
  handle.db.select().from(usageDaily).where(eq(usageDaily.userId, USER)).get()?.analyses ?? 0;

const PRICE: PriceHistory = {
  instrument: {
    kind: "stock",
    code: "00700.HK",
    name: "腾讯控股",
    market: "HK",
    board: "hk_main",
    industryL1: "资讯科技业",
    industry: "互联网",
    listDate: "2004-06-16",
    delistDate: null,
  },
  market: "HK",
  currency: "HKD",
  dataAsOf: "2026-10-16",
  dataVersion: 25,
  period: { from: "2025-10-16", to: "2026-10-16", label: "近 1 年" },
  stats: {
    start: "2025-10-16",
    end: "2026-10-16",
    startClamped: false,
    tradingDays: 247,
    ret: 0.123456,
    cagr: 0.1231,
    volatility: 0.2845,
    upDaysRatio: 0.52,
    drawdown: {
      maxDrawdown: -0.18234,
      peakDate: "2026-03-02",
      troughDate: "2026-04-09",
      recoveryDate: null,
      currentDrawdown: -0.0612,
    },
  },
  levels: {
    startClose: 512.5,
    endClose: 575.0,
    highClose: 612.5,
    highDate: "2026-03-02",
    lowClose: 470.2,
    lowDate: "2026-04-09",
  },
  windows: { "1w": 0.012, "1m": -0.034, ytd: 0.081, "1y": 0.123456 },
  trend: { vsMa20: 0.01, vsMa60: -0.02, vsMa250: 0.05 },
  totalReturn: null,
  benchmark: {
    key: "hsi",
    label: "恒指（盈富基金含分红）",
    ret: 0.0789,
    excess: 0.044556,
    beta: 1.1234,
    correlation: 0.8123,
  },
  listing: null,
  suspendedDays: 0,
  avgDailyAmount20d: 1.234e10,
  series: [],
  notes: ["港股数据截至 2026-10-16（已提交的最新数据日）"],
};

function stubWorker(status: number, body: unknown) {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    seen.push(String(input));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return seen;
}

describe("分析工具的额度（D59）", () => {
  it("拿到结果才扣 1 次数据查询；worker 说找不到时不扣", async () => {
    const tools = buildTools({ userId: USER, threadId: "th", page: {} });
    const seen = stubWorker(200, PRICE);
    const out = (await tools.get_price_history!.execute!({ query: "腾讯" }, opts)) as PriceHistory;
    expect(out.instrument.kind).toBe("stock");
    expect(seen[0]).toMatch(/\/internal\/analytics\/price-history$/);
    expect(used()).toBe(1);

    stubWorker(404, { error: "没找到「不存在」" });
    await expect(tools.get_price_history!.execute!({ query: "不存在" }, opts)).rejects.toThrow(
      /没找到/,
    );
    expect(used()).toBe(1);
  });

  it("额度用完时直接 429，不调 worker；计算器不计额度", async () => {
    handle.db.insert(userQuotas).values({ userId: USER, analyses: 0 }).run();
    const tools = buildTools({ userId: USER, threadId: "th", page: {} });
    const seen = stubWorker(200, PRICE);
    await expect(tools.get_market_overview!.execute!({ market: "A" }, opts)).rejects.toThrow(
      /数据查询额度/,
    );
    expect(seen).toHaveLength(0);
    const calc = (await tools.calculate!.execute!(
      { items: [{ label: "超额", expr: "0.123456 - 0.0789", unit: "%" }] },
      opts,
    )) as { items: Array<{ value: number }> };
    expect(calc.items[0]!.value).toBeCloseTo(4.4556, 8);
  });

  it("七个新工具都注册了", () => {
    const names = Object.keys(buildTools({ userId: USER, threadId: "th", page: {} }));
    for (const n of [
      "get_price_history",
      "compare_securities",
      "get_market_overview",
      "get_industry_performance",
      "get_factor_history",
      "get_financials",
      "calculate",
    ])
      expect(names).toContain(n);
  });
});

describe("模型摘要与数字核对（D104）", () => {
  it("走势：照抄的收益、回撤、价格、超额都核对得上；编的数核对不上", () => {
    const ev = collectEvidence("get_price_history", priceHistoryForModel(PRICE));
    const good =
      "腾讯近 1 年涨 12.3%，跑赢恒指 4.5 个百分点（恒指 7.9%）；最大回撤 18.2%，现在距高点回撤 6.1%。收盘 575 港元，区间最高 612.5 港元，β 1.12。";
    expect(checkGrounding(good, ev).unverified).toEqual([]);
    const bad = checkGrounding("腾讯近 1 年涨 15.2%，收盘 590 港元", ev);
    expect(bad.unverified.map((u) => u.raw)).toEqual(["15.2%", "590 港元"]);
  });

  it("因子历史：百分数因子按百分数核对", () => {
    const f: FactorHistory = {
      instrument: PRICE.instrument as FactorHistory["instrument"],
      period: { from: "2021-10-16", to: "2026-10-16", label: "近 5 年" },
      factors: [
        {
          key: "dividend_yield_ttm",
          label: "股息率 TTM",
          unit: "%",
          current: 0.82,
          currentDate: "2026-10-16",
          startValue: 0.3,
          min: 0.25,
          minDate: "2022-01-01",
          max: 1.1,
          maxDate: "2024-01-01",
          median: 0.6,
          percentile: 77.4,
          observations: 1200,
          crossSection: {
            marketPercentile: 20.2,
            marketMedian: 3.4,
            marketCount: 2800,
            industry: "资讯科技业",
            industryPercentile: 66,
            industryMedian: 0.5,
            industryCount: 120,
          },
          series: [],
        },
      ],
      notes: [],
    };
    const ev = collectEvidence("get_factor_history", factorHistoryForModel(f));
    expect(
      checkGrounding("股息率 0.82%，在近 5 年排 77% 分位，全市场中位数 3.4%", ev).unverified,
    ).toEqual([]);
    expect(checkGrounding("股息率 82%", ev).unverified).toHaveLength(1);
  });

  it("大盘：成交额、家数与估值分位", () => {
    const m: MarketOverview = {
      market: "A",
      date: "2026-10-20",
      prevDate: "2026-10-19",
      dataAsOf: "2026-10-20",
      indices: [
        {
          sym: "csi300",
          label: "沪深300",
          close: 4123.456,
          chg1d: 0.0123,
          windows: { "1m": 0.02, ytd: 0.1, "1y": 0.15 },
          vsMa60: 0.01,
          vsMa250: 0.05,
        },
      ],
      breadth: {
        traded: 5217,
        up: 3120,
        down: 1900,
        flat: 197,
        medianChg: 0.0081,
        buckets: [],
        limitUp: 62,
        limitDown: 5,
        aboveMa60Ratio: 0.553,
        newHigh250: 140,
        newLow250: 21,
      },
      turnover: { amount: 1.2345e12, avg20dAmount: 1.1e12, ratioTo20d: 1.1223 },
      industries: { top: [], bottom: [] },
      valuation: {
        pe_ttm: 28.4,
        pb: 2.3,
        dividend_yield_ttm: 1.2,
        pePercentile5y: 64.2,
        pbPercentile5y: 40,
        dividendYieldPercentile5y: 55,
        samples: 260,
      },
      notes: [],
    };
    const ev = collectEvidence("get_market_overview", marketForModel(m));
    const text =
      "沪深300 涨 1.2%，收 4123.46；上涨 3120 只、下跌 1900 只，涨停 62 只；成交额 1.23 万亿，是 20 日均量的 1.12 倍；全市场 PE 中位数 28.4 倍，处在近 5 年 64% 分位。";
    expect(checkGrounding(text, ev).unverified).toEqual([]);
  });

  it("计算器：结果按单位核对", () => {
    const ev = collectEvidence(
      "calculate",
      calcForModel(
        calculate([
          { label: "超额", expr: "0.123456 - 0.0789", unit: "%" },
          { label: "100 万现在值", expr: "100万 * (1 + 0.123456)", unit: "元" },
        ]),
      ),
    );
    expect(checkGrounding("超额 4.5%，100 万现在值 112.3 万元", ev).unverified).toEqual([]);
    expect(checkGrounding("超额 5.5%", ev).unverified).toHaveLength(1);
  });

  it("行业：11–15 个行业时也给最弱的几个（和最强的 10 个不重叠）", () => {
    const mk = (i: number) => ({
      industry: `行业${i}`,
      count: 5,
      members: 5,
      capWeightedRet: 0.1 - i * 0.01,
      medianRet: 0,
      upRatio: 0.5,
      mcap: 100,
      median: { pe_ttm: 10, pb: 1, roe_ttm: 10, dividend_yield_ttm: 2 },
    });
    const r = {
      market: "A",
      level: "l1",
      start: "2026-09-30",
      end: "2026-10-20",
      period: { label: "近 1 月" },
      benchmark: null,
      industries: Array.from({ length: 12 }, (_, i) => mk(i)),
      focus: null,
      notes: [],
    } as IndustryPerformance;
    const v = industryForModel(r);
    expect(v.strongest).toHaveLength(10);
    expect(v.weakest.map((x) => x.industry)).toEqual(["行业11", "行业10"]);
    expect(industryForModel({ ...r, industries: r.industries.slice(0, 8) }).weakest).toEqual([]);
  });
});

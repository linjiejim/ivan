/**
 * 对话分析工具的行情仓查询（spec 20261020）：在合成市场上核对标的解析、走势统计、对比、大盘宽度、行业、因子历史与财报。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedSyntheticMarket } from "../../testing/seed.ts";
import { Warehouse } from "../../warehouse/db.ts";
import {
  AnalyticsError,
  compareSecurities,
  factorHistory,
  financialHistory,
  industryPerformance,
  marketOverview,
  priceHistory,
  resolveInstrument,
} from "./index.ts";

const DAYS = 300;
let wh: Warehouse;
let cal: string[];
let committed: string;

beforeEach(async () => {
  wh = await Warehouse.open(":memory:");
  const last = DAYS - 1;
  ({ calendar: cal } = await seedSyntheticMarket(wh, {
    market: "A",
    start: "2025-01-02",
    days: DAYS,
    dataVersion: false,
    stocks: [
      {
        code: "600001.SH",
        name: "甲银行",
        industry_l1: "银行",
        listDate: "2025-01-02",
        close: (i) => 10 + i * 0.01,
        factors: (i) => ({ pe_ttm: 5 + i * 0.01, pb: 0.8, mcap: 300, roe_ttm: 12, dividend_yield_ttm: 5 }),
      },
      {
        code: "600002.SH",
        name: "乙银行",
        industry_l1: "银行",
        listDate: "2010-01-04",
        close: (i) => 20 - i * 0.01,
        factors: () => ({ pe_ttm: 6, pb: 0.6, mcap: 100, roe_ttm: 10, dividend_yield_ttm: 6 }),
      },
      {
        code: "600003.SH",
        name: "丙食品测试",
        industry_l1: "食品饮料",
        listDate: "2010-01-04",
        close: () => 30,
        factors: () => ({ pe_ttm: 30, pb: 6, mcap: 2000, roe_ttm: 25, dividend_yield_ttm: 2 }),
      },
      {
        code: "600004.SH",
        name: "丁食品测试",
        industry_l1: "食品饮料",
        listDate: "2010-01-04",
        // 最后一天涨停（主板 10%）
        close: (i) => (i < last ? 10 : 11),
        factors: () => ({ pe_ttm: 20, pb: 3, mcap: 50, roe_ttm: 15, dividend_yield_ttm: 1 }),
      },
    ],
  }));
  committed = cal.at(-1)!;
  await wh.run(
    `INSERT INTO data_versions (id, market, as_of, kind, status) VALUES (3, 'A', $d::DATE, 'daily', 'ok')`,
    { d: committed },
  );
});
afterEach(() => wh.close());

describe("标的解析", () => {
  it("指数叫法、代码、名称；重名列候选；找不到给可用指数", async () => {
    const idx = await resolveInstrument(wh, "沪深 300");
    expect(idx).toMatchObject({ kind: "index", sym: "csi300", trSym: "csi300_tr", market: "A" });
    expect(await resolveInstrument(wh, "hsi")).toMatchObject({ kind: "index", sym: "hsi", market: "HK" });
    expect(await resolveInstrument(wh, "600001")).toMatchObject({ kind: "stock", code: "600001.SH" });
    expect(await resolveInstrument(wh, "乙银行")).toMatchObject({ code: "600002.SH" });
    await expect(resolveInstrument(wh, "食品测试")).rejects.toThrow(/对应多只股票.*600003\.SH/);
    const e = await resolveInstrument(wh, "不存在的公司").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AnalyticsError);
    expect((e as AnalyticsError).status).toBe(404);
    expect((e as Error).message).toMatch(/恒生指数/);
  });
});

describe("走势（D99）", () => {
  it("个股近 1 年：区间收益、默认基准的超额、点位与图", async () => {
    const r = await priceHistory(wh, { query: "甲银行", period: "1y" });
    expect(r.period.to).toBe(committed);
    const s = r.stats;
    const i0 = cal.findLastIndex((d) => d <= s.start);
    const expected = (10 + (DAYS - 1) * 0.01) / (10 + i0 * 0.01) - 1;
    expect(s.ret).toBeCloseTo(expected, 10);
    expect(r.levels.endClose).toBeCloseTo(10 + (DAYS - 1) * 0.01, 10);
    expect(r.levels.highDate).toBe(committed);
    expect(s.drawdown.maxDrawdown).toBe(0);
    expect(r.benchmark?.key).toBe("csi300");
    expect(r.benchmark!.excess).toBeCloseTo(s.ret - r.benchmark!.ret, 12);
    expect(r.series.length).toBeLessThanOrEqual(240);
    expect(r.series[0]!.v).toBe(1);
    expect(r.series.at(-1)!.d).toBe(committed);
    expect(r.windows["1m"]).not.toBeNull();
    expect(r.trend.vsMa20).toBeGreaterThan(0);
    expect(r.suspendedDays).toBe(0);
    expect(r.listing).toBeNull();
    expect(r.currency).toBe("CNY");
  });

  it("只读到已提交的截至日（D60）", async () => {
    await wh.run(`INSERT INTO data_versions (id, market, as_of, kind, status) VALUES (4, 'A', $d::DATE, 'daily', 'failed')`, {
      d: committed,
    });
    await wh.run(`UPDATE data_versions SET as_of = $d::DATE WHERE id = 3`, { d: cal.at(-3)! });
    const r = await priceHistory(wh, { query: "600001", period: "1m", to: "2099-01-01" });
    expect(r.period.to).toBe(cal.at(-3));
    expect(r.levels.endClose).toBeCloseTo(10 + (DAYS - 3) * 0.01, 10);
  });

  it("上市以来：从第一根 K 线算，标出是上市首日", async () => {
    const r = await priceHistory(wh, { query: "甲银行", period: "since_listing" });
    expect(r.listing?.firstIsListingDay).toBe(true);
    expect(r.listing?.firstDate).toBe(cal[0]);
    expect(r.listing!.retFromFirstClose).toBeCloseTo((10 + (DAYS - 1) * 0.01) / 10 - 1, 10);
    expect(r.notes.join("")).toMatch(/没有发行价/);
  });

  it("指数：同期全收益与价格指数并列", async () => {
    const r = await priceHistory(wh, { query: "沪深300", period: "3m" });
    expect(r.instrument.kind).toBe("index");
    expect(r.benchmark).toBeNull();
    expect(r.totalReturn?.sym).toBe("csi300_tr");
    expect(r.totalReturn!.ret).toBeCloseTo(r.stats.ret, 10);
  });

  it("参数不对给 400", async () => {
    await expect(priceHistory(wh, { query: "甲银行", from: "2026/01/01" })).rejects.toThrow(/日期格式/);
    await expect(priceHistory(wh, { query: "甲银行", benchmark: "hsi" })).rejects.toThrow(/不在同一个市场/);
  });
});

describe("对比（D100）", () => {
  it("三只：各自统计、两两相关、关键因子", async () => {
    const r = await compareSecurities(wh, { queries: ["甲银行", "乙银行", "沪深300"], period: "6m" });
    expect(r.items).toHaveLength(3);
    expect(r.correlation).toHaveLength(3);
    expect(r.items[0]!.factors?.pe_ttm).toBeCloseTo(5 + (DAYS - 1) * 0.01, 10);
    expect(r.items[2]!.factors).toBeNull();
    expect(r.items[1]!.stats!.ret).toBeLessThan(0);
    await expect(compareSecurities(wh, { queries: ["甲银行"] })).rejects.toThrow(/2–6/);
  });
});

describe("大盘与行业（D101、D102）", () => {
  it("涨跌家数、涨停、成交额与估值中位数", async () => {
    const r = await marketOverview(wh, { market: "A" });
    expect(r.date).toBe(committed);
    expect(r.breadth.traded).toBe(4);
    expect(r.breadth.up).toBe(2);
    expect(r.breadth.down).toBe(1);
    expect(r.breadth.flat).toBe(1);
    expect(r.breadth.limitUp).toBe(1);
    expect(r.breadth.limitDown).toBe(0);
    expect(r.breadth.buckets.reduce((a, b) => a + b.count, 0)).toBe(4);
    expect(r.turnover.amount).toBeGreaterThan(0);
    expect(r.turnover.ratioTo20d).not.toBeNull();
    expect(r.indices.map((i) => i.sym)).toEqual(["sse", "csi300"]);
    expect(r.valuation.pe_ttm).toBeCloseTo((5 + (DAYS - 1) * 0.01 + 20) / 2, 8);
    expect(r.valuation.samples).toBeGreaterThan(10);
  });

  it("行业：市值加权收益、成分股按市值排", async () => {
    const r = await industryPerformance(wh, { market: "A", period: "3m", industry: "银行" });
    const bank = r.industries.find((x) => x.industry === "银行")!;
    expect(bank.members).toBe(2);
    expect(bank.mcap).toBe(400);
    expect(bank.median.pb).toBeCloseTo(0.7, 10);
    expect(r.focus?.members.map((m) => m.code)).toEqual(["600001.SH", "600002.SH"]);
    expect(r.benchmark?.sym).toBe("csi300");
    await expect(industryPerformance(wh, { market: "A", industry: "半导体" })).rejects.toThrow(/没有叫/);
  });
});

describe("因子历史与财报（D103）", () => {
  it("PE 一路上升：当前分位接近 100，横截面在 4 只里排位", async () => {
    const r = await factorHistory(wh, { query: "甲银行", factors: ["pe_ttm", "roe_ttm"], period: "1y" });
    const pe = r.factors[0]!;
    expect(pe.percentile).toBeGreaterThan(99);
    expect(pe.max).toBeCloseTo(pe.current!, 10);
    expect(pe.crossSection?.marketCount).toBe(4);
    expect(pe.crossSection?.industryCount).toBe(2);
    await expect(factorHistory(wh, { query: "甲银行", factors: ["industry"] })).rejects.toThrow(/不是数值因子/);
    await expect(factorHistory(wh, { query: "沪深300" })).rejects.toThrow(/只能查个股/);
  });

  it("单季、TTM 与分红", async () => {
    const rows: Array<[string, string, string, number, number]> = [
      ["2025-03-31", "Q1", "2025-04-28", 100, 10],
      ["2025-06-30", "H1", "2025-08-28", 250, 24],
      ["2025-09-30", "Q3", "2025-10-28", 380, 37],
      ["2025-12-31", "FY", "2026-03-28", 520, 50],
      ["2026-03-31", "Q1", "2026-04-28", 120, 13],
    ];
    for (const [rd, p, nd, rev, np] of rows) {
      await wh.run(
        `INSERT INTO financials (code, report_date, period, fy_start, notice_date, eff_date, currency, revenue, np)
         VALUES ('600001.SH', $rd::DATE, $p, $fy::DATE, $nd::DATE, $nd::DATE, 'CNY', $rev, $np)`,
        { rd, p, fy: `${rd.slice(0, 4)}-01-01`, nd, rev, np },
      );
    }
    await wh.run(
      `INSERT INTO corp_actions (code, date, prev_close, ref_price, cash, split)
       VALUES ('600001.SH', DATE '2025-07-10', 10, 9.5, 0.5, 1), ('600001.SH', DATE '2024-07-10', 10, 9.6, 0.4, 1)`,
    );
    const r = await financialHistory(wh, { query: "600001", periods: 5 });
    const [q1, fy, q3, h1, q1Last] = r.rows;
    expect(q1!.single).toMatchObject({ label: "Q1", revenue: 120, np: 13 });
    expect(q1!.single!.revenueYoyPct).toBeCloseTo(20, 10);
    expect(q1!.revenueTtm).toBe(520 + 120 - 100);
    expect(fy!.single).toMatchObject({ label: "Q4", revenue: 140, np: 13 });
    expect(q3!.single).toMatchObject({ label: "Q3", revenue: 130 });
    expect(h1!.single).toMatchObject({ label: "Q2", revenue: 150 });
    expect(q1Last!.revenueTtm).toBeNull();
    expect(r.dividends[0]).toMatchObject({ date: "2025-07-10", cash: 0.5, yieldPct: 5 });
    expect(r.dividendsByYear.map((y) => y.year)).toEqual(["2025", "2024"]);
    expect(r.dividend_yield_ttm).toBe(5);
  });
});

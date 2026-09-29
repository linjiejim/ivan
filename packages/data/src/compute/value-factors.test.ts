/**
 * 注册表第 2 版（D47–D49）：新因子的口径、行业内比较与行业上限的选股 SQL、旧行情仓补列。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACTORS, validateSpec } from "@ivan/core";
import { afterAll, describe, expect, it } from "vitest";
import { crossSectionSelect } from "../etl/factors.ts";
import { compileSelection } from "../query/selection.ts";
import { Warehouse } from "../warehouse/db.ts";
import { FACTOR_COLUMNS } from "../warehouse/schema.ts";
import { deriveFinancials, type FinRow } from "./financials.ts";
import { computeStockFactors, KEY_COLUMNS } from "./stock-factors.ts";

const col = (k: string) => KEY_COLUMNS.length + FACTORS.findIndex((f) => f.key === k);

function fin(p: Partial<FinRow> & Pick<FinRow, "report_date" | "period" | "eff_date">): FinRow {
  return {
    code: "600000.SH",
    fy_start: `${p.report_date.slice(0, 4)}-01-01`,
    notice_date: p.eff_date,
    currency: "CNY",
    revenue: null,
    np: null,
    deducted_np: null,
    revenue_yoy: null,
    np_yoy: null,
    deducted_np_yoy: null,
    roe: null,
    gross_margin: null,
    debt_ratio: null,
    ocf: null,
    equity: null,
    shares: null,
    ...p,
  };
}

describe("新因子：ROE 三年最低、近三年分红年数、12-1 月动量、派息率、PEG", () => {
  // 2021-01-04 起 700 个工作日；第 500 天起收盘价从 10 跳到 20
  const dates: string[] = [];
  for (let d = new Date("2021-01-04T00:00:00Z"); dates.length < 700; d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) dates.push(d.toISOString().slice(0, 10));
  }
  const n = dates.length;
  const close = Float64Array.from(dates, (_, k) => (k < 500 ? 10 : 20));
  const rows = computeStockFactors({
    meta: { code: "600000.SH", market: "A", board: "main", list_date: "2010-01-01", industry: "化学原料", industry_l1: "化工" },
    bars: { date: dates, open: close, high: close, low: close, close, volume: new Float64Array(n).fill(1e6), adj: new Float64Array(n).fill(1) },
    shares: [{ eff_date: "2010-01-01", total_shares: 1e9, reason: "首发" }],
    // 第 100 天、第 600 天各派一次现金
    actions: [
      { date: dates[100]!, cash: 0.5, split: 0 },
      { date: dates[600]!, cash: 0.8, split: 0 },
    ],
    fin: deriveFinancials([
      fin({ report_date: "2020-12-31", period: "FY", eff_date: "2021-03-31", np: 1e8, roe: 20 }),
      fin({ report_date: "2021-12-31", period: "FY", eff_date: "2022-03-31", np: 6e7, roe: 5 }),
      fin({ report_date: "2022-12-31", period: "FY", eff_date: "2023-03-31", np: 1.1e8, roe: 12 }),
    ]),
    st: () => false,
    fromDate: dates[0]!,
  });
  const last = rows[n - 1]!;

  it("ROE 三年最低 = 当前、约一年前、约两年前三个时点里最低的", () => {
    // 最后一天用 2022 年报（12），250 天前用 2021 年报（5），500 天前用 2020 年报（20）
    expect(last[col("roe_ttm")]).toBe(12);
    expect(rows[n - 1 - 250]![col("roe_ttm")]).toBe(5);
    expect(rows[n - 1 - 500]![col("roe_ttm")]).toBe(20);
    expect(last[col("roe_min_3y")]).toBe(5);
    // 回看不到的时点跳过：第一个有 ROE 的日子只看自己
    const first = rows.find((r) => r[col("roe_ttm")] !== null)!;
    expect(first[col("roe_min_3y")]).toBe(20);
  });

  it("近三年分红年数：现在有、一年前没有、两年前有 = 2", () => {
    expect((last[col("dividend_yield_ttm")] as number) > 0).toBe(true);
    expect(rows[n - 1 - 250]![col("dividend_yield_ttm")]).toBe(0);
    expect((rows[n - 1 - 500]![col("dividend_yield_ttm")] as number) > 0).toBe(true);
    expect(last[col("dividend_years_3y")]).toBe(2);
  });

  it("12-1 月动量 = 第 250 到第 20 个交易日前的涨幅（跳过最近一个月）", () => {
    // 最后一天：20 天前 = 20，250 天前 = 10 → +100%；最近一个月里的涨跌不算
    expect(last[col("mom_12_1")]).toBeCloseTo(100);
    expect(rows[249]![col("mom_12_1")]).toBeNull();
  });

  it("派息率 = 股息率 × 市盈率；PEG = 市盈率 ÷ 净利两年复合", () => {
    const pe = last[col("pe_ttm")] as number;
    const dy = last[col("dividend_yield_ttm")] as number;
    expect(last[col("payout_ratio")]).toBeCloseTo(dy * pe);
    // 每股分红 0.8 元、每股收益 0.11 元 → 派息率 ≈ 727%（分得比赚得多）
    expect(last[col("payout_ratio")]).toBeCloseTo((0.8 / (1.1e8 / 1e9)) * 100, 0);
    const g = last[col("np_cagr_2y")] as number;
    expect(g).toBeCloseTo((Math.sqrt(1.1e8 / 1e8) - 1) * 100, 3);
    expect(last[col("peg")]).toBeCloseTo(pe / g);
  });
});

describe("选股 SQL：行业内比较、同一行业最多 N 只、全市场市值排名", () => {
  const dir = mkdtempSync(join(tmpdir(), "ivan-wh-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const D = "2026-06-30";
  // 银行 PE 5/6/7，电子 PE 30/40/50；市值 900/800/700/600/500/400
  const STOCKS = [
    ["600001.SH", "银行", 5, 900],
    ["600002.SH", "银行", 6, 800],
    ["600003.SH", "银行", 7, 700],
    ["000001.SZ", "电子", 30, 600],
    ["000002.SZ", "电子", 40, 500],
    ["000003.SZ", "电子", 50, 400],
  ] as const;
  const open = async () => {
    const wh = await Warehouse.open(":memory:");
    for (const [code, ind, pe, mcap] of STOCKS) {
      await wh.run(
        `INSERT INTO factors_daily (code, date, market, close, pe_ttm, mcap, industry, industry_l1, flag_st, flag_new_listing)
         VALUES ($c, DATE '${D}', 'A', 10, $pe, $mcap, $ind, $ind, false, false)`,
        { c: code, pe, mcap, ind },
      );
    }
    return wh;
  };
  const pick = async (wh: Warehouse, rank: object) => {
    const v = validateSpec({ name: "t", market: "A", rank });
    expect(v.errors).toEqual([]);
    const rows = await wh.all<{ code: string }>(compileSelection(v.spec!, [D], 4));
    return rows.map((r) => r.code);
  };

  it("全市场一起比：PE 最低的四只里有三只银行", async () => {
    const wh = await open();
    expect(await pick(wh, { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 4 })).toEqual([
      "600001.SH",
      "600002.SH",
      "600003.SH",
      "000001.SZ",
    ]);
    wh.close();
  });

  it("行业内比：各行业最便宜的先入选，电子股不再因为行业整体贵而垫底", async () => {
    const wh = await open();
    const got = await pick(wh, { terms: [{ factor: "pe_ttm", weight: 1, better: "low", neutral: true }], top: 4 });
    expect(got).toEqual(["000001.SZ", "600001.SH", "000002.SZ", "600002.SH"]);
    wh.close();
  });

  it("同一行业最多 2 只：第三只银行让位给电子", async () => {
    const wh = await open();
    const got = await pick(wh, { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 4, maxPerIndustry: 2 });
    expect(got).toEqual(["600001.SH", "600002.SH", "000001.SZ", "000002.SZ"]);
    wh.close();
  });

  it("全市场市值排名：同日同市场从大到小，1 = 最大", async () => {
    const wh = await open();
    await wh.run(`CREATE TABLE factors_stage AS SELECT * FROM factors_daily`);
    const rows = await wh.all<{ code: string; mcap_rank: number }>(
      `SELECT code, mcap_rank FROM (SELECT ${crossSectionSelect()} FROM factors_stage s) ORDER BY mcap_rank`,
    );
    expect(rows.map((r) => [r.code, r.mcap_rank])).toEqual(STOCKS.map(([c], i) => [c, i + 1]));
    wh.close();
  });

  it("旧版行情仓（第 1 版表结构）打开时在表尾补上新因子列，列顺序和注册表一致", async () => {
    const path = join(dir, "v1.duckdb");
    let wh = await Warehouse.open(path);
    const added = FACTORS.slice(FACTORS.findIndex((f) => f.key === "mcap_rank")).map((f) => f.key);
    for (const k of added) await wh.run(`ALTER TABLE factors_daily DROP COLUMN ${k}`);
    await wh.setMeta("schema_version", "1");
    await wh.checkpoint();
    wh.close();
    wh = await Warehouse.open(path);
    const cols = await wh.all<{ name: string }>(
      `SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'factors_daily' ORDER BY ordinal_position`,
    );
    expect(cols.map((c) => c.name)).toEqual([...KEY_COLUMNS, ...FACTOR_COLUMNS]);
    wh.close();
  });
});

describe("A 股成交量单位（D51）", () => {
  it("有成交额时按成交额判断：比值约 100 是「手」，约 1 是「股」", async () => {
    const { inferVolumeMultiplier, volumeMultiplier } = await import("./volume-unit.ts");
    // 茅台：成交额 23.7 亿、价格 1238、成交量 19198（手）
    expect(inferVolumeMultiplier([{ close: 1238.09, volume: 19198, amount: 2.373e9 }])).toBe(100);
    // 中芯国际（科创板）：成交额 14.3 亿、价格 116.79、成交量 12244298（股）
    expect(inferVolumeMultiplier([{ close: 116.79, volume: 12244298, amount: 1.4336e9 }])).toBe(1);
    expect(inferVolumeMultiplier([{ close: 10, volume: 100, amount: null }])).toBeNull();
    // 没有成交额（腾讯日 K）：按板块，科创板 1、其余 A 股 100、港股 1
    expect(volumeMultiplier("688981.SH", [{ close: 116.56, volume: 26935409 }])).toBe(1);
    expect(volumeMultiplier("689009.SH")).toBe(1);
    expect(volumeMultiplier("600519.SH")).toBe(100);
    expect(volumeMultiplier("300750.SZ")).toBe(100);
    expect(volumeMultiplier("00700.HK")).toBe(1);
  });

  it("旧库打开时修正一次已入库的成交量，之后不再动（包括新写入的正确数据）", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "ivan-vol-"));
    const path = join(dir2, "v1.duckdb");
    const D = "2026-09-28";
    let wh = await Warehouse.open(path);
    // 模拟旧库：删掉修正标记，写入旧代码产生的数据
    await wh.run(`DELETE FROM meta WHERE key LIKE 'fix:%'`);
    // 科创板腾讯日 K（没有成交额）：被放大 100 倍
    await wh.run(`INSERT INTO bars_daily VALUES ('688981.SH', DATE '${D}', 116.56, 116.56, 116.56, 116.56, 2693540900, NULL, 1)`);
    // 科创板实时报价（有成交额）：同样被放大
    await wh.run(`INSERT INTO bars_daily VALUES ('688002.SH', DATE '${D}', 175, 175, 175, 175, 8e8, 1.4e9, 1)`);
    // 主板（有、没有成交额）：本来就对，不该动
    await wh.run(`INSERT INTO bars_daily VALUES ('600519.SH', DATE '${D}', 1238, 1238, 1238, 1238, 1919800, 2.373e9, 1)`);
    await wh.run(`INSERT INTO bars_daily VALUES ('600000.SH', DATE '${D}', 10, 10, 10, 10, 5e7, NULL, 1)`);
    await wh.checkpoint();
    wh.close();
    const vols = async (w: Warehouse) =>
      Object.fromEntries(
        (await w.all<{ code: string; volume: number }>(`SELECT code, volume FROM bars_daily ORDER BY code`)).map((r) => [r.code, r.volume]),
      );
    wh = await Warehouse.open(path);
    const once = await vols(wh);
    expect(once).toEqual({ "600000.SH": 5e7, "600519.SH": 1919800, "688002.SH": 8e6, "688981.SH": 26935409 });
    // 修正之后按新口径写入的科创板数据
    await wh.run(`INSERT INTO bars_daily VALUES ('688981.SH', DATE '2026-09-29', 117, 117, 117, 117, 12244298, NULL, 1)`);
    await wh.checkpoint();
    wh.close();
    wh = await Warehouse.open(path);
    const rows = await wh.all<{ d: string; volume: number }>(`SELECT date::VARCHAR AS d, volume FROM bars_daily WHERE code = '688981.SH' ORDER BY d`);
    expect(rows).toEqual([
      { d: D, volume: 26935409 },
      { d: "2026-09-29", volume: 12244298 },
    ]);
    wh.close();
    rmSync(dir2, { recursive: true, force: true });
  });
});

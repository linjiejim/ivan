import { FACTORS } from "@ivan/core";
import { describe, expect, it } from "vitest";
import { chainToStored } from "../etl/reference.ts";
import { HK_RMB_COUNTER } from "../etl/securities.ts";
import { deriveFinancials, FinCursor, type FinRow, hkEffectiveDate } from "./financials.ts";
import { stResolver } from "./names.ts";
import { adjFromRefPrices, decomposeHfq, type PriceBar, resolveActions } from "./adjust.ts";
import { SPLIT_REASON_RE } from "./series.ts";
import { rollingPercentile, SortedWindow } from "./series.ts";
import { alignShareChanges, computeStockFactors, KEY_COLUMNS } from "./stock-factors.ts";

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

const ROWS: FinRow[] = [
  fin({ report_date: "2023-06-30", period: "H1", eff_date: "2023-08-20", np: 40, revenue: 400 }),
  fin({ report_date: "2023-12-31", period: "FY", eff_date: "2024-03-30", np: 90, roe: 18 }),
  fin({ report_date: "2024-03-31", period: "Q1", eff_date: "2024-04-25", np: 25, roe: 5 }),
  fin({ report_date: "2024-06-30", period: "H1", eff_date: "2024-08-20", np: 50, revenue: 500, roe: 9 }),
  fin({ report_date: "2024-12-31", period: "FY", eff_date: "2025-04-20", np: 100, roe: 20, np_yoy: 11 }),
  fin({ report_date: "2025-03-31", period: "Q1", eff_date: "2025-04-28", np: 30, roe: 6, np_yoy: 20 }),
  fin({ report_date: "2025-06-30", period: "H1", eff_date: "2025-08-20", np: 60, revenue: 625, roe: 11 }),
];

describe("财报派生（TTM 与点时）", () => {
  const d = deriveFinancials(ROWS);
  const by = (rd: string) => d.find((r) => r.report_date === rd)!;

  it("TTM = 本期累计 + 上一财年 − 上年同期", () => {
    expect(by("2025-03-31").ttm_np).toBe(30 + 100 - 25);
    expect(by("2025-06-30").ttm_np).toBe(60 + 100 - 50);
    expect(by("2024-12-31").ttm_np).toBe(100);
    expect(by("2025-06-30").roe_ttm).toBeCloseTo(11 + 20 - 9);
  });

  it("两年复合只在两期都为正时有值", () => {
    // 2025H1 营收 625，2023H1 营收 400 → 年化 25%
    expect(by("2025-06-30").rev_cagr_2y).toBeCloseTo(25);
    expect(by("2025-03-31").rev_cagr_2y).toBeNull();
  });

  it("游标只返回截至当日已生效的报告，公告日当天起生效", () => {
    const c = new FinCursor(d);
    expect(c.at("2025-04-19")?.report_date).toBe("2024-06-30");
    expect(c.at("2025-04-20")?.report_date).toBe("2024-12-31");
    expect(c.at("2025-08-19")?.report_date).toBe("2025-03-31");
    expect(c.at("2025-08-20")?.report_date).toBe("2025-06-30");
  });

  it("上年年报还没公告时，TTM 为空而不是偷看未来", () => {
    const early = deriveFinancials([
      ...ROWS.filter((r) => r.report_date !== "2024-12-31"),
      // 年报晚于一季报公告（假想情形）
      fin({ report_date: "2024-12-31", period: "FY", eff_date: "2025-05-10", np: 100 }),
    ]);
    const q1 = early.find((r) => r.report_date === "2025-03-31")!;
    expect(q1.ttm_np).toBeNull();
  });

  it("港股生效日：年报 +90 天，其余 +60 天", () => {
    expect(hkEffectiveDate("2025-12-31", "FY")).toBe("2026-03-31");
    expect(hkEffectiveDate("2026-06-30", "H1")).toBe("2026-08-29");
  });
});

describe("ST 点时判定", () => {
  it("深市按官方简称变更：变更日之前用变更前简称", () => {
    const st = stResolver(
      "000418.SZ",
      [
        { date: "2006-05-01", before: "小天鹅A", after: "ST天鹅A", source: "szse" },
        { date: "2007-06-01", before: "ST天鹅A", after: "小天鹅A", source: "szse" },
      ],
      "小天鹅A",
    );
    expect(st("2006-04-30")).toBe(false);
    expect(st("2006-05-01")).toBe(true);
    expect(st("2007-05-31")).toBe(true);
    expect(st("2007-06-01")).toBe(false);
  });

  it("沪市在每日简称起点之前返回 null（交给年报连亏近似）", () => {
    const st = stResolver(
      "600000.SH",
      [
        { date: "2018-01-02", before: null, after: "浦发银行", source: "em_daily" },
        { date: "2020-05-06", before: "浦发银行", after: "*ST浦发", source: "em_daily" },
      ],
      "浦发银行",
    );
    expect(st("2017-12-29")).toBeNull();
    expect(st("2019-01-02")).toBe(false);
    expect(st("2020-05-06")).toBe(true);
  });
});

describe("序列工具", () => {
  it("滚动分位：窗口外的值被移除，样本不足为 NaN", () => {
    const w = new SortedWindow();
    [5, 1, 3].forEach((x) => w.add(x));
    expect(w.percentile(3)).toBeCloseTo(50);
    w.remove(1);
    expect(w.percentile(3)).toBeCloseTo(25);
    const pct = rollingPercentile([10, 20, 30, -5, 40], 3, 2);
    expect(Number.isNaN(pct[0]!)).toBe(true);
    expect(pct[1]).toBeCloseTo(75); // [10,20] 里 20 的位置
    expect(Number.isNaN(pct[3]!)).toBe(true); // 负值不算
    expect(pct[4]).toBeCloseTo(75); // 窗口 [30,-5,40] → 正值 [30,40]
  });

  it("送转股的生效日对齐到最近的除权日", () => {
    const aligned = alignShareChanges(
      [
        { eff_date: "2020-01-01", total_shares: 100, reason: "首发" },
        { eff_date: "2025-06-12", total_shares: 200, reason: "送股上市" },
      ],
      ["2025-06-10"],
    );
    expect(aligned[1]!.eff_date).toBe("2025-06-10");
  });
});

describe("单股因子：点时正确（验收 1）", () => {
  const col = (k: string) => KEY_COLUMNS.length + FACTORS.findIndex((f) => f.key === k);
  // 2025-04-14 起 12 个工作日（到 04-29）
  const dates: string[] = [];
  for (let d = new Date("2025-04-14T00:00:00Z"); dates.length < 12; d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) dates.push(d.toISOString().slice(0, 10));
  }
  const n = dates.length;
  const arr = (v: number) => new Float64Array(n).fill(v);
  const rows = computeStockFactors({
    meta: {
      code: "600000.SH",
      market: "A",
      board: "main",
      list_date: "2010-01-01",
      industry: "银行",
      industry_l1: "金融",
    },
    bars: {
      date: dates,
      open: arr(10),
      high: arr(10),
      low: arr(10),
      close: arr(10),
      volume: arr(1e6),
      adj: arr(1),
    },
    shares: [{ eff_date: "2010-01-01", total_shares: 1e9, reason: "首发" }],
    actions: [],
    fin: deriveFinancials(ROWS),
    st: () => false,
    fromDate: dates[0]!,
  });

  it("年报公告日（2025-04-20 周日）之前的交易日用不到年报，公告后第一个交易日起才用", () => {
    const at = (d: string) => rows.find((r) => r[1] === d)!;
    // 2025-04-18（周五）：最新是 2024H1，TTM = 50 + 90 − 40 = 100 → PE = 100 亿 / 100
    expect(at("2025-04-18")[col("pe_ttm")]).toBeCloseTo(1e10 / 100);
    // 2025-04-21（周一）：年报已生效，TTM = 100
    expect(at("2025-04-21")[col("np_yoy")]).toBe(11);
    expect(at("2025-04-21")[col("pe_ttm")]).toBeCloseTo(1e10 / 100);
    // 2025-04-28 一季报生效：TTM = 30 + 100 − 25 = 105
    expect(at("2025-04-28")[col("pe_ttm")]).toBeCloseTo(1e10 / 105);
    expect(at("2025-04-25")[col("np_yoy")]).toBe(11);
    expect(at("2025-04-28")[col("np_yoy")]).toBe(20);
  });

  it("市值用当日有效总股本，单位亿", () => {
    expect(rows[0]![col("mcap")]).toBeCloseTo(100);
  });

  it("金融行业不判高负债", () => {
    expect(rows[0]![col("flag_high_debt")]).toBeNull();
  });
});

describe("复权分解（腾讯/东财后复权 = a × 价 + b）", () => {
  const P = (date: string, o: number, c: number, h: number, l: number): PriceBar => ({
    date,
    open: o,
    close: c,
    high: h,
    low: l,
  });
  // 2026-09 实测的茅台腾讯日 K（不复权 / 后复权）；2024 年度分红每股 27.624 元，2025-06-26 除息
  const raw = [
    P("2025-06-19", 1426.0, 1426.0, 1433.67, 1417.18),
    P("2025-06-20", 1423.58, 1428.66, 1441.14, 1420.2),
    P("2025-06-23", 1420.0, 1420.0, 1433.0, 1405.18),
    P("2025-06-24", 1423.35, 1437.2, 1451.68, 1423.35),
    P("2025-06-25", 1439.11, 1435.86, 1449.2, 1420.51),
    P("2025-06-26", 1415.0, 1420.0, 1428.0, 1410.08),
    P("2025-06-27", 1420.01, 1403.09, 1423.0, 1403.09),
    P("2025-06-30", 1403.5, 1409.52, 1413.23, 1402.0),
  ];
  const hfq = [
    P("2025-06-19", 9380.647, 9380.647, 9423.812, 9331.01),
    P("2025-06-20", 9367.028, 9395.617, 9465.851, 9348.006),
    P("2025-06-23", 9346.88, 9346.88, 9420.041, 9263.477),
    P("2025-06-24", 9365.733, 9443.678, 9525.168, 9365.733),
    P("2025-06-25", 9454.427, 9436.136, 9511.211, 9349.75),
    P("2025-06-26", 9474.068, 9502.206, 9547.229, 9446.379),
    P("2025-06-27", 9502.263, 9407.041, 9519.09, 9407.041),
    P("2025-06-30", 9409.348, 9443.227, 9464.106, 9400.907),
  ];

  it("从真实数据里认出茅台 2025-06-26 每股 27.624 元的分红，且只认这一次", () => {
    const { events, adj } = decomposeHfq(raw, hfq, 3);
    expect(events).toHaveLength(1);
    expect(events[0]!.date).toBe("2025-06-26");
    expect(events[0]!.cash).toBeCloseTo(27.624, 1);
    expect(events[0]!.split).toBe(0);
    // 等比因子：除息日乘以 前收 / (前收 − 分红)
    expect(adj[5]! / adj[4]!).toBeCloseTo(1435.86 / (1435.86 - 27.624), 4);
    expect(adj[0]).toBe(adj[4]);
  });

  it("10 送 10 + 每股派 1 元：拆出送转比例与现金", () => {
    // 构造：a=2、b=5 → 除权后 a'=4、b'=5+2×1=7；前收 20，参考价 (20−1)/2 = 9.5
    const rawS = [P("d1", 20, 20, 20.5, 19.6), P("d2", 19.8, 20, 20.3, 19.5), P("d3", 9.5, 9.7, 9.9, 9.4)];
    const lin = (b: PriceBar, a: number, c: number) =>
      P(b.date, a * b.open + c, a * b.close + c, a * b.high + c, a * b.low + c);
    const hfqS = [lin(rawS[0]!, 2, 5), lin(rawS[1]!, 2, 5), lin(rawS[2]!, 4, 7)];
    const { events, adj } = decomposeHfq(rawS, hfqS, 3);
    expect(events).toHaveLength(1);
    expect(events[0]!.split).toBeCloseTo(1, 3);
    expect(events[0]!.cash).toBeCloseTo(1, 3);
    expect(adj[2]! / adj[1]!).toBeCloseTo(20 / 9.5, 4);
  });

  it("2 位小数（东财）的舍入噪声不会被当成分红", () => {
    const rows: PriceBar[] = [];
    const h: PriceBar[] = [];
    for (let i = 0; i < 60; i++) {
      const c = 5 + Math.sin(i / 3) * 0.4;
      const bar = P(`d${String(i).padStart(2, "0")}`, c - 0.03, c, c + 0.05, c - 0.06);
      const r2 = (x: number) => Math.round(x * 100) / 100;
      rows.push(P(bar.date, r2(bar.open), r2(bar.close), r2(bar.high), r2(bar.low)));
      const b = rows[i]!;
      h.push(P(b.date, r2(3.37 * b.open + 1.9), r2(3.37 * b.close + 1.9), r2(3.37 * b.high + 1.9), r2(3.37 * b.low + 1.9)));
    }
    expect(decomposeHfq(rows, h, 2).events).toHaveLength(0);
  });

  it("腾讯 2014-05-15 一拆五、次日除息 0.24：拆股日不混进分红", () => {
    // 2026-09 实测东财日 K（不复权 | 后复权），后复权 = a × 价 + b：拆股前 a=1、b=3.48，拆股后 a=5，除息后 b=4.68
    const r = [
      P("2014-05-12", 481, 504, 507.5, 480),
      P("2014-05-13", 512, 507.5, 519, 504.5),
      P("2014-05-14", 516.5, 514, 516.5, 498.8),
      P("2014-05-15", 110, 108.8, 112, 107.9),
      P("2014-05-16", 107.4, 106.5, 107.8, 105.4),
      P("2014-05-19", 107, 107.6, 108.3, 106.1),
      P("2014-05-20", 109.5, 111.9, 112, 108.8),
    ];
    const h = [
      P("2014-05-12", 484.48, 507.48, 510.98, 483.48),
      P("2014-05-13", 515.48, 510.98, 522.48, 507.98),
      P("2014-05-14", 519.98, 517.48, 519.98, 502.28),
      P("2014-05-15", 553.48, 547.48, 563.48, 542.98),
      P("2014-05-16", 541.68, 537.18, 543.68, 531.68),
      P("2014-05-19", 539.68, 542.68, 546.18, 535.18),
      P("2014-05-20", 552.18, 564.18, 564.68, 548.68),
    ];
    const { events } = decomposeHfq(r, h, 2);
    expect(events).toEqual([
      { date: "2014-05-15", cash: 0, split: 4 },
      { date: "2014-05-16", cash: 0.24, split: 0 },
    ]);
  });
});

describe("A 股单请求路径：参考前收 = 收盘 − 涨跌额（D31）", () => {
  it("茅台 2025-06-26 除息：参考价 1408.24，因子跳变 = 前收 / 参考价，拆出每股 27.62 元", () => {
    const bars = [
      { date: "2025-06-24", close: 1437.2, chg: 17.2 },
      { date: "2025-06-25", close: 1435.86, chg: -1.34 },
      { date: "2025-06-26", close: 1420.0, chg: 11.76 },
      { date: "2025-06-27", close: 1403.09, chg: -16.91 },
    ];
    const { adj, actions } = adjFromRefPrices(bars);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.refPrice).toBeCloseTo(1408.24, 6);
    expect(adj[2]! / adj[1]!).toBeCloseTo(1435.86 / 1408.24, 10);
    expect(adj[3]).toBe(adj[2]);
    const [a] = resolveActions(actions, [], SPLIT_REASON_RE);
    expect(a).toEqual({ date: "2025-06-26", cash: 27.62, split: 0 });
  });

  it("10 送 10 派 1 元：股本变动给出送转比例，拆出现金 1 元", () => {
    const [a] = resolveActions(
      [{ date: "2025-06-10", prevClose: 20, refPrice: 9.5, cash: null, split: null }],
      [
        { eff_date: "2020-01-01", total_shares: 1e8, reason: "首发" },
        { eff_date: "2025-06-11", total_shares: 2e8, reason: "送股上市" },
      ],
      SPLIT_REASON_RE,
    );
    expect(a).toEqual({ date: "2025-06-10", cash: 1, split: 1 });
  });
});


describe("ETF 总收益序列增量接续（盈富基金曾在窗口起点凭空跳 −29%）", () => {
  it("按窗口里第一个已存的日子缩放，窗口内涨跌不变", () => {
    const fresh = [
      { date: "2026-09-08", close: 25.88 },
      { date: "2026-09-09", close: 25.84 },
      { date: "2026-09-10", close: 25.58 },
    ];
    const out = chainToStored(fresh, { date: "2026-09-08", close: 36.67 });
    expect(out[0]!.close).toBeCloseTo(36.67, 10);
    expect(out[2]!.close / out[1]!.close).toBeCloseTo(25.58 / 25.84, 12);
  });

  it("库里还没有（首次回填）或锚点不在窗口里时原样返回", () => {
    const fresh = [{ date: "2026-09-08", close: 25.88 }];
    expect(chainToStored(fresh, undefined)).toBe(fresh);
    expect(chainToStored(fresh, { date: "2026-09-01", close: 30 })).toBe(fresh);
  });
});

describe("港股人民币柜台不进股票池", () => {
  it("8xxxx 是人民币柜台；08xxx 是创业板、0xxxx 是港币柜台，都保留", () => {
    expect(HK_RMB_COUNTER.test("80941.HK")).toBe(true);
    expect(HK_RMB_COUNTER.test("80700.HK")).toBe(true);
    expect(HK_RMB_COUNTER.test("00941.HK")).toBe(false);
    expect(HK_RMB_COUNTER.test("08001.HK")).toBe(false);
    expect(HK_RMB_COUNTER.test("600519.SH")).toBe(false);
  });
});

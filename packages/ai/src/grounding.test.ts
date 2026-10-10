import { describe, expect, it } from "vitest";
import {
  checkGrounding,
  collectEvidence,
  extractFigures,
  GROUNDING_VERSION,
  normalizeText,
  redactUnverified,
} from "./grounding.ts";

const ev = (payload: unknown, source = "tool") => collectEvidence(source, payload);
const check = (text: string, payload: unknown) => checkGrounding(text, ev(payload));

describe("数字核对：规范化与抽数", () => {
  it("全角数字与符号、U+2212、零宽字符、千分位", () => {
    expect(normalizeText("１２．５％")).toBe("12.5%");
    expect(normalizeText("−3.1%")).toBe("-3.1%");
    expect(normalizeText("1\u200B2%")).toBe("12%");
    expect(normalizeText("1,234 亿与 1，234,567 元")).toBe("1234 亿与 1234567 元");
    // 代码之间的逗号不是千分位
    expect(normalizeText("600519,000001")).toBe("600519,000001");
  });

  it("按单位分类：百分数、百分点、金额、倍数、计数、裸整数", () => {
    const { figures } = extractFigures(
      "年化超额 +7.3%，多了 2 个百分点，滑点 5bp，市值 1.2 亿，PE 12.5 倍，跟踪 40 天，200 日均线，夏普 0.82",
    );
    const by = Object.fromEntries(figures.map((f) => [f.raw.trim(), f]));
    expect(by["+7.3%"]).toMatchObject({ kind: "percent", value: 7.3, decimals: 1, plus: true });
    expect(by["2 个百分点"]).toMatchObject({ kind: "points", value: 2 });
    expect(by["5bp"]).toMatchObject({ kind: "points", value: 0.05, decimals: 2 });
    expect(by["1.2 亿"]).toMatchObject({ kind: "money", value: 1.2e8, scale: 1e8 });
    expect(by["12.5 倍"]).toMatchObject({ kind: "ratio", value: 12.5 });
    expect(by["40 天"]).toMatchObject({ kind: "count", value: 40 });
    expect(by["200"]).toMatchObject({ kind: "plain" });
    expect(by["0.82"]).toMatchObject({ kind: "ratio", decimals: 2 });
  });

  it("区间里的短横不是负号", () => {
    const { figures } = extractFigures("PE 在 5-25 倍之间，回撤 -27%");
    expect(figures.find((f) => f.raw.includes("25"))!.negative).toBe(false);
    expect(figures.find((f) => f.raw.includes("27"))!.negative).toBe(true);
  });
});

describe("数字核对：匹配（表驱动）", () => {
  const ok: Array<[string, string, unknown]> = [
    ["比例", "年化超额 +7.3%", { excessCagr: 0.0731 }],
    ["百分点键名", "跑赢回测同期 18%", { beatBacktestPct: 18 }],
    ["回撤带负号", "最大回撤 -27%", { maxDrawdown: -0.268 }],
    ["回撤不带负号但前面有「回撤」", "最大回撤 27%", { maxDrawdown: -0.268 }],
    ["小数按写出的精度", "夏普 0.82", { sharpe: 0.82467 }],
    ["全角", "年化 １２．５％", { cagr: 0.125 }],
    ["金额按亿换算", "最终资产 1.2 亿", { finalEquity: 1.23e8 }],
    ["计数", "跟踪 40 天", { days: 40 }],
    ["数组长度是计数", "明天买 3 只", { buys: ["甲", "乙", "丙"] }],
    ["股息率按因子单位（百分点）", "股息率 4.3%", { dividend_yield_ttm: 4.25 }],
    [
      "DSL 条件里的 value 按因子单位",
      "ROE 不低于 12%",
      { filters: [{ factor: "roe_ttm", op: ">=", value: 12 }] },
    ],
    ["市值（亿）带千分位", "市值 1,234 亿", { mcap: 1234.4 }],
    ["成交额（亿）", "日均成交额 3.2 亿", { turnover_20d: 3.21 }],
    ["波动率（%）", "波动率 28.5%", { volatility_60d: 28.47 }],
    ["名次（名）", "市值排第 800 名", { mcap_rank: 800 }],
    ["证据项带 unit", "毛利率 91.5%", { items: [{ label: "毛利率", value: 91.47, unit: "%" }] }],
    ["分位容器里的因子键", "PE 分位 85%", { termPct: { pe_ttm: 85 } }],
    ["财报字段", "ROE 31.2%", { financials: [{ roe: 31.24 }] }],
    ["字符串里写过的数", "样本外年化超额 -3.2%", { checks: [{ detail: "样本外年化超额 -3.2%" }] }],
  ];
  it.each(ok)("%s：「%s」对得上", (_, text, payload) => {
    const r = check(text, payload);
    expect(r.version).toBe(GROUNDING_VERSION);
    expect(r.checked).toBeGreaterThan(0);
    expect(r.unverified).toEqual([]);
  });

  const bad: Array<[string, string, unknown, "no_match" | "sign_mismatch"]> = [
    ["比例对不上", "年化超额 +7.3%", { excessCagr: 0.0812 }, "no_match"],
    ["小数超出半个末位", "夏普 0.8", { sharpe: 0.86 }, "no_match"],
    ["计数必须相等", "跟踪 41 天", { days: 40 }, "no_match"],
    ["证据为负、文字写成正", "超额 +3.1%", { excessCagr: -0.031 }, "sign_mismatch"],
    ["证据为负、文字没写负号也没说跌", "超额 3.1%", { excessCagr: -0.031 }, "sign_mismatch"],
    ["推算出来的差值不算", "比回测少了 2.1%", { cagr: 0.123, backtestCagr: 0.144 }, "no_match"],
  ];
  it.each(bad)("%s：「%s」被标出", (_, text, payload, reason) => {
    const r = check(text, payload);
    expect(r.unverified).toHaveLength(1);
    expect(r.unverified[0]!.reason).toBe(reason);
  });

  it("对不上时给出最接近的工具数", () => {
    const r = check("年化超额 +7.3%", { excessCagr: 0.0812, days: 40 });
    expect(r.unverified[0]).toMatchObject({
      raw: "+7.3%",
      kind: "percent",
      reason: "no_match",
      nearest: { path: "tool.excessCagr", value: 0.0812 },
    });
  });

  it("日期、代码、均线窗口、版本号从不核对", () => {
    const text =
      "2024-06-28 收盘后，600519 与 00700.HK、600519.SH 入选；200 日均线；v3 版本；引擎 1.2.0；" +
      "2024 年 6 月 28 日、6 月 28 日、2024 年、6 月；前 15 名；`pe_ttm < 30`";
    const r = check(text, {});
    expect(r.checked).toBe(0);
    expect(r.unverified).toEqual([]);
    expect(r.exempt).toBeGreaterThan(10);
  });

  it("缩写后紧跟数字和单位时照样核对：「ROE15%」「PE12.5倍」不是标识符", () => {
    const fake = check("ROE15%", { roe_ttm: 30 });
    expect(fake.checked).toBe(1);
    expect(fake.unverified).toHaveLength(1);
    expect(fake.unverified[0]).toMatchObject({ raw: "15%", reason: "no_match" });
    const pe = check("PE12.5倍", { pe_ttm: 12.47 });
    expect(pe.checked).toBe(1);
    expect(pe.unverified).toEqual([]);
    // 后面不是单位的仍是标识符
    const id = check("站上 MA20，基准 H00905，策略 v3", {});
    expect(id.checked).toBe(0);
    expect(id.unverified).toEqual([]);
  });

  it("回看窗口的天数不核对（D69），持有天数这类计数照样核对", () => {
    const vol = check("近 60 天波动率 28.5%", { volatility_60d: 28.47 });
    expect(vol.checked).toBe(1);
    expect(vol.unverified).toEqual([]);
    const adv = check("过去 20 个交易日日均成交额 3.2 亿", { turnover_20d: 3.21 });
    expect(adv.unverified).toEqual([]);
    expect(check("60 天波动率 28.5%", { volatility_60d: 28.47 }).unverified).toEqual([]);
    expect(check("每 5 天调仓一次", {}).checked).toBe(0);
    const held = check("平均持有 23 天", { days: 40 });
    expect(held.unverified).toHaveLength(1);
    expect(held.unverified[0]).toMatchObject({ raw: "23 天", reason: "no_match" });
  });

  it("行首序号不核对", () => {
    const r = check("1. 年化超额 7.3%\n2、最大回撤 -27%", {
      excessCagr: 0.073,
      maxDrawdown: -0.27,
    });
    expect(r.checked).toBe(2);
    expect(r.unverified).toEqual([]);
  });

  it("redactUnverified 只换掉对不上的数", () => {
    const text = "年化 7.3%，回撤 -99.9%";
    const r = check(text, { cagr: 0.073, maxDrawdown: -0.27 });
    expect(redactUnverified(text, r)).toBe("年化 7.3%，回撤 [待核对]");
  });
});

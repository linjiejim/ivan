/**
 * 指标第 2 版（D63）：风险指标手算、完整持仓、样本外起点修正、毛超额修正、锚点不单独成桶、各年表现不一致。
 * 第 1 版的结果由金标准守着（legacy.test.ts）。
 */
import {
  diffDays,
  LEGACY_EXEC,
  type Metrics,
  type SeriesPoint,
  type SimInput,
  type Trade,
} from "@ivan/core";
import { describe, expect, it } from "vitest";
import { BACKTEST_ONLY_CHECKS, runChecks } from "./checks.ts";
import { computeMetrics, oosStart, periodMetrics, riskMetrics, roundTrips } from "./metrics.ts";
import { simulate } from "./simulate.ts";
import { baseFixture, exposureFixture, weekdays } from "./testing/fixtures.ts";

const pts = (dates: readonly string[], navs: readonly number[], bench?: readonly number[]) =>
  navs.map((nav, i): SeriesPoint => ({
    date: dates[i]!,
    nav,
    bench: bench?.[i] ?? 1,
    cash: 0,
    positions: 1,
  }));

const withV2 = (input: SimInput, metrics: 1 | 2 = 2): SimInput => ({
  ...input,
  params: { ...input.params, exec: { ...LEGACY_EXEC, metrics } },
});

describe("风险指标", () => {
  it("基准不动时：跟踪误差 = 波动、信息比率 = 夏普；索提诺按手算", () => {
    const dates = weekdays("2024-01-01", 6);
    const navs = [1, 1.01, 0.99, 1.02, 1.0, 1.03];
    const s = pts(dates, navs);
    const p = periodMetrics(s);
    const risk = riskMetrics(s, [], [], { minObs: 0 });
    expect(risk.trackingError).toBeCloseTo(p.volatility, 12);
    expect(risk.infoRatio).toBeCloseTo(p.sharpe, 12);
    // 手算：r = 0.01, −0.02/1.01, 0.03/0.99, −0.02/1.02, 0.03
    const r = [0.01, -0.02 / 1.01, 0.03 / 0.99, -0.02 / 1.02, 0.03];
    const perYear = 5 / (diffDays(dates[5]!, dates[0]!) / 365.25);
    const mean = r.reduce((a, b) => a + b, 0) / 5;
    const down = Math.sqrt(((0.02 / 1.01) ** 2 + (0.02 / 1.02) ** 2) / 4);
    expect(risk.sortino).toBeCloseTo((mean * perYear) / (down * Math.sqrt(perYear)), 10);
    // 基准不动：β 没有定义
    expect(risk.beta).toBeNull();
    expect(risk.alpha).toBeNull();
  });

  it("观测少于 30 个时收益分布类为 null", () => {
    const dates = weekdays("2024-01-01", 6);
    const risk = riskMetrics(pts(dates, [1, 1.01, 0.99, 1.02, 1.0, 1.03]), [], []);
    expect(risk.sortino).toBeNull();
    expect(risk.trackingError).toBeNull();
    expect(risk.var95).toBeNull();
    expect(risk.skew).toBeNull();
    expect(risk.maxUnderwaterDays).toBe(1);
  });

  it("20 个日收益的单日 VaR / ES（95%，历史法，损失记正数）", () => {
    const rets = [-0.05, -0.03, ...Array.from({ length: 18 }, (_, i) => 0.001 * (i + 1))];
    const navs = [1];
    for (const r of rets) navs.push(navs.at(-1)! * (1 + r));
    const risk = riskMetrics(pts(weekdays("2024-01-01", 21), navs), [], [], { minObs: 0 });
    // type 7：h = 19 × 0.05 = 0.95 → −0.05 + 0.95 × 0.02 = −0.031
    expect(risk.var95).toBeCloseTo(0.031, 10);
    // 不高于 −0.031 的只有 −0.05
    expect(risk.es95).toBeCloseTo(0.05, 10);
    // 99%：h = 0.19 → −0.05 + 0.19 × 0.02
    expect(risk.var99).toBeCloseTo(0.0462, 10);
    expect(risk.es99).toBeCloseTo(0.05, 10);
  });

  it("水下天数：最长与当前（到区间末）", () => {
    const dates = weekdays("2024-01-01", 7);
    const a = riskMetrics(pts(dates, [1, 1.1, 1.0, 0.9, 1.05, 1.2, 1.1]), [], []);
    expect(a.maxUnderwaterDays).toBe(3);
    expect(a.currentUnderwaterDays).toBe(1);
    const b = riskMetrics(pts(dates, [1, 1.1, 1.0, 1.2, 1.3, 1.25, 1.4]), [], []);
    expect(b.maxUnderwaterDays).toBe(1);
    expect(b.currentUnderwaterDays).toBe(0);
    // 溃疡指数 = sqrt(回撤平方的均值)
    const dd = [0, 0, 1 / 1.1 - 1, 0.9 / 1.1 - 1, 1.05 / 1.1 - 1, 0, 1.1 / 1.2 - 1];
    expect(a.ulcer).toBeCloseTo(Math.sqrt(dd.reduce((s, x) => s + x * x, 0) / 7), 12);
  });
});

describe("完整持仓（D63）", () => {
  const t = (o: Partial<Trade> & Pick<Trade, "date" | "side" | "reason">): Trade => ({
    code: "600001.SH",
    price: 10,
    shares: 100,
    amount: 1000,
    fee: 1,
    ...o,
  });
  const trades: Trade[] = [
    t({ date: "2024-01-02", side: "buy", reason: "entry" }),
    t({ date: "2024-01-09", side: "sell", reason: "exposure", pnl: 10, holdDays: 5 }),
    t({ date: "2024-01-16", side: "sell", reason: "exposure", pnl: -3, holdDays: 10 }),
    t({ date: "2024-01-23", side: "buy", reason: "exposure" }),
    t({ date: "2024-01-30", side: "sell", reason: "rebalance", pnl: 20, holdDays: 20 }),
  ];

  it("两次仓位控制减仓加最后清仓 → 一笔完整持仓，盈亏合计", () => {
    expect(roundTrips(trades)).toEqual([
      { code: "600001.SH", entryDate: "2024-01-02", exitDate: "2024-01-30", pnl: 27, holdDays: 20 },
    ]);
  });

  it("仓位控制被减到 0 后又建仓：先按上一笔卖出结掉", () => {
    const more: Trade[] = [
      t({ date: "2024-01-02", side: "buy", reason: "entry" }),
      t({ date: "2024-01-09", side: "sell", reason: "exposure", pnl: -5, holdDays: 5 }),
      t({ date: "2024-02-01", side: "buy", reason: "entry" }),
      t({ date: "2024-02-08", side: "sell", reason: "stop_loss", pnl: -7, holdDays: 5 }),
    ];
    expect(roundTrips(more).map((x) => [x.entryDate, x.exitDate, x.pnl])).toEqual([
      ["2024-01-02", "2024-01-09", -5],
      ["2024-02-01", "2024-02-08", -7],
    ]);
  });

  it("仓位控制减到 0、之后没再买：知道区间末不持有时按最后一笔卖出结掉；还持有或不知道时不算", () => {
    const zeroed: Trade[] = [
      t({ date: "2024-01-02", side: "buy", reason: "entry" }),
      t({ date: "2024-01-09", side: "sell", reason: "exposure", pnl: 4, holdDays: 5 }),
    ];
    expect(roundTrips(zeroed, new Set())).toEqual([
      { code: "600001.SH", entryDate: "2024-01-02", exitDate: "2024-01-09", pnl: 4, holdDays: 5 },
    ]);
    expect(roundTrips(zeroed, new Set(["600001.SH"]))).toEqual([]);
    expect(roundTrips(zeroed)).toEqual([]);
  });

  it("第 2 版的买卖次数不数仓位控制的增减，胜率按完整持仓", () => {
    const s = pts(
      weekdays("2024-01-02", 22),
      Array.from({ length: 22 }, (_, i) => 1 + i * 0.001),
    );
    const v2 = computeMetrics(s, trades, 100_000, { version: 2 });
    expect(v2.buys).toBe(1);
    expect(v2.sells).toBe(1);
    expect(v2.roundTrips).toBe(1);
    expect(v2.winRate).toBe(1);
    expect(v2.avgHoldDays).toBe(20);
    expect(v2.profitFactor).toBeNull();
    const v1 = computeMetrics(s, trades, 100_000);
    expect(v1.buys).toBe(2);
    expect(v1.sells).toBe(3);
    expect(v1.winRate).toBeCloseTo(2 / 3, 12);
    expect(v1).not.toHaveProperty("metricsVersion");
  });

  it("盈亏比、平均盈利与亏损", () => {
    const mk = (pnl: number, d: string): Trade[] => [
      t({ date: d, side: "buy", reason: "entry" }),
      t({ date: d, side: "sell", reason: "rebalance", pnl, holdDays: 1 }),
    ];
    const tr = [...mk(30, "2024-01-02"), ...mk(-10, "2024-01-03"), ...mk(10, "2024-01-04")];
    const s = pts(weekdays("2024-01-02", 3), [1, 1, 1]);
    const m = computeMetrics(s, tr, 100_000, { version: 2 });
    expect(m.profitFactor).toBe(4);
    expect(m.avgWin).toBe(20);
    expect(m.avgLoss).toBe(-10);
    expect(m.payoff).toBe(2);
    expect(m.winRate).toBeCloseTo(2 / 3, 12);
  });
});

describe("从投入第一笔资金算起（D63）", () => {
  it("总收益 = 期末资产 ÷ 初始资金 − 1（逐位相等），含首日买入费用", () => {
    const input = withV2(baseFixture());
    const r = simulate(input);
    const capital = input.params.capital;
    expect(r.metrics.metricsVersion).toBe(2);
    expect(r.metrics.totalReturn).toBe(r.metrics.finalEquity / capital - 1);
    expect(r.anchor).toEqual({
      date: "2025-06-02",
      nav: 1,
      bench: 1,
      cash: capital,
      positions: 0,
    });
    // 存下的序列不变：第 2 版只在指标里加锚点
    const v1 = simulate(withV2(baseFixture(), 1));
    expect(r.series).toEqual(v1.series);
    expect(r.trades).toEqual(v1.trades);
    expect(v1.anchor).toBeUndefined();
    // 首日收盘的净值已经扣了买入费用：第 2 版的总收益比第 1 版低
    expect(r.metrics.totalReturn).toBeLessThan(v1.metrics.totalReturn);
  });

  it("仓位控制的增减不进买卖次数", () => {
    const v1 = simulate(withV2(exposureFixture("choppy"), 1));
    const v2 = simulate(withV2(exposureFixture("choppy"), 2));
    const exposure = v2.trades.filter((t) => t.reason === "exposure");
    expect(exposure.length).toBeGreaterThan(0);
    const real = v2.trades.filter((t) => t.reason !== "exposure");
    expect(v2.metrics.buys).toBe(real.filter((t) => t.side === "buy").length);
    expect(v2.metrics.sells).toBe(real.filter((t) => t.side === "sell").length);
    expect(v1.metrics.buys).toBe(v1.trades.filter((t) => t.side === "buy").length);
    expect(v2.metrics.roundTrips).toBe(roundTrips(v2.trades).length);
  });

  it("锚点只作第一个桶的起点，不单独成桶", () => {
    const dates = weekdays("2018-01-02", 60); // 2018-01-02 到 2018-03-26
    const navs = dates.map((_, i) => 1 + 0.002 * i);
    const s = pts(dates, navs);
    const anchor: SeriesPoint = { date: "2017-12-29", nav: 1, bench: 1, cash: 1e5, positions: 0 };
    const m = computeMetrics(s, [], 100_000, { version: 2, anchor });
    expect(m.monthly.map((x) => x.month)).toEqual(["2018-01", "2018-02", "2018-03"]);
    expect(m.yearly.map((x) => x.year)).toEqual(["2018"]);
    const lastJan = s.filter((p) => p.date.startsWith("2018-01")).at(-1)!;
    expect(m.monthly[0]!.ret).toBe(lastJan.nav / 1 - 1);
    expect(m.risk!.consistency.years).toBe(1);
    // 起点写第一个真实交易日（锚点只参与数值）
    expect(m.start).toBe("2018-01-02");
  });
});

describe("样本外起点（D63 公式修正）", () => {
  const dates = ["2023-01-03", "2023-06-30", "2024-01-31", "2024-02-29", "2024-03-31"];
  const s = pts(dates, [1, 1, 1, 1, 1]);
  it("第 2 版：3 月 31 日减 1 个月是 2 月 29 日；第 1 版保留原来的 3 月 2 日", () => {
    expect(oosStart(s, 1, 2)).toBe("2024-02-29");
    expect(oosStart(s, 1, 1)).toBe("2024-03-02");
    expect(oosStart(s, 1)).toBe("2024-03-02");
  });
  it("区间不到 2N 个月不分段", () => {
    expect(oosStart(s, 12, 2)).toBeNull();
    expect(oosStart(s, 6, 2)).toBe("2023-09-30");
  });
});

describe("检查项（指标第 2 版）", () => {
  const input = (): SimInput => ({
    ...baseFixture(),
    params: { ...baseFixture().params, capital: 100_000 },
  });
  const metrics = (o: Partial<Metrics>): Metrics =>
    ({
      ...computeMetrics(pts(weekdays("2024-01-02", 3), [1, 1, 1]), [], 100_000),
      buys: 100,
      ...o,
    }) as Metrics;
  const run = (m: Metrics) =>
    runChecks({
      input: input(),
      metrics: m,
      segments: { inSample: m, outOfSample: null },
      attribution: { byStock: [], byIndustry: [] },
      trades: [],
    });

  it("交易成本吃掉超额：第 2 版的毛超额把费用加回去", () => {
    const base = { finalEquity: 110_000, fees: 2_000, benchReturn: 0.05, turnover: 3 };
    // 第 1 版：(110000 − 105000) = 5000 → 40%
    const c1 = run(metrics(base)).find((c) => c.id === "cost_drag")!;
    expect(c1.detail).toContain("占超额收益的 40.0%");
    // 第 2 版：(110000 + 2000 − 105000) = 7000 → 28.6%
    const c2 = run(metrics({ ...base, metricsVersion: 2 })).find((c) => c.id === "cost_drag")!;
    expect(c2.detail).toContain("占超额收益的 28.6%");
  });

  it("调参次数多：第 2 版补一句「新建一个策略会从零算」，第 1 版的文字原样", () => {
    const withTrials = (m: Metrics) =>
      runChecks({
        input: { ...input(), priorVersionsOnPeriod: 12 },
        metrics: m,
        segments: { inSample: m, outOfSample: null },
        attribution: { byStock: [], byIndustry: [] },
        trades: [],
      }).find((c) => c.id === "tuning_count")!;
    expect(withTrials(metrics({ metricsVersion: 2 })).detail).toMatch(/新建一个策略会从零算。$/);
    expect(withTrials(metrics({})).detail).toMatch(/或向前跟踪。$/);
  });

  it("各年表现不一致：只在第 2 版、至少 3 年、跑赢不到一半而年化超额为正时提示", () => {
    const risk = (years: number, positiveYears: number) =>
      ({ consistency: { years, positiveYears, worstYear: null } }) as Metrics["risk"];
    const hit = run(metrics({ metricsVersion: 2, excessCagr: 0.03, risk: risk(8, 3) })).find(
      (c) => c.id === "inconsistent_years",
    );
    expect(hit).toEqual({
      id: "inconsistent_years",
      level: "info",
      title: "各年表现不一致",
      detail: "8 年里只有 3 年跑赢基准，超额主要来自少数年份。",
    });
    const ids = (m: Metrics) => run(m).map((c) => c.id);
    expect(ids(metrics({ excessCagr: 0.03, risk: risk(8, 3) }))).not.toContain(
      "inconsistent_years",
    );
    expect(ids(metrics({ metricsVersion: 2, excessCagr: 0.03, risk: risk(2, 0) }))).not.toContain(
      "inconsistent_years",
    );
    expect(ids(metrics({ metricsVersion: 2, excessCagr: 0.03, risk: risk(4, 2) }))).not.toContain(
      "inconsistent_years",
    );
    expect(ids(metrics({ metricsVersion: 2, excessCagr: -0.01, risk: risk(8, 3) }))).not.toContain(
      "inconsistent_years",
    );
    // 跟踪只保留数据局限类提示：这一项不进跟踪
    expect(BACKTEST_ONLY_CHECKS.has("inconsistent_years")).toBe(true);
  });
});

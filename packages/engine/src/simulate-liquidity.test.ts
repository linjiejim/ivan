/**
 * 按流动性成交进模拟器（D64）：单笔上限、拒单诊断、决策日的日均成交额（不偷看成交日的放量）、
 * 容量估计、最近的拒单样例、明日计划的估算。
 */
import {
  type DateStr,
  defaultExec,
  type ExecConfig,
  LEGACY_EXEC,
  type PriceSeries,
  type SecurityInfo,
  type SimInput,
  StrategySpecSchema,
} from "@ivan/core";
import { describe, expect, it } from "vitest";
import { BACKTEST_ONLY_CHECKS } from "./checks.ts";
import { SAMPLE_LIMIT } from "./fill.ts";
import { simulate } from "./simulate.ts";
import { seriesOn, weekdays } from "./testing/fixtures.ts";

interface StockDef {
  closes: number[];
  /** 日均成交额（元）：一个数 = 每天一样；数组 = 逐日；undefined = 面板里没有这一列 */
  adv?: number | number[];
  sigma?: number;
  missing?: DateStr[];
}

function liqInput(o: {
  days: number;
  stocks: Record<string, StockDef>;
  top: number;
  exec: ExecConfig;
  capital?: number;
  maxWeight?: number;
  every?: "week" | "month";
  stopLoss?: number;
  /** 决策日 → 名单；缺省 = 第一天决策日买入全部 */
  selections?: Map<DateStr, string[]>;
  endIdx?: number;
}): SimInput {
  const calendar = weekdays("2025-06-02", o.days);
  const n = calendar.length;
  const prices = new Map<string, PriceSeries>();
  const securities = new Map<string, SecurityInfo>();
  for (const [code, d] of Object.entries(o.stocks)) {
    const s = seriesOn(calendar, code, d.closes, { missing: d.missing });
    if (d.adv !== undefined) {
      s.adv = Float32Array.from({ length: n }, (_, i) =>
        typeof d.adv === "number" ? d.adv : (d.adv as number[])[i]!,
      );
      s.sigma = new Float32Array(n).fill(d.sigma ?? 0.02);
    }
    prices.set(code, s);
    securities.set(code, { code, name: code, board: "main", lotSize: 100, industry: "银行" });
  }
  const spec = StrategySpecSchema.parse({
    name: "流动性",
    market: "A",
    rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: o.top },
    rebalance: { every: o.every ?? "month", buffer: 1 },
    sizing: o.maxWeight ? { method: "equal", maxWeight: o.maxWeight } : { method: "equal" },
    exits: o.stopLoss ? { stopLoss: o.stopLoss } : {},
  });
  return {
    spec,
    params: {
      start: calendar[1]!,
      end: calendar[o.endIdx ?? n - 1]!,
      capital: o.capital ?? 1_000_000,
      oosMonths: 0,
      exec: o.exec,
    },
    calendar,
    prices,
    securities,
    selections: o.selections ?? new Map([[calendar[0]!, Object.keys(o.stocks)]]),
    bench: new Float64Array(n).fill(1000),
    benchLabel: "测试基准",
    benchWithDividends: true,
  };
}

const flat = (n: number, v: number) => new Array(n).fill(v) as number[];
/** 只设单笔上限（不计滑点与冲击），方便手算 */
const capOnly: ExecConfig = { ...LEGACY_EXEC, participation: 0.1 };

describe("单笔上限与拒单诊断", () => {
  it("日均成交额小的股票：截小买入、记一次 capacity，空位照样占用", () => {
    const input = liqInput({
      days: 25,
      top: 2,
      exec: capOnly,
      stocks: {
        "600001.SH": { closes: flat(25, 10), adv: 1e6 }, // 上限 10 万
        "600002.SH": { closes: flat(25, 10), adv: 1e10 },
      },
    });
    const r = simulate(input);
    const buys = r.trades.filter((t) => t.side === "buy");
    const small = buys.find((t) => t.code === "600001.SH")!;
    const big = buys.find((t) => t.code === "600002.SH")!;
    expect(small.shares).toBe(10_000);
    expect(small.amount).toBeCloseTo(1e5, 6);
    expect(big.amount).toBeGreaterThan(4.9e5);
    expect(small.part).toBeCloseTo(0.1, 9);
    expect(small.ref).toBe(10);
    expect(small.slip).toBe(0);
    const d = r.diagnostics!;
    expect(d.rejections["buy:capacity"]!.count).toBe(1);
    // 没买到的金额 = 预算 − 成交金额
    expect(d.rejections["buy:capacity"]!.value).toBeCloseTo(5e5 - 1e5, 0);
    expect(d.samples).toEqual([
      expect.objectContaining({
        code: "600001.SH",
        side: "buy",
        reason: "capacity",
        wantValue: 5e5,
        filledValue: 1e5,
      }),
    ]);
    expect(d.cappedBuyShare).toBeCloseTo(0.5, 9);
    // 截小的那只照样占一个空位
    expect(r.series[0]!.positions).toBe(2);
    expect(buys).toHaveLength(2);
    expect(r.checks.find((c) => c.id === "capacity_limit")).toMatchObject({
      level: "warn",
      title: "容量受限",
      detail: "有 50.0% 的买单因为超过日均成交额的 10% 只买到一部分；资金再大，结果会更差。",
    });
    expect(r.checks.find((c) => c.id === "illiquid_holdings")?.level).toBe("info");
  });

  it("没被截小、但容量估计不到资金 5 倍时给 info；两项检查都只用于回测", () => {
    const stocks: Record<string, StockDef> = {};
    for (let k = 1; k <= 4; k++) stocks[`60000${k}.SH`] = { closes: flat(25, 10), adv: 6e6 };
    const r = simulate(liqInput({ days: 25, top: 4, exec: capOnly, stocks }));
    expect(r.diagnostics!.cappedBuyShare).toBe(0);
    const c = r.checks.find((x) => x.id === "capacity_limit")!;
    expect(c.level).toBe("info");
    expect(c.detail).toMatch(
      /^按单笔不超过日均成交额 10% 估算，这个策略大约能容纳 \d+ 万的资金。$/,
    );
    expect(r.checks.some((x) => x.id === "illiquid_holdings")).toBe(false);
    expect(BACKTEST_ONLY_CHECKS.has("capacity_limit")).toBe(true);
    expect(BACKTEST_ONLY_CHECKS.has("illiquid_holdings")).toBe(true);
  });

  it("容量估计 = 资金 × 单笔上限 ÷ 买入参与率的 90 分位", () => {
    const input = liqInput({
      days: 25,
      top: 4,
      exec: capOnly,
      stocks: {
        "600001.SH": { closes: flat(25, 10), adv: 1e8 },
        "600002.SH": { closes: flat(25, 10), adv: 2e8 },
        "600003.SH": { closes: flat(25, 10), adv: 4e8 },
        "600004.SH": { closes: flat(25, 10), adv: 8e8 },
      },
    });
    const r = simulate(input);
    const d = r.diagnostics!;
    const parts = r.trades.filter((t) => t.side === "buy").map((t) => t.part!);
    expect(parts).toHaveLength(4);
    const sorted = [...parts].sort((a, b) => a - b);
    const p90 = sorted[2]! + 0.7 * (sorted[3]! - sorted[2]!);
    expect(d.participation!.p90).toBeCloseTo(p90, 12);
    expect(d.participation!.max).toBeCloseTo(sorted[3]!, 12);
    expect(d.capacityEstimate).toBeCloseTo((1_000_000 * 0.1) / p90, 6);
    expect(d.cappedBuyShare).toBe(0);
    expect(d.advUnknownBuys).toBe(0);
  });

  it("日均成交额未知的买单拒绝（no_liquidity），空位留给名单后面的股票", () => {
    const input = liqInput({
      days: 25,
      top: 1,
      exec: capOnly,
      stocks: {
        "600001.SH": { closes: flat(25, 10), adv: NaN },
        "600002.SH": { closes: flat(25, 10), adv: 1e10 },
      },
    });
    const r = simulate(input);
    expect(r.trades.filter((t) => t.side === "buy").map((t) => t.code)).toEqual(["600002.SH"]);
    expect(r.diagnostics!.rejections["buy:no_liquidity"]!.count).toBe(1);
    expect(r.diagnostics!.advUnknownBuys).toBe(1);
  });

  it("不设上限时日均成交额未知也照常买卖（冲击记 0）", () => {
    const closes = flat(25, 10).map((v, i) => (i >= 5 ? 8 : v));
    const r = simulate(
      liqInput({
        days: 25,
        top: 1,
        stopLoss: 0.1,
        exec: { ...defaultExec("A"), participation: null },
        stocks: { "600001.SH": { closes } },
      }),
    );
    const [buy, sell] = r.trades;
    expect(buy!.side).toBe("buy");
    expect(sell!.side).toBe("sell");
    expect(buy!.part).toBeUndefined();
    // 只有 5bp 滑点 + 半个价位（0.5 分 / 10 元 = 5bp）
    expect(buy!.price).toBeCloseTo(10 * (1 + 10 / 1e4), 9);
    expect(sell!.price).toBeCloseTo(8 * (1 - (5 + ((0.5 * 0.01) / 8) * 1e4) / 1e4), 9);
    expect(r.diagnostics!.advUnknownBuys).toBe(1);
  });

  it("拒单统计是确定的：同样的输入跑两次完全一样", () => {
    const build = () =>
      liqInput({
        days: 25,
        top: 3,
        exec: defaultExec("A"),
        stocks: {
          "600001.SH": { closes: flat(25, 10), adv: 1e6 },
          "600002.SH": { closes: flat(25, 10), adv: NaN },
          "600003.SH": { closes: flat(25, 10), adv: 3e8, missing: ["2025-06-03"] },
        },
      });
    const a = simulate(build());
    const b = simulate(build());
    expect(a.diagnostics).toEqual(b.diagnostics);
    expect(a.diagnostics!.rejections).toEqual({
      "buy:capacity": expect.objectContaining({ count: 1 }),
      "buy:no_liquidity": expect.objectContaining({ count: 1 }),
      "buy:suspended": expect.objectContaining({ count: 1 }),
    });
  });
});

describe("用决策日的日均成交额（不偷看）", () => {
  it("成交日当天的日均成交额放大 10 倍，不改变那天的成交价与上限", () => {
    const days = 25;
    const base = flat(days, 2e6);
    const spiked = [...base];
    spiked[1] = 2e7; // 第 1 天是成交日（第 0 天是决策日）
    const run = (adv: number[]) =>
      simulate(
        liqInput({
          days,
          top: 1,
          exec: defaultExec("A"),
          stocks: { "600001.SH": { closes: flat(days, 10), adv } },
        }),
      );
    const a = run(base).trades[0]!;
    const b = run(spiked).trades[0]!;
    expect(b.price).toBe(a.price);
    expect(b.shares).toBe(a.shares);
    expect(b.part).toBe(a.part);
    // 上限按决策日的 200 万 × 10%
    expect(a.amount).toBeLessThanOrEqual(2e5);
    expect(a.price).toBeGreaterThan(10);
  });
});

describe("拒单样例只留最近的", () => {
  it("顺延 500 多天的卖单：样例留最近 500 条，按日期排，计数照常累计", () => {
    const days = 560;
    const closes = flat(days, 10).map((v, i) => (i === 3 ? 8 : v));
    const cal = weekdays("2025-06-02", days);
    const r = simulate(
      liqInput({
        days,
        top: 1,
        stopLoss: 0.1,
        exec: defaultExec("A"),
        stocks: { "600001.SH": { closes, adv: 1e10, missing: cal.slice(4) } },
      }),
    );
    const d = r.diagnostics!;
    const suspended = d.rejections["sell:suspended"]!.count;
    expect(suspended).toBe(days - 4);
    expect(d.samples).toHaveLength(SAMPLE_LIMIT);
    expect(d.samples.at(-1)!.date).toBe(cal.at(-1));
    expect(d.samples[0]!.date).toBe(cal[days - SAMPLE_LIMIT]);
    const dates = d.samples.map((s) => s.date);
    expect([...dates].sort()).toEqual(dates);
  });
});

describe("明日计划的估算", () => {
  // 周一起 26 个工作日：第 25 天是周一（调仓日），区间到第 24 天（周五，决策日）
  const nextWeek = (o: { maxWeight?: number; exec?: ExecConfig }) => {
    const cal = weekdays("2025-06-02", 26);
    const stocks: Record<string, StockDef> = {};
    for (let k = 1; k <= 4; k++) stocks[`60000${k}.SH`] = { closes: flat(26, 10 * k), adv: 1e10 };
    return simulate(
      liqInput({
        days: 26,
        top: 4,
        every: "week",
        endIdx: 24,
        maxWeight: o.maxWeight,
        exec: o.exec ?? defaultExec("A"),
        stocks,
        selections: new Map([
          [cal[0]!, []],
          [cal[24]!, Object.keys(stocks)],
        ]),
      }),
    );
  };

  it("买单带估计价、股数、仓位与参考收盘价；不设单只上限时约 1/N", () => {
    const r = nextWeek({});
    const buys = r.final.pending.filter((p) => p.side === "buy");
    expect(buys).toHaveLength(4);
    for (const [k, p] of buys.entries()) {
      expect(p.refClose).toBe(10 * (k + 1));
      expect(p.estPrice!).toBeGreaterThan(p.refClose!);
      expect(p.estShares! % 100).toBe(0);
      expect(p.estWeight!).toBeGreaterThan(0.23);
      expect(p.estWeight!).toBeLessThanOrEqual(0.25);
    }
  });

  it("设了单只上限时估计仓位不超过上限", () => {
    const r = nextWeek({ maxWeight: 0.1 });
    for (const p of r.final.pending.filter((x) => x.side === "buy")) {
      expect(p.estWeight!).toBeLessThanOrEqual(0.1);
      expect(p.estWeight!).toBeGreaterThan(0.09);
    }
  });

  it("旧办法成交：估计价就是最后收盘价", () => {
    const r = nextWeek({ exec: LEGACY_EXEC });
    for (const p of r.final.pending) expect(p.estPrice).toBe(p.refClose);
  });

  it("卖单带现在的仓位与估计成交价", () => {
    const closes = flat(25, 10).map((v, i) => (i >= 20 ? 8 : v));
    const r = simulate(
      liqInput({
        days: 25,
        top: 1,
        stopLoss: 0.1,
        exec: defaultExec("A"),
        stocks: { "600001.SH": { closes, adv: 1e10 } },
        endIdx: 20,
      }),
    );
    const [sell] = r.final.pending;
    expect(sell).toMatchObject({ side: "sell", reason: "stop_loss", refClose: 8 });
    expect(sell!.estPrice!).toBeLessThan(8);
    expect(sell!.curWeight!).toBeGreaterThan(0.9);
    expect(sell!.estWeight).toBe(sell!.curWeight);
    expect(sell!.estShares).toBe(r.final.positions[0]!.shares);
  });
});

describe("滑点成本单列", () => {
  it("指标带滑点成本，费用拖累拆成两部分；旧办法成交没有这些键", () => {
    const build = (exec: ExecConfig) =>
      liqInput({
        days: 25,
        top: 1,
        exec,
        stocks: { "600001.SH": { closes: flat(25, 10), adv: 1e9 } },
      });
    const r = simulate(build(defaultExec("A")));
    const slip = r.trades.reduce((s, t) => s + (t.slip ?? 0), 0);
    expect(slip).toBeGreaterThan(0);
    expect(r.metrics.slippageCost).toBeCloseTo(slip, 9);
    expect(r.diagnostics!.slippageCost).toBeCloseTo(slip, 9);
    expect(r.metrics.costDrag).toBeCloseTo(r.metrics.feeDrag! + r.metrics.slipDrag!, 12);
    const legacy = simulate(build({ ...LEGACY_EXEC, rules: 2, metrics: 2 }));
    expect(legacy.metrics).not.toHaveProperty("slippageCost");
    expect(legacy.diagnostics).not.toHaveProperty("capacityEstimate");
    expect(legacy.trades[0]).not.toHaveProperty("ref");
  });
});

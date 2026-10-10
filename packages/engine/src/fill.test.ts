/**
 * 报价（D64）：半价差含最小价位、平方根冲击、单笔上限、涨跌停封顶、日均成交额未知的买单拒绝。
 */
import { addDays, type ExecConfig, LEGACY_EXEC } from "@ivan/core";
import { describe, expect, it } from "vitest";
import { FillLog, lotFloor, type QuoteCtx, quote, SAMPLE_LIMIT, SIGMA_FALLBACK } from "./fill.ts";

const exec = (o: Partial<ExecConfig>): ExecConfig => ({
  ...LEGACY_EXEC,
  rules: 2,
  metrics: 2,
  ...o,
});

const ctx = (o: Partial<QuoteCtx> = {}): QuoteCtx => ({
  market: "A",
  exec: exec({}),
  side: "buy",
  open: 10,
  adv: 1e8,
  sigma: 0.02,
  limit: null,
  date: "2025-06-03",
  ...o,
});

const bps = (price: number, ref: number) => (Math.abs(price - ref) / ref) * 1e4;

describe("报价 quote", () => {
  it("A 股 5.00 元、0bp、加半个最小价位 → 半价差 10bp", () => {
    const q = quote(ctx({ open: 5, exec: exec({ tickSpread: true }) }), 1e5);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.slipBps).toBeCloseTo(10, 9);
    expect(q.impactBps).toBe(0);
    expect(q.price).toBeCloseTo(5.005, 9);
    expect(q.ref).toBe(5);
  });

  it("港股 0.42 港元（价位 0.005）→ 半价差约 59.5bp", () => {
    const q = quote(
      ctx({ market: "HK", open: 0.42, date: "2024-03-01", exec: exec({ tickSpread: true }) }),
      1e5,
    );
    if (!q.ok) throw new Error("应能成交");
    expect(q.slipBps).toBeCloseTo((0.5 * 0.005 * 1e4) / 0.42, 9);
    expect(q.slipBps).toBeCloseTo(59.52, 1);
  });

  it("平方根冲击：系数 0.5、日波动 2%、100 万、日均成交额 1 亿 → 10bp", () => {
    const q = quote(ctx({ exec: exec({ impact: "sqrt", impactEta: 0.5 }) }), 1e6);
    if (!q.ok) throw new Error("应能成交");
    expect(q.impactBps).toBeCloseTo(10, 9);
    expect(bps(q.price, 10)).toBeCloseTo(10, 6);
    expect(q.sigmaFallback).toBe(false);
  });

  it("冲击按截小后的金额算；卖单减价", () => {
    const e = exec({ impact: "sqrt", impactEta: 0.5, participation: 0.01 });
    const buy = quote(ctx({ exec: e }), 1e7);
    if (!buy.ok) throw new Error("应能成交");
    expect(buy.maxValue).toBe(1e6);
    expect(buy.impactBps).toBeCloseTo(10, 9);
    const sell = quote(ctx({ exec: e, side: "sell" }), 1e6);
    if (!sell.ok) throw new Error("应能成交");
    expect(sell.maxValue).toBe(Infinity);
    expect(sell.price).toBeLessThan(10);
    expect(bps(sell.price, 10)).toBeCloseTo(10, 6);
  });

  it("单笔上限：日均成交额 200 万 × 10%、价格 10 → 取整后 20,000 股", () => {
    const q = quote(ctx({ adv: 2e6, exec: exec({ participation: 0.1 }) }), 1e6);
    if (!q.ok) throw new Error("应能成交");
    expect(q.price).toBe(10);
    expect(q.maxValue).toBeCloseTo(2e5, 6);
    expect(lotFloor("A", "main", 100, q.maxValue / q.price)).toBe(20_000);
    // 上限 20,050 股的金额也按整百取到 20,000
    expect(lotFloor("A", "main", 100, 20_050)).toBe(20_000);
    expect(lotFloor("A", "star", null, 199.9, true)).toBe(0);
    expect(lotFloor("A", "star", null, 250.5, true)).toBe(250);
    expect(lotFloor("HK", "hk_main", 500, 1_499)).toBe(1_000);
  });

  it("买价不超过涨停价，卖价不低于跌停价", () => {
    const e = exec({ slippageBps: 100 });
    const buy = quote(ctx({ exec: e, open: 10.95, limit: { up: 11, down: 9 } }), 1e5);
    if (!buy.ok) throw new Error("应能成交");
    expect(buy.price).toBe(11);
    const sell = quote(ctx({ exec: e, side: "sell", open: 9.05, limit: { up: 11, down: 9 } }), 1e5);
    if (!sell.ok) throw new Error("应能成交");
    expect(sell.price).toBe(9);
  });

  it("日均成交额未知：买单拒绝（no_liquidity），卖单照常", () => {
    const e = exec({ participation: 0.1, impact: "sqrt", impactEta: 0.5 });
    expect(quote(ctx({ exec: e, adv: NaN }), 1e5)).toEqual({ ok: false, reason: "no_liquidity" });
    expect(quote(ctx({ exec: e, adv: 0 }), 1e5)).toEqual({ ok: false, reason: "no_liquidity" });
    const sell = quote(ctx({ exec: e, adv: NaN, side: "sell" }), 1e5);
    expect(sell.ok).toBe(true);
    if (sell.ok) expect(sell.impactBps).toBe(0);
    // 仓位控制的加仓不设上限，也不因此拒绝
    expect(quote(ctx({ exec: e, adv: NaN, uncapped: true }), 1e5).ok).toBe(true);
  });

  it("日波动缺失：冲击按 2.5% 估，并标出来", () => {
    const q = quote(ctx({ sigma: NaN, exec: exec({ impact: "sqrt", impactEta: 0.5 }) }), 1e6);
    if (!q.ok) throw new Error("应能成交");
    expect(q.sigmaFallback).toBe(true);
    expect(q.impactBps).toBeCloseTo(0.5 * SIGMA_FALLBACK * 0.1 * 1e4, 9);
  });
});

describe("拒单记录 FillLog", () => {
  it("按（方向, 原因）计数与金额；样例只留最近的 500 条，按日期排", () => {
    const log = new FillLog();
    for (let i = 0; i < SAMPLE_LIMIT + 20; i++) {
      log.reject(addDays("2020-01-01", i), `C${i}`, "buy", "capacity", 100, 40);
    }
    log.reject("2099-01-01", "LAST", "sell", "suspended", 50);
    const r = log.result({ liquidity: false, capital: 1e6, participation: null });
    expect(r.rejections["buy:capacity"]).toEqual({
      count: SAMPLE_LIMIT + 20,
      value: 60 * (SAMPLE_LIMIT + 20),
    });
    expect(r.rejections["sell:suspended"]).toEqual({ count: 1, value: 50 });
    expect(r.samples).toHaveLength(SAMPLE_LIMIT);
    expect(r.samples.at(-1)!.code).toBe("LAST");
    expect(r.samples[0]!.code).toBe("C21");
    const dates = r.samples.map((s) => s.date);
    expect([...dates].sort()).toEqual(dates);
    // 旧办法成交只有拒单统计
    expect(r).not.toHaveProperty("participation");
  });
});

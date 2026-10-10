/**
 * 输入指纹（D57）：同样的输入两次组装指纹相同；改一个价格只动 priceHash，改名单顺序只动 selectionHash；
 * 跟踪前缀（rule = executed）在「周五休市、周四是本周最后一个交易日」这种边界上两晚一致。
 */
import { type DateStr, defaultExec, LEGACY_EXEC, StrategySpecSchema } from "@ivan/core";
import { afterEach, describe, expect, it } from "vitest";
import { seedSyntheticMarket, syntheticCalendar } from "../testing/seed.ts";
import { Warehouse } from "../warehouse/db.ts";
import { buildSimInput } from "./backtest.ts";
import { hashSimInput, HASH_VERSION } from "./input-hash.ts";

const spec = StrategySpecSchema.parse({
  name: "周度低估值",
  market: "A",
  rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 2 },
  rebalance: { every: "week", buffer: 1 },
});

const START = "2026-03-02"; // 周一
const SKIP = ["2026-03-20"]; // 周五休市
const THU = "2026-03-19";
const NEXT_WED = "2026-03-25";

// 四只股票的市盈率每天轮换，让各周的名单不同
const stocks = ["600001.SH", "600002.SH", "600003.SH", "600004.SH"].map((code, k) => ({
  code,
  name: `股${k}`,
  close: (i: number) => 10 + k + i * 0.1 * (k + 1),
  adj: () => 1,
  factors: (i: number) => ({ pe_ttm: 5 + ((i + k * 3) % 7) }),
}));

const opened: Warehouse[] = [];
afterEach(() => {
  for (const w of opened.splice(0)) w.close();
});

/** 种一个数据截至 lastDay 的行情仓 */
async function market(lastDay: DateStr): Promise<Warehouse> {
  const wh = await Warehouse.open(":memory:");
  opened.push(wh);
  let days = 1;
  while (syntheticCalendar(START, days, SKIP).at(-1)! < lastDay) days++;
  const { calendar } = await seedSyntheticMarket(wh, {
    market: "A",
    start: START,
    days,
    stocks,
    skipDates: SKIP,
  });
  expect(calendar.at(-1)).toBe(lastDay);
  expect(calendar).not.toContain(SKIP[0]);
  return wh;
}

const params = (end: DateStr) => ({
  start: "2026-03-03",
  end,
  capital: 1_000_000,
  oosMonths: 0,
  exec: LEGACY_EXEC,
});

describe("按流动性成交的价格面板（D64）", () => {
  it("要日均成交额时才装 adv / sigma（元、日波动），并进 priceHash", async () => {
    const wh = await Warehouse.open(":memory:");
    opened.push(wh);
    await seedSyntheticMarket(wh, {
      market: "A",
      start: START,
      days: 10,
      skipDates: SKIP,
      stocks: stocks.map((s) => ({
        ...s,
        factors: (i: number) => ({
          ...s.factors(i),
          turnover_20d: i === 2 ? null : 1 + i * 0.5,
          volatility_60d: 40,
        }),
      })),
    });
    const legacy = await buildSimInput(wh, spec, params("2026-03-13"));
    const p0 = [...legacy.input.prices.values()][0]!;
    expect(p0.adv).toBeUndefined();
    expect(p0.sigma).toBeUndefined();

    const liq = await buildSimInput(wh, spec, { ...params("2026-03-13"), exec: defaultExec("A") });
    const p = liq.input.prices.get(p0.code)!;
    const k = (i: number) => i - p.from; // 第 i 个交易日在这只股票面板里的下标
    expect(p.adv).toBeInstanceOf(Float32Array);
    expect(p.adv![k(1)]).toBeCloseTo(1.5e8, -2);
    expect(p.adv![k(2)]).toBeNaN();
    expect(p.sigma![k(1)]).toBeCloseTo(0.4 / Math.sqrt(250), 6);
    // 只要单边滑点（不设上限、不计冲击）不用这两列
    const slipOnly = await buildSimInput(wh, spec, {
      ...params("2026-03-13"),
      exec: { ...defaultExec("A"), participation: null, impact: "none" },
    });
    expect([...slipOnly.input.prices.values()][0]!.adv).toBeUndefined();
    // 同样的价格，带上这两列后 priceHash 不同
    const a = hashSimInput({ ...liq.input, params: legacy.input.params });
    expect(a.priceHash).not.toBe(hashSimInput(legacy.input).priceHash);
  });
});

describe("hashSimInput", () => {
  it("同样的数据组装两次，指纹完全相同；全长 64 位并带口径版本", async () => {
    const wh = await market(NEXT_WED);
    const a = hashSimInput((await buildSimInput(wh, spec, params(NEXT_WED))).input);
    const b = hashSimInput((await buildSimInput(wh, spec, params(NEXT_WED))).input);
    expect(b).toEqual(a);
    expect(a.inputHash).toHaveLength(64);
    expect(a.hashVersion).toBe(HASH_VERSION);
    expect(a.cut).toBe(NEXT_WED);
    expect(a.rule).toBe("all");
  });

  it("改一个复权因子只动 priceHash；调换名单顺序只动 selectionHash；检查项说明不进指纹", async () => {
    const wh = await market(NEXT_WED);
    const fresh = async () => (await buildSimInput(wh, spec, params(NEXT_WED))).input;
    const base = hashSimInput(await fresh());

    const adj = await fresh();
    const [code, series] = [...adj.prices.entries()][0]!;
    expect(code).toBeTruthy();
    series.adj[3] = series.adj[3]! * 1.01;
    const h1 = hashSimInput(adj);
    expect(h1.priceHash).not.toBe(base.priceHash);
    expect(h1.selectionHash).toBe(base.selectionHash);
    expect(h1.benchHash).toBe(base.benchHash);
    expect(h1.inputHash).not.toBe(base.inputHash);

    const order = await fresh();
    const [d, list] = [...order.selections.entries()][1]!;
    expect(list.length).toBeGreaterThan(1);
    order.selections.set(d, [...list].reverse());
    const h2 = hashSimInput(order);
    expect(h2.selectionHash).not.toBe(base.selectionHash);
    expect(h2.priceHash).toBe(base.priceHash);
    expect(h2.benchHash).toBe(base.benchHash);

    const caveats = await fresh();
    caveats.dataCaveats = [{ id: "x", level: "warn", title: "t", detail: "d" }];
    caveats.priorVersionsOnPeriod = 7;
    expect(hashSimInput(caveats)).toEqual(base);
  });

  it("口径版本 2（S04）：上市日进价格指纹；成交假设补齐后的规则表 / 指标版本进总指纹", async () => {
    expect(HASH_VERSION).toBe(2);
    const wh = await market(NEXT_WED);
    const fresh = async () => (await buildSimInput(wh, spec, params(NEXT_WED))).input;
    const base = await fresh();
    // 行情仓里的上市日带进证券信息
    const [code, sec] = [...base.securities.entries()][0]!;
    expect(sec).toHaveProperty("listDate");
    const h0 = hashSimInput(base);

    const moved = await fresh();
    moved.securities.set(code, { ...moved.securities.get(code)!, listDate: "2026-03-04" });
    const h1 = hashSimInput(moved);
    expect(h1.priceHash).not.toBe(h0.priceHash);
    expect(h1.selectionHash).toBe(h0.selectionHash);
    expect(h1.inputHash).not.toBe(h0.inputHash);

    // 缺省 exec 与显式 LEGACY_EXEC 同一个指纹；换成新口径就不同
    const noExec = await fresh();
    noExec.params = { ...noExec.params, exec: undefined };
    expect(hashSimInput(noExec).inputHash).toBe(h0.inputHash);
    const v2 = await fresh();
    v2.params = { ...v2.params, exec: { ...LEGACY_EXEC, rules: 2, metrics: 2 } };
    const h2 = hashSimInput(v2);
    expect(h2.priceHash).toBe(h0.priceHash);
    expect(h2.inputHash).not.toBe(h0.inputHash);
  });

  it("周五休市：今晚与上一晚按 executed 规则在周四截的前缀相同，按 all 规则不同", async () => {
    // A：上一晚，数据截至周四（跟踪会在日历末尾补一个下一个工作日）
    const a = await buildSimInput(await market(THU), spec, params(THU), { appendNextDay: true });
    // B：几天后，数据截至下周三；周四是上一周的最后一个交易日，它的选股在下周一执行
    const b = await buildSimInput(await market(NEXT_WED), spec, params(NEXT_WED), {
      appendNextDay: true,
    });
    expect([...b.input.selections.keys()]).toContain(THU);
    expect([...a.input.selections.keys()]).not.toContain(THU);

    const exA = hashSimInput(a.input, { cut: THU, rule: "executed" });
    const exB = hashSimInput(b.input, { cut: THU, rule: "executed" });
    expect(exB.inputHash).toBe(exA.inputHash);

    const allA = hashSimInput(a.input, { cut: THU, rule: "all" });
    const allB = hashSimInput(b.input, { cut: THU, rule: "all" });
    expect(allB.selectionHash).not.toBe(allA.selectionHash);
    expect(allB.inputHash).not.toBe(allA.inputHash);

    // 周中截（周三）：两种规则下两晚都一致
    for (const rule of ["all", "executed"] as const) {
      expect(hashSimInput(b.input, { cut: "2026-03-11", rule }).inputHash).toBe(
        hashSimInput(a.input, { cut: "2026-03-11", rule }).inputHash,
      );
    }
  });
});

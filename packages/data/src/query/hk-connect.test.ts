/**
 * 港股通股票池（D77）：决策日在名单里（值 Y 的区间覆盖这天）才入选；早于首次记录日用首次名单并加 hk_connect_approx；
 * 一行名单都没有时拒绝；没勾港股通的策略选股 SQL 一字不变。
 */
import { type StrategySpec, StrategySpecSchema } from "@ivan/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedSyntheticMarket } from "../testing/seed.ts";
import { Warehouse } from "../warehouse/db.ts";
import { buildSimInput } from "./backtest.ts";
import { explainSelection, screenOn } from "./explain.ts";
import { compileSelection, loadHkConnect, runSelection, SelectionDataError } from "./selection.ts";

let wh: Warehouse;
let calendar: string[];
/** X 一直在名单里；Z 不在；W 在名单里、第 15 天调出 */
const X = "00001.HK";
const Z = "00002.HK";
const W = "00003.HK";

beforeEach(async () => {
  wh = await Warehouse.open(":memory:");
  ({ calendar } = await seedSyntheticMarket(wh, {
    market: "HK",
    start: "2026-03-02",
    days: 30,
    // 市盈率 Z 最低、W 其次、X 最高：不筛港股通时 Z 排第一
    stocks: [
      { code: X, name: "在名单", close: () => 10, factors: () => ({ pe_ttm: 30 }) },
      { code: Z, name: "不在名单", close: () => 20, factors: () => ({ pe_ttm: 5 }) },
      { code: W, name: "后来调出", close: () => 30, factors: () => ({ pe_ttm: 10 }) },
    ],
  }));
});
afterEach(() => wh.close());

/** 首次快照在第 10 个交易日 */
async function seedSnapshots() {
  const d10 = calendar[10]!;
  const d15 = calendar[15]!;
  await wh.append("attr_history", [
    [X, "hk_connect_sz", "Y", d10, null, "em", 1],
    [Z, "hk_connect_sz", "N", d10, null, "em", 1],
    [W, "hk_connect_sz", "Y", d10, d15, "em", 1],
    [W, "hk_connect_sz", "N", d15, null, "em", 2],
  ]);
}

const specOf = (hkConnect: boolean): StrategySpec =>
  StrategySpecSchema.parse({
    name: "港股低市盈率",
    market: "HK",
    universe: hkConnect ? { hkConnect: true } : {},
    rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 3 },
    rebalance: { every: "week", buffer: 1 },
  });

describe("港股通名单", () => {
  it("名单的属性与首次记录日；没有行时为 null", async () => {
    expect(await loadHkConnect(wh)).toBeNull();
    await seedSnapshots();
    expect(await loadHkConnect(wh)).toEqual({ attrs: ["hk_connect_sz"], first: calendar[10] });
    // 沪港通核实后另记：取并集，首次记录日取最早的
    await wh.append("attr_history", [[X, "hk_connect_sh", "Y", calendar[12]!, null, "em", 3]]);
    expect(await loadHkConnect(wh)).toEqual({
      attrs: ["hk_connect_sz", "hk_connect_sh"],
      first: calendar[10],
    });
  });

  it("第 12 天：只选名单里的（X、W），Z 被排除；W 调出后第 16 天也被排除", async () => {
    await seedSnapshots();
    const d12 = calendar[12]!;
    const d16 = calendar[16]!;
    const sel = await runSelection(wh, specOf(true), [d12, d16], 10);
    expect(sel.get(d12)).toEqual([W, X]);
    expect(sel.get(d16)).toEqual([X]);
    // 不筛港股通：Z 排第一
    expect((await runSelection(wh, specOf(false), [d12], 10)).get(d12)).toEqual([Z, W, X]);
  });

  it("早于首次记录日的第 5 天用第 10 天的名单", async () => {
    await seedSnapshots();
    const d5 = calendar[5]!;
    expect((await runSelection(wh, specOf(true), [d5], 10)).get(d5)).toEqual([W, X]);
  });

  it("回测起点早于首次记录日 → hk_connect_approx（info），写明只记了深港通", async () => {
    await seedSnapshots();
    const built = await buildSimInput(wh, specOf(true), {
      start: calendar[5]!,
      end: calendar.at(-1)!,
      capital: 1e6,
      oosMonths: 0,
    });
    for (const list of built.input.selections.values()) expect(list).not.toContain(Z);
    const c = built.input.dataCaveats!.find((x) => x.id === "hk_connect_approx");
    expect(c).toEqual({
      id: "hk_connect_approx",
      level: "info",
      title: "港股通名单为近似",
      detail: `港股通名单从 ${calendar[10]} 起逐日记录，之前的日期用的是那天的名单（以后才纳入的股票会被当成一直能买）；目前只记录了深港通名单。`,
    });
    // 没勾港股通的策略不加这条
    const plain = await buildSimInput(wh, specOf(false), {
      start: calendar[5]!,
      end: calendar.at(-1)!,
      capital: 1e6,
      oosMonths: 0,
    });
    expect(plain.input.dataCaveats!.map((x) => x.id)).not.toContain("hk_connect_approx");
  });

  it("选股解释：Z 的原因是「不是港股通标的」；今日选股同一条路径", async () => {
    await seedSnapshots();
    const d12 = calendar[12]!;
    const ex = await explainSelection(wh, specOf(true), d12, { limit: 10, codes: [Z, X] });
    expect(ex.candidates.map((c) => c.code)).toEqual([W, X]);
    expect(ex.codes.find((c) => c.code === Z)!.failed).toEqual(["不是港股通标的"]);
    expect(ex.codes.find((c) => c.code === X)!.passed).toBe(true);
    expect((await screenOn(wh, specOf(true), d12, 10)).map((r) => r.code)).toEqual([W, X]);
  });

  it("一行名单都没有 → 回测、解释、选股都给出中文原因", async () => {
    const msg = "港股通名单还没有记录，等今晚证券表刷新后再试";
    await expect(
      buildSimInput(wh, specOf(true), { start: calendar[5]!, end: calendar.at(-1)!, capital: 1e6, oosMonths: 0 }),
    ).rejects.toThrow(msg);
    await expect(explainSelection(wh, specOf(true), calendar[12]!, { limit: 5 })).rejects.toBeInstanceOf(
      SelectionDataError,
    );
    await expect(screenOn(wh, specOf(true), calendar[12]!, 5)).rejects.toThrow(msg);
    expect(() => compileSelection(specOf(true), [calendar[12]!], 5)).toThrow(msg);
  });

  it("没勾港股通的策略：选股 SQL 一字不变，不碰 attr_history", async () => {
    await seedSnapshots();
    const list = (await loadHkConnect(wh))!;
    const dates = [calendar[12]!];
    const plain = compileSelection(specOf(false), dates, 5);
    expect(compileSelection(specOf(false), dates, 5, { hkConnect: list })).toBe(plain);
    expect(plain).not.toMatch(/attr_history/);
    expect(compileSelection(specOf(true), dates, 5, { hkConnect: list })).toMatch(
      /EXISTS \(SELECT 1 FROM attr_history h WHERE h\.code = factors_daily\.code AND h\.attr IN \('hk_connect_sz'\)/,
    );
  });
});

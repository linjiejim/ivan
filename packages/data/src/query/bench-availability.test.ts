/**
 * 基准没数据时（D75）：回测在建输入时拒绝（不拿一条平线比），跟踪（补下一个交易日的那条路）不抛错、加 bench_missing 提示，
 * 免得全收益基准晚到一天就让结算失败。
 */
import { StrategySpecSchema } from "@ivan/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedSyntheticMarket } from "../testing/seed.ts";
import { Warehouse } from "../warehouse/db.ts";
import { buildSimInput } from "./backtest.ts";
import { benchFirstDates } from "./bench.ts";

let wh: Warehouse;
let calendar: string[];
beforeEach(async () => {
  wh = await Warehouse.open(":memory:");
  ({ calendar } = await seedSyntheticMarket(wh, {
    market: "A",
    start: "2026-03-02",
    days: 30,
    stocks: [{ code: "600001.SH", name: "入选", close: () => 10, factors: () => ({ pe_ttm: 5 }) }],
  }));
  // 中证1000全收益从第 10 个交易日才有数据
  await wh.run(
    `INSERT INTO index_bars (sym, date, close, provisional)
     SELECT 'csi1000_tr', date, close, provisional FROM index_bars WHERE sym = 'csi300_tr' AND date >= $d::DATE`,
    { d: calendar[10]! },
  );
});
afterEach(() => wh.close());

const spec = (benchmark: string) =>
  StrategySpecSchema.parse({
    name: "小盘",
    market: "A",
    rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 1 },
    rebalance: { every: "week", buffer: 1 },
    benchmark,
  });
const params = (start: string) => ({ start, end: calendar.at(-1)!, capital: 1e6, oosMonths: 0 });

describe("基准的首个数据日", () => {
  it("data-status 用：各基准按 sym 给首个数据日，一行都没有为 null", async () => {
    expect(await benchFirstDates(wh, "A")).toEqual({
      csi300_tr: calendar[0],
      sse: calendar[0],
      csi500_tr: null,
      csi1000_tr: calendar[10],
      csi_div_tr: null,
    });
    expect(await benchFirstDates(wh, "HK")).toEqual({ hsi_tr: null, hscei_tr: null });
  });
});

describe("回测：起点前一个交易日没有基准数据就拒绝", () => {
  it("基准从起点之后才有数据 → 抛中文原因", async () => {
    await expect(buildSimInput(wh, spec("csi1000"), params(calendar[5]!))).rejects.toThrow(
      `基准「中证1000全收益」从 ${calendar[10]} 才有数据，请把起点设在这之后，或换个基准`,
    );
    // 起点就是首个数据日：前一个交易日还没有，同样拒绝
    await expect(buildSimInput(wh, spec("csi1000"), params(calendar[10]!))).rejects.toThrow(/才有数据/);
  });

  it("起点前一个交易日有数据 → 正常建输入，没有 bench_missing", async () => {
    const built = await buildSimInput(wh, spec("csi1000"), params(calendar[11]!));
    expect(built.input.dataCaveats!.map((c) => c.id)).not.toContain("bench_missing");
  });

  it("基准一行都没有 → 「还没有数据」", async () => {
    await expect(buildSimInput(wh, spec("csi500"), params(calendar[5]!))).rejects.toThrow(
      "基准「中证500全收益」还没有数据，等今晚行情更新后再试",
    );
  });
});

describe("跟踪：不抛错，加 bench_missing 提示", () => {
  it("同样的起点、补下一个交易日 → 有 bench_missing（warn），不抛错", async () => {
    const built = await buildSimInput(wh, spec("csi1000"), params(calendar[5]!), { appendNextDay: true });
    const c = built.input.dataCaveats!.find((x) => x.id === "bench_missing");
    expect(c).toMatchObject({ level: "warn", title: "基准缺数据" });
    expect(c!.detail).toBe(
      `基准「中证1000全收益」在 ${calendar[4]} 没有数据，超额按缺值处理（共 6 个交易日）。`,
    );
  });

  it("全收益基准晚到一天（最后一天没有）→ bench_missing 指出那一天", async () => {
    await wh.run(`DELETE FROM index_bars WHERE sym = 'csi1000_tr' AND date = $d::DATE`, {
      d: calendar.at(-1)!,
    });
    const built = await buildSimInput(wh, spec("csi1000"), params(calendar[12]!), { appendNextDay: true });
    expect(built.input.dataCaveats!.find((x) => x.id === "bench_missing")!.detail).toBe(
      `基准「中证1000全收益」在 ${calendar.at(-1)} 没有数据，超额按缺值处理。`,
    );
    // 回测不管最后一天（只要求起点前一个交易日有数据）
    const bt = await buildSimInput(wh, spec("csi1000"), params(calendar[12]!));
    expect(bt.input.dataCaveats!.map((x) => x.id)).not.toContain("bench_missing");
  });
});

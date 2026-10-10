/**
 * 「基准可能不匹配」（D75，bench_mismatch，info）：各决策日入选股票的市值排名中位数决定建议哪个基准；
 * 排序主要看股息率时建议中证红利。只是提示：进检查项，不进输入指纹。
 */
import { type StrategySpec, StrategySpecSchema } from "@ivan/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SeedStock, seedSyntheticMarket } from "../testing/seed.ts";
import { Warehouse } from "../warehouse/db.ts";
import { buildSimInput } from "./backtest.ts";
import { dividendWeightShare, selectedMedianMcapRank } from "./bench.ts";
import { hashSimInput } from "./input-hash.ts";

let wh: Warehouse;
let calendar: string[];

/** 三只股票，入选的（市盈率最低的）市值排名是 rank，另外两只是大盘股 */
async function seed(market: "A" | "HK", rank: number) {
  const suffix = market === "A" ? ".SH" : ".HK";
  const code = (k: number) => (market === "A" ? `60000${k}${suffix}` : `0000${k}${suffix}`);
  const stocks: SeedStock[] = [1, 2, 3].map((k) => ({
    code: code(k),
    name: `股票${k}`,
    close: () => 10 * k,
    factors: () => ({
      pe_ttm: k * 10,
      dividend_yield_ttm: 6 - k,
      mcap_rank: k === 1 ? rank : k,
    }),
  }));
  ({ calendar } = await seedSyntheticMarket(wh, { market, start: "2026-03-02", days: 25, stocks }));
}

beforeEach(async () => {
  wh = await Warehouse.open(":memory:");
});
afterEach(() => wh.close());

const specOf = (o: Record<string, unknown>): StrategySpec =>
  StrategySpecSchema.parse({
    name: "低市盈率",
    market: "A",
    rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 1 },
    rebalance: { every: "week", buffer: 1 },
    ...o,
  });

const build = (spec: StrategySpec) =>
  buildSimInput(wh, spec, { start: calendar[1]!, end: calendar.at(-1)!, capital: 1e6, oosMonths: 0 });
const mismatchOf = async (spec: StrategySpec) =>
  (await build(spec)).input.dataCaveats!.find((c) => c.id === "bench_mismatch");

describe("基准不匹配提示", () => {
  it("沪深300 配市值排名约 1200 名的持仓 → 建议中证1000（info）", async () => {
    await seed("A", 1200);
    const c = await mismatchOf(specOf({}));
    expect(c).toEqual({
      id: "bench_mismatch",
      level: "info",
      title: "基准可能不匹配",
      detail: "持仓中位市值排名约第 1,200 名，沪深300 可能不是合适的比较基准，可试试中证1000。",
    });
  });

  it("排名约 600 名 → 建议中证500；已经选了中证1000 时不提示", async () => {
    await seed("A", 600);
    expect((await mismatchOf(specOf({})))?.detail).toMatch(/约第 600 名.*可试试中证500/);
    // 选了别的基准：不做市值比较（基准没数据会先被拒，这里给中证1000补上数据）
    await wh.run(
      `INSERT INTO index_bars (sym, date, close, provisional)
       SELECT 'csi1000_tr', date, close, provisional FROM index_bars WHERE sym = 'csi300_tr'`,
    );
    expect(await mismatchOf(specOf({ benchmark: "csi1000" }))).toBeUndefined();
  });

  it("持仓是大盘股（排名 50）→ 没有提示", async () => {
    await seed("A", 50);
    expect(await mismatchOf(specOf({}))).toBeUndefined();
  });

  it("排序主要看股息率 → 建议中证红利全收益；选了中证红利就不提示", async () => {
    await seed("A", 50);
    const div = {
      rank: {
        terms: [
          { factor: "dividend_yield_ttm", weight: 2, better: "high" },
          { factor: "pe_ttm", weight: 3, better: "low" },
        ],
        top: 1,
      },
    };
    expect(dividendWeightShare(specOf(div))).toBeCloseTo(0.4);
    expect((await mismatchOf(specOf(div)))?.detail).toBe(
      "排序主要看股息率，可以和中证红利全收益比一比。",
    );
    await wh.run(
      `INSERT INTO index_bars (sym, date, close, provisional)
       SELECT 'csi_div_tr', date, close, provisional FROM index_bars WHERE sym = 'csi300_tr'`,
    );
    expect(await mismatchOf(specOf({ ...div, benchmark: "csi_div" }))).toBeUndefined();
    // 弱势排序里的股息率也算进占比
    const regime = specOf({
      rank: {
        terms: [{ factor: "pe_ttm", weight: 1, better: "low" }],
        top: 1,
        regime: { ma: 20, weak: { terms: [{ factor: "dividend_yield_ttm", weight: 1, better: "high" }] } },
      },
    });
    expect(dividendWeightShare(regime)).toBeCloseTo(0.5);
  });

  it("港股恒指配中小盘（排名 > 300）→ 提示恒指可能不合适", async () => {
    await seed("HK", 450);
    const c = await mismatchOf(specOf({ market: "HK" }));
    expect(c?.detail).toBe("持仓多是中小盘，恒指可能不是合适的比较基准。");
  });

  it("只进检查项，不进输入指纹", async () => {
    await seed("A", 1200);
    const withCaveat = await build(specOf({}));
    const plain = { ...withCaveat.input, dataCaveats: [] };
    expect(hashSimInput(withCaveat.input).inputHash).toBe(hashSimInput(plain).inputHash);
  });

  it("超过 5000 对时均匀抽样，中位数照样算得出", async () => {
    await seed("A", 1200);
    const pairs = Array.from({ length: 12_000 }, (_, i) => [calendar[i % calendar.length]!, "600001.SH"] as const);
    expect(await selectedMedianMcapRank(wh, pairs)).toBe(1200);
    expect(await selectedMedianMcapRank(wh, [])).toBeNull();
  });
});

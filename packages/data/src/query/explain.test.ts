/**
 * 选股解释与回测同一条 SQL（D67）：候选名单的顺序与得分和 runSelectionScored 完全一致（含大盘切换日、行业上限、
 * 按代码打破平局），得分 = Σ 权重 × 分位 ÷ Σ 权重；逐条判定给出中文原因；今日选股走同一条路径。
 */
import { describeCondition, type StrategySpec, StrategySpecSchema } from "@ivan/core";
import { sha256Canonical } from "@ivan/core/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSyntheticMarket } from "../testing/seed.ts";
import { Warehouse } from "../warehouse/db.ts";
import { explainSelection, screenOn } from "./explain.ts";
import { compileSelection, runSelectionScored, specForRegime } from "./selection.ts";

let wh: Warehouse;
let calendar: string[];
const INDUSTRIES = ["银行", "医药", "电子"];
const N = 12;
const code = (k: number) => `6000${String(k + 1).padStart(2, "0")}.SH`;
/** 第 25 个交易日沪深300 跌破 20 日均线（弱势），其余强势 */
const WEAK_DAY = 25;

beforeAll(async () => {
  wh = await Warehouse.open(":memory:");
  ({ calendar } = await seedSyntheticMarket(wh, {
    market: "A",
    start: "2024-03-04",
    days: 30,
    index: {
      csi300: (i) => (i === WEAK_DAY ? 80 : 100 + i * 0.1),
      csi300_tr: (i) => 1000 + i,
    },
    stocks: Array.from({ length: N }, (_, k) => ({
      code: code(k),
      name: `股票${k + 1}`,
      industry_l1: INDUSTRIES[k % 3],
      industry: INDUSTRIES[k % 3],
      // 第 12 只在第 20 天停牌（当天没有因子行）
      close: (i: number) => (k === 11 && i === 20 ? NaN : 10 + k),
      factors: (i: number) => ({
        pe_ttm: 5 + ((k * 7 + i * 3) % 17),
        pb: 0.5 + ((k * 5 + i) % 9) / 3,
        // 第 2 只 ROE 不够；第 4 只没有 PB（排序因子缺值）
        roe_ttm: k === 1 ? 8 : 12 + (k % 5),
        ...(k === 3 ? { pb: null } : {}),
        dividend_yield_ttm: 1 + ((k * 11 + i) % 7) / 2,
        mcap: 50 + k * 10,
        flag_st: false,
        flag_new_listing: false,
      }),
    })),
  }));
});
afterAll(() => wh.close());

const ROE = { factor: "roe_ttm", op: ">=", value: 12 } as const;
const spec = (rank: Record<string, unknown> = {}): StrategySpec =>
  StrategySpecSchema.parse({
    name: "解释",
    market: "A",
    filters: [ROE],
    rank: {
      terms: [
        { factor: "pe_ttm", weight: 2, better: "low" },
        { factor: "pb", weight: 1, better: "low", neutral: true },
      ],
      top: 3,
      regime: { ma: 20, weak: { terms: [{ factor: "dividend_yield_ttm", weight: 1, better: "high" }] } },
      ...rank,
    },
  });

async function parity(s: StrategySpec, d: string, weak: boolean, limit = 6) {
  const ex = await explainSelection(wh, s, d, { limit });
  const scored = (await runSelectionScored(wh, specForRegime(s, weak), [d], limit)).get(d) ?? [];
  expect(ex.regime).toBe(weak ? "weak" : "strong");
  expect(ex.candidates.map((c) => ({ code: c.code, score: c.score }))).toEqual(scored);
  expect(ex.candidates.length).toBeGreaterThan(0);
  const terms = specForRegime(s, weak).rank!.terms;
  const totalW = terms.reduce((a, t) => a + t.weight, 0);
  for (const c of ex.candidates) {
    const sum = terms.reduce((a, t) => a + t.weight * c.termPct[t.factor]!, 0);
    expect(Math.abs(c.score - sum / totalW)).toBeLessThan(1e-12);
  }
  return ex;
}

describe("选股解释（D67）", () => {
  it("普通日：候选的顺序与得分和回测的选股完全一致，得分 = Σ 权重 × 分位 ÷ Σ 权重", async () => {
    const ex = await parity(spec(), calendar[22]!, false);
    expect(ex.candidates.map((c) => c.rank)).toEqual(ex.candidates.map((_, i) => i + 1));
    // 带出常用估值与策略用到的因子
    expect(Object.keys(ex.candidates[0]!.factors)).toEqual(
      expect.arrayContaining(["pe_ttm", "pb", "mcap", "roe_ttm", "dividend_yield_ttm", "industry"]),
    );
    expect(ex.candidates[0]!.name).toMatch(/^股票/);
  });

  it("大盘弱势日用弱势排序，仍与回测一致", async () => {
    const ex = await parity(spec(), calendar[WEAK_DAY]!, true);
    expect(Object.keys(ex.candidates[0]!.termPct)).toEqual(["dividend_yield_ttm"]);
  });

  it("同一行业最多 1 只：一致；被截掉的给出原因与得分", async () => {
    const s = spec({ maxPerIndustry: 1, regime: undefined });
    const d = calendar[22]!;
    const ex = await explainSelection(wh, s, d, { limit: 6 });
    const scored = (await runSelectionScored(wh, s, [d], 6)).get(d)!;
    expect(ex.regime).toBeNull();
    expect(ex.candidates.map((c) => ({ code: c.code, score: c.score }))).toEqual(scored);
    expect(ex.candidates).toHaveLength(3);
    // 没被选中、但通过了筛选的股票：同行业已满
    const others = Array.from({ length: N }, (_, k) => code(k)).filter(
      (c) => ![code(1), code(3), code(11)].includes(c) && !scored.some((x) => x.code === c),
    );
    const r = await explainSelection(wh, s, d, { limit: 6, codes: [others[0]!] });
    expect(r.codes[0]).toMatchObject({ hasData: true, passed: false, cappedOut: true, rank: null });
    expect(r.codes[0]!.failed).toEqual(["同行业已满 1 只"]);
    expect(r.codes[0]!.score).toBeTypeOf("number");
  });

  it("逐条判定：没满足的筛选写中文条件；排序因子缺值、当天没数据都给原因；排在 limit 之后的给出名次", async () => {
    const s = spec({ regime: undefined });
    const d = calendar[20]!;
    const all = (await runSelectionScored(wh, s, [d], 100)).get(d)!;
    const beyond = all[3]!.code;
    const ex = await explainSelection(wh, s, d, {
      limit: 2,
      codes: [code(1), code(3), code(11), beyond, all[0]!.code],
    });
    const by = new Map(ex.codes.map((c) => [c.code, c]));
    expect(by.get(code(1))!.failed).toEqual([`没满足：${describeCondition(ROE)}`]);
    expect(by.get(code(1))!.failed[0]).toBe("没满足：ROE（TTM） ≥ 12%");
    expect(by.get(code(1))!.factors.roe_ttm).toBe(8);
    expect(by.get(code(3))!.failed).toEqual(["排序因子「市净率」没有数据"]);
    expect(by.get(code(11))).toMatchObject({
      hasData: false,
      passed: false,
      failed: ["当天没有数据（停牌或未上市）"],
    });
    expect(by.get(beyond)).toMatchObject({ passed: true, rank: 4, failed: [] });
    expect(by.get(beyond)!.rank!).toBeGreaterThan(ex.limit);
    expect(by.get(beyond)!.score).toBe(all[3]!.score);
    expect(by.get(all[0]!.code)).toMatchObject({ passed: true, rank: 1, score: all[0]!.score });
  });

  it("compileSelection 的 SQL 文本不变", () => {
    const a = StrategySpecSchema.parse({
      name: "快照",
      market: "A",
      universe: {
        boards: ["main", "gem"],
        exclude: ["st", "new_listing", "loss"],
        minMcap: 50,
        industries: { include: ["银行", "O'Brien"], exclude: ["医药"] },
      },
      filters: [
        { factor: "roe_ttm", op: ">=", value: 12 },
        { factor: "pe_ttm", op: "between", value: [0, 20] },
        { factor: "flag_value_trap", op: "not" },
        { factor: "industry_l1", op: "not_in", value: ["地产"] },
      ],
      rank: {
        terms: [
          { factor: "dividend_yield_ttm", weight: 2, better: "high" },
          { factor: "pb", weight: 1, better: "low", neutral: true },
        ],
        top: 10,
        maxPerIndustry: 2,
      },
    });
    const b = StrategySpecSchema.parse({
      name: "简",
      market: "HK",
      rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 5 },
    });
    expect(compileSelection(a, ["2024-01-02", "2024-02-01"], 25)).toBe(SNAPSHOT_A);
    expect(compileSelection(b, ["2024-01-02"], 8)).toBe(SNAPSHOT_HK);
  });

  it("今日选股走同一条路径：行与候选名单一致，名单指纹两次相同", async () => {
    const d = calendar[22]!;
    const rows = await screenOn(wh, spec(), d, 5);
    const ex = await explainSelection(wh, spec(), d, { limit: 5 });
    expect(rows).toEqual(
      ex.candidates.map((c) => ({
        rank: c.rank,
        code: c.code,
        name: c.name,
        score: c.score,
        close: c.close,
        factors: c.factors,
      })),
    );
    expect(rows[0]!.close).toBeTypeOf("number");
    const again = await screenOn(wh, spec(), d, 5);
    expect(sha256Canonical(again)).toBe(sha256Canonical(rows));
  });
});

const SNAPSHOT_A = `WITH base AS (
  SELECT date, code, industry_l1, dividend_yield_ttm, pb
  FROM factors_daily
  WHERE market = 'A'
    AND board IN ('main', 'gem')
    AND coalesce(flag_st, false) = false
    AND coalesce(flag_new_listing, false) = false
    AND coalesce(flag_loss, false) = false
    AND mcap >= 50
    AND industry IN ('银行', 'O''Brien')
    AND (industry IS NULL OR industry NOT IN ('医药'))
    AND roe_ttm >= 12
    AND pe_ttm BETWEEN 0 AND 20
    AND coalesce(flag_value_trap, false) = false
    AND (industry_l1 IS NULL OR industry_l1 NOT IN ('地产'))
    AND date IN (DATE '2024-01-02',DATE '2024-02-01')
    AND dividend_yield_ttm IS NOT NULL
    AND pb IS NOT NULL
), scored AS (
  SELECT date, code, industry_l1, (2 * percent_rank() OVER (PARTITION BY date ORDER BY dividend_yield_ttm ASC) + 1 * percent_rank() OVER (PARTITION BY date, industry_l1 ORDER BY pb DESC)) / 3 AS score FROM base
), capped AS (
  SELECT * FROM scored
  QUALIFY row_number() OVER (PARTITION BY date, coalesce(industry_l1, code) ORDER BY score DESC, code) <= 2
)
SELECT date::VARCHAR AS date, code, score FROM capped
QUALIFY row_number() OVER (PARTITION BY date ORDER BY score DESC, code) <= 25
ORDER BY date, score DESC, code`;
const SNAPSHOT_HK = `WITH base AS (
  SELECT date, code, industry_l1, pe_ttm
  FROM factors_daily
  WHERE market = 'HK'
    AND coalesce(flag_st, false) = false
    AND coalesce(flag_new_listing, false) = false
    AND date IN (DATE '2024-01-02')
    AND pe_ttm IS NOT NULL
), scored AS (
  SELECT date, code, industry_l1, (1 * percent_rank() OVER (PARTITION BY date ORDER BY pe_ttm DESC)) / 1 AS score FROM base
)
SELECT date::VARCHAR AS date, code, score FROM scored
QUALIFY row_number() OVER (PARTITION BY date ORDER BY score DESC, code) <= 8
ORDER BY date, score DESC, code`;

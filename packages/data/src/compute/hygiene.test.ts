/**
 * 日线体检（D74）：R1–R3 拒收，其余只标记；公司行动日不判 R5–R7；新股前 5 个交易日不判 R5；
 * 主板 ST 限幅按规则表第 2 版（2025-07-07 起 10%）。
 */
import { describe, expect, it } from "vitest";
import { syntheticCalendar } from "../testing/seed.ts";
import type { BarRow } from "../etl/bars.ts";
import { type HygieneCtx, validateBars } from "./hygiene.ts";

const CAL = syntheticCalendar("2025-06-23", 20);
const ctxOf = (o: Partial<HygieneCtx> = {}): HygieneCtx => ({
  calendar: new Set(CAL),
  today: CAL.at(-1)!,
  board: "main",
  listDate: "2010-01-04",
  isST: () => false,
  actions: new Set(),
  ...o,
});

/** 第 i 个交易日的一根 K 线：开高低收都等于 close（可覆盖） */
function bar(
  code: string,
  i: number,
  close: number,
  o: Partial<{ open: number; high: number; low: number; volume: number; adj: number; date: string }> = {},
): BarRow {
  return [
    code,
    o.date ?? CAL[i]!,
    o.open ?? close,
    o.high ?? close,
    o.low ?? close,
    close,
    o.volume ?? 1000 + i,
    close * 1000,
    o.adj ?? 1,
    "em",
    1,
  ];
}

const rules = (r: ReturnType<typeof validateBars>) =>
  r.issues.map((x) => `${x.severity}:${x.rule}:${x.date}`);

describe("validateBars", () => {
  it("干净的数据：全部入库，没有问题", () => {
    const rows = [0, 1, 2].map((i) => bar("600000.SH", i, 10 + i * 0.1));
    const r = validateBars("600000.SH", rows, ctxOf());
    expect(r.accepted).toHaveLength(3);
    expect(r.issues).toEqual([]);
  });

  it("R1 ohlc：高价低于收盘、价格为 0 都拒收，不入库", () => {
    const rows = [
      bar("600000.SH", 0, 10),
      bar("600000.SH", 1, 10.2, { high: 10.1 }),
      bar("600000.SH", 2, 0),
      bar("600000.SH", 3, 10.1, { high: 10, low: 10.2, open: 10.1 }),
    ];
    const r = validateBars("600000.SH", rows, ctxOf());
    expect(r.accepted.map((x) => x[1])).toEqual([CAL[0]]);
    expect(rules(r)).toEqual([
      `reject:ohlc:${CAL[1]}`,
      `reject:ohlc:${CAL[2]}`,
      `reject:ohlc:${CAL[3]}`,
    ]);
  });

  it("R2 volume：成交量为负拒收；成交量 0 但收盘变了只标记", () => {
    const rows = [
      bar("600000.SH", 0, 10),
      bar("600000.SH", 1, 10.1, { volume: -5 }),
      bar("600000.SH", 2, 10.2, { volume: 0 }),
    ];
    const r = validateBars("600000.SH", rows, ctxOf());
    expect(r.accepted.map((x) => x[1])).toEqual([CAL[0], CAL[2]]);
    expect(rules(r)).toEqual([`reject:volume:${CAL[1]}`, `flag:volume:${CAL[2]}`]);
  });

  it("R3 calendar：不在交易日历里、晚于今天都拒收", () => {
    const rows = [
      bar("600000.SH", 0, 10),
      bar("600000.SH", 0, 10, { date: "2025-06-28" }), // 周六
      bar("600000.SH", 0, 10, { date: "2030-01-02" }),
    ];
    const r = validateBars("600000.SH", rows, ctxOf());
    expect(r.accepted).toHaveLength(1);
    expect(rules(r)).toEqual(["reject:calendar:2025-06-28", "reject:calendar:2030-01-02"]);
  });

  it("R4 重复日期：保留最后一条，只标记", () => {
    const rows = [bar("600000.SH", 0, 10), bar("600000.SH", 1, 10.1), bar("600000.SH", 1, 10.2)];
    const r = validateBars("600000.SH", rows, ctxOf());
    expect(r.accepted.map((x) => [x[1], x[5]])).toEqual([
      [CAL[0], 10],
      [CAL[1], 10.2],
    ]);
    expect(rules(r)).toEqual([`flag:duplicate:${CAL[1]}`]);
  });

  it("R5 limit_breach：主板涨 12% 标记；当天有公司行动不判", () => {
    const rows = [bar("600000.SH", 0, 10), bar("600000.SH", 1, 11.2)];
    expect(rules(validateBars("600000.SH", rows, ctxOf()))).toEqual([`flag:limit_breach:${CAL[1]}`]);
    // 涨 10.4% 在容差内
    expect(validateBars("600000.SH", [rows[0]!, bar("600000.SH", 1, 11.04)], ctxOf()).issues).toEqual([]);
    expect(
      validateBars("600000.SH", rows, ctxOf({ actions: new Set([CAL[1]!]) })).issues,
    ).toEqual([]);
  });

  it("R5：上市前 5 个交易日不判", () => {
    const rows = [bar("600000.SH", 0, 10), bar("600000.SH", 1, 14), bar("600000.SH", 6, 17)];
    const r = validateBars("600000.SH", rows, ctxOf({ listDate: CAL[0]! }));
    // 第 1 个交易日涨 40% 不判；第 6 个交易日涨 21% 判
    expect(rules(r)).toEqual([`flag:limit_breach:${CAL[6]}`]);
  });

  it("R5：主板 ST 2025-07-07 之前限幅 5%，之后 10%", () => {
    const i0 = CAL.indexOf("2025-07-01");
    const i1 = CAL.indexOf("2025-07-08");
    const st = ctxOf({ isST: () => true });
    const before = validateBars("600000.SH", [bar("600000.SH", i0 - 1, 10), bar("600000.SH", i0, 10.7)], st);
    expect(rules(before)).toEqual(["flag:limit_breach:2025-07-01"]);
    const after = validateBars("600000.SH", [bar("600000.SH", i1 - 1, 10), bar("600000.SH", i1, 10.7)], st);
    expect(after.issues).toEqual([]);
  });

  it("R6 adj_jump：复权因子跳变但没有公司行动才标记", () => {
    const rows = [bar("600000.SH", 0, 10), bar("600000.SH", 1, 9, { adj: 1.1 })];
    expect(rules(validateBars("600000.SH", rows, ctxOf()))).toEqual([`flag:adj_jump:${CAL[1]}`]);
    expect(validateBars("600000.SH", rows, ctxOf({ actions: new Set([CAL[1]!]) })).issues).toEqual([]);
  });

  it("R7 hk_jump：港股单日涨 60% 标记，有公司行动不判；A 股不判 R7", () => {
    const rows = [bar("00700.HK", 0, 10), bar("00700.HK", 1, 16)];
    expect(rules(validateBars("00700.HK", rows, ctxOf({ board: "hk_main" })))).toEqual([
      `flag:hk_jump:${CAL[1]}`,
    ]);
    expect(
      validateBars("00700.HK", rows, ctxOf({ board: "hk_main", actions: new Set([CAL[1]!]) })).issues,
    ).toEqual([]);
  });

  it("R8 stale_print：开高低收量与前一天完全相同（含库里的前一根）", () => {
    const rows = [bar("600000.SH", 0, 10, { volume: 500 }), bar("600000.SH", 1, 10, { volume: 500 })];
    expect(rules(validateBars("600000.SH", rows, ctxOf()))).toEqual([`flag:stale_print:${CAL[1]}`]);
    const prevRef = { close: 10, adj: 1, open: 10, high: 10, low: 10, volume: 500 };
    expect(
      rules(validateBars("600000.SH", [bar("600000.SH", 2, 10, { volume: 500 })], ctxOf({ prevRef }))),
    ).toEqual([`flag:stale_print:${CAL[2]}`]);
    // 量为 0 不算
    expect(
      validateBars("600000.SH", [bar("600000.SH", 2, 10, { volume: 0 })], ctxOf({ prevRef: { ...prevRef, volume: 0 } }))
        .issues,
    ).toEqual([]);
  });

  it("拒收的行不参与后面的比较：坏行之后的那天和坏行之前的那天比", () => {
    const rows = [bar("600000.SH", 0, 10), bar("600000.SH", 1, 100, { high: 1 }), bar("600000.SH", 2, 10.5)];
    const r = validateBars("600000.SH", rows, ctxOf());
    expect(rules(r)).toEqual([`reject:ohlc:${CAL[1]}`]);
  });
});

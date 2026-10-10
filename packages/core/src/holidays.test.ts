import { describe, expect, it } from "vitest";
import { HOLIDAYS, isHoliday, nextTradingDay } from "./holidays.ts";
import { weekday } from "./dates.ts";

describe("交易所休市日表", () => {
  it("跳过表里的休市日：A 股国庆长假前最后一个交易日 → 节后第一天", () => {
    expect(nextTradingDay("A", "2026-09-30")).toEqual({
      date: "2026-10-08",
      basis: "holiday_table",
    });
    // 中秋（周五）休市：周四之后是下周一
    expect(nextTradingDay("A", "2026-09-24")).toEqual({
      date: "2026-09-28",
      basis: "holiday_table",
    });
  });

  it("港股与 A 股各用各的表：同一天 A 股休市、港股开市", () => {
    expect(isHoliday("A", "2026-10-05")).toBe(true);
    expect(isHoliday("HK", "2026-10-05")).toBe(false);
    expect(nextTradingDay("HK", "2026-10-02")).toEqual({
      date: "2026-10-05",
      basis: "holiday_table",
    });
  });

  it("表里没有那一年：只跳过周末，依据是 weekday", () => {
    expect(HOLIDAYS.A["2030"]).toBeUndefined();
    // 2030-01-04 是周五
    expect(nextTradingDay("A", "2030-01-04")).toEqual({ date: "2030-01-07", basis: "weekday" });
    expect(nextTradingDay("A", "2030-01-01")).toEqual({ date: "2030-01-02", basis: "weekday" });
  });

  it("表里只有工作日、升序、每年都有出处", () => {
    for (const m of ["A", "HK"] as const) {
      for (const [y, row] of Object.entries(HOLIDAYS[m])) {
        expect(row.cite.length).toBeGreaterThan(4);
        expect([...row.dates].sort()).toEqual(row.dates);
        for (const d of row.dates) {
          expect(d.slice(0, 4)).toBe(y);
          expect([0, 6]).not.toContain(weekday(d));
        }
      }
    }
  });
});

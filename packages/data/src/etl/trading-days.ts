/**
 * 点时事件数据的可得日环境（D80）：按 A 股交易日历推下一个 / 前几个交易日。交易日历到哪天就用到哪天；
 * 超出日历（未来的解禁、今晚的大宗）用 S08 的休市日表；表里没有那一年（或早于日历的历史）只跳过周末，依据记成 weekday。
 */
import { addDays, type DateStr, HOLIDAYS, isHoliday, weekday } from "@ivan/core";
import type { Warehouse } from "../warehouse/db.ts";

export type AvailBasis = "calendar" | "holiday_table" | "weekday";

export interface AvailEnv {
  today: DateStr;
  /** d 之后的下一个交易日 */
  nextTd(d: DateStr): DateStr;
  /** d 之前的上一个交易日 */
  prevTd(d: DateStr): DateStr;
  /** 从 d 起往后（n > 0）或往前（n < 0）数 |n| 个交易日；basis 是一路上最弱的依据 */
  shiftTd(d: DateStr, n: number): { date: DateStr; basis: AvailBasis };
  /** 上市日（证券表里没有为 null） */
  listDate(code: string): DateStr | null;
  /** 在 A 股证券表里（ETF、基金不在，丢弃） */
  isASecurity(code: string): boolean;
  /** 交易日历里 [from, to] 的交易日（回填两融按天分块用） */
  tradingDays(from: DateStr, to: DateStr): DateStr[];
}

const RANK: Record<AvailBasis, number> = { calendar: 0, holiday_table: 1, weekday: 2 };

/** 纯函数版本（测试直接喂日历与证券） */
export function availEnvOf(
  today: DateStr,
  calendar: readonly DateStr[],
  securities: ReadonlyMap<string, DateStr | null>,
): AvailEnv {
  const cal = [...calendar].sort();
  const set = new Set(cal);
  const min = cal[0];
  const max = cal.at(-1);
  /** 这一天是不是交易日、按什么判断的 */
  const judge = (x: DateStr): { td: boolean; basis: AvailBasis } => {
    if (min && max && x >= min && x <= max) return { td: set.has(x), basis: "calendar" };
    const w = weekday(x);
    const basis: AvailBasis = HOLIDAYS.A[x.slice(0, 4)] ? "holiday_table" : "weekday";
    return { td: w !== 0 && w !== 6 && !isHoliday("A", x), basis };
  };
  const shiftTd = (d: DateStr, n: number) => {
    let x = d;
    let basis: AvailBasis = "calendar";
    const step = n >= 0 ? 1 : -1;
    for (let left = Math.abs(n); left > 0; ) {
      x = addDays(x, step);
      const j = judge(x);
      if (RANK[j.basis] > RANK[basis]) basis = j.basis;
      if (j.td) left--;
    }
    return { date: x, basis };
  };
  const between = (from: DateStr, to: DateStr) => cal.filter((d) => d >= from && d <= to);
  return {
    today,
    nextTd: (d) => shiftTd(d, 1).date,
    prevTd: (d) => shiftTd(d, -1).date,
    shiftTd,
    listDate: (code) => securities.get(code) ?? null,
    isASecurity: (code) => securities.has(code),
    tradingDays: between,
  };
}

export async function buildAvailEnv(wh: Warehouse, today: DateStr): Promise<AvailEnv> {
  const cal = await wh.all<{ d: string }>(
    `SELECT DISTINCT date::VARCHAR AS d FROM trade_calendar WHERE market = 'A' ORDER BY d`,
  );
  const secs = await wh.all<{ code: string; l: string | null }>(
    `SELECT code, list_date::VARCHAR AS l FROM securities WHERE market = 'A'`,
  );
  return availEnvOf(
    today,
    cal.map((r) => r.d),
    new Map(secs.map((s) => [s.code, s.l ?? null])),
  );
}

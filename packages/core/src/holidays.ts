/**
 * 交易所休市日表（D68 计划日）：A 股与港股当年和下一年落在工作日的休市日，每年一行出处。
 *
 * 只用来推算「下一个交易日」（跟踪补的计划日、快照的 plan_date）：回测与过去的重放都只用行情仓里的真实交易日历。
 * 表里没有那一年时退回「下一个工作日」，并标明依据（weekday），界面写「按工作日推算，遇节假日顺延」。
 *
 * 维护：每年 12 月按交易所公告补下一年（实施清单「每年 12 月」）；录入后人工对照公告原文核对。
 * 周末本来就不开市，表里只列工作日；A 股调休的周末上班日交易所也不开市，不用列。
 */
import { addDays, type DateStr, weekday } from "./dates.ts";
import type { Market } from "./market.ts";

export interface HolidayYear {
  /** 落在工作日的休市日（升序） */
  dates: DateStr[];
  /** 公告名（人工核对的依据） */
  cite: string;
}

export const HOLIDAYS: Record<Market, Record<string, HolidayYear>> = {
  A: {
    // 待核对公告原文（R2 人工清单）
    "2026": {
      dates: [
        "2026-01-01",
        "2026-01-02",
        "2026-02-16",
        "2026-02-17",
        "2026-02-18",
        "2026-02-19",
        "2026-02-20",
        "2026-02-23",
        "2026-04-06",
        "2026-05-01",
        "2026-05-04",
        "2026-05-05",
        "2026-06-19",
        "2026-09-25",
        "2026-10-01",
        "2026-10-02",
        "2026-10-05",
        "2026-10-06",
        "2026-10-07",
      ],
      cite: "上交所、深交所《关于 2026 年部分节假日休市安排的通知》（依据国务院办公厅 2026 年部分节假日安排）",
    },
    // 2027 年：国务院办公厅的节假日安排通常 11 月前后才发布，发布后按交易所通知补录
  },
  HK: {
    // 待核对公告原文（R2 人工清单）；平安夜、除夕前一天等半日市照常开市，不算休市
    "2026": {
      dates: [
        "2026-01-01",
        "2026-02-17",
        "2026-02-18",
        "2026-02-19",
        "2026-04-03",
        "2026-04-06",
        "2026-04-07",
        "2026-05-01",
        "2026-05-25",
        "2026-06-19",
        "2026-07-01",
        "2026-10-01",
        "2026-10-19",
        "2026-12-25",
      ],
      cite: "香港交易所《2026 年证券及衍生产品市场交易日历》（依据香港特区政府 2026 年公众假期）",
    },
    // 2027 年：港交所发布下一年交易日历后补录
  },
};

export type TradingDayBasis = "holiday_table" | "weekday";

/** 那一天按休市日表是不是休市（表里没有那一年时只看周末） */
export function isHoliday(market: Market, d: DateStr): boolean {
  return HOLIDAYS[market][d.slice(0, 4)]?.dates.includes(d) ?? false;
}

/**
 * d 之后的下一个交易日：跳过周末与表里的休市日。日期所在的年份在表里时依据是 holiday_table，
 * 否则只跳过周末、依据是 weekday（遇节假日要顺延，界面要说明）。
 */
export function nextTradingDay(
  market: Market,
  d: DateStr,
): { date: DateStr; basis: TradingDayBasis } {
  let x = addDays(d, 1);
  for (;;) {
    const w = weekday(x);
    if (w !== 0 && w !== 6 && !isHoliday(market, x)) break;
    x = addDays(x, 1);
  }
  return { date: x, basis: HOLIDAYS[market][x.slice(0, 4)] ? "holiday_table" : "weekday" };
}

/**
 * 事件数据的可得日规则（D80、验收 18）：两融、大宗 T+1（周末、节假日、超出交易日历按休市日表）；户数按公告日、绝不用截至日；
 * 解禁 ipo_terms / notice_bound / notice_bound:weekday / first_seen；大宗同日同金额的序号稳定。
 */
import { LOCKUP_NOTICE_LEAD_TD } from "@ivan/core";
import { describe, expect, it } from "vitest";
import type { BlockRow, HolderRow, LockupRow, MarginRow } from "../sources/types.ts";
import {
  BLOCKS,
  HOLDERS,
  LOCKUPS,
  lockupRuleDate,
  MARGIN,
  monthChunks,
  sequenceBlocks,
  yearChunks,
} from "./datasets.ts";
import { availEnvOf } from "./trading-days.ts";

/** 2026-09-14 ~ 到 end 的 A 股交易日（去掉周末与 2026 年的休市日） */
function calendar(end: string): string[] {
  const holidays = new Set(["2026-09-25", "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"]);
  const out: string[] = [];
  for (let t = Date.parse("2026-09-14"); ; t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (d > end) break;
    const w = new Date(t).getUTCDay();
    if (w !== 0 && w !== 6 && !holidays.has(d)) out.push(d);
  }
  return out;
}

const securities = new Map<string, string | null>([
  ["600519.SH", "2001-08-27"],
  ["300005.SZ", "2009-10-30"],
  ["301358.SZ", "2022-09-01"],
  ["001366.SZ", "2022-03-01"],
  ["002999.SZ", null],
]);
const env = availEnvOf("2026-10-09", calendar("2026-10-09"), securities);

const margin = (date: string): MarginRow => ({
  code: "600519.SH",
  date,
  rzye: 1,
  rzmre: null,
  rzche: null,
  rqye: null,
  rqyl: null,
  floatMcap: null,
  rzyezb: null,
});

describe("两融可得日 = 下一个交易日", () => {
  it("周末顺延到周一、节假日顺延到节后", () => {
    expect(MARGIN.avail(margin("2026-09-18"), env)).toEqual({ date: "2026-09-21", rule: "td+1" });
    // 9-25 休市
    expect(MARGIN.avail(margin("2026-09-24"), env).date).toBe("2026-09-28");
    // 国庆
    expect(MARGIN.avail(margin("2026-09-30"), env).date).toBe("2026-10-08");
  });

  it("超出交易日历按休市日表推（日历只到 9-30 时，国庆后第一个交易日仍是 10-08）", () => {
    const short = availEnvOf("2026-09-30", calendar("2026-09-30"), securities);
    expect(MARGIN.avail(margin("2026-09-30"), short).date).toBe("2026-10-08");
    expect(short.shiftTd("2026-09-30", 1)).toEqual({ date: "2026-10-08", basis: "holiday_table" });
    expect(MARGIN.avail(margin("2026-10-09"), env).date).toBe("2026-10-12");
  });

  it("夜间取前两个交易日；回填按日历每天一块", () => {
    expect(MARGIN.nightly(env).map((c) => c.id)).toEqual(["2026-09-30", "2026-10-08"]);
    expect(MARGIN.backfill(env, "2026-09-28").map((c) => c.id)).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-08",
    ]);
  });
});

describe("股东户数可得日 = 公告日", () => {
  const row: HolderRow = {
    code: "000603.SZ",
    endDate: "2026-06-30",
    noticeDate: "2026-08-01",
    holderNum: 66961,
    preHolderNum: 74197,
    preEndDate: "2026-05-29",
  };
  it("截至 6 月 30 日、8 月 1 日公告：可得日 8 月 1 日，绝不是截至日", () => {
    expect(HOLDERS.avail(row, env)).toEqual({ date: "2026-08-01", rule: "notice" });
    expect(HOLDERS.avail(row, env).date).not.toBe(row.endDate);
    expect(HOLDERS.dateOf(row)).toBe("2026-08-01");
  });
  it("夜间公告日近 14 天，周检近 120 天", () => {
    expect(HOLDERS.nightly(env)).toEqual([{ id: "2026-09-25~2026-10-09", from: "2026-09-25", to: "2026-10-09" }]);
    expect(HOLDERS.check(env)[0]!.from).toBe("2026-06-11");
  });
});

describe("限售解禁可得日", () => {
  const lock = (o: Partial<LockupRow>): LockupRow => ({
    code: "301358.SZ",
    freeDate: "2026-09-30",
    type: "定向增发机构配售股份",
    unlockShares: 1,
    ableShares: 1,
    floatAfter: 2,
    ratioFloat: 1,
    ratioTotal: 0.5,
    ...o,
  });

  it("首发且上市日 ≤ 解禁日：上市日（ipo_terms）", () => {
    const r = lock({ code: "300005.SZ", freeDate: "2013-01-04", type: "首发原股东限售股份" });
    expect(LOCKUPS.avail(r, env, { first_seen: "2026-10-09", gone_from: null })).toEqual({
      date: "2009-10-30",
      rule: "ipo_terms",
    });
  });

  it("其他类型：解禁日前 LOCKUP_NOTICE_LEAD_TD 个交易日（跳过休市日，notice_bound）", () => {
    expect(LOCKUP_NOTICE_LEAD_TD).toBe(3);
    // 9-30 往前 3 个交易日：9-29、9-28、9-24（9-25 休市）
    expect(LOCKUPS.avail(lock({}), env, { first_seen: "2026-10-09", gone_from: null })).toEqual({
      date: "2026-09-24",
      rule: "notice_bound",
    });
    // 首发但证券表里没有上市日：也按 notice_bound
    expect(lockupRuleDate(lock({ code: "002999.SZ", type: "首发原股东限售股份" }), env).rule).toBe("notice_bound");
  });

  it("超出日历且那一年没有休市日表：按工作日数，规则 notice_bound:weekday", () => {
    expect(lockupRuleDate(lock({ freeDate: "2027-03-03" }), env)).toEqual({
      date: "2027-02-26",
      rule: "notice_bound:weekday",
    });
    // 2026 年有休市日表：notice_bound
    expect(lockupRuleDate(lock({ freeDate: "2026-10-15" }), env)).toEqual({
      date: "2026-10-12",
      rule: "notice_bound",
    });
  });

  it("首次见到早于规则日：以首次见到为准（first_seen）；以后重取仍按库里的首次见到", () => {
    // 今天第一次见到明年的解禁
    expect(LOCKUPS.avail(lock({ freeDate: "2027-03-03" }), env)).toEqual({ date: "2026-10-09", rule: "first_seen" });
    // 一个月后再取：首次见到的日子不变
    const later = availEnvOf("2026-11-09", calendar("2026-10-09"), securities);
    expect(
      LOCKUPS.avail(lock({ freeDate: "2027-03-03" }), later, { first_seen: "2026-10-09", gone_from: null }),
    ).toEqual({ date: "2026-10-09", rule: "first_seen" });
    const row = LOCKUPS.toRow(
      lock({ freeDate: "2027-03-03" }),
      { date: "2026-10-09", rule: "first_seen" },
      { src: "em", ver: null, batch: 7, today: "2026-11-09" },
      { first_seen: "2026-10-09", gone_from: null },
    );
    expect(row.slice(10, 13)).toEqual(["2026-10-09", "2026-11-09", null]);
  });

  it("夜间 [今天 − 7, 今天 + 180]，周检 [−30, +365]，回填按整年到明年", () => {
    expect(LOCKUPS.nightly(env)[0]).toMatchObject({ from: "2026-10-02", to: "2027-04-07" });
    expect(LOCKUPS.check(env)[0]).toMatchObject({ from: "2026-09-09", to: "2027-10-09" });
    expect(LOCKUPS.backfill(env, "2024-06-01").map((c) => [c.id, c.from, c.to])).toEqual([
      ["2024", "2024-01-01", "2024-12-31"],
      ["2025", "2025-01-01", "2025-12-31"],
      ["2026", "2026-01-01", "2026-12-31"],
      ["2027", "2027-01-01", "2027-12-31"],
    ]);
  });
});

describe("大宗交易", () => {
  const trade = (o: Partial<BlockRow>): BlockRow => ({
    code: "001366.SZ",
    tradeDate: "2026-09-29",
    dealPrice: 11.84,
    closePrice: 13.13,
    premium: 11.84 / 13.13 - 1,
    dealVolume: 500000,
    dealAmount: 5920000,
    buyerInst: true,
    sellerInst: false,
    ...o,
  });

  it("可得日 T+1", () => {
    expect(BLOCKS.avail({ ...trade({}), seq: 1 }, env)).toEqual({ date: "2026-09-30", rule: "td+1" });
    expect(BLOCKS.avail({ ...trade({ tradeDate: "2026-09-30" }), seq: 1 }, env).date).toBe("2026-10-08");
  });

  it("同一天同金额的几笔：序号按成交额降序、价、量、机构标记排，和输入顺序无关", () => {
    const a = trade({});
    const b = trade({ sellerInst: true });
    const c = trade({ dealAmount: 9_000_000, dealVolume: 760000 });
    const d = trade({ code: "001309.SZ", premium: 0, dealPrice: 88.52, closePrice: 88.52 });
    const stamp = { src: "em", ver: 3, batch: 1, today: "2026-10-09" };
    const rows = (xs: BlockRow[]) =>
      sequenceBlocks(xs).map((r) => BLOCKS.toRow(r, BLOCKS.avail(r, env), stamp));
    const one = rows([a, b, c, d]);
    expect(rows([d, b, c, a])).toEqual(one);
    expect(rows([b, a, d, c])).toEqual(one);
    expect(sequenceBlocks([a, b, c, d]).map((r) => [r.code, r.seq, r.dealAmount, r.sellerInst])).toEqual([
      ["001309.SZ", 1, 5920000, false],
      ["001366.SZ", 1, 9000000, false],
      ["001366.SZ", 2, 5920000, false],
      ["001366.SZ", 3, 5920000, true],
    ]);
  });

  it("夜间成交日近 7 天，周检近 30 天，回填按月", () => {
    expect(BLOCKS.nightly(env)[0]).toMatchObject({ from: "2026-10-02", to: "2026-10-09" });
    expect(BLOCKS.check(env)[0]).toMatchObject({ from: "2026-09-09", to: "2026-10-09" });
    expect(monthChunks("2026-08-15", "2026-10-09")).toEqual([
      { id: "2026-08", from: "2026-08-15", to: "2026-08-31" },
      { id: "2026-09", from: "2026-09-01", to: "2026-09-30" },
      { id: "2026-10", from: "2026-10-01", to: "2026-10-09" },
    ]);
    expect(yearChunks(2013, 2014).map((c) => c.id)).toEqual(["2013", "2014"]);
  });
});

describe("回填的块总是整月、整年", () => {
  const ranges = (cs: { id: string; from: string; to: string }[]) => cs.map((c) => [c.id, c.from, c.to]);

  it("起点往前取到月初；带 to 往后取到月末，但不过今天；含今天的那块截到今天", () => {
    expect(ranges(BLOCKS.backfill(env, "2026-08-15"))).toEqual([
      ["2026-08", "2026-08-01", "2026-08-31"],
      ["2026-09", "2026-09-01", "2026-09-30"],
      ["2026-10", "2026-10-01", "2026-10-09"],
    ]);
    expect(ranges(HOLDERS.backfill(env, "2026-08-15", "2026-09-10"))).toEqual([
      ["2026-08", "2026-08-01", "2026-08-31"],
      ["2026-09", "2026-09-01", "2026-09-30"],
    ]);
    expect(ranges(BLOCKS.backfill(env, "2026-09-20", "2026-12-31"))).toEqual([
      ["2026-09", "2026-09-01", "2026-09-30"],
      ["2026-10", "2026-10-01", "2026-10-09"],
    ]);
  });

  it("换起点、终点再回填，同一个块 id 总是同一段（否则做过的半块会被当成整块跳过，缺的那段再也补不上）", () => {
    const calls: [string, string?][] = [["2026-09-01"], ["2026-05-06"], ["2024-06-01", "2026-09-10"], ["2026-09-15", "2026-09-20"]];
    for (const spec of [HOLDERS, LOCKUPS, BLOCKS]) {
      const seen = new Map<string, string>();
      for (const [from, to] of calls) {
        for (const c of spec.backfill(env, from, to)) {
          const range = `${c.from}~${c.to}`;
          expect(seen.get(c.id) ?? range, `${spec.id} ${c.id}`).toBe(range);
          seen.set(c.id, range);
        }
      }
    }
  });
});

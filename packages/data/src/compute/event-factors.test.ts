/**
 * 事件因子 SQL（S15b，D84）：点时（T+1、按公告日、可得日 ≤ d、撤下的在撤下前仍算）、
 * 户数状态时间线、「没有」与「不知道」分开、过期即空、港股行不动、列别名 = EVENT_FACTOR_KEYS。
 */
import { type DateStr, EVENT_FACTOR_KEYS } from "@ivan/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { conditionSql } from "../query/selection.ts";
import { syntheticCalendar } from "../testing/seed.ts";
import { Warehouse } from "../warehouse/db.ts";
import {
  eventFactorAliases,
  type EventSyncState,
  fillEventColumns,
  loadEventSyncState,
} from "./event-factors.ts";

const CAL = syntheticCalendar("2026-01-01", 261);
const idx = (d: DateStr) => {
  const i = CAL.indexOf(d);
  if (i < 0) throw new Error(`${d} 不是交易日`);
  return i;
};
const FULL: EventSyncState = {
  margin: { from: "2026-01-01", windowThrough: "2026-12-31" },
  holders: { from: "2025-01-01", syncedAt: "2026-12-31" },
  lockups: { from: "2026-01-01", syncedAt: "2026-12-31" },
  blocks: { from: "2026-01-01", windowThrough: "2026-12-31" },
};
const CODES = ["600001.SH", "600002.SH", "600003.SH", "600010.SH", "600011.SH", "600012.SH", "600013.SH"];
/** 两融：A 全部日子都有；B 缺 2026-03-16 那条 */
const A = "600001.SH";
const B = "600002.SH";
/** 没有任何事件记录 */
const C = "600003.SH";
const H = "600010.SH";
const H2 = "600011.SH";
const H3 = "600012.SH";
/** 同一季末有两次公告（更正）：取当时可见的最新一次 */
const H4 = "600013.SH";
const HK = "00700.HK";
const rzye = (i: number) => 1e8 * (100 + i);
const FM = 1e11;

let wh: Warehouse;

async function insert(table: string, cols: string, rows: string[]) {
  for (let i = 0; i < rows.length; i += 500) {
    await wh.run(`INSERT INTO ${table} (${cols}) VALUES ${rows.slice(i, i + 500).join(",")}`);
  }
}

async function fill(s: EventSyncState = FULL, from = CAL[0]!, to = CAL.at(-1)!) {
  return fillEventColumns(wh, "factors_daily", s, from, to);
}

async function get(code: string, date: DateStr): Promise<Record<string, unknown>> {
  const r = await wh.one<Record<string, unknown>>(
    `SELECT ${EVENT_FACTOR_KEYS.join(", ")}, pe_ttm FROM factors_daily WHERE code = $c AND date = $d::DATE`,
    { c: code, d: date },
  );
  if (!r) throw new Error(`没有 ${code} ${date}`);
  return r;
}

beforeAll(async () => {
  wh = await Warehouse.open(":memory:");
  await insert("trade_calendar", "market, date", CAL.map((d) => `('A', DATE '${d}')`));
  const rows: string[] = [];
  for (const d of CAL) {
    for (const c of CODES) rows.push(`('${c}', DATE '${d}', 'A', 10, 5)`);
    rows.push(`('${HK}', DATE '${d}', 'HK', 300, 5)`);
  }
  await insert("factors_daily", "code, date, market, close, pe_ttm", rows);
  // 两融：数据日 T，可得日 T+1
  const m: string[] = [];
  for (let i = 0; i < CAL.length - 1; i++) {
    const d = CAL[i]!;
    const avail = CAL[i + 1]!;
    m.push(`('${A}', DATE '${d}', DATE '${avail}', ${rzye(i)}, ${FM}, 'em', NULL, 1)`);
    if (d !== "2026-03-16") m.push(`('${B}', DATE '${d}', DATE '${avail}', ${rzye(i)}, ${FM}, 'em', NULL, 1)`);
  }
  await insert("margin_daily", "code, date, avail_date, rzye, float_mcap, src, ver, batch", m);
  const holder = (code: string, end: string, notice: string, n: number, gone: string | null = null) =>
    `('${code}', DATE '${end}', DATE '${notice}', DATE '${notice}', ${n}, DATE '${notice}', DATE '${notice}', ${gone ? `DATE '${gone}'` : "NULL"}, 'em', NULL, 1)`;
  await insert(
    "holder_counts",
    "code, end_date, notice_date, avail_date, holder_num, first_seen, last_seen, gone_from, src, ver, batch",
    [
      holder(H, "2025-06-30", "2025-08-10", 800),
      holder(H, "2025-09-30", "2025-10-20", 900),
      // 一季报先于年报公告
      holder(H, "2026-03-31", "2026-04-25", 1100),
      holder(H, "2025-12-31", "2026-04-29", 1000),
      // 不是季末：不参与环比
      holder(H, "2026-05-29", "2026-06-05", 5000),
      holder(H, "2026-06-30", "2026-08-01", 1320),
      holder(H2, "2025-09-30", "2025-10-20", 900),
      holder(H2, "2025-12-31", "2026-01-10", 990),
      holder(H3, "2025-06-30", "2025-08-10", 800),
      holder(H3, "2025-09-30", "2025-10-20", 900),
      holder(H3, "2025-12-31", "2026-01-15", 1000, "2026-03-02"),
      holder(H4, "2025-09-30", "2025-10-20", 900),
      holder(H4, "2025-12-31", "2026-01-15", 990),
      holder(H4, "2025-12-31", "2026-02-10", 1080),
    ],
  );
  const lockup = (code: string, free: string, type: string, ratio: number, avail: string, rule: string, gone: string | null = null) =>
    `('${code}', DATE '${free}', '${type}', ${ratio}, DATE '${avail}', '${rule}', DATE '${avail}', DATE '${avail}', ${gone ? `DATE '${gone}'` : "NULL"}, 'em', NULL, 1)`;
  await insert(
    "lockups",
    "code, free_date, type, ratio_float, avail_date, avail_rule, first_seen, last_seen, gone_from, src, ver, batch",
    [
      lockup(A, "2026-06-15", "首发原股东限售股份", 0.05, "2026-01-05", "ipo_terms"),
      lockup(A, "2026-09-10", "定向增发机构配售股份", 0.02, "2026-09-07", "notice_bound"),
      lockup(A, "2026-11-20", "股权激励限售股份", 0.1, "2026-03-02", "notice_bound", "2026-10-01"),
      // C：12-10 有比例，12-15 缺比例（最新的解禁常缺 FREE_RATIO）
      lockup(C, "2026-12-10", "定向增发机构配售股份", 0.03, "2026-11-02", "notice_bound"),
      `('${C}', DATE '2026-12-15', '首发原股东限售股份', NULL, DATE '2026-11-02', 'ipo_terms', DATE '2026-11-02', DATE '2026-11-02', NULL, 'em', NULL, 1)`,
    ],
  );
  const block = (code: string, d: string, seq: number, avail: string, prem: number, amt: number) =>
    `('${code}', DATE '${d}', ${seq}, DATE '${avail}', ${prem}, ${amt}, 'em', NULL, 1)`;
  await insert("block_trades", "code, trade_date, seq, avail_date, premium, deal_amount, src, ver, batch", [
    block(B, "2026-03-02", 1, "2026-03-03", -0.1, 100),
    block(B, "2026-03-02", 2, "2026-03-03", 0.02, 300),
    // 可得日落在周六（交易日历外）：从下一个交易日起算进窗口
    block(H, "2026-04-03", 1, "2026-04-04", 0.05, 100),
  ]);
  await fill();
});
afterAll(() => wh.close());

describe("列别名", () => {
  it("SQL 的列别名由 EVENT_FACTOR_KEYS 生成，二者一致", () => {
    expect(eventFactorAliases(FULL)).toEqual([...EVENT_FACTOR_KEYS]);
  });
});

describe("两融（T+1，正好 20 个交易日，过期即空）", () => {
  it("决策日用的是前一个交易日的两融：T 日的数据 T+1 才进因子", async () => {
    const d = "2026-03-03";
    const i = idx(d);
    const r = await get(A, d);
    expect(r.margin_ratio).toBeCloseTo((rzye(i - 1) / FM) * 100, 10);
    expect(r.margin_eligible).toBe(true);
    expect(r.margin_chg_20d).toBeCloseTo((rzye(i - 1) / rzye(i - 21) - 1) * 100, 10);
    // 覆盖起点后 7 天之前：不知道
    const early = await get(A, "2026-01-07");
    expect(early.margin_ratio).toBeNull();
    expect(early.margin_eligible).toBeNull();
    // 不是两融标的：否（数据可用时），比率为空
    const c = await get(C, d);
    expect(c.margin_eligible).toBe(false);
    expect(c.margin_ratio).toBeNull();
    expect(c.margin_chg_20d).toBeNull();
  });

  it("20 日变化要求编号正好差 20：中间缺一条的那段为空，跨过之后恢复", async () => {
    const k = idx("2026-03-16");
    // 最近一条是 k+1（决策日 k+2）：往前 20 条跨过了缺口，正好 20 个交易日前那条不在 lag 20 上
    expect((await get(B, CAL[k + 2]!)).margin_chg_20d).toBeNull();
    expect((await get(B, CAL[k + 2]!)).margin_ratio).not.toBeNull();
    // 最近一条早于缺口（决策日 k）：照常
    expect((await get(B, CAL[k]!)).margin_chg_20d).toBeCloseTo(
      (rzye(k - 1) / rzye(k - 21) - 1) * 100,
      10,
    );
    // 缺口滑出 20 个交易日之后恢复
    const j = k + 22;
    expect((await get(B, CAL[j]!)).margin_chg_20d).toBeCloseTo((rzye(j - 1) / rzye(j - 21) - 1) * 100, 10);
  });

  it("两融数据窗口落后 5 个交易日以上：三个两融因子都为空（不知道），之前的日子不受影响", async () => {
    const wt = "2026-06-01";
    const w = idx(wt);
    await fill({ ...FULL, margin: { from: FULL.margin.from, windowThrough: wt } });
    const ok = await get(A, CAL[w + 5]!);
    expect(ok.margin_ratio).not.toBeNull();
    expect(ok.margin_eligible).toBe(true);
    for (const code of [A, C]) {
      const r = await get(code, CAL[w + 6]!);
      expect([r.margin_ratio, r.margin_chg_20d, r.margin_eligible]).toEqual([null, null, null]);
    }
    expect((await get(A, CAL[w - 30]!)).margin_ratio).not.toBeNull();
    await fill();
  });

  it("选股「不是两融标的」：两融数据过期那天谁都不选（不知道不当成「否」），数据新鲜时只选非标的", async () => {
    const pick = async (d: DateStr, op: "is" | "not") =>
      (
        await wh.all<{ code: string }>(
          `SELECT code FROM factors_daily WHERE market = 'A' AND date = $d::DATE
           AND ${conditionSql({ factor: "margin_eligible", op })} ORDER BY code`,
          { d },
        )
      ).map((r) => r.code);
    const wt = "2026-06-01";
    const stale = CAL[idx(wt) + 6]!;
    expect(await pick(stale, "not")).toContain(C);
    expect(await pick(stale, "not")).not.toContain(A);
    await fill({ ...FULL, margin: { from: FULL.margin.from, windowThrough: wt } });
    expect(await pick(stale, "not")).toEqual([]);
    expect(await pick(stale, "is")).toEqual([]);
    expect(await pick("2026-01-07", "not")).toEqual([]);
    await fill();
  });

  it("最近一条两融早于 5 个交易日：比率为空、两融标的为否", async () => {
    // 单独给 C 造一条两融记录，看它多久之后算过期
    await wh.run(`DELETE FROM margin_daily WHERE code = '${C}'`);
    const k = idx("2026-07-01");
    await insert("margin_daily", "code, date, avail_date, rzye, float_mcap, src, ver, batch", [
      `('${C}', DATE '${CAL[k]}', DATE '${CAL[k + 1]}', 1e9, ${FM}, 'em', NULL, 1)`,
    ]);
    await fill();
    // 数据日 k 的那条：决策日 k+1 起可得，到 k+5（相隔 5 个交易日）为止
    expect((await get(C, CAL[k + 5]!)).margin_eligible).toBe(true);
    const r = await get(C, CAL[k + 6]!);
    expect(r.margin_eligible).toBe(false);
    expect(r.margin_ratio).toBeNull();
    await wh.run(`DELETE FROM margin_daily WHERE code = '${C}'`);
    await fill();
  });
});

describe("股东户数环比（状态时间线，按公告日）", () => {
  it("截至 6-30、8-1 公告：7-31 用的仍是上一期（一季报对年报），8-3 才用二季报对一季报", async () => {
    expect((await get(H, "2026-07-31")).holder_num_qoq).toBeCloseTo(10, 10);
    expect((await get(H, "2026-08-03")).holder_num_qoq).toBeCloseTo(20, 10);
  });

  it("年报 4-29 公告、一季报 4-25 公告：4-27 年报还看不到为空，4-30 用一季报对年报（不倒退回年报对三季报）", async () => {
    expect((await get(H, "2026-04-24")).holder_num_qoq).toBeCloseTo(12.5, 10);
    expect((await get(H, "2026-04-27")).holder_num_qoq).toBeNull();
    expect((await get(H, "2026-04-30")).holder_num_qoq).toBeCloseTo(10, 10);
  });

  it("不是季末的截至日不参与", async () => {
    expect((await get(H, "2026-06-10")).holder_num_qoq).toBeCloseTo(10, 10);
  });

  it("公告超过 200 天为空（第 200 天还有）", async () => {
    expect((await get(H2, "2026-07-29")).holder_num_qoq).toBeCloseTo(10, 10);
    expect((await get(H2, "2026-07-30")).holder_num_qoq).toBeNull();
  });

  it("最新一季撤下（gone_from）：撤下之前照常用它，撤下当天起回到上一季", async () => {
    expect((await get(H3, "2026-02-27")).holder_num_qoq).toBeCloseTo((1000 / 900 - 1) * 100, 10);
    expect((await get(H3, "2026-03-02")).holder_num_qoq).toBeCloseTo(12.5, 10);
  });

  it("同一季末有更正公告：更正可得之前用原公告，之后用更正（与事件卡片、证据同一规则）", async () => {
    expect((await get(H4, "2026-02-09")).holder_num_qoq).toBeCloseTo(10, 10);
    expect((await get(H4, "2026-02-10")).holder_num_qoq).toBeCloseTo(20, 10);
  });

  it("户数同步落后 30 天以上为空", async () => {
    await fill({ ...FULL, holders: { from: FULL.holders.from, syncedAt: "2026-05-01" } });
    expect((await get(H, "2026-05-29")).holder_num_qoq).toBeCloseTo(10, 10);
    expect((await get(H, "2026-06-01")).holder_num_qoq).toBeNull();
    await fill();
  });
});

describe("限售解禁（可得日 ≤ d，撤下的在撤下前仍算已知；没有为 181 / 0，不知道为空）", () => {
  it("已知的下一次解禁与 30 天内比例", async () => {
    const r = await get(A, "2026-05-20");
    expect(r.unlock_days).toBe(26);
    expect(r.unlock_ratio_30d).toBeCloseTo(5, 10);
    // 31 天前：在 180 天内、不在 30 天内
    const e = await get(A, "2026-05-15");
    expect(e.unlock_days).toBe(31);
    expect(e.unlock_ratio_30d).toBe(0);
  });

  it("按提示性公告推算的可得日之前看不到，之后才算", async () => {
    // 9-4：9-10 那次还不可得；11-20 那次已可得（3-2 起），67 天后
    const before = await get(A, "2026-09-04");
    expect(before.unlock_days).toBe(77);
    expect(before.unlock_ratio_30d).toBe(0);
    const after = await get(A, "2026-09-07");
    expect(after.unlock_days).toBe(3);
    expect(after.unlock_ratio_30d).toBeCloseTo(2, 10);
  });

  it("撤下的解禁：撤下前一天仍算已知，撤下当天起不算", async () => {
    expect((await get(A, "2026-09-30")).unlock_days).toBe(51);
    const r = await get(A, "2026-10-01");
    expect(r.unlock_days).toBe(181);
    expect(r.unlock_ratio_30d).toBe(0);
  });

  it("数据可用而没有已知解禁：181 与 0（unlock_days > 90 不会把它们排除）", async () => {
    const r = await get(C, "2026-05-20");
    expect(r.unlock_days).toBe(181);
    expect(r.unlock_ratio_30d).toBe(0);
  });

  it("30 天内有已知解禁但缺比例：比例为空（不知道），不当成 0；距下次解禁照常", async () => {
    // 11-12：12-10（有比例）在 30 天内，12-15（缺比例）不在
    const a = await get(C, "2026-11-12");
    expect(a.unlock_days).toBe(28);
    expect(a.unlock_ratio_30d).toBeCloseTo(3, 10);
    // 11-20：两条都在 30 天内，其中一条缺比例
    const b = await get(C, "2026-11-20");
    expect(b.unlock_days).toBe(20);
    expect(b.unlock_ratio_30d).toBeNull();
    // 12-11：只剩缺比例的那条
    const c = await get(C, "2026-12-11");
    expect(c.unlock_days).toBe(4);
    expect(c.unlock_ratio_30d).toBeNull();
  });

  it("解禁同步落后 3 天以上为空", async () => {
    await fill({ ...FULL, lockups: { from: FULL.lockups.from, syncedAt: "2026-05-15" } });
    expect((await get(C, "2026-05-18")).unlock_days).toBe(181);
    const r = await get(C, "2026-05-19");
    expect([r.unlock_days, r.unlock_ratio_30d]).toEqual([null, null]);
    await fill();
  });
});

describe("大宗交易折溢价（T+1，近 20 个交易日按成交额加权）", () => {
  it("成交日当天看不到，T+1 起按成交额加权，20 个交易日后滑出", async () => {
    expect((await get(B, "2026-03-02")).block_premium_20d).toBeNull();
    const i = idx("2026-03-03");
    expect((await get(B, CAL[i]!)).block_premium_20d).toBeCloseTo(-1, 10);
    expect((await get(B, CAL[i + 19]!)).block_premium_20d).toBeCloseTo(-1, 10);
    expect((await get(B, CAL[i + 20]!)).block_premium_20d).toBeNull();
    expect((await get(C, CAL[i]!)).block_premium_20d).toBeNull();
  });

  it("可得日落在非交易日：按日期范围算进下一个交易日起的 20 个交易日", async () => {
    expect((await get(H, "2026-04-03")).block_premium_20d).toBeNull();
    const i = idx("2026-04-06");
    expect((await get(H, CAL[i]!)).block_premium_20d).toBeCloseTo(5, 10);
    expect((await get(H, CAL[i + 19]!)).block_premium_20d).toBeCloseTo(5, 10);
    expect((await get(H, CAL[i + 20]!)).block_premium_20d).toBeNull();
  });

  it("大宗窗口没到决策日的前一个交易日为空", async () => {
    const i = idx("2026-03-03");
    await fill({ ...FULL, blocks: { from: FULL.blocks.from, windowThrough: CAL[i - 1]! } });
    expect((await get(B, CAL[i]!)).block_premium_20d).toBeCloseTo(-1, 10);
    expect((await get(B, CAL[i + 1]!)).block_premium_20d).toBeNull();
    await fill();
  });
});

describe("范围与安全", () => {
  it("港股行不动；核心列不动；只改 [from, to]", async () => {
    const hk = await get(HK, "2026-05-20");
    for (const k of EVENT_FACTOR_KEYS) expect(hk[k]).toBeNull();
    expect((await get(A, "2026-05-20")).pe_ttm).toBe(5);
    await wh.run(`UPDATE factors_daily SET unlock_days = -1 WHERE code = '${C}'`);
    const n = await fill(FULL, "2026-05-01", "2026-05-31");
    expect(n).toBe(CODES.length * CAL.filter((d) => d.startsWith("2026-05")).length);
    expect((await get(C, "2026-04-30")).unlock_days).toBe(-1);
    expect((await get(C, "2026-05-04")).unlock_days).toBe(181);
    await fill();
  });

  it("同步状态全空（pit_sync 没有行）：全部为空；从 pit_sync 读状态", async () => {
    const s = await loadEventSyncState(wh);
    expect(s.margin).toEqual({ from: null, windowThrough: null });
    await fill(s);
    const r = await get(A, "2026-05-20");
    for (const k of EVENT_FACTOR_KEYS) expect(r[k]).toBeNull();
    await wh.run(
      `INSERT INTO pit_sync (dataset, covered_from, window_through, synced_at) VALUES ('margin', DATE '2026-01-01', DATE '2026-12-31', DATE '2026-12-31')`,
    );
    expect((await loadEventSyncState(wh)).margin).toEqual({ from: "2026-01-01", windowThrough: "2026-12-31" });
    await wh.run(`DELETE FROM pit_sync`);
    await fill();
  });

  it("有覆盖起点、但还没同步过（同步日期为空）：这个数据集的因子为空", async () => {
    await fill({
      margin: { from: "2026-01-01", windowThrough: null },
      holders: { from: "2025-01-01", syncedAt: null },
      lockups: { from: "2026-01-01", syncedAt: null },
      blocks: { from: "2026-01-01", windowThrough: null },
    });
    const r = await get(A, "2026-05-20");
    for (const k of EVENT_FACTOR_KEYS) expect(r[k]).toBeNull();
    await fill();
  });

  it("字面量先校验格式", async () => {
    await expect(
      fill({ ...FULL, margin: { from: "2026-01-01'; DROP TABLE x; --", windowThrough: null } }),
    ).rejects.toThrow(/非法日期/);
  });
});

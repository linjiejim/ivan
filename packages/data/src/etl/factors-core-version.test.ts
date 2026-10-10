/**
 * 注册表第 3 版不触发全量重算（S15b，D83）：行情仓里 factor_registry_version:A 记的是核心版本 '2'，夜间只重算近 15 天、
 * 写回的仍是 '2'（回滚到 R4 也不重算）；事件列在暂存表里一起算好换上；事件 SQL 出错是软步骤：
 * 保留已有的事件值、今天的新行留空、记进 completeness.soft，整晚照常提交。
 */
import { EVENT_FACTOR_KEYS, FACTOR_CORE_VERSION } from "@ivan/core";
import type * as EventFactors from "../compute/event-factors.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { committedAsOf } from "../query/versions.ts";
import { softStepStatus } from "../query/data-health.ts";
import { emEventsServer } from "../testing/events.ts";
import { FakeHttp, loadFixture } from "../testing/fake-http.ts";
import { A_INDEX_SECIDS, emDailyRoute } from "../testing/nightly.ts";
import { seedSyntheticMarket } from "../testing/seed.ts";
import { Warehouse } from "../warehouse/db.ts";
import type { Completeness } from "./completeness.ts";
import {
  EVENT_FACTORS_META,
  EVENT_FACTORS_OK_META,
  eventColsTask,
  eventColumnsStatus,
} from "./event-columns.ts";
import { markDone } from "./context.ts";
import { daily } from "./pipeline.ts";

const fail = vi.hoisted(() => ({ on: false, restore: false }));
vi.mock("../compute/event-factors.ts", async (orig) => {
  const m = await orig<typeof EventFactors>();
  return {
    ...m,
    fillEventColumns: (...a: Parameters<typeof m.fillEventColumns>) =>
      fail.on ? Promise.reject(new Error("Out of Memory Error: 模拟事件 SQL 失败")) : m.fillEventColumns(...a),
    restoreEventColumns: (...a: Parameters<typeof m.restoreEventColumns>) =>
      fail.restore ? Promise.reject(new Error("Out of Memory Error: 模拟拷回失败")) : m.restoreEventColumns(...a),
  };
});

type Row = Record<string, string | number | null>;
const fx = (name: string) => (JSON.parse(loadFixture(name)) as { result: { data: Row[] } }).result.data;
const marginOn = (d: string) => fx("em-rzrq-2026-09-29.json").map((r) => ({ ...r, DATE: `${d} 00:00:00` }));
const CODES = ["600519.SH", "000001.SZ", "000002.SZ", "688981.SH", "001366.SZ", "301358.SZ", "000603.SZ"];

let wh: Warehouse;
afterEach(() => {
  fail.on = false;
  fail.restore = false;
  wh.close();
});

async function seedA() {
  wh = await Warehouse.open(":memory:");
  await seedSyntheticMarket(wh, {
    market: "A",
    start: "2026-09-21",
    days: 14,
    stocks: CODES.map((code) => ({ code, name: code, close: () => 10, factors: () => ({ pe_ttm: 12 }) })),
  });
  // S15 的回填已完成：四个数据集都有覆盖起点（夜间同步只更新别的列）
  for (const id of ["margin", "holders", "lockups", "blocks"]) {
    await wh.run(`INSERT INTO pit_sync (dataset, backfill_from, covered_from) VALUES ($d, DATE '2026-01-01', DATE '2026-01-01')`, {
      d: id,
    });
  }
}

const http = () =>
  new FakeHttp([
    { match: /qt\.gtimg\.cn/, status: 500 },
    { match: /RPT_F10_FINANCE_MAINFINADATA|RPT_F10_EH_EQUITY/, reply: { result: { data: [], pages: 1 } } },
    emEventsServer({
      RPTA_WEB_RZRQ_GGMX: ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12"].flatMap(marginOn),
      RPT_HOLDERNUM_DET: [],
      RPT_LIFT_STAGE: fx("em-lift-stage.json"),
      RPT_DATA_BLOCKTRADE: fx("em-blocktrade.json").map((r) => ({ ...r, TRADE_DATE: "2026-10-08 00:00:00" })),
    }),
    emDailyRoute({
      ...A_INDEX_SECIDS,
      ...Object.fromEntries(CODES.map((c) => [`${c.endsWith(".SH") ? 1 : 0}.${c.slice(0, 6)}`, 10])),
    }),
  ]);

const events = (code: string, date: string) =>
  wh.one<Record<string, unknown>>(
    `SELECT ${EVENT_FACTOR_KEYS.join(", ")} FROM factors_daily WHERE code = $c AND date = $d::DATE`,
    { c: code, d: date },
  );

describe("核心版本与事件列的夜间填充", () => {
  it("meta 是 '2'：只重算近 15 天，写回的仍是核心版本 '2'；事件列在暂存表里算好一起换上", async () => {
    await seedA();
    await wh.setMeta("factor_registry_version:A", "2");
    const logs: string[] = [];
    const r = await daily({ wh, http: http(), today: "2026-10-09", log: (m) => logs.push(m) }, "A");
    expect(r.completeness!.ok).toBe(true);
    expect(FACTOR_CORE_VERSION).toBe(2);
    expect(logs.find((l) => /^因子 A：/.test(l))).toMatch(/（2026-09-24 起）/);
    expect(await wh.meta("factor_registry_version:A")).toBe("2");
    expect(r.completeness!.soft!.find((s) => s.step === "event_factors")).toMatchObject({ ok: true });
    // 今天：解禁同步了（301358.SZ 10-15 解禁，今晚首次见到），两融窗口到 10-08
    const today = await events("301358.SZ", "2026-10-09");
    expect(today!.unlock_days).toBe(6);
    expect(today!.unlock_ratio_30d).toBeCloseTo(10.8135536917, 6);
    expect((await events("000001.SZ", "2026-10-09"))!.unlock_days).toBe(181);
    expect((await events("600519.SH", "2026-10-09"))!.margin_eligible).toBe(true);
    expect((await events("600519.SH", "2026-10-09"))!.margin_ratio).toBeGreaterThan(0);
    // 15 天之前的行不在这次重算的范围里：事件列没动
    expect((await events("600519.SH", "2026-09-21"))!.margin_eligible).toBeNull();
  });

  it("meta 不是核心版本（全新的库）：全量重算，写回 '2'", async () => {
    await seedA();
    const logs: string[] = [];
    await daily({ wh, http: http(), today: "2026-10-09", log: (m) => logs.push(m) }, "A");
    expect(logs.find((l) => /^因子 A：/.test(l))).toMatch(/（2013-01-01 起）/);
    expect(await wh.meta("factor_registry_version:A")).toBe("2");
  });

  it("事件 SQL 出错：保留已有的事件值、今天的新行留空，记软步骤失败，整晚照常提交", async () => {
    await seedA();
    await wh.setMeta("factor_registry_version:A", "2");
    await daily({ wh, http: http(), today: "2026-10-09", log: () => {} }, "A");
    const before = await events("301358.SZ", "2026-10-09");
    expect(before!.unlock_days).toBe(6);
    fail.on = true;
    const logs: string[] = [];
    const r = await daily({ wh, http: http(), today: "2026-10-12", log: (m) => logs.push(m) }, "A");
    const c = r.completeness as Completeness;
    expect(c.ok).toBe(true);
    expect(c.soft!.find((s) => s.step === "event_factors")).toMatchObject({
      ok: false,
      error: "Out of Memory Error: 模拟事件 SQL 失败",
    });
    expect(logs.some((l) => /事件因子计算失败，沿用已有的值/.test(l))).toBe(true);
    expect(await committedAsOf(wh, "A")).toBe("2026-10-12");
    expect(await events("301358.SZ", "2026-10-09")).toEqual(before);
    const today = await events("301358.SZ", "2026-10-12");
    for (const k of EVENT_FACTOR_KEYS) expect(today![k]).toBeNull();
    // 核心因子照常算了（今天的行都在，收盘价写进去了）
    expect(await wh.scalar(`SELECT close FROM factors_daily WHERE code = '301358.SZ' AND date = DATE '2026-10-12'`)).toBe(10);
    expect(Number(await wh.scalar(`SELECT count(*) FROM factors_daily WHERE date = DATE '2026-10-12'`))).toBe(CODES.length);
    expect((await softStepStatus(wh, "A")).find((s) => s.step === "event_factors")).toMatchObject({ failingNights: 1 });
  });

  it("拷回也失败：仍不让整晚失败，今天的新行留空", async () => {
    await seedA();
    await wh.setMeta("factor_registry_version:A", "2");
    await daily({ wh, http: http(), today: "2026-10-09", log: () => {} }, "A");
    fail.on = true;
    fail.restore = true;
    const logs: string[] = [];
    const r = await daily({ wh, http: http(), today: "2026-10-12", log: (m) => logs.push(m) }, "A");
    const c = r.completeness as Completeness;
    expect(c.ok).toBe(true);
    expect(c.soft!.find((s) => s.step === "event_factors")).toMatchObject({ ok: false });
    expect(logs.some((l) => /事件因子拷回也失败/.test(l))).toBe(true);
    expect(await committedAsOf(wh, "A")).toBe("2026-10-12");
    const today = await events("301358.SZ", "2026-10-12");
    for (const k of EVENT_FACTOR_KEYS) expect(today![k]).toBeNull();
  });

  it("连续失败留空的日子滑出夜间重算范围：成功的那晚重开那几年的按年补算（完成标记改为未完成）", async () => {
    await seedA();
    await wh.setMeta("factor_registry_version:A", "2");
    await daily({ wh, http: http(), today: "2026-10-09", log: () => {} }, "A");
    expect(await wh.meta(EVENT_FACTORS_OK_META)).toBe("2026-10-09");
    // 假装补算已经完成，而最近一次算成功是在很久以前
    const st = await eventColumnsStatus(wh);
    await markDone(wh, eventColsTask(st.sig), "2026");
    await wh.setMeta(EVENT_FACTORS_META, JSON.stringify({ v: st.v, sig: st.sig, complete: true, batch: 1 }));
    expect((await eventColumnsStatus(wh)).complete).toBe(true);
    await wh.setMeta(EVENT_FACTORS_OK_META, "2026-08-31");
    const logs: string[] = [];
    await daily({ wh, http: http(), today: "2026-10-12", log: (m) => logs.push(m) }, "A");
    expect(logs.some((l) => /重新按年补算 2026 年/.test(l))).toBe(true);
    const after = await eventColumnsStatus(wh);
    expect(after.complete).toBe(false);
    expect(after.pendingYears).toEqual([2026]);
    expect(await wh.meta(EVENT_FACTORS_OK_META)).toBe("2026-10-12");
    // 正常的下一晚：不再重开
    await markDone(wh, eventColsTask(st.sig), "2026");
    logs.length = 0;
    await daily({ wh, http: http(), today: "2026-10-12", log: (m) => logs.push(m) }, "A");
    expect(logs.some((l) => /重新按年补算/.test(l))).toBe(false);
    expect(Number(await wh.scalar(`SELECT count(*) FROM etl_progress WHERE task = $t`, { t: eventColsTask(st.sig) }))).toBe(1);
  });
});

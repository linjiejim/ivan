/**
 * 点时事件数据运行器（D81、D82，验收 18、19、22）：行级来源、两融按交易所到齐、整窗替换幂等、合并的软删除与重现、
 * 回填续跑与覆盖起点、夜间不写进度键、预算、金丝雀失败就关、翻页对不上、非东财的实现走同一套流程、读不到空窗口。
 */
import { readFileSync } from "node:fs";
import type { DateStr } from "@ivan/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANARY_SAMPLE_ROWS } from "../sources/adapters/eastmoney-events.ts";
import { emEventsServer, eventColumnViolations } from "../testing/events.ts";
import { FakeHttp, loadFixture } from "../testing/fake-http.ts";
import { seedSyntheticMarket } from "../testing/seed.ts";
import { Warehouse } from "../warehouse/db.ts";
import type { MarginRow, PitFetcher } from "../sources/types.ts";
import type { EtlContext } from "./context.ts";
import { openPitBatch, readPitSync, syncPitDataset } from "./pit-runner.ts";

type Row = Record<string, string | number | null>;
const fx = (name: string) => (JSON.parse(loadFixture(name)) as { result: { data: Row[] } }).result.data;

/** 9-29 的两融行换成别的日期 */
const marginOn = (d: DateStr, only?: "SH") =>
  fx("em-rzrq-2026-09-29.json")
    .filter((r) => !only || String(r.SECUCODE).endsWith(".SH"))
    .map((r): Row => ({ ...r, DATE: `${d} 00:00:00` }));

const CODES = [
  ["000001.SZ"],
  ["000002.SZ"],
  ["600519.SH", "2001-08-27"],
  ["688981.SH"],
  ["000603.SZ"],
  ["002064.SZ"],
  ["300005.SZ", "2009-10-30"],
  ["002150.SZ"],
  ["301358.SZ", "2022-09-01"],
  ["001309.SZ"],
  ["001366.SZ"],
] as const;

let wh: Warehouse;
let data: Record<string, Row[]>;
let http: FakeHttp;
let logs: string[];

beforeEach(async () => {
  wh = await Warehouse.open(":memory:");
  // 2026-09-21 起：9-25、国庆休市；交易日历到 10-09
  await seedSyntheticMarket(wh, {
    market: "A",
    start: "2026-09-21",
    days: 15,
    skipDates: ["2026-09-25", "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"],
    stocks: CODES.map(([code, listDate]) => ({ code, name: code, listDate, close: () => 10 })),
  });
  data = {
    RPTA_WEB_RZRQ_GGMX: [...marginOn("2026-09-29"), ...marginOn("2026-09-30", "SH")],
    RPT_HOLDERNUM_DET: [
      ...fx("em-holdernum.json"),
      // 金丝雀的固定样本
      {
        SECUCODE: "600519.SH",
        END_DATE: "2026-06-30 00:00:00",
        HOLD_NOTICE_DATE: "2026-07-30 00:00:00",
        HOLDER_NUM: 160000,
        PRE_HOLDER_NUM: 200000,
        PRE_END_DATE: "2026-03-31 00:00:00",
        HOLDER_NUM_RATIO: -20,
      },
    ],
    RPT_LIFT_STAGE: fx("em-lift-stage.json"),
    RPT_DATA_BLOCKTRADE: fx("em-blocktrade.json"),
  };
  http = new FakeHttp([emEventsServer(data)]);
  logs = [];
});
afterEach(() => wh.close());

const ctxOn = (today: DateStr, ver?: number): EtlContext => ({
  wh,
  http,
  today,
  log: (m) => logs.push(m),
  ...(ver !== undefined ? { ver } : {}),
});
const batch = () => openPitBatch({ wh }, "nightly", ["margin"], null);
const progressKeys = () =>
  wh.all<{ task: string; key: string; status: string }>(
    `SELECT task, key, status FROM etl_progress WHERE task LIKE 'pit:%' ORDER BY task, key`,
  );

describe("两融（整窗替换）", () => {
  it("夜间：行盖 src / ver / batch，ETF 丢掉；只到沪市的一天写入但记 partial；不写 pit:margin 进度键", async () => {
    const b = await batch();
    const r = await syncPitDataset(ctxOn("2026-10-08", 42), "margin", { mode: "nightly", batch: b });
    expect(r).toMatchObject({
      ok: true,
      servedBy: "eastmoney",
      chunks: 2,
      done: 1,
      partial: ["2026-09-30"],
      status: "partial",
      rows: 4 + 2,
    });
    expect(r.canary).toMatchObject({ status: "ok", source: "eastmoney" });
    const rows = await wh.all(
      `SELECT code, date::VARCHAR AS date, avail_date::VARCHAR AS avail, rzyezb, float_mcap, src, ver, batch
       FROM margin_daily WHERE date = DATE '2026-09-29' ORDER BY code`,
    );
    expect(rows.map((x) => x.code)).toEqual(["000001.SZ", "000002.SZ", "600519.SH", "688981.SH"]);
    expect(rows[2]).toEqual({
      code: "600519.SH",
      date: "2026-09-29",
      avail: "2026-09-30",
      rzyezb: 1.09532005,
      float_mcap: 1573377704650,
      src: "em",
      ver: 42,
      batch: b,
    });
    // 9-30 的可得日跨过国庆
    expect(
      await wh.scalar(`SELECT DISTINCT avail_date::VARCHAR FROM margin_daily WHERE date = DATE '2026-09-30'`),
    ).toBe("2026-10-08");
    expect(await progressKeys()).toEqual([]);
    const sync = (await readPitSync(wh)).get("margin")!;
    expect(sync).toMatchObject({
      window_through: "2026-09-29",
      synced_at: "2026-10-08",
      last_status: "partial",
      nightly_since: "2026-10-08",
      covered_from: null,
    });
    expect(sync.last_detail).toBe("2026-09-30 只拿到沪市 3 行，之后的夜里再取");
    expect(eventColumnViolations(http.calls)).toEqual([]);
  });

  it("没到齐的一天之后的夜里重取，两市都到了就算完成", async () => {
    await syncPitDataset(ctxOn("2026-10-08", 1), "margin", { mode: "nightly", batch: await batch() });
    // 深市 9-30 的数据第二天才有；10-08 两市都有
    data.RPTA_WEB_RZRQ_GGMX!.splice(0, Infinity, ...marginOn("2026-09-29"), ...marginOn("2026-09-30"), ...marginOn("2026-10-08"));
    const r = await syncPitDataset(ctxOn("2026-10-09", 2), "margin", { mode: "nightly", batch: await batch() });
    expect(r).toMatchObject({ ok: true, partial: [], done: 2, status: "ok" });
    expect(Number(await wh.scalar(`SELECT count(*) FROM margin_daily WHERE date = DATE '2026-09-30'`))).toBe(4);
    expect((await readPitSync(wh)).get("margin")).toMatchObject({
      window_through: "2026-10-08",
      nightly_since: "2026-10-08",
      last_status: "ok",
    });
    // 夜间从不写回填的进度键
    expect(await progressKeys()).toEqual([]);
  });

  it("周六补齐：上一个交易日（10-09）的两融还没公布（9201）→ 金丝雀照样过，这一天记没到齐、不算失败，窗口停在 10-08，公布后夜里补上", async () => {
    data.RPTA_WEB_RZRQ_GGMX!.splice(0, Infinity, ...marginOn("2026-09-30"), ...marginOn("2026-10-08"));
    const b = await openPitBatch({ wh }, "backfill", ["margin"], null);
    // 2026-10-10 是周六：10-09 的两融下周一早上才公布
    const r = await syncPitDataset(ctxOn("2026-10-10"), "margin", { mode: "backfill", from: "2026-09-30", batch: b });
    expect(r.canary).toMatchObject({ status: "ok" });
    expect(r).toMatchObject({
      ok: true,
      chunks: 3,
      done: 2,
      partial: ["2026-10-09"],
      failed: [],
      remaining: 0,
      status: "partial",
    });
    let sync = (await readPitSync(wh)).get("margin")!;
    expect(sync).toMatchObject({ window_through: "2026-10-08", covered_from: "2026-09-30", last_status: "partial" });
    expect(sync.last_detail).toBe("2026-10-09 沪深两市都还没有数据，之后的夜里再取");
    // 没到齐的块不算 done：下次回填照样重取
    expect(await progressKeys()).toContainEqual({ task: "pit:margin", key: "2026-10-09", status: "partial" });
    // 周一早上公布了：周一晚上的夜间重取 10-09，两市都到了就算完成，数据窗口到 10-09
    data.RPTA_WEB_RZRQ_GGMX!.push(...marginOn("2026-10-09"));
    const n = await syncPitDataset(ctxOn("2026-10-12", 3), "margin", { mode: "nightly", batch: await batch() });
    expect(n).toMatchObject({ ok: true, partial: [], status: "ok" });
    sync = (await readPitSync(wh)).get("margin")!;
    expect(sync).toMatchObject({ window_through: "2026-10-09", covered_from: "2026-09-30", last_status: "ok" });
    expect(Number(await wh.scalar(`SELECT count(*) FROM margin_daily WHERE date = DATE '2026-10-09'`))).toBe(4);
  });

  it("20 个交易日后仍没到齐：记一次 partial_exchange，不再重取", async () => {
    await wh.run(
      `INSERT INTO etl_progress (task, key, status, detail) VALUES
         ('pit_days:margin', '2026-09-01', 'partial', '{"rows":2001,"sh":2001,"sz":0}')`,
    );
    for (let i = 0; i < 2; i++) {
      await syncPitDataset(ctxOn("2026-10-08", 5), "margin", { mode: "nightly", batch: await batch() });
    }
    expect(
      await wh.all(`SELECT dataset, rule, severity, date::VARCHAR AS d, ver FROM data_issues`),
    ).toEqual([{ dataset: "margin", rule: "partial_exchange", severity: "flag", d: "2026-09-01", ver: 5 }]);
    expect(http.calls.some((c) => c.url.includes("2026-09-01"))).toBe(false);
  });

  it("同一块跑两次：行完全一样", async () => {
    const b = await batch();
    const snap = () =>
      wh.all(`SELECT * EXCLUDE (date, avail_date), date::VARCHAR AS d, avail_date::VARCHAR AS a
              FROM margin_daily ORDER BY code, d`);
    await syncPitDataset(ctxOn("2026-10-08", 7), "margin", { mode: "nightly", batch: b });
    const first = await snap();
    await syncPitDataset(ctxOn("2026-10-08", 7), "margin", { mode: "nightly", batch: b });
    expect(await snap()).toEqual(first);
    expect(first).toHaveLength(6);
  });

  it("预算 0：一块都不写，stoppedForBudget", async () => {
    const r = await syncPitDataset(ctxOn("2026-10-08"), "margin", {
      mode: "backfill",
      from: "2026-09-21",
      batch: await batch(),
      budgetMs: 0,
    });
    expect(r).toMatchObject({ stoppedForBudget: true, done: 0, remaining: r.chunks });
    expect(r.chunks).toBeGreaterThan(0);
    expect(Number(await wh.scalar(`SELECT count(*) FROM margin_daily`))).toBe(0);
  });
});

describe("回填：续跑、覆盖起点", () => {
  it("续跑跳过已完成的块；全部 done 或 partial 后才设 covered_from，之后没到齐的一天不移动它", async () => {
    data.RPTA_WEB_RZRQ_GGMX!.splice(
      0,
      Infinity,
      ...["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-28", "2026-09-29"].flatMap((d) =>
        marginOn(d),
      ),
      ...marginOn("2026-09-30", "SH"),
    );
    // 第一段：时钟每次 +1 秒，预算 2.5 秒 → 做两块就停
    let t = 0;
    const now = () => (t += 1000);
    const b = await openPitBatch({ wh }, "backfill", ["margin"], null);
    const first = await syncPitDataset(ctxOn("2026-10-08"), "margin", {
      mode: "backfill",
      from: "2026-09-21",
      batch: b,
      budgetMs: 2500,
      now,
    });
    expect(first).toMatchObject({ stoppedForBudget: true, done: 2, chunks: 7, remaining: 5 });
    expect((await readPitSync(wh)).get("margin")).toMatchObject({
      backfill_from: "2026-09-21",
      covered_from: null,
    });
    // 后台回填的行不盖数据版本号
    expect(await wh.all(`SELECT DISTINCT ver, batch FROM margin_daily`)).toEqual([{ ver: null, batch: b }]);
    const before = http.calls.length;
    const rest = await syncPitDataset(ctxOn("2026-10-08"), "margin", { mode: "backfill", from: "2026-09-21", batch: b });
    expect(rest).toMatchObject({ chunks: 5, done: 4, partial: ["2026-09-30"] });
    // 9-21、9-22 没有再请求
    const asked = http.calls.slice(before).map((c) => new URL(c.url).searchParams.get("filter"));
    expect(asked.some((f) => /2026-09-2[12]/.test(f ?? ""))).toBe(false);
    expect(await progressKeys()).toContainEqual({ task: "pit:margin", key: "2026-09-30", status: "partial" });
    expect((await readPitSync(wh)).get("margin")!.covered_from).toBe("2026-09-21");
    // 之后夜间又遇到没到齐的一天：覆盖起点不动
    data.RPTA_WEB_RZRQ_GGMX!.push(...marginOn("2026-10-08", "SH"));
    await syncPitDataset(ctxOn("2026-10-09", 3), "margin", { mode: "nightly", batch: b });
    expect((await readPitSync(wh)).get("margin")).toMatchObject({
      covered_from: "2026-09-21",
      last_status: "partial",
    });
  });
});

describe("回填：有界回填（--to）、换更早的起点再补", () => {
  it("带 to 的回填全部做完也不设 covered_from（to 之后还没补）；之后补完到今天才设", async () => {
    const b = await openPitBatch({ wh }, "backfill", ["blocks"], null);
    const bounded = await syncPitDataset(ctxOn("2026-10-08"), "blocks", {
      mode: "backfill",
      from: "2026-08-01",
      to: "2026-08-31",
      batch: b,
    });
    expect(bounded).toMatchObject({ ok: true, chunks: 1, done: 1, remaining: 0 });
    expect((await readPitSync(wh)).get("blocks")).toMatchObject({ backfill_from: "2026-08-01", covered_from: null });
    // 不带 to 再跑一次：8 月已完成跳过，补完 9、10 月后才设覆盖起点
    const rest = await syncPitDataset(ctxOn("2026-10-08"), "blocks", { mode: "backfill", from: "2026-08-01", batch: b });
    expect(rest).toMatchObject({ ok: true, chunks: 2, remaining: 0 });
    expect((await readPitSync(wh)).get("blocks")!.covered_from).toBe("2026-08-01");
  });

  it("先从 9 月、再从 5 月回填解禁：块总是整年，第二次跳过的 2026 块里没有缺口，覆盖起点前移到 5 月", async () => {
    // 本地端到端测试发现的：块 id 只认年份而第一次只取了 9 月起，第二次把 2026 当成做完跳过，5–8 月的解禁一直缺着
    const may = { ...data.RPT_LIFT_STAGE![1]!, FREE_DATE: "2026-05-20 00:00:00" };
    data.RPT_LIFT_STAGE!.push(may);
    const b = await openPitBatch({ wh }, "backfill", ["lockups"], null);
    await syncPitDataset(ctxOn("2026-10-08"), "lockups", { mode: "backfill", from: "2026-09-01", batch: b });
    const again = await syncPitDataset(ctxOn("2026-10-08"), "lockups", { mode: "backfill", from: "2026-05-06", batch: b });
    expect(again).toMatchObject({ ok: true, chunks: 0, remaining: 0 });
    expect((await readPitSync(wh)).get("lockups")!.covered_from).toBe("2026-05-06");
    expect(
      await wh.all(`SELECT code, free_date::VARCHAR AS d FROM lockups WHERE free_date < DATE '2026-09-01'`),
    ).toEqual([{ code: "002150.SZ", d: "2026-05-20" }]);
  });
});

describe("合并（解禁、户数）", () => {
  const lockups = () =>
    wh.all<{ code: string; first_seen: string; last_seen: string; gone_from: string | null; avail_rule: string }>(
      `SELECT code, first_seen::VARCHAR AS first_seen, last_seen::VARCHAR AS last_seen,
              gone_from::VARCHAR AS gone_from, avail_rule FROM lockups ORDER BY code`,
    );
  const issues = () =>
    wh.all<{ rule: string; code: string; date: string; detail: string }>(
      `SELECT rule, code, date::VARCHAR AS date, detail FROM data_issues ORDER BY id`,
    );

  it("消失的行设 gone_from、记 row_removed（附原行），不删；又出现时清空并记 row_returned；首次见到的日子不变", async () => {
    const b = await batch();
    await syncPitDataset(ctxOn("2026-10-08", 1), "lockups", { mode: "nightly", batch: b });
    expect(await lockups()).toEqual([
      // 10-12 解禁：规则日 9-30 早于首次见到 → 按规则；10-15 解禁：规则日 10-12 晚于首次见到 → 首次见到
      { code: "002150.SZ", first_seen: "2026-10-08", last_seen: "2026-10-08", gone_from: null, avail_rule: "notice_bound" },
      { code: "301358.SZ", first_seen: "2026-10-08", last_seen: "2026-10-08", gone_from: null, avail_rule: "first_seen" },
    ]);
    // 301358 被撤下
    const saved = data.RPT_LIFT_STAGE!.splice(2, 1);
    await syncPitDataset(ctxOn("2026-10-09", 2), "lockups", { mode: "nightly", batch: b });
    const after = await lockups();
    expect(after[1]).toMatchObject({ code: "301358.SZ", gone_from: "2026-10-09", last_seen: "2026-10-08" });
    expect(after[0]).toMatchObject({ code: "002150.SZ", first_seen: "2026-10-08", last_seen: "2026-10-09" });
    const removed = (await issues())[0]!;
    expect(removed).toMatchObject({ rule: "row_removed", code: "301358.SZ", date: "2026-10-15" });
    expect(JSON.parse(removed.detail)).toMatchObject({ code: "301358.SZ", type: "定向增发机构配售股份" });
    // 又出现了
    data.RPT_LIFT_STAGE!.push(...saved);
    const r = await syncPitDataset(ctxOn("2026-10-12", 3), "lockups", { mode: "nightly", batch: b });
    expect(r.ok).toBe(true);
    expect((await lockups())[1]).toEqual({
      code: "301358.SZ",
      first_seen: "2026-10-08",
      last_seen: "2026-10-12",
      gone_from: null,
      avail_rule: "first_seen",
    });
    expect((await issues()).map((i) => i.rule)).toEqual(["row_removed", "row_returned"]);
  });

  it("同一（代码, 截至日）出现新公告日：追加一行、记 avail_moved；可得日是公告日", async () => {
    const b = await batch();
    await syncPitDataset(ctxOn("2026-08-10"), "holders", { mode: "nightly", batch: b });
    data.RPT_HOLDERNUM_DET!.push({
      ...data.RPT_HOLDERNUM_DET![0]!,
      HOLD_NOTICE_DATE: "2026-08-05 00:00:00",
      HOLDER_NUM: 66000,
    });
    await syncPitDataset(ctxOn("2026-08-10"), "holders", { mode: "nightly", batch: b });
    expect(
      await wh.all(
        `SELECT end_date::VARCHAR AS e, notice_date::VARCHAR AS n, avail_date::VARCHAR AS a, holder_num, gone_from
         FROM holder_counts WHERE code = '000603.SZ' ORDER BY n`,
      ),
    ).toEqual([
      { e: "2026-06-30", n: "2026-08-01", a: "2026-08-01", holder_num: 66961, gone_from: null },
      { e: "2026-06-30", n: "2026-08-05", a: "2026-08-05", holder_num: 66000, gone_from: null },
    ]);
    expect(await issues()).toEqual([
      {
        rule: "avail_moved",
        code: "000603.SZ",
        date: "2026-08-05",
        detail: "截至 2026-06-30 的户数公告日从 2026-08-01 变成 2026-08-05",
      },
    ]);
  });
});

describe("失败就关（D82）", () => {
  const seedMargin = async () => {
    await syncPitDataset(ctxOn("2026-10-08", 1), "margin", { mode: "nightly", batch: await batch() });
    return Number(await wh.scalar(`SELECT count(*) FROM margin_daily`));
  };

  it("金丝雀 9501：已有的行原样、不发正式请求，last_status = canary_failed", async () => {
    const n = await seedMargin();
    const drift = new FakeHttp([
      { match: /RPTA_WEB_RZRQ_GGMX/, reply: loadFixture("em-9501-schema-drift.json") },
    ]);
    const r = await syncPitDataset({ ...ctxOn("2026-10-09", 2), http: drift }, "margin", {
      mode: "nightly",
      batch: await batch(),
    });
    expect(r).toMatchObject({ ok: false, status: "canary_failed", rows: 0, done: 0 });
    expect(r.canary!.status).toBe("schema_drift");
    expect(drift.calls).toHaveLength(1);
    expect(Number(await wh.scalar(`SELECT count(*) FROM margin_daily`))).toBe(n);
    const sync = (await readPitSync(wh)).get("margin")!;
    expect(sync.last_status).toBe("canary_failed");
    expect(sync.last_detail).toMatch(/^东财「两融明细」接口字段变了：.*字段不存在.*，今晚没更新$/);
    expect(JSON.parse(sync.canary!)).toMatchObject({ status: "schema_drift", source: "eastmoney" });
    // 之前的覆盖信息不动
    expect(sync.window_through).toBe("2026-09-29");
  });

  it("正式抓取时缺了请求过的键：这个数据集不写、ok = false", async () => {
    const n = await seedMargin();
    data.RPTA_WEB_RZRQ_GGMX!.push(...marginOn("2026-10-08"));
    const missing = new FakeHttp([
      emEventsServer(data, (report, url) => {
        if (report !== "RPTA_WEB_RZRQ_GGMX" || new URL(url).searchParams.get("pageSize") === String(CANARY_SAMPLE_ROWS)) return undefined;
        const rows = marginOn("2026-09-30").map(({ RZYEZB: _x, ...r }) => r);
        return { result: { pages: 1, count: rows.length, data: rows }, code: 0, success: true };
      }),
    ]);
    const r = await syncPitDataset({ ...ctxOn("2026-10-09", 2), http: missing }, "margin", {
      mode: "nightly",
      batch: await batch(),
    });
    expect(r).toMatchObject({ ok: false, status: "failed", done: 0, rows: 0 });
    expect(r.detail).toBe("东财「两融明细」接口字段变了：两融明细缺少字段 RZYEZB，今晚没更新");
    expect(Number(await wh.scalar(`SELECT count(*) FROM margin_daily`))).toBe(n);
  });

  it("行数对不上：重取一次，还不对就这一块失败、不写；回填记 failed", async () => {
    let tries = 0;
    const bad = new FakeHttp([
      emEventsServer(data, (report, url) => {
        if (report !== "RPT_DATA_BLOCKTRADE" || new URL(url).searchParams.get("pageSize") === String(CANARY_SAMPLE_ROWS)) return undefined;
        tries++;
        const rows = fx("em-blocktrade.json");
        return { result: { pages: 1, count: rows.length + 1, data: rows }, code: 0, success: true };
      }),
    ]);
    const r = await syncPitDataset({ ...ctxOn("2026-10-08"), http: bad }, "blocks", {
      mode: "backfill",
      from: "2026-09-01",
      to: "2026-09-30",
      batch: await batch(),
    });
    expect(tries).toBe(2);
    expect(r).toMatchObject({ ok: false, failed: ["2026-09"], done: 0, status: "partial" });
    expect(Number(await wh.scalar(`SELECT count(*) FROM block_trades`))).toBe(0);
    expect(await progressKeys()).toEqual([{ task: "pit:blocks", key: "2026-09", status: "failed" }]);
  });

  it("两笔完全相同的大宗：重取一次、两次一样就照常写入（seq 1、2），回填记 done", async () => {
    data.RPT_DATA_BLOCKTRADE = fx("em-blocktrade-identical.json");
    const r = await syncPitDataset(ctxOn("2026-10-08"), "blocks", {
      mode: "backfill",
      from: "2026-09-01",
      to: "2026-09-30",
      batch: await batch(),
    });
    expect(r).toMatchObject({ ok: true, failed: [], done: 1, rows: 3 });
    expect(
      await wh.all(`SELECT seq FROM block_trades WHERE code = '001366.SZ' ORDER BY seq`),
    ).toEqual([{ seq: 1 }, { seq: 2 }]);
    expect(await progressKeys()).toEqual([{ task: "pit:blocks", key: "2026-09", status: "done" }]);
  });
});

describe("与来源无关", () => {
  it("一个假的非东财实现走同样的流程（行的来源记成它自己的）", async () => {
    const fetched: string[] = [];
    const fake: PitFetcher<MarginRow> = {
      async canary(_s, today, prevTd) {
        return { status: "ok", source: "tencent", at: `${today}T17:30:00Z`, detail: `样本 ${prevTd}` };
      },
      async fetchChunk(_s, chunk) {
        fetched.push(chunk.id);
        const row = (code: string): MarginRow => ({
          code,
          date: chunk.from,
          rzye: 100,
          rzmre: 1,
          rzche: 1,
          rqye: 0,
          rqyl: 0,
          floatMcap: 1e4,
          rzyezb: 1,
        });
        return { rows: [row("600519.SH"), row("000001.SZ")], rawCount: 2, requests: 1, byExchange: { sh: 1, sz: 1 } };
      },
    };
    const r = await syncPitDataset(ctxOn("2026-10-08", 9), "margin", {
      mode: "nightly",
      batch: await batch(),
      chain: [{ source: "tencent", fetcher: fake as PitFetcher<unknown> }],
    });
    expect(r).toMatchObject({ ok: true, servedBy: "tencent", done: 2, rows: 4 });
    expect(fetched).toEqual(["2026-09-29", "2026-09-30"]);
    expect(await wh.all(`SELECT DISTINCT src, ver FROM margin_daily`)).toEqual([{ src: "tx", ver: 9 }]);
    expect(http.calls).toHaveLength(0);
  });

  it("运行器与数据集规格不引用任何东财的东西", () => {
    for (const f of ["./pit-runner.ts", "./datasets.ts", "./trading-days.ts"]) {
      const text = readFileSync(new URL(f, import.meta.url), "utf8");
      const imports = text.split("\n").filter((l) => /^\s*(import|from|\} from)/.test(l) || l.includes(" from "));
      expect(imports.join("\n")).not.toMatch(/eastmoney|emkline|RPT_/i);
    }
  });
});

describe("读不到空窗口", () => {
  it("写同一块时，并发的读一直看得到这一天的行", async () => {
    const b = await batch();
    await syncPitDataset(ctxOn("2026-10-08", 1), "margin", { mode: "nightly", batch: b });
    let stop = false;
    let min = Infinity;
    let reads = 0;
    const reader = (async () => {
      while (!stop) {
        const n = Number(await wh.scalar(`SELECT count(*) FROM margin_daily WHERE date = DATE '2026-09-29'`));
        min = Math.min(min, n);
        reads++;
      }
    })();
    for (let i = 0; i < 15; i++) {
      await syncPitDataset(ctxOn("2026-10-08", 1), "margin", { mode: "nightly", batch: b });
    }
    stop = true;
    await reader;
    expect(reads).toBeGreaterThan(10);
    expect(min).toBe(4);
  });
});

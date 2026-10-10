/**
 * 事件列按年补算（S15b，D83、D81）：每次一年、断点续跑、签名变了从头补、不开数据版本、核心列逐字节不变、
 * S15 的回填没完成时不补、补完写完成标记。
 */
import { EVENT_FACTOR_KEYS, EVENT_FACTOR_VERSION } from "@ivan/core";
import { sha256Canonical } from "@ivan/core/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSyntheticMarket } from "../testing/seed.ts";
import { FACTOR_COLUMNS } from "../warehouse/schema.ts";
import { Warehouse } from "../warehouse/db.ts";
import {
  backfillEventColumns,
  eventColsTask,
  eventColumnsStatus,
  eventSig,
  readEventFactorsMeta,
} from "./event-columns.ts";

let wh: Warehouse;
let calendar: string[];
const SH = "600001.SH";
const ctx = () => ({ wh, log: () => {} });
const CORE = ["code", "date", "market", "close", ...FACTOR_COLUMNS.filter((k) => !EVENT_FACTOR_KEYS.includes(k))];

async function coreHash(): Promise<string> {
  return sha256Canonical(
    await wh.all(`SELECT ${CORE.map((c) => (c === "date" ? "date::VARCHAR AS date" : c)).join(", ")}
                  FROM factors_daily ORDER BY code, date`),
  );
}

async function setCovered(id: string, d: string | null) {
  await wh.run(`UPDATE pit_sync SET covered_from = ${d ? `DATE '${d}'` : "NULL"} WHERE dataset = $id`, { id });
}

beforeAll(async () => {
  wh = await Warehouse.open(":memory:");
  ({ calendar } = await seedSyntheticMarket(wh, {
    market: "A",
    start: "2023-06-01",
    days: 640,
    stocks: [
      { code: SH, name: "甲", close: (i) => 10 + i / 100, factors: (i) => ({ pe_ttm: 8 + i / 1000, roe_ttm: 12 }) },
      { code: "000002.SZ", name: "乙", close: () => 20, factors: () => ({ pe_ttm: 30, flag_st: false }) },
    ],
  }));
  for (const id of ["margin", "holders", "lockups", "blocks"]) {
    await wh.run(
      `INSERT INTO pit_sync (dataset, backfill_from, covered_from, window_through, synced_at)
       VALUES ($d, DATE '2023-06-01', DATE '2023-06-01', $t::DATE, $t::DATE)`,
      { d: id, t: calendar.at(-1)! },
    );
  }
  await wh.run(
    `INSERT INTO lockups (code, free_date, type, unlock_shares, ratio_float, avail_date, avail_rule, first_seen, last_seen, src, ver, batch)
     VALUES ('${SH}', DATE '2024-03-15', '首发原股东限售股份', 1e8, 0.2, DATE '2023-06-01', 'ipo_terms', DATE '2023-06-01', DATE '2023-06-01', 'em', NULL, 1)`,
  );
});
afterAll(() => wh.close());

describe("事件列按年补算", () => {
  it("签名 = 事件因子版本 + 各数据集覆盖起点（按月）；同月内挪动不变，换月就变", async () => {
    const st = await eventColumnsStatus(wh);
    expect(st.sig).toMatch(/^[0-9a-f]{8}$/);
    expect(st.sig).toBe(eventSig(st.state));
    expect(st).toMatchObject({ v: EVENT_FACTOR_VERSION, backfillComplete: true, complete: false, from: "2023-06-01" });
    expect(st.totalYears).toBe(Number(calendar.at(-1)!.slice(0, 4)) - 2023 + 1);
    await setCovered("margin", "2023-06-20");
    expect((await eventColumnsStatus(wh)).sig).toBe(st.sig);
    await setCovered("margin", "2023-05-31");
    expect((await eventColumnsStatus(wh)).sig).not.toBe(st.sig);
    await setCovered("margin", "2023-06-01");
  });

  it("S15 的回填还没完成（有数据集没有覆盖起点）：不补", async () => {
    await setCovered("blocks", null);
    const r = await backfillEventColumns(ctx(), "A", { maxYears: 1 });
    expect(r).toMatchObject({ skipped: "backfill_incomplete", years: [], batch: null });
    expect(Number(await wh.scalar(`SELECT count(*) FROM pit_batches`))).toBe(0);
    await setCovered("blocks", "2023-06-01");
  });

  it("每次一年、断点续跑、不开数据版本；补完写完成标记；核心列逐字节不变", async () => {
    const versions = Number(await wh.scalar(`SELECT count(*) FROM data_versions`));
    const committed = await wh.all(`SELECT id, as_of::VARCHAR AS a, status FROM data_versions ORDER BY id`);
    const before = await coreHash();
    const st0 = await eventColumnsStatus(wh);

    const r1 = await backfillEventColumns(ctx(), "A", { maxYears: 1 });
    expect(r1.years).toEqual([2023]);
    expect(r1.remaining).toBe(st0.totalYears - 1);
    expect(r1.complete).toBe(false);
    expect(await wh.one(`SELECT kind, status, data_version, chunks FROM pit_batches WHERE id = $id`, { id: r1.batch! })).toEqual(
      { kind: "event_cols", status: "ok", data_version: null, chunks: 1 },
    );
    // 2023 年的行补上了：2024-03-15 解禁，比例 20%
    const d23 = calendar.find((d) => d >= "2023-12-01")!;
    expect(
      await wh.one(`SELECT unlock_days, unlock_ratio_30d FROM factors_daily WHERE code = $c AND date = $d::DATE`, {
        c: SH,
        d: d23,
      }),
    ).toMatchObject({ unlock_ratio_30d: 0 });
    // 2024 年的行还没补
    expect(
      await wh.scalar(`SELECT count(*) FROM factors_daily WHERE date >= DATE '2024-01-01' AND unlock_days IS NOT NULL`),
    ).toBe(0);
    expect((await eventColumnsStatus(wh)).doneYears).toBe(1);

    // 续跑：从 2024 年接着补，直到完成
    let r = r1;
    const seen = [2023];
    while (!r.complete) {
      r = await backfillEventColumns(ctx(), "A", { maxYears: 1 });
      seen.push(...r.years);
    }
    expect(seen).toEqual(Array.from({ length: st0.totalYears }, (_, i) => 2023 + i));
    const meta = await readEventFactorsMeta(wh);
    expect(meta).toEqual({ v: EVENT_FACTOR_VERSION, sig: st0.sig, complete: true, batch: r.batch });
    const st = await eventColumnsStatus(wh);
    expect(st).toMatchObject({ complete: true, doneYears: st0.totalYears, pendingYears: [] });
    const mar = await wh.one<{ unlock_days: number; unlock_ratio_30d: number }>(
      `SELECT unlock_days, unlock_ratio_30d FROM factors_daily WHERE code = $c AND date = DATE '2024-03-01'`,
      { c: SH },
    );
    expect(mar).toEqual({ unlock_days: 14, unlock_ratio_30d: 20 });

    // 不开数据版本：版本表一行没变
    expect(Number(await wh.scalar(`SELECT count(*) FROM data_versions`))).toBe(versions);
    expect(await wh.all(`SELECT id, as_of::VARCHAR AS a, status FROM data_versions ORDER BY id`)).toEqual(committed);
    // 核心列逐字节不变
    expect(await coreHash()).toBe(before);

    // 补完之后再调：没有要补的年份，不改任何行
    const again = await backfillEventColumns(ctx(), "A");
    expect(again).toMatchObject({ years: [], remaining: 0, complete: true });
  });

  it("签名变了（覆盖起点换月）：完成标记对不上，换一个进度键从头补；force 清掉进度重补", async () => {
    const old = await eventColumnsStatus(wh);
    expect(old.complete).toBe(true);
    await setCovered("lockups", "2023-07-03");
    const st = await eventColumnsStatus(wh);
    expect(st.sig).not.toBe(old.sig);
    expect(st).toMatchObject({ complete: false, doneYears: 0 });
    const r = await backfillEventColumns(ctx(), "A");
    expect(r.years.length).toBe(st.totalYears);
    expect(r.complete).toBe(true);
    expect((await readEventFactorsMeta(wh))!.sig).toBe(st.sig);
    expect(
      Number(await wh.scalar(`SELECT count(*) FROM etl_progress WHERE task = $t`, { t: eventColsTask(st.sig) })),
    ).toBe(st.totalYears);
    // 2023-07-03 之前解禁数据不可用：为空
    expect(
      await wh.scalar(`SELECT unlock_days FROM factors_daily WHERE code = $c AND date = DATE '2023-06-30'`, { c: SH }),
    ).toBeNull();

    const f = await backfillEventColumns(ctx(), "A", { force: true, maxYears: 1 });
    expect(f.years).toEqual([2023]);
    expect((await eventColumnsStatus(wh)).complete).toBe(false);
    await backfillEventColumns(ctx(), "A");
    expect((await eventColumnsStatus(wh)).complete).toBe(true);
  });
});

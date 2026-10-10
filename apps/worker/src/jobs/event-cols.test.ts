/**
 * 事件因子列按年补算任务（S15b，D83、D81）：每次一年、15 秒后再排下一年；北京时间 16:30–21:00 不开新的一年；
 * 算写行情仓的任务（排队时回测暂停，等下一年的 15 秒里不挡）；不开数据版本；只在回填完成或签名、版本变了时排。
 */
import { committedAsOf, readEventFactorsMeta } from "@ivan/data";
import { seedSyntheticMarket } from "@ivan/data/testing";
import { computeBlocked, WAREHOUSE_WRITERS } from "@ivan/db";
import { afterEach, describe, expect, it } from "vitest";
import { claim, enqueue } from "../runner.ts";
import { fakeJobContext, makeTestEnv } from "../testing/harness.ts";
import {
  EVENT_COLS_GAP_MS,
  enqueueEventColsIfNeeded,
  eventColsJob,
  setEventColsClockForTest,
} from "./event-cols.ts";

const cst = (s: string) => Date.parse(`${s}+08:00`);

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  setEventColsClockForTest();
  await cleanup?.();
  cleanup = undefined;
});

async function setup(o: { covered?: boolean } = {}) {
  const t = await makeTestEnv({ today: "2026-10-09" });
  cleanup = t.cleanup;
  const wh = t.env.wh;
  await seedSyntheticMarket(wh, {
    market: "A",
    start: "2025-09-01",
    days: 120,
    stocks: [{ code: "600001.SH", name: "甲", close: () => 10, factors: () => ({ pe_ttm: 8 }) }],
  });
  for (const id of ["margin", "holders", "lockups", "blocks"]) {
    await wh.run(
      `INSERT INTO pit_sync (dataset, backfill_from, covered_from, window_through, synced_at)
       VALUES ($d, DATE '2025-09-01', ${o.covered === false && id === "blocks" ? "NULL" : "DATE '2025-09-01'"}, DATE '2026-02-13', DATE '2026-02-13')`,
      { d: id },
    );
  }
  return { t, wh };
}

const queued = (t: Awaited<ReturnType<typeof setup>>["t"]) =>
  t.env.app.sqlite
    .prepare(
      `SELECT id, payload, not_before AS notBefore FROM jobs WHERE kind = 'event_cols' AND status = 'queued'`,
    )
    .all() as Array<{ id: string; payload: string; notBefore: number | null }>;

describe("event_cols 任务", () => {
  it("每次只补一年，15 秒后再排下一年；补完写完成标记、不再排；不开数据版本", async () => {
    const { t, wh } = await setup();
    const versions = Number(await wh.scalar(`SELECT count(*) FROM data_versions`));
    const asOf = await committedAsOf(wh, "A");
    const now = cst("2026-10-09T10:00:00");
    setEventColsClockForTest(() => now);
    const r1 = await eventColsJob(fakeJobContext("event_cols", { market: "A" }));
    expect(r1).toMatchObject({
      years: [2025],
      remaining: 1,
      complete: false,
      notBefore: now + EVENT_COLS_GAP_MS,
    });
    const q = queued(t);
    expect(q).toHaveLength(1);
    expect(JSON.parse(q[0]!.payload)).toEqual({ market: "A" });
    expect(q[0]!.notBefore).toBe(now + EVENT_COLS_GAP_MS);
    t.env.app.sqlite.prepare(`UPDATE jobs SET status = 'done' WHERE id = ?`).run(q[0]!.id);

    const ctx = fakeJobContext("event_cols", { market: "A" });
    const r2 = await eventColsJob(ctx);
    expect(r2).toMatchObject({ years: [2026], remaining: 0, complete: true, notBefore: null });
    expect(queued(t)).toEqual([]);
    expect(ctx.logs.some((l) => /事件因子补算完成（第 1 版/.test(l))).toBe(true);
    expect((await readEventFactorsMeta(wh))!.complete).toBe(true);
    expect(await wh.all(`SELECT kind, data_version FROM pit_batches`)).toEqual([
      { kind: "event_cols", data_version: null },
      { kind: "event_cols", data_version: null },
    ]);
    expect(Number(await wh.scalar(`SELECT count(*) FROM data_versions`))).toBe(versions);
    expect(await committedAsOf(wh, "A")).toBe(asOf);
  });

  it("北京时间 16:30–21:00 不开新的一年：17:00 认领到就推到 21:00；16:29:50 补完一年，下一年也推到 21:00", async () => {
    const { t, wh } = await setup();
    setEventColsClockForTest(() => cst("2026-10-09T17:00:00"));
    const r = await eventColsJob(fakeJobContext("event_cols", { market: "A", force: true }));
    expect(r).toEqual({ deferred: true, notBefore: cst("2026-10-09T21:00:00") });
    expect(Number(await wh.scalar(`SELECT count(*) FROM pit_batches`))).toBe(0);
    const q = queued(t);
    expect(q.map((x) => [JSON.parse(x.payload), x.notBefore])).toEqual([
      [{ market: "A", force: true }, cst("2026-10-09T21:00:00")],
    ]);
    t.env.app.sqlite.prepare(`DELETE FROM jobs`).run();

    setEventColsClockForTest(() => cst("2026-10-09T16:29:50"));
    const r2 = await eventColsJob(fakeJobContext("event_cols", { market: "A" }));
    expect(r2).toMatchObject({ years: [2025], notBefore: cst("2026-10-09T21:00:00") });
  });

  it("算写行情仓的任务：排队时回测暂停；等下一年的 15 秒里（not_before 在未来）不挡回测", async () => {
    const { t } = await setup();
    expect(WAREHOUSE_WRITERS.has("event_cols")).toBe(true);
    expect(WAREHOUSE_WRITERS.has("events")).toBe(false);
    const now = Date.now();
    enqueue("event_cols", { market: "A" }, null, { notBefore: now + EVENT_COLS_GAP_MS });
    expect(computeBlocked(t.env.app.sqlite, now)).toBeNull();
    expect(computeBlocked(t.env.app.sqlite, now + EVENT_COLS_GAP_MS)).toMatchObject({
      kind: "event_cols",
    });
    enqueue("backtest", { runId: "r_x" }, "u_test");
    expect(claim("compute", now + EVENT_COLS_GAP_MS)).toBeUndefined();
  });

  it("只在 S15 的回填完成、且补算标记与当前签名或版本对不上时排；已经有一个时不再排", async () => {
    const { t, wh } = await setup({ covered: false });
    const logs: string[] = [];
    // 回填没完成：不排
    expect(await enqueueEventColsIfNeeded((m) => logs.push(m))).toBeNull();
    await wh.run(`UPDATE pit_sync SET covered_from = DATE '2025-09-01' WHERE dataset = 'blocks'`);
    const id = await enqueueEventColsIfNeeded((m) => logs.push(m));
    expect(id).toEqual(expect.any(String));
    expect(logs.at(-1)).toBe("事件数据的历史已补齐，排上事件因子按年补算");
    // 已经有一个在排队：不再排
    expect(await enqueueEventColsIfNeeded(() => {})).toBeNull();
    t.env.app.sqlite.prepare(`DELETE FROM jobs`).run();
    // 补完之后：签名、版本对得上，不排
    setEventColsClockForTest(() => cst("2026-10-09T10:00:00"));
    let r = await eventColsJob(fakeJobContext("event_cols", { market: "A" }));
    while (!r.complete) {
      t.env.app.sqlite.prepare(`DELETE FROM jobs`).run();
      r = await eventColsJob(fakeJobContext("event_cols", { market: "A" }));
    }
    t.env.app.sqlite.prepare(`DELETE FROM jobs`).run();
    expect(await enqueueEventColsIfNeeded(() => {})).toBeNull();
    // 覆盖起点换了月（重新回填得更早）：签名变了，排
    await wh.run(`UPDATE pit_sync SET covered_from = DATE '2025-08-01' WHERE dataset = 'margin'`);
    expect(await enqueueEventColsIfNeeded((m) => logs.push(m))).toEqual(expect.any(String));
    expect(logs.at(-1)).toMatch(
      /^事件因子的补算签名或版本变了（\w{8} v1 → \w{8} v1），排上按年补算$/,
    );
  });
});

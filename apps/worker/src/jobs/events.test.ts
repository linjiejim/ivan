/**
 * 点时事件数据的后台分段回填（S15，D81，验收 19、22）：不开数据版本（一晚因子写了一半后失败，接着跑一段回填，
 * committedAsOf 仍是前一天）；预算用完 1 分钟后再排一段；北京时间 16:30–21:00 不开新段；第二次排队 409。
 */
import { beginDataVersion, CANARY_SAMPLE_ROWS, commitDataVersion, committedAsOf } from "@ivan/data";
import {
  emEventsServer,
  eventColumnViolations,
  FakeHttp,
  loadFixture,
  seedSyntheticMarket,
} from "@ivan/data/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { etlContext } from "../env.ts";
import { createInternalApp } from "../internal.ts";
import { fakeJobContext, makeTestEnv } from "../testing/harness.ts";
import {
  EVENTS_REQUEUE_DELAY_MS,
  eventsJob,
  inEventsPause,
  nextAllowed,
  setEventsClockForTest,
} from "./events.ts";

type Row = Record<string, string | number | null>;
const fx = (name: string) =>
  (JSON.parse(loadFixture(name)) as { result: { data: Row[] } }).result.data;
const marginOn = (d: string) =>
  fx("em-rzrq-2026-09-29.json").map((r) => ({ ...r, DATE: `${d} 00:00:00` }));

/** 北京时间的毫秒时间戳 */
const cst = (s: string) => Date.parse(`${s}+08:00`);

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  setEventsClockForTest();
  vi.unstubAllEnvs();
  await cleanup?.();
  cleanup = undefined;
});

function eventData(): Record<string, Row[]> {
  return {
    RPTA_WEB_RZRQ_GGMX: [
      ...["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-02", "2026-10-08"].flatMap(marginOn),
    ],
    RPT_HOLDERNUM_DET: [
      ...fx("em-holdernum.json"),
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
    RPT_DATA_BLOCKTRADE: fx("em-blocktrade.json").map((r) => ({
      ...r,
      TRADE_DATE: "2026-09-29 00:00:00",
    })),
  };
}

/** 9-21 起 10 个工作日（到 10-02）已提交；然后一晚写了 10-05 的因子却没提交成功 */
async function setup(override?: Parameters<typeof emEventsServer>[1]) {
  const http = new FakeHttp([emEventsServer(eventData(), override)]);
  const t = await makeTestEnv({ http, today: "2026-10-09", cfg: { internalSecret: "s" } });
  cleanup = t.cleanup;
  const wh = t.env.wh;
  await seedSyntheticMarket(wh, {
    market: "A",
    start: "2026-09-21",
    days: 10,
    stocks: [
      "600519.SH",
      "000001.SZ",
      "000002.SZ",
      "688981.SH",
      "001366.SZ",
      "301358.SZ",
      "000603.SZ",
    ].map((code) => ({ code, name: code, close: () => 10 })),
  });
  expect(await committedAsOf(wh, "A")).toBe("2026-10-02");
  const ctx = etlContext(() => {});
  const ver = await beginDataVersion(ctx, "A", "daily");
  await wh.run(
    `INSERT INTO factors_daily SELECT * REPLACE (DATE '2026-10-05' AS date) FROM factors_daily WHERE date = DATE '2026-10-02'`,
  );
  await commitDataVersion(ctx, ver, { status: "incomplete" });
  expect(await committedAsOf(wh, "A")).toBe("2026-10-02");
  return { t, wh, http };
}

const versions = async (wh: Awaited<ReturnType<typeof setup>>["wh"]) =>
  wh.all<{ id: number; kind: string; status: string }>(
    `SELECT id, kind, status FROM data_versions ORDER BY id`,
  );

const queuedKinds = (t: Awaited<ReturnType<typeof setup>>["t"], kind: string) =>
  t.env.app.sqlite
    .prepare(`SELECT payload FROM jobs WHERE kind = ? AND status = 'queued'`)
    .all(kind) as Array<{ payload: string }>;

const queuedEvents = (t: Awaited<ReturnType<typeof setup>>["t"]) =>
  t.env.app.sqlite
    .prepare(
      `SELECT payload, not_before AS notBefore FROM jobs WHERE kind = 'events' AND status = 'queued'`,
    )
    .all() as Array<{ payload: string; notBefore: number | null }>;

describe("后台分段回填（events 任务）", () => {
  it("不开数据版本：一晚写了一半因子后失败，接着跑一段回填，committedAsOf 仍是前一天；行上 ver 为空、盖批次", async () => {
    const { t, wh, http } = await setup();
    const before = await versions(wh);
    setEventsClockForTest(() => cst("2026-10-09T10:00:00"));
    const ctx = fakeJobContext("events", { market: "A", since: "2026-09-01" });
    const r = await eventsJob(ctx);

    expect(await versions(wh)).toEqual(before);
    expect(await committedAsOf(wh, "A")).toBe("2026-10-02");
    expect(r).toMatchObject({
      again: false,
      complete: true,
      broken: [],
      notBefore: null,
      skipped: [],
    });
    expect(ctx.logs).toContain("事件数据回填完成");
    expect(queuedEvents(t)).toEqual([]);

    const batches = await wh.all<{
      id: number;
      kind: string;
      data_version: number | null;
      status: string;
      note: string;
    }>(`SELECT id, kind, data_version, status, note FROM pit_batches`);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ kind: "backfill", data_version: null });
    expect(batches[0]!.note).toMatch(/两融 \d+ \/ \d+ 天/);
    const margin = await wh.all<{ ver: number | null; batch: number }>(
      `SELECT DISTINCT ver, batch FROM margin_daily`,
    );
    expect(margin).toEqual([{ ver: null, batch: batches[0]!.id }]);
    expect(Number(await wh.scalar(`SELECT count(*) FROM lockups`))).toBeGreaterThan(0);
    // 回填完成，覆盖起点设上
    const sync = await wh.all<{ dataset: string; covered_from: string | null }>(
      `SELECT dataset, covered_from::VARCHAR AS covered_from FROM pit_sync ORDER BY dataset`,
    );
    expect(sync.every((s) => s.covered_from === "2026-09-01")).toBe(true);
    expect(eventColumnViolations(http.calls)).toEqual([]);
    // 全部做完：自动排上 S15b 的事件因子列补算（只排一个）
    expect(queuedKinds(t, "event_cols")).toEqual([{ payload: '{"market":"A"}' }]);
    expect(r.eventCols).toEqual(expect.any(String));
    await eventsJob(fakeJobContext("events", { market: "A", since: "2026-09-01" }));
    expect(queuedKinds(t, "event_cols")).toHaveLength(1);
  });

  it("预算用完：停在下一块之前，1 分钟后再排一段；同样不开数据版本", async () => {
    const { t, wh } = await setup();
    const before = await versions(wh);
    vi.stubEnv("EVENTS_JOB_BUDGET_MS", "5");
    // 每读一次时钟走 1 毫秒：几块之后就超预算
    let now = cst("2026-10-09T10:00:00");
    setEventsClockForTest(() => ++now);
    const r = await eventsJob(fakeJobContext("events", { market: "A", since: "2026-09-01" }));
    expect(r.again).toBe(true);
    const q = queuedEvents(t);
    expect(q).toHaveLength(1);
    expect(JSON.parse(q[0]!.payload)).toEqual({ market: "A", since: "2026-09-01" });
    expect(q[0]!.notBefore).toBe(r.notBefore);
    const delay = q[0]!.notBefore! - cst("2026-10-09T10:00:00");
    expect(delay).toBeGreaterThanOrEqual(EVENTS_REQUEUE_DELAY_MS);
    expect(delay).toBeLessThan(EVENTS_REQUEUE_DELAY_MS + 1000);
    expect(await versions(wh)).toEqual(before);
    expect(await committedAsOf(wh, "A")).toBe("2026-10-02");
    // 没做完不排补算
    expect(queuedKinds(t, "event_cols")).toEqual([]);
  });

  it.each([
    [
      "金丝雀回 9501",
      (url: string) => new URL(url).searchParams.get("pageSize") === String(CANARY_SAMPLE_ROWS),
    ],
    [
      "正式抓取中途回 9501",
      (url: string) => new URL(url).searchParams.get("pageSize") !== String(CANARY_SAMPLE_ROWS),
    ],
  ])(
    "%s：两融接口变了 → 不说「完成」、不重排，日志写明哪个接口；其他数据集照常补",
    async (_n, hit) => {
      const { t, wh } = await setup((report, url) =>
        report === "RPTA_WEB_RZRQ_GGMX" && hit(url)
          ? loadFixture("em-9501-schema-drift.json")
          : undefined,
      );
      setEventsClockForTest(() => cst("2026-10-09T10:00:00"));
      const ctx = fakeJobContext("events", { market: "A", since: "2026-09-01" });
      const r = await eventsJob(ctx);
      expect(r).toMatchObject({
        again: false,
        complete: false,
        broken: ["margin"],
        notBefore: null,
      });
      expect(ctx.logs).not.toContain("事件数据回填完成");
      expect(queuedKinds(t, "event_cols")).toEqual([]);
      expect(
        ctx.logs.some(
          (l) => l.startsWith("事件数据回填停下：") && l.includes("「两融明细」接口字段变了"),
        ),
      ).toBe(true);
      expect(queuedEvents(t)).toEqual([]);
      const sync = await wh.all<{ dataset: string; covered_from: string | null }>(
        `SELECT dataset, covered_from::VARCHAR AS covered_from FROM pit_sync ORDER BY dataset`,
      );
      expect(sync.find((s) => s.dataset === "margin")?.covered_from ?? null).toBeNull();
      expect(sync.find((s) => s.dataset === "lockups")?.covered_from).toBe("2026-09-01");
    },
  );

  it("北京时间 17:00 认领到：不跑，推到当天 21:00 再排", async () => {
    const { t, http } = await setup();
    setEventsClockForTest(() => cst("2026-10-09T17:00:00"));
    const r = await eventsJob(fakeJobContext("events", { market: "A" }));
    expect(r).toEqual({ deferred: true, notBefore: cst("2026-10-09T21:00:00") });
    expect(queuedEvents(t).map((j) => j.notBefore)).toEqual([cst("2026-10-09T21:00:00")]);
    expect(http.calls).toEqual([]);
  });

  it("16:30–21:00 之间不开新段（边界）", () => {
    expect(inEventsPause(cst("2026-10-09T16:29:59"))).toBe(false);
    expect(inEventsPause(cst("2026-10-09T16:30:00"))).toBe(true);
    expect(inEventsPause(cst("2026-10-09T20:59:59"))).toBe(true);
    expect(inEventsPause(cst("2026-10-09T21:00:00"))).toBe(false);
    expect(nextAllowed(cst("2026-10-09T16:29:00"))).toBe(cst("2026-10-09T16:29:00"));
    expect(nextAllowed(cst("2026-10-09T18:15:00"))).toBe(cst("2026-10-09T21:00:00"));
    expect(nextAllowed(cst("2026-10-09T23:30:00"))).toBe(cst("2026-10-09T23:30:00"));
  });
});

describe("/internal/events/backfill", () => {
  const post = (b: unknown) =>
    createInternalApp().request("/internal/events/backfill", {
      method: "POST",
      headers: { "x-internal-secret": "s", "content-type": "application/json" },
      body: JSON.stringify(b),
    });

  it("排一个 events 任务；已经有一个在排队或运行时 409；参数不对 400", async () => {
    const { t } = await setup();
    expect((await post({ datasets: ["margin", "nope"] })).status).toBe(400);
    expect((await post({ since: "2013/01/01" })).status).toBe(400);
    const first = await post({ datasets: ["lockups"], since: "2015-01-01" });
    expect(first.status).toBe(200);
    expect(queuedEvents(t).map((j) => JSON.parse(j.payload))).toEqual([
      { market: "A", datasets: ["lockups"], since: "2015-01-01" },
    ]);
    const second = await post({});
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe(
      "已经有一个事件数据回填在排队或运行",
    );
    expect(queuedEvents(t)).toHaveLength(1);
  });

  it("数据状态带上各数据集与回填进度", async () => {
    await setup();
    setEventsClockForTest(() => cst("2026-10-09T10:00:00"));
    await eventsJob(fakeJobContext("events", { market: "A", since: "2026-09-01" }));
    const res = await createInternalApp().request("/internal/data-status", {
      headers: { "x-internal-secret": "s" },
    });
    const body = (await res.json()) as {
      events: {
        datasets: Record<
          string,
          { label: string; coveredFrom: string | null; rows: number; canary: { status: string } }
        >;
        backfill: {
          status: string;
          progress: Record<string, { done: number; total: number }>;
          lastBatch: { status: string };
        };
      };
      factorCoverage: Record<string, { from: string | null; ready: boolean }>;
      eventFactors: {
        v: number;
        sig: string;
        complete: boolean;
        doneYears: number;
        totalYears: number;
      };
    };
    expect(body.events.datasets.margin).toMatchObject({
      label: "两融明细",
      coveredFrom: "2026-09-01",
    });
    expect(body.events.datasets.margin!.rows).toBeGreaterThan(0);
    expect(body.events.datasets.lockups!.canary.status).toMatch(/ok|empty/);
    expect(body.events.backfill.status).toBe("idle");
    expect(body.events.backfill.progress.margin!.done).toBe(
      body.events.backfill.progress.margin!.total,
    );
    // 事件因子（S15b）：数据起点 = 覆盖起点 + 预热；补算还没跑，都没 ready
    expect(body.factorCoverage.margin_chg_20d).toEqual({ from: "2026-10-11", ready: false });
    expect(body.factorCoverage.unlock_days).toEqual({ from: "2026-09-01", ready: false });
    expect(body.eventFactors).toMatchObject({ v: 1, complete: false, doneYears: 0, totalYears: 1 });
  });
});

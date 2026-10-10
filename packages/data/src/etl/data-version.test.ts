/**
 * 数据版本先开后提交（D60）：open → ok / incomplete / failed / skipped；只有 ok 能被引用；
 * 夜间增量在写任何东西之前开版本，指数与日历也盖上版本号；休市提交 skipped；出错提交 failed 再抛。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { committedAsOf, latestDataVersion } from "../query/backtest.ts";
import { FakeHttp } from "../testing/fake-http.ts";
import { Warehouse } from "../warehouse/db.ts";
import type { EtlContext } from "./context.ts";
import { backfill, beginDataVersion, commitDataVersion, daily, weeklyCheck } from "./pipeline.ts";

let wh: Warehouse;
const logs: string[] = [];
const ctxOf = (http = new FakeHttp([]), today = "2025-10-06"): EtlContext => ({
  wh,
  http,
  today,
  log: (m) => logs.push(m),
});

beforeEach(async () => {
  wh = await Warehouse.open(":memory:");
  logs.length = 0;
});
afterEach(() => wh.close());

async function versions() {
  return wh.all<{ id: number; status: string; as_of: string | null; kind: string; note: string | null }>(
    `SELECT id, status, as_of::VARCHAR AS as_of, kind, note FROM data_versions ORDER BY id`,
  );
}

async function factorsUpTo(d: string) {
  await wh.run(
    `INSERT INTO factors_daily (code, date, market, close) VALUES ('600000.SH', $d::DATE, 'A', 10)`,
    { d },
  );
}

describe("beginDataVersion / commitDataVersion", () => {
  it("开出来是 open、没有截至日；提交 ok 后截至日 = 因子表最新日期", async () => {
    await factorsUpTo("2025-09-30");
    const ctx = ctxOf();
    const id = await beginDataVersion(ctx, "A", "daily");
    expect(await versions()).toEqual([
      { id, status: "open", as_of: null, kind: "daily", note: null },
    ]);
    expect(await wh.scalar(`SELECT registry_version FROM data_versions WHERE id = $id`, { id })).toBe(2);
    expect(await latestDataVersion(wh, "A")).toEqual({ id: null, asOf: null });
    const r = await commitDataVersion(ctx, id, { status: "ok" });
    expect(r).toEqual({ id, asOf: "2025-09-30" });
    expect(await latestDataVersion(wh, "A")).toEqual({ id, asOf: "2025-09-30" });
  });

  it("latestDataVersion 跳过 open、failed、incomplete、skipped，旧行（status 为空）算 ok", async () => {
    await factorsUpTo("2025-09-29");
    await wh.run(
      `INSERT INTO data_versions (id, market, as_of, kind) VALUES (nextval('data_version_seq'), 'A', DATE '2025-09-26', 'daily')`,
    );
    const legacy = (await latestDataVersion(wh, "A")).id;
    expect(legacy).not.toBeNull();
    const ctx = ctxOf();
    for (const status of ["failed", "incomplete", "skipped"] as const) {
      const id = await beginDataVersion(ctx, "A", "daily");
      await commitDataVersion(ctx, id, { status });
    }
    await beginDataVersion(ctx, "A", "daily");
    expect(await latestDataVersion(wh, "A")).toEqual({ id: legacy, asOf: "2025-09-26" });
    // incomplete 有截至日（S13 用），skipped / failed 没有
    expect((await versions()).map((v) => [v.status, v.as_of])).toEqual([
      [null, "2025-09-26"],
      ["failed", null],
      ["incomplete", "2025-09-29"],
      ["skipped", null],
      ["open", null],
    ]);
  });

  it("再开一个版本时，残留的 open 版本被关成 failed 并注明中断", async () => {
    const ctx = ctxOf();
    const stale = await beginDataVersion(ctx, "A", "daily");
    const hk = await beginDataVersion(ctx, "HK", "daily");
    const next = await beginDataVersion(ctx, "A", "check");
    const rows = await versions();
    expect(rows.find((v) => v.id === stale)).toMatchObject({ status: "failed", note: "中断" });
    // 别的市场的 open 版本不受影响
    expect(rows.find((v) => v.id === hk)).toMatchObject({ status: "open" });
    expect(rows.find((v) => v.id === next)).toMatchObject({ status: "open", kind: "check" });
  });
});

/** 东财指数日 K：日期,开,收 */
const emIndex = (days: string[]) => ({
  rc: 0,
  data: { code: "000001", decimal: 2, klines: days.map((d, i) => `${d},${3000 + i},${3001 + i}`) },
});

describe("daily() 的数据版本", () => {
  it("休市：先开版本再更新指数与日历（盖上版本号），然后提交 skipped，不会被引用", async () => {
    await factorsUpTo("2025-09-30");
    const http = new FakeHttp([
      { match: /push2his\.eastmoney\.com/, reply: emIndex(["2025-09-29", "2025-09-30"]) },
    ]);
    const r = await daily(ctxOf(http, "2025-10-06"), "A");
    expect(r).toMatchObject({ tradingDay: false, latest: "2025-09-30" });
    const [v] = await versions();
    expect(v).toMatchObject({ status: "skipped", as_of: null, note: "休市" });
    const idx = await wh.all<{ sym: string; ver: number; src: string }>(
      `SELECT DISTINCT sym, ver, src FROM index_bars ORDER BY sym`,
    );
    expect(idx.length).toBeGreaterThan(0);
    for (const row of idx) expect(row).toMatchObject({ ver: v!.id, src: "em" });
    expect(await wh.all(`SELECT DISTINCT ver FROM trade_calendar`)).toEqual([{ ver: v!.id }]);
    expect(await latestDataVersion(wh, "A")).toEqual({ id: null, asOf: null });
  });

  it("出错：版本记成 failed（带原因）再把错误抛出去；下一次开版本不受影响", async () => {
    // 日历指数拉不到：核心步骤失败
    await expect(daily(ctxOf(new FakeHttp([]), "2025-10-09"), "A")).rejects.toThrow();
    const [v] = await versions();
    expect(v!.status).toBe("failed");
    expect(v!.note).toContain("FakeHttp");
    const next = await beginDataVersion(ctxOf(), "A", "daily");
    expect((await versions()).map((x) => [x.id, x.status])).toEqual([
      [v!.id, "failed"],
      [next, "open"],
    ]);
  });
});

describe("不新增交易日的提交不前移截至日", () => {
  /** 周四提交了 ok；周五写了一半因子后失败（版本 failed） */
  async function failedNightAfterCommit() {
    const ctx = ctxOf();
    await factorsUpTo("2025-10-02");
    await commitDataVersion(ctx, await beginDataVersion(ctx, "A", "daily"), { status: "ok" });
    const fri = await beginDataVersion(ctx, "A", "daily");
    await factorsUpTo("2025-10-03");
    await commitDataVersion(ctx, fri, { status: "failed", note: "进程被重启" });
  }

  it("每周抽检提交 ok，但截至日还是失败夜之前提交过的那天", async () => {
    await failedNightAfterCommit();
    const r = await weeklyCheck(ctxOf(new FakeHttp([]), "2025-10-05"), "A");
    expect(r).toEqual({ checked: 0, revisedRows: 0, repaired: [], flagged: 0 });
    const last = (await versions()).at(-1)!;
    expect(last).toMatchObject({ kind: "check", status: "ok", as_of: "2025-10-02" });
    expect(await committedAsOf(wh, "A")).toBe("2025-10-02");
  });

  it("从没提交过时，抽检不给截至日", async () => {
    await factorsUpTo("2025-10-03");
    await weeklyCheck(ctxOf(new FakeHttp([]), "2025-10-05"), "A");
    expect((await versions()).at(-1)).toMatchObject({ kind: "check", status: "ok", as_of: null });
    expect(await committedAsOf(wh, "A")).toBeNull();
  });

  it("按代码回填也不前移截至日", async () => {
    await failedNightAfterCommit();
    await backfill(ctxOf(new FakeHttp([]), "2025-10-05"), "A", {
      codes: ["000001.SZ"],
      steps: ["factors"],
    });
    expect((await versions()).at(-1)).toMatchObject({ kind: "backfill", status: "ok", as_of: "2025-10-02" });
    expect(await committedAsOf(wh, "A")).toBe("2025-10-02");
  });

  it("截至日没超过上限时照常取因子表最新日期", async () => {
    await factorsUpTo("2025-10-02");
    const ctx = ctxOf();
    const id = await beginDataVersion(ctx, "A", "check");
    expect(await commitDataVersion(ctx, id, { status: "ok", maxAsOf: "2025-10-03" })).toEqual({
      id,
      asOf: "2025-10-02",
    });
  });
});

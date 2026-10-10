/**
 * 内部接口 /internal/data-status：每个市场带今天的状态 day（D78）、正在写的版本与采集情况（D60、D61）；
 * 维护状态（行情仓还没升级，D76）下健康检查照常 200、读行情仓的接口 503。
 */
import { MAINTENANCE_V3 } from "@ivan/data";
import { jobs, newId } from "@ivan/db";
import { afterEach, describe, expect, it } from "vitest";
import { createInternalApp } from "./internal.ts";
import { makeTestEnv } from "./testing/harness.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe("/internal/data-status", () => {
  it("每个市场都带今天的状态：没跑过 etl 是 pending，etl 返回非交易日是 closed", async () => {
    const t = await makeTestEnv({ today: "2026-10-05", cfg: { internalSecret: "s" } });
    cleanup = t.cleanup;
    t.env.app.db
      .insert(jobs)
      .values({
        id: newId("j_"),
        kind: "etl",
        payload: { market: "HK" },
        status: "done",
        result: { market: "HK", tradingDay: false, latest: "2026-09-30" },
        createdAt: Date.parse("2026-10-05T17:00:00+08:00"),
      })
      .run();
    const res = await createInternalApp().request("/internal/data-status", {
      headers: { "x-internal-secret": "s" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { markets: Array<{ market: string; day: string }> };
    expect(body.markets.map((m) => [m.market, m.day])).toEqual([
      ["A", "pending"],
      ["HK", "closed"],
    ]);
  });
});

const get = (path: string, init: RequestInit = {}) =>
  createInternalApp().request(path, {
    ...init,
    headers: { "x-internal-secret": "s", "content-type": "application/json" },
  });

describe("数据版本、写库暂停与采集情况", () => {
  it("有 open 版本时报出版本号与开始时间；etl 排队时 computePaused；带上采集情况", async () => {
    const t = await makeTestEnv({ today: "2026-10-20", cfg: { internalSecret: "s" } });
    cleanup = t.cleanup;
    await t.env.wh.run(
      `INSERT INTO data_versions (id, market, as_of, kind, status) VALUES (1, 'A', DATE '2026-10-16', 'daily', 'skipped'),
         (2, 'A', NULL, 'daily', 'open')`,
    );
    await t.env.wh.run(
      `UPDATE data_versions SET started_at = TIMESTAMP '2026-10-20 17:30:05' WHERE id = 2`,
    );
    t.env.app.db
      .insert(jobs)
      .values({
        id: newId("j_"),
        kind: "etl",
        payload: { market: "A" },
        status: "running",
        createdAt: 5,
        startedAt: 7,
      })
      .run();
    const body = (await (await get("/internal/data-status")).json()) as {
      maintenance: string | null;
      computePaused: { reason: string; since: number } | null;
      markets: Array<{
        market: string;
        openVersion: { id: number; startedAt: number } | null;
        lastVersionStatus: string | null;
        capture: { attrs: Array<{ attr: string }>; financialsSeen: { rows: number } };
      }>;
    };
    expect(body.maintenance).toBeNull();
    expect(body.computePaused).toEqual({ reason: "etl", since: 7 });
    const a = body.markets.find((m) => m.market === "A")!;
    // 库里是 DuckDB 时区（默认本机时区）下的本地时间，和 JS 的本地时间一致
    expect(a.openVersion).toEqual({ id: 2, startedAt: new Date("2026-10-20T17:30:05").getTime() });
    expect(a.lastVersionStatus).toBe("skipped");
    expect(a.capture.attrs.map((x) => x.attr)).toEqual(["industry_l1", "industry"]);
    const hk = body.markets.find((m) => m.market === "HK")!;
    expect(hk.capture.attrs.map((x) => x.attr)).toEqual([
      "industry_l1",
      "lot_size",
      "hk_connect_sz",
    ]);
    expect(hk.openVersion).toBeNull();
  });

  it("带上最近一晚的取数来源（D72）：只看夜间增量、跳过休市夜；没有台账时为 null", async () => {
    const t = await makeTestEnv({ today: "2026-10-20", cfg: { internalSecret: "s" } });
    cleanup = t.cleanup;
    const ledger = (served: object) =>
      JSON.stringify({
        v: 1,
        served,
        fallbacks: 2,
        empty: 0,
        failed: 1,
        failures: [],
        index: { sse: "em" },
      });
    await t.env.wh.run(
      `INSERT INTO data_versions (id, market, as_of, kind, status, started_at, sources) VALUES
         (1, 'A', DATE '2026-10-19', 'daily', 'ok', TIMESTAMP '2026-10-19 17:30:00', $a),
         (2, 'A', NULL, 'daily', 'skipped', TIMESTAMP '2026-10-20 17:30:00', $b),
         (3, 'A', DATE '2026-10-19', 'check', 'ok', TIMESTAMP '2026-10-20 18:00:00', NULL)`,
      { a: ledger({ em: 120, tx: 3, txq: 5227 }), b: ledger({}) },
    );
    const body = (await (await get("/internal/data-status")).json()) as {
      markets: Array<{ market: string; sources: unknown }>;
    };
    expect(body.markets.find((m) => m.market === "A")!.sources).toEqual({
      versionId: 1,
      status: "ok",
      date: "2026-10-19",
      served: { em: 120, tx: 3, txq: 5227 },
      fallbacks: 2,
      failed: 1,
      empty: 0,
      index: { sse: "em" },
      // 第 1 版台账没有事件数据集
      datasets: {},
    });
    expect(body.markets.find((m) => m.market === "HK")!.sources).toBeNull();
  });

  it("维护状态：健康检查 200 带说明，数据状态只报维护，读行情仓的接口 503", async () => {
    const t = await makeTestEnv({ cfg: { internalSecret: "s" } });
    cleanup = t.cleanup;
    t.env.wh.maintenance = MAINTENANCE_V3;
    const health = await get("/internal/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, maintenance: MAINTENANCE_V3 });
    const status = await get("/internal/data-status");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      markets: [],
      maintenance: MAINTENANCE_V3,
      computePaused: null,
    });
    const screen = await get("/internal/screen", { method: "POST", body: "{}" });
    expect(screen.status).toBe(503);
    expect(await screen.json()).toEqual({ error: MAINTENANCE_V3 });
    expect((await get("/internal/securities/search?q=600")).status).toBe(503);
  });
});

describe("完整性闸门与数据质量（D73、D74）", () => {
  it("排着队等自动重跑：lastEtl 带重跑时间、第几次与上一次失败的原因；辅助步骤带连续失败晚数", async () => {
    const t = await makeTestEnv({ today: "2026-10-09", cfg: { internalSecret: "s" } });
    cleanup = t.cleanup;
    const at = Date.parse("2026-10-09T17:40:00+08:00");
    t.env.app.db
      .insert(jobs)
      .values([
        {
          id: newId("j_"),
          kind: "etl",
          payload: { market: "A" },
          status: "failed",
          error: "A 股有 12 只股票今天的日线没拿到，已停止更新，以免被当成停牌",
          createdAt: at - 60_000,
        },
        {
          id: newId("j_"),
          kind: "etl",
          payload: { market: "A" },
          status: "queued",
          createdAt: at,
          notBefore: at + 45 * 60_000,
          attempt: 1,
        },
      ])
      .run();
    for (const [d, ok] of [
      ["2026-10-05", true],
      ["2026-10-06", false],
      ["2026-10-07", false],
      ["2026-10-08", false],
    ] as const) {
      await t.env.wh.run(
        `INSERT INTO data_versions (id, market, as_of, kind, status, completeness)
         VALUES (nextval('data_version_seq'), 'A', $d::DATE, 'daily', 'ok', $c)`,
        { d, c: JSON.stringify({ date: d, noTrade: 40, soft: [{ step: "fundamentals", ok }] }) },
      );
    }
    // 今晚闸门没过：版本 incomplete，没跑到财报那一步
    await t.env.wh.run(
      `INSERT INTO data_versions (id, market, as_of, kind, status, completeness)
       VALUES (nextval('data_version_seq'), 'A', DATE '2026-10-08', 'daily', 'incomplete', $c)`,
      {
        c: JSON.stringify({
          date: "2026-10-09",
          ok: false,
          soft: [{ step: "securities", ok: true }],
        }),
      },
    );
    const body = (await (await get("/internal/data-status")).json()) as {
      markets: Array<{
        market: string;
        day: string;
        lastEtl: { status: string; error: string | null; attempt: number; retryAt: number | null };
        soft: Array<{ step: string; lastOkDate: string | null; failingNights: number }>;
      }>;
    };
    const a = body.markets.find((m) => m.market === "A")!;
    expect(a.day).toBe("stale");
    expect(a.lastEtl).toMatchObject({
      status: "queued",
      attempt: 1,
      retryAt: at + 45 * 60_000,
      error: "A 股有 12 只股票今天的日线没拿到，已停止更新，以免被当成停牌",
    });
    expect(a.soft).toEqual([
      { step: "securities", lastOkDate: "2026-10-09", failingNights: 0, firstFailDate: null },
      {
        step: "fundamentals",
        lastOkDate: "2026-10-05",
        failingNights: 3,
        firstFailDate: "2026-10-06",
      },
    ]);
  });

  it("数据质量：按规则统计、问题最多的代码、未解决列表；管理员标为已核对后从列表里消失", async () => {
    const t = await makeTestEnv({ cfg: { internalSecret: "s" } });
    cleanup = t.cleanup;
    await t.env.wh.run(
      `INSERT INTO data_versions (id, market, as_of, kind, status) VALUES (7, 'A', DATE '2026-10-08', 'daily', 'ok')`,
    );
    await t.env.wh.run(
      `INSERT INTO data_issues (ver, dataset, code, date, rule, severity, detail, src) VALUES
         (7, 'bars', '600000.SH', DATE '2026-10-08', 'ohlc', 'reject', '高低价和开收对不上', 'em'),
         (7, 'bars', '600000.SH', DATE '2026-10-07', 'ohlc', 'reject', '高低价和开收对不上', 'em'),
         (7, 'bars', '600001.SH', DATE '2026-10-08', 'calendar', 'reject', '日期不在交易日历里', 'em'),
         (7, 'bars', '600001.SH', DATE '2026-10-08', 'stale_print', 'flag', '开高低收量与前一天完全相同', 'txq')`,
    );
    const q = (await (await get("/internal/data-quality?days=7")).json()) as {
      byRule: Array<{ rule: string; severity: string; n: number; open: number }>;
      topCodes: Array<{ code: string; n: number }>;
      open: Array<{ id: number; code: string; rule: string }>;
    };
    expect(q.byRule).toEqual([
      { rule: "ohlc", severity: "reject", n: 2, open: 2 },
      { rule: "calendar", severity: "reject", n: 1, open: 1 },
      { rule: "stale_print", severity: "flag", n: 1, open: 1 },
    ]);
    expect(q.topCodes.map((c) => [c.code, c.n])).toEqual([
      ["600000.SH", 2],
      ["600001.SH", 2],
    ]);
    expect(q.open).toHaveLength(4);
    const flag = q.open.find((o) => o.rule === "stale_print")!;
    const res = await get(`/internal/data-issues/${flag.id}/resolve`, { method: "POST" });
    expect(await res.json()).toEqual({ id: flag.id, resolvedVer: 7, resolvedBy: "admin" });
    const after = (await (await get("/internal/data-quality")).json()) as typeof q;
    expect(after.open.map((o) => o.rule)).not.toContain("stale_print");
    expect(after.byRule.find((r) => r.rule === "stale_print")).toMatchObject({ n: 1, open: 0 });
    expect((await get("/internal/data-issues/99999/resolve", { method: "POST" })).status).toBe(404);
    expect((await get("/internal/data-issues/abc/resolve", { method: "POST" })).status).toBe(400);
  });
});

describe("基准首个数据日与港股通名单（D75、D77）", () => {
  it("data-status 带各基准首个数据日与港股通名单；按数据版本缓存，提交新版本才重算", async () => {
    const t = await makeTestEnv({ today: "2026-10-09", cfg: { internalSecret: "s" } });
    cleanup = t.cleanup;
    await t.env.wh.run(
      `INSERT INTO data_versions (id, market, as_of, kind, status) VALUES
         (1, 'A', DATE '2026-10-08', 'daily', 'ok'), (2, 'HK', DATE '2026-10-08', 'daily', 'ok')`,
    );
    await t.env.wh.run(
      `INSERT INTO index_bars (sym, date, close, provisional) VALUES
         ('csi300_tr', DATE '2013-01-04', 1, false), ('csi1000_tr', DATE '2014-10-17', 1, false),
         ('hsi_tr', DATE '2013-01-02', 1, false)`,
    );
    type Body = {
      markets: Array<{
        market: string;
        benchFirstDates: Record<string, string | null>;
        hkConnect?: { attrs: string[]; firstDate: string } | null;
      }>;
    };
    const status = async () => (await (await get("/internal/data-status")).json()) as Body;
    let body = await status();
    const a = body.markets.find((m) => m.market === "A")!;
    expect(a.benchFirstDates).toEqual({
      csi300_tr: "2013-01-04",
      sse: null,
      csi500_tr: null,
      csi1000_tr: "2014-10-17",
      csi_div_tr: null,
    });
    expect(a.hkConnect).toBeNull();
    expect(body.markets.find((m) => m.market === "HK")!).toMatchObject({
      benchFirstDates: { hsi_tr: "2013-01-02", hscei_tr: null },
      hkConnect: null,
    });

    // 名单与新指数写进来了，但版本没变：还是缓存的结果
    await t.env.wh.append("attr_history", [
      ["00700.HK", "hk_connect_sz", "Y", "2026-10-09", null, "em", 3],
    ]);
    await t.env.wh.run(
      `INSERT INTO index_bars (sym, date, close, provisional) VALUES ('csi_div_tr', DATE '2013-01-04', 1, false)`,
    );
    body = await status();
    expect(body.markets.find((m) => m.market === "HK")!.hkConnect).toBeNull();
    // 提交新版本后重算
    await t.env.wh.run(
      `INSERT INTO data_versions (id, market, as_of, kind, status) VALUES
         (3, 'A', DATE '2026-10-09', 'daily', 'ok'), (4, 'HK', DATE '2026-10-09', 'daily', 'ok')`,
    );
    body = await status();
    expect(body.markets.find((m) => m.market === "A")!.benchFirstDates.csi_div_tr).toBe(
      "2013-01-04",
    );
    expect(body.markets.find((m) => m.market === "HK")!.hkConnect).toEqual({
      attrs: ["hk_connect_sz"],
      firstDate: "2026-10-09",
    });
  });

  it("港股通名单没有记录时，选股接口给 400 和中文原因", async () => {
    const t = await makeTestEnv({ cfg: { internalSecret: "s" } });
    cleanup = t.cleanup;
    await t.env.wh.run(
      `INSERT INTO data_versions (id, market, as_of, kind, status) VALUES (1, 'HK', DATE '2026-10-08', 'daily', 'ok')`,
    );
    const res = await get("/internal/screen", {
      method: "POST",
      body: JSON.stringify({
        spec: {
          name: "港股通",
          market: "HK",
          universe: { hkConnect: true },
          rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 5 },
        },
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "港股通名单还没有记录，等今晚证券表刷新后再试" });
  });
});

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

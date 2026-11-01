/**
 * 用户路径的场景测试（验收 17）：从种好的行情出发，走完真实的任务代码，再断言模型实际看到的摘要。
 * （a）跟踪一晚结算 → 计划快照 → get_plan 的模型输出带原因、名次与数据版本。
 * （b）默认成交假设的小盘回测 → get_run 的模型输出带容量提示、区间与行情来源。
 * （c）R5 升级（S15b，验收 20）：第 4 版行情仓上的旧回测与运行中的跟踪 → 迁移到第 5 版 + 事件列按年补算 →
 *     核心列逐字节不变、旧回测「输入一致」且完整重跑逐笔一致、跟踪 0 漂移且不加计划版次；用解禁因子的新回测运行卡带 data.events。
 * （d）从首版 R0（R1 之前）升级：运行卡之前的旧回测（收尾有待执行的卖单）复核「早于指纹记录」、完整重跑逐笔一致；
 *     旧形状的跟踪第一晚 0 漂移、健康度补算一次、计划第 1 版，同一晚再结算什么都不加。
 */
import { planForModel, type RunModelInput, runForModel } from "@ivan/ai";
import { join } from "node:path";
import {
  defaultExec,
  EVENT_FACTOR_KEYS,
  type Metrics,
  type RunCard,
  type StrategySpec,
  StrategySpecSchema,
} from "@ivan/core";
import { sha256Canonical, specHashOf } from "@ivan/core/node";
import { FACTOR_COLUMNS, MAINTENANCE_V5, Warehouse } from "@ivan/data";
import { seedSyntheticMarket } from "@ivan/data/testing";
import {
  type AppDbHandle,
  newId,
  planItemsOf,
  planSnapshots,
  runs,
  strategies,
  strategyVersions,
  trackings,
} from "@ivan/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backtestJob } from "./jobs/backtest.ts";
import { eventColsJob, setEventColsClockForTest } from "./jobs/event-cols.ts";
import { settleMarket } from "./jobs/settle.ts";
import { verifyJob } from "./jobs/verify.ts";
import { fakeJobContext, makeTestEnv, seedTracking } from "./testing/harness.ts";

let t: Awaited<ReturnType<typeof makeTestEnv>>;
beforeEach(async () => {
  t = await makeTestEnv();
});
afterEach(() => t.cleanup());

describe("场景（验收 17）", () => {
  it("（a）跟踪一晚结算 → 计划快照 → get_plan 的模型输出带原因文字、名次与数据版本", async () => {
    // 03-02 … 03-06：周五 S1 市盈率升到 9.5（掉出前 2 名），下周一调仓
    await seedSyntheticMarket(t.env.wh, {
      market: "A",
      start: "2026-03-02",
      days: 5,
      stocks: ["600001.SH", "600002.SH", "600003.SH", "600004.SH"].map((code, k) => ({
        code,
        name: `股${k + 1}`,
        close: () => 10,
        factors: (i: number) => ({ pe_ttm: i === 4 && k === 0 ? 9.5 : 5 + k }),
      })),
    });
    const spec = StrategySpecSchema.parse({
      name: "周度低估值",
      market: "A",
      rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 2 },
      rebalance: { every: "week", buffer: 1 },
    });
    const { trackingId } = seedTracking(t.env.app, { spec, startDate: "2026-03-03" });
    const r = await settleMarket("A", fakeJobContext("settle", { market: "A" }));
    expect(r).toEqual({ settled: 1, failed: 0 });

    const snap = t.env.app.db
      .select()
      .from(planSnapshots)
      .where(eq(planSnapshots.trackingId, trackingId))
      .get()!;
    const m = planForModel(snap, planItemsOf(t.env.app, snap.id));
    expect(m).toMatchObject({
      decisionDate: "2026-03-06",
      planDate: "2026-03-09",
      planDateBasis: "holiday_table",
      edition: 1,
      cause: "initial",
      dataAsOf: "2026-03-06",
      dataVersion: expect.any(Number),
    });
    const sell = m.items.find((i) => i.side === "sell")!;
    expect(sell).toMatchObject({ name: "股1", reasonText: "掉出前 2 名（排第 4）", rank: 4 });
    const buy = m.items.find((i) => i.side === "buy")!;
    expect(buy).toMatchObject({ name: "股3", reasonText: "建仓", rank: 2 });
    expect(buy.keyFactors[0]).toMatchObject({ value: 7, unit: "x" });
    expect(m.note).toMatch(/不构成投资建议/);
  });

  it("（b）默认成交假设的小盘回测 → get_run 的模型输出带容量提示、超额区间与行情来源", async () => {
    await seedSyntheticMarket(t.env.wh, {
      market: "A",
      start: "2025-01-06",
      days: 120,
      stocks: ["600001.SH", "600002.SH", "600003.SH", "600004.SH"].map((code, k) => ({
        code,
        name: `股${k}`,
        close: (i: number) => 10 + k + Math.sin(i / 5 + k) * 2,
        // 股0、股2 是小盘：20 日均成交额只有 50 万
        factors: (i: number) => ({
          pe_ttm: 5 + ((i + k * 7) % 11),
          turnover_20d: k % 2 === 0 ? 0.005 : 5 + k,
          volatility_60d: 30,
        }),
      })),
    });
    // 行级来源：前段东财、后段腾讯报价，其余来源未记录
    await t.env.wh.run(`UPDATE bars_daily SET src = 'em' WHERE date < DATE '2025-04-01'`);
    await t.env.wh.run(`UPDATE bars_daily SET src = 'txq' WHERE date >= DATE '2025-06-01'`);
    const spec = StrategySpecSchema.parse({
      name: "小盘低估值",
      market: "A",
      rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 2 },
    });
    const strategyId = newId("s_");
    const versionId = newId("v_");
    const runId = newId("r_");
    const { db } = t.env.app;
    db.insert(strategies)
      .values({
        id: strategyId,
        userId: "u_test",
        name: spec.name,
        market: "A",
        currentVersionId: versionId,
      })
      .run();
    db.insert(strategyVersions)
      .values({
        id: versionId,
        strategyId,
        n: 1,
        spec: spec as unknown as Record<string, unknown>,
        specHash: specHashOf(spec),
      })
      .run();
    db.insert(runs)
      .values({
        id: runId,
        userId: "u_test",
        strategyId,
        versionId,
        kind: "backtest",
        params: {
          start: "2025-02-03",
          end: "2025-06-20",
          capital: 1_000_000,
          oosMonths: 0,
          exec: defaultExec("A"),
          priorVersions: 0,
        },
      })
      .run();
    await backtestJob(fakeJobContext("backtest", { runId }));
    const r = db.select().from(runs).where(eq(runs.id, runId)).get()!;
    expect(r.status).toBe("done");
    // 和 server getRun 给模型的字段同形
    const input: RunModelInput = {
      id: r.id,
      status: r.status,
      error: r.error,
      dataAsOf: r.dataAsOf,
      engineVersion: r.engineVersion,
      cardHash: r.cardHash,
      exec: defaultExec("A"),
      metrics: r.metrics as unknown as Metrics,
      segments: r.segments as unknown as RunModelInput["segments"],
      diagnostics: r.diagnostics as unknown as RunModelInput["diagnostics"],
      validation: r.validation as unknown as RunModelInput["validation"],
      checks: r.checks as unknown as RunModelInput["checks"],
      card: r.card,
    };
    const m = runForModel(input) as Record<string, unknown> & {
      checks: Array<{ title: string; detail: string }>;
      dataSources: { bySource: Record<string, number>; rows: number; gapDays: number };
    };
    expect(m.checks.some((c) => /容量/.test(c.title))).toBe(true);
    expect(m.capacityEstimate).toEqual(expect.any(Number));
    const ci = m.excessCagrCi as [number, number];
    expect(ci).toHaveLength(2);
    expect(ci[0]).toBeLessThanOrEqual(ci[1]);
    expect(Object.keys(m.dataSources.bySource).sort()).toEqual(["东方财富", "来源未记录", "腾讯"]);
    const shares = Object.values(m.dataSources.bySource);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    expect(m.dataSources.rows).toBeGreaterThan(0);
    expect(m.dataSources.gapDays).toBe(0);
  });
});

/** 照 server 的做法插一条回测（scenario b 同款） */
function insertRun(
  app: AppDbHandle,
  spec: StrategySpec,
  params: Record<string, unknown>,
  o: { kind?: string; strategyId?: string; versionId?: string } = {},
): { runId: string; strategyId: string; versionId: string } {
  const strategyId = o.strategyId ?? newId("s_");
  const versionId = o.versionId ?? newId("v_");
  const runId = newId("r_");
  if (!o.strategyId) {
    app.db
      .insert(strategies)
      .values({
        id: strategyId,
        userId: "u_test",
        name: spec.name,
        market: "A",
        currentVersionId: versionId,
      })
      .run();
    app.db
      .insert(strategyVersions)
      .values({
        id: versionId,
        strategyId,
        n: 1,
        spec: spec as unknown as Record<string, unknown>,
        specHash: specHashOf(spec),
      })
      .run();
  }
  app.db
    .insert(runs)
    .values({
      id: runId,
      userId: "u_test",
      strategyId,
      versionId,
      kind: o.kind ?? "backtest",
      params,
    })
    .run();
  return { runId, strategyId, versionId };
}

describe("场景（验收 20，S15b）", () => {
  it("（c）R5 升级：迁移 + 事件列补算后，旧回测输入一致、逐笔一致，跟踪 0 漂移、不加计划版次；新回测带 data.events", async () => {
    // 文件行情仓（要关掉重开才能走升级）
    const path = join(t.dir, "warehouse.duckdb");
    t.env.wh.close();
    let wh = await Warehouse.open(path);
    t.env.wh = wh;
    const { calendar } = await seedSyntheticMarket(wh, {
      market: "A",
      start: "2025-11-03",
      days: 80,
      stocks: ["600001.SH", "600002.SH", "600003.SH", "600004.SH"].map((code, k) => ({
        code,
        name: `股${k}`,
        close: (i: number) => 10 + k + Math.sin(i / 5 + k) * 2,
        factors: (i: number) => ({
          pe_ttm: 5 + ((i + k * 7) % 11),
          turnover_20d: 5 + k,
          volatility_60d: 30,
        }),
      })),
    });
    const last = calendar.at(-1)!;
    const prev = calendar.at(-2)!;
    // 最后一天的因子先不提交（第二晚再加上）
    await wh.run(`CREATE TABLE held AS SELECT * FROM factors_daily WHERE date = $d::DATE`, {
      d: last,
    });
    await wh.run(`DELETE FROM factors_daily WHERE date = $d::DATE`, { d: last });
    await wh.run(`UPDATE data_versions SET as_of = $d::DATE`, { d: prev });
    // 退回第 4 版（R4 的行情仓：没有事件因子列）
    await wh.migrateDown(4);

    // R4 时代：一次回测、一个运行中的跟踪（第一晚结算出计划快照）
    const spec = StrategySpecSchema.parse({
      name: "低估值",
      market: "A",
      rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 2 },
      rebalance: { every: "week", buffer: 1 },
    });
    const old = insertRun(t.env.app, spec, {
      start: "2025-12-01",
      end: prev,
      capital: 1_000_000,
      oosMonths: 0,
      exec: defaultExec("A"),
      priorVersions: 0,
    });
    await backtestJob(fakeJobContext("backtest", { runId: old.runId }));
    const oldRun = t.env.app.db.select().from(runs).where(eq(runs.id, old.runId)).get()!;
    expect(oldRun.status).toBe("done");
    const { trackingId } = seedTracking(t.env.app, { spec, startDate: "2025-12-01" });
    expect(await settleMarket("A", fakeJobContext("settle", { market: "A" }))).toEqual({
      settled: 1,
      failed: 0,
    });
    const snaps = () =>
      t.env.app.db
        .select()
        .from(planSnapshots)
        .where(eq(planSnapshots.trackingId, trackingId))
        .all();
    const snapsBefore = snaps();
    expect(snapsBefore).toHaveLength(1);
    const CORE = [
      "code",
      "date::VARCHAR AS date",
      "market",
      "close",
      ...FACTOR_COLUMNS.filter((k) => !EVENT_FACTOR_KEYS.includes(k)),
    ];
    const coreHash = async () =>
      sha256Canonical(
        await t.env.wh.all(`SELECT ${CORE.join(", ")} FROM factors_daily ORDER BY code, date`),
      );
    const coreBefore = await coreHash();

    // 部署 R5：worker 用 light 打开进维护状态；scripts/migrate.sh 用 auto 升级
    wh.close();
    wh = await Warehouse.open(path, { migrate: "light" });
    expect(wh.maintenance).toBe(MAINTENANCE_V5);
    wh.close();
    wh = await Warehouse.open(path, { migrate: "auto" });
    t.env.wh = wh;
    expect(wh.maintenance).toBeNull();
    expect(await wh.meta("schema_version")).toBe("5");

    // S15 的回填已完成（这里直接设覆盖起点、放一条解禁），事件列按年补算到完成
    for (const id of ["margin", "holders", "lockups", "blocks"]) {
      await wh.run(
        `INSERT INTO pit_sync (dataset, backfill_from, covered_from, window_through, synced_at, nightly_since)
         VALUES ($d, DATE '2025-11-03', DATE '2025-11-03', $t::DATE, $t::DATE, DATE '2025-11-03')`,
        { d: id, t: last },
      );
    }
    await wh.run(
      `INSERT INTO lockups (code, free_date, type, unlock_shares, ratio_float, avail_date, avail_rule, first_seen, last_seen, src, ver, batch)
       VALUES ('600001.SH', DATE '2026-03-02', '首发原股东限售股份', 1e8, 0.12, DATE '2025-11-03', 'ipo_terms', DATE '2025-11-03', DATE '2025-11-03', 'em', NULL, 1)`,
    );
    setEventColsClockForTest(() => Date.parse("2026-02-27T10:00:00+08:00"));
    try {
      let r = await eventColsJob(fakeJobContext("event_cols", { market: "A" }));
      while (!r.complete) {
        t.env.app.sqlite.prepare(`DELETE FROM jobs WHERE kind = 'event_cols'`).run();
        r = await eventColsJob(fakeJobContext("event_cols", { market: "A" }));
      }
    } finally {
      setEventColsClockForTest();
    }
    t.env.app.sqlite.prepare(`DELETE FROM jobs WHERE kind = 'event_cols'`).run();
    expect(
      Number(await wh.scalar(`SELECT count(*) FROM factors_daily WHERE unlock_days IS NOT NULL`)),
    ).toBeGreaterThan(0);
    // 核心列逐字节不变
    expect(await coreHash()).toBe(coreBefore);

    // 旧回测：复核数据「输入一致」；完整重跑逐笔一致
    await verifyJob(fakeJobContext("verify", { runId: old.runId }));
    const runOf = (id: string) => t.env.app.db.select().from(runs).where(eq(runs.id, id)).get()!;
    expect(runOf(old.runId).verify).toMatchObject({ status: "done", sameInput: true });
    const repro = insertRun(
      t.env.app,
      spec,
      {
        ...(oldRun.params as object),
        end: (oldRun.card as unknown as RunCard).params.end,
        reproOf: old.runId,
      },
      { kind: "reproduce", strategyId: old.strategyId, versionId: old.versionId },
    );
    await backtestJob(fakeJobContext("backtest", { runId: repro.runId }));
    expect(runOf(old.runId).verify).toMatchObject({
      kind: "full",
      sameInput: true,
      sameResult: true,
    });
    expect((runOf(repro.runId).card as unknown as RunCard).outputs.coreHash).toBe(
      (oldRun.card as unknown as RunCard).outputs.coreHash,
    );
    expect((runOf(repro.runId).card as unknown as RunCard).data.events).toBeUndefined();

    // 跟踪：升级后同一晚重跑结算不加计划版次、重放 0 漂移
    expect(await settleMarket("A", fakeJobContext("settle", { market: "A" }))).toEqual({
      settled: 1,
      failed: 0,
    });
    expect(snaps().map((x) => [x.id, x.edition])).toEqual(
      snapsBefore.map((x) => [x.id, x.edition]),
    );
    const summary = () =>
      t.env.app.db.select().from(trackings).where(eq(trackings.id, trackingId)).get()!.summary as {
        replay: { cause: string; navDrift: number };
        lastDate: string;
      };
    expect(summary().replay).toMatchObject({ cause: "none", navDrift: 0 });
    // 第二晚：最后一天的因子（旧列）进来，提交新版本
    const oldCols = [
      "code",
      "date",
      "market",
      "close",
      ...FACTOR_COLUMNS.filter((k) => !EVENT_FACTOR_KEYS.includes(k)),
    ];
    await wh.run(
      `INSERT INTO factors_daily (${oldCols.join(", ")}) SELECT ${oldCols.join(", ")} FROM held`,
    );
    await wh.run(
      `INSERT INTO data_versions (id, market, as_of, kind, status) VALUES (nextval('data_version_seq'), 'A', $d::DATE, 'daily', 'ok')`,
      { d: last },
    );
    expect(await settleMarket("A", fakeJobContext("settle", { market: "A" }))).toEqual({
      settled: 1,
      failed: 0,
    });
    expect(summary().lastDate).toBe(last);
    expect(summary().replay).toMatchObject({ cause: "none", navDrift: 0 });

    // 新回测用解禁因子：补完了，运行卡带 data.events
    const evSpec = StrategySpecSchema.parse({
      name: "避开解禁",
      market: "A",
      filters: [{ factor: "unlock_ratio_30d", op: "<", value: 5 }],
      rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 2 },
    });
    const fresh = insertRun(t.env.app, evSpec, {
      start: "2025-12-01",
      end: last,
      capital: 1_000_000,
      oosMonths: 0,
      exec: defaultExec("A"),
      priorVersions: 0,
    });
    await backtestJob(fakeJobContext("backtest", { runId: fresh.runId }));
    const fr = runOf(fresh.runId);
    expect(fr.status).toBe("done");
    const card = fr.card as unknown as RunCard;
    expect(card.data.factorRegistry).toBe(3);
    expect(card.data.events).toMatchObject({
      version: 1,
      sig: expect.stringMatching(/^[0-9a-f]{8}$/),
      batch: expect.any(Number),
      datasets: { lockups: { coveredFrom: "2025-11-03", syncedAt: last } },
    });
    // 30 天内解禁 12% 的股0 在解禁前 30 天里（决策日 02-02 … 03-01）不会被买入
    const trades = t.env.app.sqlite
      .prepare(`SELECT code, date, side FROM run_trades WHERE run_id = ?`)
      .all(fresh.runId) as Array<{ code: string; date: string; side: string }>;
    expect(trades.length).toBeGreaterThan(0);
    expect(
      trades.some(
        (x) =>
          x.side === "buy" &&
          x.code === "600001.SH" &&
          x.date > "2026-02-02" &&
          x.date <= "2026-03-02",
      ),
    ).toBe(false);
  });
});

/** 旧回测的终点（日历下标）：持有满 3 天的仓位在这天收盘触发卖出，收尾时有待执行的卖单 */
const LEGACY_END = 28;

describe("场景：从 R0 升级（运行卡与健康度之前的跟踪）", () => {
  it("（d）运行卡之前的旧回测：复核「早于指纹记录」、完整重跑逐笔一致；旧形状的跟踪（summary 没有指纹与 lastDate、没有健康读数与计划快照、明日计划没有快照号）：第一晚 0 漂移、补算一次、计划第 1 版；同晚再结算不加任何东西", async () => {
    const { calendar } = await seedSyntheticMarket(t.env.wh, {
      market: "A",
      start: "2025-11-03",
      days: 60,
      stocks: ["600001.SH", "600002.SH", "600003.SH", "600004.SH"].map((code, k) => ({
        code,
        name: `股${k}`,
        close: (i: number) => 10 + k + Math.sin(i / 5 + k) * 2,
        factors: (i: number) => ({
          pe_ttm: 5 + ((i + k * 7) % 11),
          turnover_20d: 5 + k,
          volatility_60d: 30,
        }),
      })),
    });
    const spec = StrategySpecSchema.parse({
      name: "低估值",
      market: "A",
      rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 2 },
      rebalance: { every: "week", buffer: 1 },
    });
    const runOf = (id: string) => t.env.app.db.select().from(runs).where(eq(runs.id, id)).get()!;

    // R0 留下的回测：没有运行卡与输入指纹、引擎 1.1.0、旧口径（参数里没有 exec），收尾时有待执行的卖单（持有到期），
    // 存档的 final.pending 只有 1.1.0 写过的 {code, name, side, reason}
    const legacySpec = StrategySpecSchema.parse({ ...spec, exits: { maxHoldDays: 3 } });
    const legacy = insertRun(t.env.app, legacySpec, {
      start: calendar[2]!,
      end: calendar[LEGACY_END]!,
      capital: 1_000_000,
      oosMonths: 0,
      priorVersions: 0,
    });
    await backtestJob(fakeJobContext("backtest", { runId: legacy.runId }));
    const lr = runOf(legacy.runId);
    expect(lr.status).toBe("done");
    const final = lr.final as { pending: Array<Record<string, unknown>> };
    expect(final.pending.length).toBeGreaterThan(0);
    t.env.app.db
      .update(runs)
      .set({
        card: null,
        cardHash: null,
        inputHash: null,
        engineVersion: "1.1.0",
        final: {
          ...final,
          pending: final.pending.map(({ code, name, side, reason }) => ({
            code,
            name,
            side,
            reason,
          })),
        },
      })
      .where(eq(runs.id, legacy.runId))
      .run();
    // 复核数据：早于指纹记录，没法只比输入
    await verifyJob(fakeJobContext("verify", { runId: legacy.runId }));
    expect(runOf(legacy.runId).verify).toMatchObject({
      status: "done",
      sameInput: null,
      reason: "unrecorded",
    });
    // 完整重跑：两边投影到 1.1.0 存过的字段再比，逐笔一致（不因预估字段报「结果不同」）
    const repro = insertRun(
      t.env.app,
      legacySpec,
      { ...(lr.params as Record<string, unknown>), reproOf: legacy.runId },
      { kind: "reproduce", strategyId: legacy.strategyId, versionId: legacy.versionId },
    );
    await backtestJob(fakeJobContext("backtest", { runId: repro.runId }));
    expect(runOf(legacy.runId).verify).toMatchObject({
      status: "done",
      kind: "full",
      sameResult: true,
      reportSame: true,
      cause: "none",
    });

    // 旧跟踪：成交假设是旧口径（应用库迁移给的默认 {"v":1}）；先用新代码结算一晚拿到逐日净值，再改回 R0 留下的样子
    const { trackingId } = seedTracking(t.env.app, { spec, startDate: calendar[1]! });
    expect(await settleMarket("A", fakeJobContext("settle", { market: "A" }))).toEqual({
      settled: 1,
      failed: 0,
    });
    const { sqlite } = t.env.app;
    const navs = () =>
      sqlite
        .prepare(`SELECT date, nav, bench FROM tracking_days WHERE tracking_id = ? ORDER BY date`)
        .all(trackingId);
    const navsBase = navs();
    const row = t.env.app.db.select().from(trackings).where(eq(trackings.id, trackingId)).get()!;
    const s = row.summary as Record<string, unknown>;
    const baseSummary = Object.fromEntries(
      ["dataAsOf", "equity", "cash", "positions", "exposure", "metrics", "checks", "replay"].map(
        (k) => [k, s[k] ?? null],
      ),
    );
    const tables = ["ledger_entries", "plan_items", "plan_snapshots", "tracking_health"];
    const triggers = sqlite
      .prepare(
        `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%_no_delete'`,
      )
      .all() as Array<{ name: string; sql: string }>;
    for (const tr of triggers) sqlite.exec(`DROP TRIGGER ${tr.name}`);
    try {
      sqlite
        .prepare(
          `DELETE FROM plan_items WHERE snapshot_id IN (SELECT id FROM plan_snapshots WHERE tracking_id = ?)`,
        )
        .run(trackingId);
      sqlite.prepare(`DELETE FROM plan_snapshots WHERE tracking_id = ?`).run(trackingId);
      sqlite.prepare(`DELETE FROM tracking_health WHERE tracking_id = ?`).run(trackingId);
      sqlite.prepare(`DELETE FROM ledger_entries`).run();
    } finally {
      for (const tr of triggers) sqlite.exec(tr.sql);
    }
    sqlite
      .prepare(`UPDATE tracking_orders SET snapshot_id = NULL WHERE tracking_id = ?`)
      .run(trackingId);
    sqlite
      .prepare(`UPDATE trackings SET summary = ? WHERE id = ?`)
      .run(JSON.stringify(baseSummary), trackingId);
    const counts = () =>
      tables.map((tb) =>
        Number((sqlite.prepare(`SELECT count(*) AS n FROM ${tb}`).get() as { n: number }).n),
      );
    expect(counts()).toEqual([0, 0, 0, 0]);

    // 升级后的第一晚
    expect(await settleMarket("A", fakeJobContext("settle", { market: "A" }))).toEqual({
      settled: 1,
      failed: 0,
    });
    expect(navs()).toEqual(navsBase);
    const after = t.env.app.db.select().from(trackings).where(eq(trackings.id, trackingId)).get()!;
    expect(
      (after.summary as { replay: { navDrift: number; benchDrift: number } }).replay,
    ).toMatchObject({
      navDrift: 0,
      benchDrift: 0,
    });
    const snaps = t.env.app.db
      .select()
      .from(planSnapshots)
      .where(eq(planSnapshots.trackingId, trackingId))
      .all();
    expect(snaps.map((x) => x.edition)).toEqual([1]);
    const transitions = sqlite
      .prepare(`SELECT count(*) AS n FROM ledger_entries WHERE kind = 'health_transition'`)
      .get() as { n: number };
    expect(transitions.n).toBeLessThanOrEqual(1);
    const once = counts();
    expect(once[2]).toBe(1);
    // 健康度按历史补算了一套读数（之后每晚只加一行）
    expect(once[3]).toBeGreaterThan(0);

    // 同一晚再结算一次：什么都不加
    expect(await settleMarket("A", fakeJobContext("settle", { market: "A" }))).toEqual({
      settled: 1,
      failed: 0,
    });
    expect(counts()).toEqual(once);
    expect(navs()).toEqual(navsBase);
  });
});

/**
 * 运行合约（D57）：回测写运行卡与输入指纹；复核数据只比输入；完整重跑比结果指纹并写回原运行。
 */
import {
  type Confidence,
  defaultExec,
  type Fan,
  LEGACY_EXEC,
  type Metrics,
  type RunCard,
  StrategySpecSchema,
} from "@ivan/core";
import { sha256Canonical, specHashOf } from "@ivan/core/node";
import { seedSyntheticMarket } from "@ivan/data/testing";
import { HASH_VERSION } from "@ivan/data";
import { type AppDbHandle, newId, runs, strategies, strategyVersions, unpackJson } from "@ivan/db";
import { ENGINE_VERSION, VALIDATION_VERSION } from "@ivan/engine";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverStale } from "../runner.ts";
import { fakeJobContext, makeTestEnv } from "../testing/harness.ts";
import { backtestJob, sweepJob } from "./backtest.ts";
import { verifyJob } from "./verify.ts";

const spec = StrategySpecSchema.parse({
  name: "低估值",
  market: "A",
  rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 2 },
});

let t: Awaited<ReturnType<typeof makeTestEnv>>;
let calendar: string[];
beforeEach(async () => {
  t = await makeTestEnv();
  ({ calendar } = await seedSyntheticMarket(t.env.wh, {
    market: "A",
    start: "2025-01-06",
    days: 120,
    stocks: ["600001.SH", "600002.SH", "600003.SH", "600004.SH"].map((code, k) => ({
      code,
      name: `股${k}`,
      close: (i: number) => 10 + k + Math.sin(i / 5 + k) * 2,
      // 股0、股2 是小盘：20 日均成交额只有 50 万（按流动性成交时单笔上限 5 万）
      factors: (i: number) => ({
        pe_ttm: 5 + ((i + k * 7) % 11),
        turnover_20d: k % 2 === 0 ? 0.005 : 5 + k,
        volatility_60d: 30,
      }),
    })),
  }));
});
afterEach(() => t.cleanup());

function seedRun(app: AppDbHandle, o: { kind?: string; params?: Record<string, unknown> } = {}) {
  const strategyId = newId("s_");
  const versionId = newId("v_");
  const runId = newId("r_");
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
  app.db
    .insert(runs)
    .values({
      id: runId,
      userId: "u_test",
      strategyId,
      versionId,
      kind: o.kind ?? "backtest",
      params: {
        start: "2025-02-03",
        end: "2025-06-20",
        capital: 1_000_000,
        oosMonths: 0,
        exec: { v: 1 },
        priorVersions: 0,
        ...o.params,
      },
    })
    .run();
  return { strategyId, versionId, runId };
}

const runOf = (id: string) => t.env.app.db.select().from(runs).where(eq(runs.id, id)).get()!;

/** 照服务端 reproduceRun 的做法插一条重跑：参数照抄，终点钉在原运行卡记下的那天 */
function seedReproduce(origId: string): string {
  const orig = runOf(origId);
  const end = (orig.card as unknown as RunCard | null)?.params.end ?? orig.params.end;
  const id = newId("r_");
  t.env.app.db
    .insert(runs)
    .values({
      id,
      userId: orig.userId,
      strategyId: orig.strategyId,
      versionId: orig.versionId,
      kind: "reproduce",
      params: { ...orig.params, end, reproOf: orig.id },
    })
    .run();
  return id;
}

describe("回测写运行卡（D57）", () => {
  it("运行卡、卡片指纹与输入指纹都存下；引擎回显的成交假设等于卡片里的", async () => {
    const { runId, versionId } = seedRun(t.env.app);
    const out = await backtestJob(fakeJobContext("backtest", { runId }));
    expect(out.runId).toBe(runId);
    const r = runOf(runId);
    expect(r.status).toBe("done");
    const card = r.card as unknown as RunCard;
    expect(r.cardHash).toBe(card.cardHash);
    expect(r.inputHash).toBe(card.data.inputHash);
    expect(r.inputHash).toHaveLength(64);
    expect(card.kind).toBe("backtest");
    expect(card.exec).toEqual(LEGACY_EXEC);
    expect(card.engine.version).toBe(ENGINE_VERSION);
    expect(card.spec).toEqual({ versionId, specHash: specHashOf(spec) });
    expect(card.params.end).toBe("2025-06-20");
    expect(card.data.market).toBe("A");
    expect(card.data.versionId).toBe(r.dataVersion);
    expect(card.data.asOf).toBe(calendar.at(-1));
    expect(card).not.toHaveProperty("runId");
    expect(r.engineVersion).toBe(ENGINE_VERSION);
  });

  it("存下的参数没有 exec（旧运行）时按旧口径跑", async () => {
    const { runId } = seedRun(t.env.app, { params: { exec: undefined } });
    await backtestJob(fakeJobContext("backtest", { runId }));
    const card = runOf(runId).card as unknown as RunCard;
    expect(card.exec).toEqual(LEGACY_EXEC);
    expect(card.engine).toMatchObject({ rulesVersion: 1, metricsVersion: 1 });
    expect((runOf(runId).metrics as unknown as Metrics).metricsVersion).toBeUndefined();
  });

  it("新回测（defaultExec）的运行卡记规则表第 2 版、指标第 2 版与指纹口径 2（S04）", async () => {
    const { runId } = seedRun(t.env.app, { params: { exec: defaultExec("A") } });
    await backtestJob(fakeJobContext("backtest", { runId }));
    const r = runOf(runId);
    const card = r.card as unknown as RunCard;
    expect(card.exec).toEqual(defaultExec("A"));
    expect(card.engine).toMatchObject({ rulesVersion: 2, metricsVersion: 2 });
    expect(HASH_VERSION).toBe(2);
    expect(card.data.hashVersion).toBe(2);
    const m = r.metrics as unknown as Metrics;
    expect(m.metricsVersion).toBe(2);
    expect(m.risk).toBeDefined();
    // 从投入第一笔资金算起
    expect(m.totalReturn).toBe(m.finalEquity / 1_000_000 - 1);
  });
});

describe("按流动性成交（D64）", () => {
  it("默认成交假设：诊断存进 runs.diagnostics，成交记录带参考价、滑点与参与率，小盘股被截小", async () => {
    const { runId } = seedRun(t.env.app, { params: { exec: defaultExec("A") } });
    await backtestJob(fakeJobContext("backtest", { runId }));
    const r = runOf(runId);
    expect(r.status).toBe("done");
    const d = r.diagnostics as unknown as {
      rejections: Record<string, { count: number; value: number }>;
      participation: { p90: number } | null;
      capacityEstimate: number | null;
      cappedBuyShare: number;
    };
    expect(d.rejections["buy:capacity"]!.count).toBeGreaterThan(0);
    expect(d.participation!.p90).toBeGreaterThan(0);
    expect(d.capacityEstimate).toBeGreaterThan(0);
    expect((r.metrics as unknown as Metrics).slippageCost).toBeGreaterThan(0);
    const trades = t.env.app.sqlite
      .prepare(
        `SELECT code, price, ref, slip, part FROM run_trades WHERE run_id = ? AND side = 'buy'`,
      )
      .all(runId) as Array<{
      code: string;
      price: number;
      ref: number;
      slip: number;
      part: number;
    }>;
    expect(trades.length).toBeGreaterThan(0);
    for (const x of trades) {
      expect(x.price).toBeGreaterThan(x.ref);
      expect(x.slip).toBeGreaterThan(0);
      expect(x.part).toBeGreaterThan(0);
    }
    // 小盘股每笔不超过 50 万 × 10%
    const small = trades.filter((x) => x.code === "600001.SH" || x.code === "600003.SH");
    expect(small.length).toBeGreaterThan(0);
    for (const x of small) expect(x.part).toBeLessThanOrEqual(0.1 + 1e-9);
    expect((r.checks as Array<{ id: string }>).some((c) => c.id === "capacity_limit")).toBe(true);
  });

  it("旧口径也存拒单统计；成交记录没有参考价与滑点", async () => {
    const { runId } = seedRun(t.env.app);
    await backtestJob(fakeJobContext("backtest", { runId }));
    const r = runOf(runId);
    const d = r.diagnostics as unknown as Record<string, unknown>;
    expect(d).toHaveProperty("rejections");
    expect(d).not.toHaveProperty("participation");
    const row = t.env.app.sqlite
      .prepare(`SELECT count(*) AS n FROM run_trades WHERE run_id = ? AND ref IS NOT NULL`)
      .get(runId) as { n: number };
    expect(row.n).toBe(0);
  });
});

describe("复核数据（verify 任务）", () => {
  it("数据没变 → 输入一致；改一根 K 线 → 输入不同；早于指纹记录 → unrecorded", async () => {
    const { runId } = seedRun(t.env.app);
    await backtestJob(fakeJobContext("backtest", { runId }));
    await verifyJob(fakeJobContext("verify", { runId }));
    let v = runOf(runId).verify as Record<string, unknown>;
    expect(v).toMatchObject({
      status: "done",
      kind: "input",
      sameInput: true,
      engineSame: true,
      hashVersionSame: true,
    });
    expect(v.dataVersionNow).toBe(v.dataVersionThen);

    // 区间中间某天所有股票的收盘被修订
    await t.env.wh.run(`UPDATE bars_daily SET close = close * 1.1 WHERE date = $d::DATE`, {
      d: "2025-03-12",
    });
    await verifyJob(fakeJobContext("verify", { runId }));
    v = runOf(runId).verify as Record<string, unknown>;
    expect(v).toMatchObject({ status: "done", sameInput: false });
    expect(v.inputHash).not.toBe(v.recordedInputHash);

    // 早于指纹记录的回测：没法只比输入
    t.env.app.db.update(runs).set({ inputHash: null, card: null }).where(eq(runs.id, runId)).run();
    await verifyJob(fakeJobContext("verify", { runId }));
    expect(runOf(runId).verify).toMatchObject({
      status: "done",
      sameInput: null,
      reason: "unrecorded",
    });
  });
});

/**
 * 最后一个交易日的因子先扣下、已提交的截至日停在前一天（「数据还没到」），
 * 之后再放回去并提交新版本（「夜间更新多了一天」）
 */
async function holdLastDay(): Promise<() => Promise<void>> {
  await t.env.wh.run(
    `CREATE TEMP TABLE held AS SELECT * FROM factors_daily WHERE date = $d::DATE`,
    { d: calendar.at(-1)! },
  );
  await t.env.wh.run(`DELETE FROM factors_daily WHERE date = $d::DATE`, { d: calendar.at(-1)! });
  await t.env.wh.run(`UPDATE data_versions SET as_of = $d::DATE`, { d: calendar.at(-2)! });
  return async () => {
    await t.env.wh.run(`INSERT INTO factors_daily SELECT * FROM held`);
    await t.env.wh.run(
      `INSERT INTO data_versions (id, market, as_of, kind) VALUES (nextval('data_version_seq'), 'A', $d::DATE, 'daily')`,
      { d: calendar.at(-1)! },
    );
  };
}

describe("终点晚于数据截至日（默认就是今天）", () => {
  it("复核按运行卡记下的终点比：刚跑完一致，多了一个交易日仍一致，改了窗口内的 K 线才不同", async () => {
    const appendDay = await holdLastDay();
    const { runId } = seedRun(t.env.app, { params: { end: "2025-12-31" } });
    await backtestJob(fakeJobContext("backtest", { runId }));
    expect((runOf(runId).card as unknown as RunCard).params.end).toBe(calendar.at(-2));

    await verifyJob(fakeJobContext("verify", { runId }));
    expect(runOf(runId).verify).toMatchObject({ status: "done", sameInput: true });

    await appendDay();
    await verifyJob(fakeJobContext("verify", { runId }));
    expect(runOf(runId).verify).toMatchObject({ status: "done", sameInput: true });

    await t.env.wh.run(`UPDATE bars_daily SET close = close * 1.1 WHERE date = $d::DATE`, {
      d: "2025-03-12",
    });
    await verifyJob(fakeJobContext("verify", { runId }));
    expect(runOf(runId).verify).toMatchObject({ status: "done", sameInput: false });
  });

  it("第二天才完整重跑：窗口不变长，逐笔一致", async () => {
    const appendDay = await holdLastDay();
    const { runId } = seedRun(t.env.app, { params: { end: "2025-12-31" } });
    await backtestJob(fakeJobContext("backtest", { runId }));
    await appendDay();
    const reproId = seedReproduce(runId);
    await backtestJob(fakeJobContext("backtest", { runId: reproId }));
    expect((runOf(reproId).card as unknown as RunCard).params.end).toBe(calendar.at(-2));
    expect(runOf(runId).verify).toMatchObject({
      kind: "full",
      sameInput: true,
      sameResult: true,
      cause: "none",
    });
  });
});

describe("worker 重启", () => {
  it("卡在排队中 / 复核中的复核标成失败；还在队列里的不动", async () => {
    const a = seedRun(t.env.app).runId;
    const b = seedRun(t.env.app).runId;
    for (const id of [a, b]) {
      t.env.app.db
        .update(runs)
        .set({ status: "done", verify: { status: "running", kind: "input" } })
        .where(eq(runs.id, id))
        .run();
    }
    t.env.app.sqlite
      .prepare(
        `INSERT INTO jobs (id, kind, user_id, payload, status, progress, created_at) VALUES ('j_q', 'verify', 'u_test', ?, 'queued', 0, 0)`,
      )
      .run(JSON.stringify({ runId: b }));
    recoverStale();
    expect(runOf(a).verify).toEqual({ status: "failed", kind: "input", error: "worker 重启" });
    expect(runOf(b).verify).toEqual({ status: "running", kind: "input" });
  });
});

describe("完整重跑（kind = reproduce）", () => {
  it("又提交了一个数据版本但没改任何 K 线：逐笔一致、提示项也一致，写回原运行", async () => {
    const { runId } = seedRun(t.env.app);
    await backtestJob(fakeJobContext("backtest", { runId }));
    await t.env.wh.run(
      `INSERT INTO data_versions (id, market, as_of, kind) VALUES (nextval('data_version_seq'), 'A', $d::DATE, 'daily')`,
      { d: calendar.at(-1)! },
    );
    const reproId = seedReproduce(runId);
    await backtestJob(fakeJobContext("backtest", { runId: reproId }));
    const repro = runOf(reproId);
    expect(repro.status).toBe("done");
    expect((repro.card as unknown as RunCard).kind).toBe("reproduce");
    const v = runOf(runId).verify as Record<string, unknown>;
    expect(v).toMatchObject({
      status: "done",
      kind: "full",
      reproRunId: reproId,
      sameInput: true,
      sameResult: true,
      reportSame: true,
      engineSame: true,
      hashVersionSame: true,
      cause: "none",
    });
    expect(v.dataVersionNow).toBe((v.dataVersionThen as number) + 1);
    // 结果相同，但数据版本不同，所以运行卡不同
    expect(repro.cardHash).not.toBe(runOf(runId).cardHash);
  });

  it("改了一根 K 线：结果不同，原因是数据修订", async () => {
    const { runId } = seedRun(t.env.app);
    await backtestJob(fakeJobContext("backtest", { runId }));
    await t.env.wh.run(`UPDATE bars_daily SET close = close * 1.05 WHERE date = $d::DATE`, {
      d: "2025-04-01",
    });
    const reproId = seedReproduce(runId);
    await backtestJob(fakeJobContext("backtest", { runId: reproId }));
    expect(runOf(runId).verify).toMatchObject({
      sameInput: false,
      sameResult: false,
      cause: "data",
    });
  });

  it("原回测已经不在了：重跑照样跑完，比对记成失败（重跑页不会一直等）", async () => {
    const { runId } = seedRun(t.env.app);
    await backtestJob(fakeJobContext("backtest", { runId }));
    const reproId = seedReproduce(runId);
    t.env.app.db.delete(runs).where(eq(runs.id, runId)).run();
    await backtestJob(fakeJobContext("backtest", { runId: reproId }));
    const repro = runOf(reproId);
    expect(repro.status).toBe("done");
    expect(repro.verify).toMatchObject({ status: "failed", kind: "full" });
  });

  it("比对本身出错：重跑仍是跑完，两边都记比对失败", async () => {
    const { runId } = seedRun(t.env.app);
    await backtestJob(fakeJobContext("backtest", { runId }));
    // 早于运行卡、存档又坏了：从存档算结果指纹会出错
    t.env.app.db
      .update(runs)
      .set({ card: null, cardHash: null, inputHash: null })
      .where(eq(runs.id, runId))
      .run();
    t.env.app.sqlite.prepare(`UPDATE runs SET series_z = X'00' WHERE id = ?`).run(runId);
    const reproId = seedReproduce(runId);
    await backtestJob(fakeJobContext("backtest", { runId: reproId }));
    expect(runOf(reproId).status).toBe("done");
    for (const id of [runId, reproId]) {
      expect(runOf(id).verify).toMatchObject({ status: "failed", kind: "full" });
    }
  });

  it("原运行早于运行卡：从存档两边同口径地比，仍能判断逐笔一致", async () => {
    const { runId } = seedRun(t.env.app, { params: { exec: undefined } });
    await backtestJob(fakeJobContext("backtest", { runId }));
    t.env.app.db
      .update(runs)
      .set({ card: null, cardHash: null, inputHash: null, engineVersion: "1.1.0" })
      .where(eq(runs.id, runId))
      .run();
    const reproId = seedReproduce(runId);
    await backtestJob(fakeJobContext("backtest", { runId: reproId }));
    expect(runOf(runId).verify).toMatchObject({
      sameInput: null,
      sameResult: true,
      reportSame: true,
      engineSame: false,
      hashVersionSame: false,
      cause: "none",
    });
  });
});

describe("可信度（D65）", () => {
  const v2 = { exec: defaultExec("A") };
  const seedOf = (inputHash: string) =>
    Number.parseInt(sha256Canonical({ inputHash, v: VALIDATION_VERSION }).slice(0, 8), 16);

  it("第 2 版口径的新回测存区间与扇形；运行卡的种子来自输入指纹；结果指纹覆盖它", async () => {
    const { runId } = seedRun(t.env.app, { params: v2 });
    await backtestJob(fakeJobContext("backtest", { runId }));
    const r = runOf(runId);
    const card = r.card as unknown as RunCard;
    const v = r.validation as unknown as Confidence;
    expect(card.seeds.validation).toBe(seedOf(r.inputHash!));
    expect(v).toMatchObject({
      method: "stationary_bootstrap",
      version: 1,
      B: 1000,
      seed: card.seeds.validation,
    });
    // 周度以外默认按月调仓：平均段长 21 天
    expect(v.blockMean).toBe(21);
    expect(v.excessCagr.lo).toBeLessThanOrEqual(v.excessCagr.hi);
    const fan = unpackJson<Fan>(r.validationZ)!;
    expect(fan.days).toHaveLength(60);
    for (let c = 0; c < 60; c++) expect(fan.p5[c]).toBeLessThanOrEqual(fan.p95[c]!);
    // low_confidence 与点估计、区间一致
    const checks = r.checks as Array<{ id: string }>;
    expect(checks.some((c) => c.id === "low_confidence")).toBe(
      v.excessCagr.est > 0 && v.excessCagr.lo <= 0,
    );
  });

  it("又提交了一个没改任何数据的版本、第二天再跑同样的参数：种子与区间完全相同；完整重跑逐笔一致", async () => {
    const { runId, strategyId, versionId } = seedRun(t.env.app, { params: v2 });
    await backtestJob(fakeJobContext("backtest", { runId }));
    await t.env.wh.run(
      `INSERT INTO data_versions (id, market, as_of, kind, status)
       VALUES (nextval('data_version_seq'), 'A', $d::DATE, 'daily', 'ok')`,
      { d: calendar.at(-1)! },
    );
    const again = newId("r_");
    t.env.app.db
      .insert(runs)
      .values({
        id: again,
        userId: "u_test",
        strategyId,
        versionId,
        kind: "backtest",
        params: runOf(runId).params,
      })
      .run();
    await backtestJob(fakeJobContext("backtest", { runId: again }));
    const [a, b] = [runOf(runId), runOf(again)];
    expect(b.dataVersion).toBe(a.dataVersion! + 1);
    expect(JSON.stringify(b.validation)).toBe(JSON.stringify(a.validation));
    expect(b.validationZ!.equals(a.validationZ!)).toBe(true);
    expect((b.card as unknown as RunCard).seeds).toEqual((a.card as unknown as RunCard).seeds);
    expect((b.card as unknown as RunCard).outputs.coreHash).toBe(
      (a.card as unknown as RunCard).outputs.coreHash,
    );

    const reproId = seedReproduce(runId);
    await backtestJob(fakeJobContext("backtest", { runId: reproId }));
    expect(JSON.stringify(runOf(reproId).validation)).toBe(JSON.stringify(a.validation));
    expect(runOf(runId).verify).toMatchObject({ kind: "full", sameResult: true, reportSame: true });
  });

  it("旧口径的回测不算可信度，种子为空", async () => {
    const { runId } = seedRun(t.env.app);
    await backtestJob(fakeJobContext("backtest", { runId }));
    const r = runOf(runId);
    expect(r.validation).toBeNull();
    expect(r.validationZ).toBeNull();
    expect((r.card as unknown as RunCard).seeds.validation).toBeNull();
    const checks = r.checks as Array<{ id: string }>;
    expect(checks.some((c) => c.id === "low_confidence" || c.id === "optimistic_drawdown")).toBe(
      false,
    );
  });

  it("扫描的子回测也算可信度，试错次数按服务端给每个取值算好的存", async () => {
    const { runId: parentId } = seedRun(t.env.app, { kind: "sweep", params: v2 });
    const variants = [10, 20].map((top, i) => ({
      label: `/rank/top = ${top}`,
      spec: { ...spec, rank: { ...spec.rank!, top } },
      priorVersions: i + 3,
    }));
    await sweepJob(fakeJobContext("sweep", { runId: parentId, variants }));
    const children = t.env.app.db.select().from(runs).where(eq(runs.parentId, parentId)).all();
    expect(children).toHaveLength(2);
    for (const c of children) {
      expect(c.status).toBe("done");
      expect(c.validation).not.toBeNull();
    }
    expect(
      children.map((c) => (c.params as { priorVersions: number }).priorVersions).sort(),
    ).toEqual([3, 4]);
  });
});

/**
 * 运行合约（D57）：回测写运行卡与输入指纹；复核数据只比输入；完整重跑比结果指纹并写回原运行。
 */
import { LEGACY_EXEC, type RunCard, StrategySpecSchema } from "@ivan/core";
import { specHashOf } from "@ivan/core/node";
import { seedSyntheticMarket } from "@ivan/data/testing";
import { type AppDbHandle, newId, runs, strategies, strategyVersions } from "@ivan/db";
import { ENGINE_VERSION } from "@ivan/engine";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverStale } from "../runner.ts";
import { fakeJobContext, makeTestEnv } from "../testing/harness.ts";
import { backtestJob } from "./backtest.ts";
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
      factors: (i: number) => ({ pe_ttm: 5 + ((i + k * 7) % 11) }),
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
    expect((runOf(runId).card as unknown as RunCard).exec).toEqual(LEGACY_EXEC);
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

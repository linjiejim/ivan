/**
 * worker 测试底座：临时目录里的 SQLite 应用库 + 内存 DuckDB 行情仓 + HTTP 假件，装进进程级单例。
 * 用法：beforeEach 里 makeTestEnv()，afterEach 里 cleanup()；行情用 @ivan/data/testing 的 seedSyntheticMarket 种。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DateStr, type StrategySpec, todayCN } from "@ivan/core";
import { type Config, loadConfig } from "@ivan/core/config";
import { specHashOf } from "@ivan/core/node";
import { type HttpLike, Warehouse } from "@ivan/data";
import { FakeHttp } from "@ivan/data/testing";
import {
  type AppDbHandle,
  type jobs,
  newId,
  openAppDb,
  strategies,
  strategyVersions,
  trackings,
} from "@ivan/db";
import { setWorkerEnvForTest, type WorkerEnv } from "../env.ts";
import type { JobContext } from "../runner.ts";

export async function makeTestEnv(
  o: { http?: HttpLike; today?: DateStr; cfg?: Partial<Config> } = {},
): Promise<{ env: WorkerEnv; dir: string; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "ivan-worker-test-"));
  const appDbPath = join(dir, "app.sqlite");
  const app = openAppDb(appDbPath);
  const wh = await Warehouse.open(":memory:");
  const base = loadConfig();
  const cfg: Config = {
    ...base,
    dataDir: dir,
    appDbPath,
    warehousePath: ":memory:",
    schedulerEnabled: false,
    // 测试绝不调 LLM：没有 key 时简报走确定性模板
    llm: { ...base.llm, apiKey: "" },
    ...o.cfg,
  };
  const env: WorkerEnv = {
    cfg,
    wh,
    app,
    http: o.http ?? new FakeHttp([]),
    today: () => o.today ?? todayCN(),
  };
  setWorkerEnvForTest(env);
  return {
    env,
    dir,
    cleanup: async () => {
      wh.close();
      app.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
      setWorkerEnvForTest(undefined);
    },
  };
}

/** 假的任务上下文：日志与进度都记下来，给断言用。 */
export function fakeJobContext(
  kind: string,
  payload: Record<string, unknown> = {},
  opts: { attempt?: number } = {},
): JobContext & { logs: string[]; progressCalls: Array<{ fraction: number; note?: string }> } {
  const logs: string[] = [];
  const progressCalls: Array<{ fraction: number; note?: string }> = [];
  const job: typeof jobs.$inferSelect = {
    id: newId("j_"),
    kind,
    userId: null,
    payload,
    status: "running",
    progress: 0,
    note: null,
    result: null,
    error: null,
    createdAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: null,
    notBefore: null,
    attempt: opts.attempt ?? 0,
  };
  return {
    job,
    logs,
    progressCalls,
    log: (m) => logs.push(m),
    progress: (fraction, note) => progressCalls.push({ fraction, note }),
  };
}

/** 直接写一个运行中的跟踪（策略 + 第 1 版 + 跟踪），绕过确认卡，测试用。 */
export function seedTracking(
  app: AppDbHandle,
  o: {
    userId?: string;
    spec: StrategySpec;
    startDate: DateStr;
    capital?: number;
    baselineRunId?: string | null;
  },
): { strategyId: string; versionId: string; trackingId: string } {
  const userId = o.userId ?? "u_test";
  const strategyId = newId("s_");
  const versionId = newId("v_");
  const trackingId = newId("t_");
  app.db
    .insert(strategies)
    .values({
      id: strategyId,
      userId,
      name: o.spec.name,
      market: o.spec.market,
      currentVersionId: versionId,
    })
    .run();
  app.db
    .insert(strategyVersions)
    .values({
      id: versionId,
      strategyId,
      n: 1,
      spec: o.spec as unknown as Record<string, unknown>,
      specHash: specHashOf(o.spec),
    })
    .run();
  app.db
    .insert(trackings)
    .values({
      id: trackingId,
      userId,
      strategyId,
      versionId,
      market: o.spec.market,
      startDate: o.startDate,
      capital: o.capital ?? 1_000_000,
      baselineRunId: o.baselineRunId ?? null,
    })
    .run();
  return { strategyId, versionId, trackingId };
}

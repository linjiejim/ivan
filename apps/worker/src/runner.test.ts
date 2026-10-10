/**
 * 行情仓写库期间不跑回测（D60）：认领规则的真值表，以及 computeBlocked 读 jobs 表的判断。
 */
import { jobs, newId } from "@ivan/db";
import { afterEach, describe, expect, it } from "vitest";
import { computeBlocked, shouldWait } from "./runner.ts";
import { makeTestEnv } from "./testing/harness.ts";

const idle = { maintenance: false, blocked: false, computeRunning: 0 };

describe("shouldWait", () => {
  it.each([
    // [道, 下一个任务, 状态, 该不该等]
    ["compute", null, idle, false],
    ["compute", null, { ...idle, blocked: true }, true],
    ["etl", "etl", idle, false],
    ["etl", "etl", { ...idle, computeRunning: 2 }, true],
    ["etl", "check", { ...idle, computeRunning: 1 }, true],
    // 结算、简报不写行情仓，不用等回测
    ["etl", "settle", { ...idle, computeRunning: 1 }, false],
    ["etl", "brief", { ...idle, computeRunning: 1 }, false],
    ["etl", null, { ...idle, computeRunning: 1 }, false],
    // 维护状态：两条道都不认领
    ["compute", null, { ...idle, maintenance: true }, true],
    ["etl", "brief", { ...idle, maintenance: true }, true],
  ] as const)("%s 道，下一个 %s，%o → %s", (lane, next, state, want) => {
    expect(shouldWait(lane, next, state)).toBe(want);
  });
});

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe("computeBlocked", () => {
  it("etl / check 排队或在跑时挡住 compute 道（回测、扫描、复核都在这条道上）；简报排队不挡", async () => {
    const t = await makeTestEnv();
    cleanup = t.cleanup;
    const { db, sqlite } = t.env.app;
    const add = (kind: string, status: string, createdAt: number, startedAt?: number) =>
      db
        .insert(jobs)
        .values({ id: newId("j_"), kind, payload: {}, status, createdAt, startedAt })
        .run();
    expect(computeBlocked(sqlite)).toBeNull();
    add("brief", "queued", 1000);
    add("settle", "running", 1100, 1150);
    add("etl", "done", 900);
    add("check", "failed", 950);
    expect(computeBlocked(sqlite)).toBeNull();
    add("etl", "queued", 2000);
    expect(computeBlocked(sqlite)).toEqual({ kind: "etl", since: 2000 });
    add("check", "running", 1500, 1600);
    // 最早的写库任务；在跑的从开始时间算
    expect(computeBlocked(sqlite)).toEqual({ kind: "check", since: 1600 });
  });
});

import { describe, expect, it } from "vitest";
import type { RunVerify } from "./types.ts";
import {
  COMPUTE_PAUSED_TEXT,
  computePausedNote,
  quotaPatch,
  REPRO_COMPARE_WAIT_MS,
  reproReason,
  reproVerdict,
  runPollInterval,
  verifyBadgeState,
} from "./verify.ts";

const full = (o: Partial<RunVerify>): RunVerify => ({ status: "done", kind: "full", ...o });
const input = (o: Partial<RunVerify>): RunVerify => ({ status: "done", kind: "input", ...o });

describe("reproReason", () => {
  it("按原因给中文", () => {
    expect(reproReason(full({ cause: "data" }))).toBe("数据已修订");
    expect(reproReason(full({ cause: "engine" }))).toBe("引擎不同");
    expect(reproReason(full({ cause: "exec" }))).toBe("成交假设不同");
    expect(reproReason(full({ cause: "unrecorded", sameInput: false }))).toBe("指纹口径升级过");
    expect(reproReason(full({ cause: "unrecorded", sameInput: null }))).toContain("早于指纹记录");
    expect(reproReason(full({ cause: "unexplained" }))).toContain("原因不明");
  });
});

describe("verifyBadgeState", () => {
  it("进行中与失败", () => {
    expect(verifyBadgeState(null)).toBeNull();
    expect(verifyBadgeState({ status: "queued", kind: "input" })).toEqual({ kind: "queued" });
    expect(verifyBadgeState({ status: "running", kind: "input" })).toEqual({ kind: "running" });
    expect(verifyBadgeState({ status: "failed", kind: "full", error: "x" })).toEqual({
      kind: "failed",
      error: "x",
    });
  });
  it("输入复核：一致 / 修订 / 早于记录 / 口径升级", () => {
    expect(verifyBadgeState(input({ sameInput: true, hashVersionSame: true }))).toEqual({
      kind: "input",
      same: true,
    });
    expect(verifyBadgeState(input({ sameInput: false, hashVersionSame: true }))).toEqual({
      kind: "input",
      same: false,
    });
    expect(verifyBadgeState(input({ sameInput: null, reason: "unrecorded" }))).toEqual({
      kind: "unrecorded",
    });
    expect(verifyBadgeState(input({ sameInput: false, hashVersionSame: false }))).toEqual({
      kind: "hashVersion",
    });
  });
  it("完整重跑：逐笔一致 / 结果不同带原因", () => {
    expect(verifyBadgeState(full({ sameResult: true, reproRunId: "r2" }))).toEqual({
      kind: "full",
      same: true,
      reason: null,
      reproRunId: "r2",
    });
    expect(verifyBadgeState(full({ sameResult: false, cause: "data" }))).toMatchObject({
      same: false,
      reason: "数据已修订",
    });
  });
});

describe("reproVerdict / runPollInterval", () => {
  const base = { id: "r2", kind: "reproduce", status: "done", finishedAt: 1_000 } as const;
  it("只认写给这次重跑的结果", () => {
    expect(reproVerdict({ id: "r2", verify: full({ reproRunId: "r2" }) })).not.toBeNull();
    expect(reproVerdict({ id: "r2", verify: full({ reproRunId: "r3" }) })).toBeNull();
    expect(reproVerdict({ id: "r2", verify: input({}) })).toBeNull();
    expect(reproVerdict({ id: "r2", verify: { status: "failed", kind: "full" } })).not.toBeNull();
  });
  it("跑着就轮询，跑完停", () => {
    expect(runPollInterval(undefined)).toBe(1500);
    expect(runPollInterval({ ...base, kind: "backtest", status: "running", verify: null })).toBe(
      1500,
    );
    expect(runPollInterval({ ...base, kind: "backtest", verify: null })).toBe(false);
    expect(
      runPollInterval({ ...base, kind: "backtest", verify: { status: "queued", kind: "input" } }),
    ).toBe(2000);
  });
  it("重跑等比对结果：有终态或等太久就停", () => {
    expect(runPollInterval({ ...base, verify: null }, 2_000)).toBe(1500);
    expect(runPollInterval({ ...base, verify: full({ reproRunId: "r2" }) }, 2_000)).toBe(false);
    expect(
      runPollInterval({ ...base, verify: { status: "failed", kind: "full", error: "x" } }, 2_000),
    ).toBe(false);
    expect(runPollInterval({ ...base, verify: null }, 1_000 + REPRO_COMPARE_WAIT_MS)).toBe(false);
  });
});

describe("quotaPatch", () => {
  it("只提交改过的项", () => {
    const initial = { chatMessages: "50", backtests: "20", analyses: "100" };
    expect(quotaPatch(initial, initial)).toEqual({});
    expect(quotaPatch(initial, { ...initial, analyses: "5" })).toEqual({ analyses: 5 });
  });
});

describe("computePausedNote", () => {
  const paused = { reason: "etl", since: 1 };
  it("排队中的回测或复核在等夜间更新时给出提示", () => {
    expect(computePausedNote({ status: "queued", verify: null, computePaused: paused })).toBe(
      COMPUTE_PAUSED_TEXT,
    );
    expect(
      computePausedNote({
        status: "done",
        verify: { status: "queued", kind: "input" },
        computePaused: paused,
      }),
    ).toBe(COMPUTE_PAUSED_TEXT);
  });
  it("没有暂停、或已经在跑 / 跑完的不提示", () => {
    expect(computePausedNote({ status: "queued", verify: null, computePaused: null })).toBeNull();
    expect(
      computePausedNote({ status: "running", verify: null, computePaused: paused }),
    ).toBeNull();
    expect(
      computePausedNote({
        status: "done",
        verify: { status: "running", kind: "input" },
        computePaused: paused,
      }),
    ).toBeNull();
    expect(computePausedNote(undefined)).toBeNull();
  });
});

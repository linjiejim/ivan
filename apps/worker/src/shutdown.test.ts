/**
 * worker 退出（D110）：按顺序收尾、在 pm2 的 kill_timeout 之前退出；关库卡住、任务不收尾时按时限放弃；第二次信号立刻退出。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createShutdown, SHUTDOWN_TIMINGS, type ShutdownDeps } from "./shutdown.ts";

function deps(over: Partial<ShutdownDeps> = {}) {
  const calls: string[] = [];
  const exits: number[] = [];
  const d: ShutdownDeps = {
    stopRunner: () => calls.push("stopRunner"),
    stopScheduler: () => calls.push("stopScheduler"),
    closeServer: () => calls.push("closeServer"),
    stopPool: async () => {
      calls.push("stopPool");
    },
    interruptWarehouse: () => calls.push("interrupt"),
    runningJobs: () => 0,
    closeWarehouse: async () => {
      calls.push("closeWarehouse");
    },
    closeAppDb: () => calls.push("closeAppDb"),
    exit: (code) => {
      exits.push(code);
    },
    log: () => {},
    ...over,
  };
  return { d, calls, exits };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createShutdown", () => {
  it("顺序：停认领与调度 → 关接口 → 停线程 → 打断查询 → 关行情仓 → 关应用库 → 退出码 0", async () => {
    const { d, calls, exits } = deps();
    await createShutdown(d)("SIGINT");
    expect(calls).toEqual([
      "stopRunner",
      "stopScheduler",
      "closeServer",
      "stopPool",
      "interrupt",
      "closeWarehouse",
      "closeAppDb",
    ]);
    expect(exits).toEqual([0]);
  });

  it("等在跑的任务收尾，最多 drainMs；关行情仓卡住最多 closeMs；合计在兜底与 pm2 的 10 秒之内", async () => {
    vi.useFakeTimers();
    const t = { hardMs: 8000, drainMs: 2000, closeMs: 3000 };
    expect(t).toEqual(SHUTDOWN_TIMINGS);
    expect(t.drainMs + t.closeMs + 1000).toBeLessThan(t.hardMs);
    expect(t.hardMs).toBeLessThan(10_000);
    const { d, calls, exits } = deps({
      runningJobs: () => 1,
      closeWarehouse: () => new Promise(() => {}),
    });
    const done = createShutdown(d, t)("SIGTERM");
    await vi.advanceTimersByTimeAsync(t.drainMs + t.closeMs + 200);
    await done;
    expect(exits).toEqual([0]);
    expect(calls.at(-1)).toBe("closeAppDb");
    // 兜底计时器已清掉：不会再退一次
    await vi.advanceTimersByTimeAsync(t.hardMs);
    expect(exits).toEqual([0]);
  });

  it("收尾本身卡住（比如停线程不返回）：兜底计时器到点强制退出，退出码 1", async () => {
    vi.useFakeTimers();
    const { d, exits } = deps({ stopPool: () => new Promise(() => {}) });
    void createShutdown(d)("SIGTERM");
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMINGS.hardMs - 1);
    expect(exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(exits).toEqual([1]);
  });

  it("退出中再收到信号：立即退出", async () => {
    vi.useFakeTimers();
    const { d, exits } = deps({ stopPool: () => new Promise(() => {}) });
    const shutdown = createShutdown(d);
    void shutdown("SIGINT");
    await shutdown("SIGINT");
    expect(exits).toEqual([1]);
  });
});

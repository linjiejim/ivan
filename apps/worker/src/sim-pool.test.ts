/**
 * 回测线程池加固：用 EventEmitter 做的假线程，不起真线程。
 */
import { EventEmitter } from "node:events";
import { type SimInput, type SimResult, StrategySpecSchema } from "@ivan/core";
import { ENGINE_VERSION } from "@ivan/engine";
import { describe, expect, it } from "vitest";
import { runSimulation, startPool, type ThreadLike } from "./sim-pool.ts";

type Mode = "ok" | "crash" | "exit" | "hang" | "slow";

class FakeThread extends EventEmitter implements ThreadLike {
  terminated = false;
  posted = 0;
  messages: unknown[] = [];
  constructor(private readonly mode: Mode) {
    super();
  }
  postMessage(msg: unknown): void {
    this.posted++;
    this.messages.push(msg);
    const { id, tasks } = msg as { id: number; tasks?: string[] };
    const validation = tasks?.includes("validation") ? { confidence: { seed: 1 } } : undefined;
    const later = (fn: () => void, ms = 1) => setTimeout(fn, ms);
    if (this.mode === "ok")
      later(() => this.emit("message", { id, result: fakeResult(id), validation }));
    if (this.mode === "slow") later(() => this.emit("message", { id, result: fakeResult(id) }), 30);
    if (this.mode === "crash") {
      later(() => {
        this.emit("error", new Error("JavaScript heap out of memory"));
        this.emit("exit", 1);
      });
    }
    if (this.mode === "exit") later(() => this.emit("exit", 134));
  }
  async terminate(): Promise<number> {
    this.terminated = true;
    return 1;
  }
}

const fakeResult = (id: number) => ({ engineVersion: `r${id}` }) as unknown as SimResult;
const input = () => ({ prices: new Map(), bench: new Float64Array(2) }) as unknown as SimInput;

/** 一个真能在主线程跑的最小回测输入（没有股票，全程空仓）。 */
function realInput(): SimInput {
  const calendar = ["2025-06-02", "2025-06-03", "2025-06-04"];
  return {
    spec: StrategySpecSchema.parse({
      name: "空",
      market: "A",
      rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 1 },
    }),
    params: { start: calendar[1]!, end: calendar[2]!, capital: 100_000, oosMonths: 0 },
    calendar,
    prices: new Map(),
    securities: new Map(),
    selections: new Map(),
    bench: new Float64Array(3).fill(1000),
    benchLabel: "测试基准",
    benchWithDividends: true,
  };
}

/** 按顺序给出每次新建线程的行为，记下建了哪些线程。 */
function factory(modes: Mode[]) {
  const made: FakeThread[] = [];
  return {
    made,
    spawn: () => {
      const t = new FakeThread(modes[made.length] ?? "ok");
      made.push(t);
      return t;
    },
  };
}

describe("回测线程池", () => {
  it("正常：结果按 id 对上", async () => {
    const f = factory(["ok"]);
    startPool(1, { spawn: f.spawn, timeoutMs: 1000 });
    const { result: r } = await runSimulation(input());
    expect(r.engineVersion).toMatch(/^r\d+$/);
    expect(f.made).toHaveLength(1);
    // 每次调用的监听都摘掉了，不会越积越多；只剩常驻的 error / exit 各一个
    expect(f.made[0]!.listenerCount("message")).toBe(0);
    expect(f.made[0]!.listenerCount("error")).toBe(1);
    expect(f.made[0]!.listenerCount("exit")).toBe(1);
  });

  it("线程崩溃：当前调用被拒（只拒一次），线程重建，下一次调用在新线程上成功", async () => {
    const f = factory(["crash", "ok"]);
    startPool(1, { spawn: f.spawn, timeoutMs: 1000 });
    await expect(runSimulation(input())).rejects.toThrow(
      "回测线程异常退出：JavaScript heap out of memory",
    );
    expect(f.made).toHaveLength(2);
    expect(f.made[0]!.terminated).toBe(true);
    const { result: r } = await runSimulation(input());
    expect(r.engineVersion).toMatch(/^r\d+$/);
    expect(f.made).toHaveLength(2);
    expect(f.made[1]!.posted).toBe(1);
  });

  it("非零退出码也算崩溃", async () => {
    const f = factory(["exit", "ok"]);
    startPool(1, { spawn: f.spawn, timeoutMs: 1000 });
    await expect(runSimulation(input())).rejects.toThrow("回测线程异常退出：退出码 134");
    await expect(runSimulation(input())).resolves.toBeTruthy();
  });

  it("卡死超时：终止并重建；排队等槽位的第二个调用在新线程上成功", async () => {
    const f = factory(["hang", "ok"]);
    startPool(1, { spawn: f.spawn, timeoutMs: 50 });
    const first = runSimulation(input());
    const second = runSimulation(input());
    await expect(first).rejects.toThrow("回测线程 50 毫秒没有返回结果，已重启线程");
    const { result: r } = await second;
    expect(r.engineVersion).toMatch(/^r\d+$/);
    expect(f.made[0]!.terminated).toBe(true);
    expect(f.made[0]!.posted).toBe(1);
    expect(f.made[1]!.posted).toBe(1);
  });

  it("第二个调用等第一个跑完再用同一个线程", async () => {
    const f = factory(["slow"]);
    startPool(1, { spawn: f.spawn, timeoutMs: 1000 });
    const [{ result: a }, { result: b }] = await Promise.all([
      runSimulation(input()),
      runSimulation(input()),
    ]);
    expect(a.engineVersion).not.toBe(b.engineVersion);
    expect(f.made).toHaveLength(1);
    expect(f.made[0]!.posted).toBe(2);
  });

  it("线程池大小为 0：在主线程直接跑", async () => {
    const f = factory([]);
    startPool(0, { spawn: f.spawn });
    const { result: r } = await runSimulation(realInput());
    expect(r.engineVersion).toBe(ENGINE_VERSION);
    expect(f.made).toHaveLength(0);
  });

  it("线程在两次任务之间死了：下一次调用先重建线程，不往死线程上发", async () => {
    const f = factory(["ok", "ok"]);
    startPool(1, { spawn: f.spawn, timeoutMs: 1000 });
    await runSimulation(input());
    // 空闲时出错退出：常驻监听接住，主线程不抛
    f.made[0]!.emit("error", new Error("boom"));
    f.made[0]!.emit("exit", 1);
    const { result: r } = await runSimulation(input());
    expect(r.engineVersion).toMatch(/^r\d+$/);
    expect(f.made).toHaveLength(2);
    expect(f.made[0]!.terminated).toBe(true);
    expect(f.made[0]!.posted).toBe(1);
    expect(f.made[1]!.posted).toBe(1);
  });

  it("崩溃后线程重建失败：当前调用被拒，排队的调用改在主线程跑，不去等死线程超时", async () => {
    let made = 0;
    const t = new FakeThread("crash");
    startPool(1, {
      timeoutMs: 60_000,
      spawn: () => {
        if (made++ > 0) throw new Error("起不来");
        return t;
      },
    });
    const first = runSimulation(input());
    const second = runSimulation(realInput());
    await expect(first).rejects.toThrow("回测线程异常退出");
    const { result: r } = await second;
    expect(r.engineVersion).toBe(ENGINE_VERSION);
    expect(t.posted).toBe(1);
    // 之后的调用也直接在主线程跑
    await expect(runSimulation(realInput())).resolves.toMatchObject({
      result: { engineVersion: ENGINE_VERSION },
    });
  });

  it("可信度任务与种子随消息转交，线程回传的 validation 原样返回；不请求时没有", async () => {
    const f = factory(["ok"]);
    startPool(1, { spawn: f.spawn, timeoutMs: 1000 });
    const out = await runSimulation(input(), { tasks: ["validation"], seed: 42 });
    expect(out.validation).toEqual({ confidence: { seed: 1 } });
    expect(f.made[0]!.messages[0]).toMatchObject({ tasks: ["validation"], seed: 42 });
    const plain = await runSimulation(input());
    expect(plain).not.toHaveProperty("validation");
  });

  it("主线程退路走同一个 runSimTasks：旧口径的输入即使请求可信度也不算", async () => {
    startPool(0, { spawn: factory([]).spawn });
    const out = await runSimulation(realInput(), { tasks: ["validation"], seed: 1 });
    expect(out.result.engineVersion).toBe(ENGINE_VERSION);
    expect(out).not.toHaveProperty("validation");
  });
});

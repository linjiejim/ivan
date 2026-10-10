/**
 * 回测线程池：大小由 BACKTEST_POOL_SIZE 决定（jim-server 默认 1）。线程起不来时退回主线程执行。
 *
 * 加固（spec §1）：线程崩溃（error / 非零 exit）时拒绝当前调用并重建线程；单次调用超过 timeoutMs 终止并重建；
 * 线程堆上限 resourceLimits.maxOldGenerationSizeMb。结算在串行的 etl 道里调它，一次崩溃或卡死不能堵住后面的任务。
 * 线程工厂可注入，测试用假线程。
 */
import { Worker } from "node:worker_threads";
import type { SimInput, SimResult } from "@ivan/core";
import { simulate } from "@ivan/engine";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (...a: any[]) => void;

/** 回测线程需要的那部分 Worker 接口（测试里用 EventEmitter 做的假线程实现）。 */
export interface ThreadLike {
  postMessage(msg: unknown, transfer?: readonly ArrayBuffer[]): void;
  on(ev: "message" | "error" | "exit", fn: Listener): unknown;
  off(ev: string, fn: Listener): unknown;
  terminate(): Promise<number>;
  unref?(): void;
}

export interface PoolOptions {
  /** 单次回测最长多久（毫秒），默认 120000 */
  timeoutMs?: number;
  /** 线程堆上限（MB），默认 256 */
  maxOldGenMb?: number;
  /** 线程工厂（测试注入） */
  spawn?: () => ThreadLike;
}

interface Slot {
  thread: ThreadLike;
  busy: boolean;
  /** 线程在空闲时死了（error / exit）：下次取用前先重建，不往死线程上发任务 */
  dead: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OLD_GEN_MB = 256;

let slots: Slot[] = [];
let waiting: Array<() => void> = [];
let seq = 0;
let disabled = false;
let timeoutMs = DEFAULT_TIMEOUT_MS;
let spawn: () => ThreadLike = () => {
  throw new Error("回测线程池还没启动");
};

/**
 * 起一个线程并挂上常驻的 error / exit 监听：没有 error 监听时 Worker 的 error 事件会在主线程抛出；
 * 线程在两次任务之间死掉也要记下来，下次取用时先重建。只认这个槽当前的线程（主动终止的旧线程退出不算）。
 */
function spawnFor(slot: Pick<Slot, "thread" | "dead">): ThreadLike {
  const t = spawn();
  const markDead = () => {
    if (slot.thread === t) slot.dead = true;
  };
  t.on("error", markDead);
  t.on("exit", markDead);
  return t;
}

export function startPool(size: number, opts: PoolOptions = {}): void {
  slots = [];
  waiting = [];
  disabled = false;
  timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOldGenMb = opts.maxOldGenMb ?? DEFAULT_MAX_OLD_GEN_MB;
  spawn =
    opts.spawn ??
    (() => {
      const w = new Worker(new URL("./sim-thread.ts", import.meta.url), {
        execArgv: ["--import", "tsx"],
        resourceLimits: { maxOldGenerationSizeMb: maxOldGenMb },
      });
      w.unref();
      return w;
    });
  if (size <= 0) {
    disabled = true;
    return;
  }
  try {
    for (let k = 0; k < size; k++) {
      const slot = { busy: false, dead: false } as Slot;
      slot.thread = spawnFor(slot);
      slots.push(slot);
    }
  } catch (e) {
    console.warn(`回测线程起不来，改在主线程跑：${e instanceof Error ? e.message : e}`);
    slots = [];
    disabled = true;
  }
}

/** 取一个空闲槽位；线程池已退回主线程（或槽位都没了）时返回 null。 */
async function acquire(): Promise<Slot | null> {
  for (;;) {
    if (disabled || !slots.length) return null;
    const free = slots.find((s) => !s.busy);
    if (free) {
      if (free.dead && !respawn(free)) continue;
      free.busy = true;
      return free;
    }
    await new Promise<void>((r) => waiting.push(r));
  }
}

function transferables(input: SimInput): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const p of input.prices.values()) {
    for (const a of [p.open, p.high, p.low, p.close, p.adj, p.st]) out.add(a.buffer as ArrayBuffer);
  }
  out.add(input.bench.buffer as ArrayBuffer);
  return [...out];
}

/**
 * 终止坏掉的线程（尽力而为）并换一个新的。新线程起不来时去掉这个槽位（槽位都没了就整个退回主线程），
 * 并叫醒所有排队的调用重新取槽位——不能让它们拿到死线程、各自白等一个超时。
 */
function respawn(slot: Slot): boolean {
  slot.thread.terminate().catch(() => {});
  try {
    slot.thread = spawnFor(slot);
    slot.dead = false;
    return true;
  } catch (e) {
    console.warn(`回测线程重建失败，这个槽位改在主线程跑：${e instanceof Error ? e.message : e}`);
    slots = slots.filter((s) => s !== slot);
    if (!slots.length) disabled = true;
    const woken = waiting;
    waiting = [];
    for (const w of woken) w();
    return false;
  }
}

function timeoutText(ms: number): string {
  return ms < 1000 ? `${ms} 毫秒` : `${Math.round(ms / 1000)} 秒`;
}

export async function runSimulation(input: SimInput): Promise<SimResult> {
  const slot = await acquire();
  if (!slot) return simulate(input);
  const id = ++seq;
  const thread = slot.thread;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners: Array<[string, Listener]> = [];
  try {
    return await new Promise<SimResult>((resolve, reject) => {
      let settled = false;
      const listen = (ev: "message" | "error" | "exit", fn: Listener) => {
        thread.on(ev, fn);
        listeners.push([ev, fn]);
      };
      // 崩溃时 error 与 exit 会先后到，超时终止也会触发 exit：只处理第一次
      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        respawn(slot);
        reject(new Error(msg));
      };
      listen("message", (msg: { id: number; result?: SimResult; error?: string }) => {
        if (settled || msg?.id !== id) return;
        settled = true;
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.result!);
      });
      listen("error", (e: unknown) => {
        fail(`回测线程异常退出：${e instanceof Error ? e.message : String(e)}`);
      });
      listen("exit", (code: number) => {
        if (code !== 0) fail(`回测线程异常退出：退出码 ${code}`);
      });
      timer = setTimeout(() => {
        fail(`回测线程 ${timeoutText(timeoutMs)}没有返回结果，已重启线程`);
      }, timeoutMs);
      thread.postMessage({ id, input }, transferables(input));
    });
  } finally {
    if (timer) clearTimeout(timer);
    for (const [ev, fn] of listeners) thread.off(ev, fn);
    slot.busy = false;
    waiting.shift()?.();
  }
}

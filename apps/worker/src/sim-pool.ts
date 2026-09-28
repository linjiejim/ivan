/**
 * 回测线程池：大小由 BACKTEST_POOL_SIZE 决定（jim-server 默认 1）。线程起不来时退回主线程执行。
 */
import { Worker } from "node:worker_threads";
import type { SimInput, SimResult } from "@ivan/core";
import { simulate } from "@ivan/engine";

interface Slot {
  worker: Worker;
  busy: boolean;
}

let slots: Slot[] = [];
const waiting: Array<() => void> = [];
let seq = 0;
let disabled = false;

export function startPool(size: number): void {
  if (size <= 0) {
    disabled = true;
    return;
  }
  try {
    slots = Array.from({ length: size }, () => ({
      worker: new Worker(new URL("./sim-thread.ts", import.meta.url), {
        execArgv: ["--import", "tsx"],
      }),
      busy: false,
    }));
    for (const s of slots) s.worker.unref();
  } catch (e) {
    console.warn(`回测线程起不来，改在主线程跑：${e instanceof Error ? e.message : e}`);
    disabled = true;
  }
}

async function acquire(): Promise<Slot> {
  for (;;) {
    const free = slots.find((s) => !s.busy);
    if (free) {
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

export async function runSimulation(input: SimInput): Promise<SimResult> {
  if (disabled || !slots.length) return simulate(input);
  const slot = await acquire();
  const id = ++seq;
  try {
    return await new Promise<SimResult>((resolve, reject) => {
      const onMessage = (msg: { id: number; result?: SimResult; error?: string }) => {
        if (msg.id !== id) return;
        cleanup();
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.result!);
      };
      const onError = (e: Error) => {
        cleanup();
        reject(e);
      };
      const cleanup = () => {
        slot.worker.off("message", onMessage);
        slot.worker.off("error", onError);
      };
      slot.worker.on("message", onMessage);
      slot.worker.on("error", onError);
      slot.worker.postMessage({ id, input }, transferables(input));
    });
  } finally {
    slot.busy = false;
    waiting.shift()?.();
  }
}

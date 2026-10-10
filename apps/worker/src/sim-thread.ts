/**
 * 回测线程（D3）：主线程组装好输入（TypedArray 零拷贝转交），这里只跑纯函数 simulate（与按需的可信度，D65）。
 */
import { parentPort } from "node:worker_threads";
import type { SimInput } from "@ivan/core";
import { runSimTasks, type SimTask } from "./sim-tasks.ts";

parentPort?.on(
  "message",
  (msg: { id: number; input: SimInput; tasks?: SimTask[]; seed?: number }) => {
    try {
      const { result, validation } = runSimTasks(msg.input, { tasks: msg.tasks, seed: msg.seed });
      parentPort!.postMessage({ id: msg.id, result, validation });
    } catch (e) {
      parentPort!.postMessage({ id: msg.id, error: e instanceof Error ? e.message : String(e) });
    }
  },
);

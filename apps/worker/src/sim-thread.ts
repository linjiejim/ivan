/**
 * 回测线程（D3）：主线程组装好输入（TypedArray 零拷贝转交），这里只跑纯函数 simulate。
 */
import { parentPort } from "node:worker_threads";
import type { SimInput } from "@ivan/core";
import { simulate } from "@ivan/engine";

parentPort?.on("message", (msg: { id: number; input: SimInput }) => {
  try {
    const result = simulate(msg.input);
    parentPort!.postMessage({ id: msg.id, result });
  } catch (e) {
    parentPort!.postMessage({ id: msg.id, error: e instanceof Error ? e.message : String(e) });
  }
});

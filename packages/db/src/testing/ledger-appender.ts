/**
 * 账本并发测试用的线程（ledger.test.ts）：另开一个连接（相当于另一个进程），收到 go 后追加 n 条，再回 done。
 */
import { parentPort, workerData } from "node:worker_threads";
import { appendLedger } from "../ledger.ts";
import { openAppDb } from "../index.ts";

const { path, userId, n, tag } = workerData as {
  path: string;
  userId: string;
  n: number;
  tag: string;
};
const h = openAppDb(path, { migrate: false });
parentPort!.on("message", (m: string) => {
  if (m !== "go") return;
  try {
    for (let i = 0; i < n; i++) {
      appendLedger(h, {
        userId,
        kind: "tracking_start",
        subjectType: "user",
        subjectId: userId,
        asOf: null,
        payloadTable: "inline",
        payload: { from: tag, i },
      });
    }
    parentPort!.postMessage({ done: true });
  } catch (e) {
    parentPort!.postMessage({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    h.sqlite.close();
  }
});
parentPort!.postMessage({ ready: true });

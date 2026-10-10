/**
 * ivan-worker：调度 + ETL + 任务执行；行情仓 DuckDB 的唯一持有者。
 * 内部接口只监听 127.0.0.1。调度器显式用北京时间（D14），不依赖机器时区。
 */
import { serve } from "@hono/node-server";
import { Cron } from "croner";
import { initEnv } from "./env.ts";
import { createInternalApp } from "./internal.ts";
import { enqueue, recoverStale, runLoop, stopRunner } from "./runner.ts";
import { startPool } from "./sim-pool.ts";

const e = await initEnv({
  migrate: process.env.WAREHOUSE_MIGRATE_ON_BOOT === "1" ? "auto" : "light",
});
if (e.wh.maintenance) console.log(`行情仓维护中：${e.wh.maintenance}（调度不排任务，任务不认领）`);
const stale = recoverStale();
if (stale) console.log(`上次有 ${stale} 个任务没跑完，已标为失败`);
startPool(e.cfg.backtestPoolSize, {
  timeoutMs: e.cfg.backtestTimeoutMs,
  maxOldGenMb: e.cfg.backtestThreadMemoryMb,
});

const server = serve(
  { fetch: createInternalApp().fetch, port: e.cfg.workerPort, hostname: "127.0.0.1" },
  (info) =>
    console.log(`ivan-worker 内部接口：127.0.0.1:${info.port}（行情仓 ${e.cfg.warehousePath}）`),
);

// 维护状态（行情仓还没升级）不排任务：升级完 scripts/migrate.sh 会重启 worker
if (e.cfg.schedulerEnabled && !e.wh.maintenance) {
  const tz = { timezone: "Asia/Shanghai" };
  // spec §8：17:30 A 股、18:00 港股（交易日判断在 daily() 里），19:00 简报
  new Cron("30 17 * * 1-5", tz, () => void enqueue("etl", { market: "A" }));
  new Cron("0 18 * * 1-5", tz, () => void enqueue("etl", { market: "HK" }));
  new Cron("0 19 * * 1-5", tz, () => void enqueue("brief", {}));
  new Cron("0 3 * * 0", tz, () => void enqueue("check", {}));
  console.log("调度已开启（北京时间工作日 17:30 A 股 / 18:00 港股 / 19:00 简报；周日 03:00 抽检）");
}

const shutdown = () => {
  console.log("ivan-worker 正在退出…");
  stopRunner();
  server.close();
  e.wh.close();
  e.app.sqlite.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await runLoop(e.cfg.backtestPoolSize);

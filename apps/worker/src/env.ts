/**
 * worker 进程级单例：配置、行情仓（DuckDB，唯一持有者）、应用库（SQLite）、抓取客户端。
 */
import { type Config, loadConfig } from "@ivan/core/config";
import { todayCN } from "@ivan/core";
import { type EtlContext, Http, Warehouse } from "@ivan/data";
import { type AppDbHandle, openAppDb } from "@ivan/db";

export interface WorkerEnv {
  cfg: Config;
  wh: Warehouse;
  app: AppDbHandle;
  http: Http;
}

let handle: WorkerEnv | undefined;

export async function initEnv(): Promise<WorkerEnv> {
  if (handle) return handle;
  const cfg = loadConfig();
  const wh = await Warehouse.open(cfg.warehousePath, cfg.duckdb);
  const app = openAppDb(cfg.appDbPath);
  const http = new Http({
    concurrencyPerHost: cfg.fetch.concurrency,
    minIntervalMs: cfg.fetch.minIntervalMs,
  });
  handle = { cfg, wh, app, http };
  return handle;
}

export function env(): WorkerEnv {
  if (!handle) throw new Error("worker 环境还没初始化");
  return handle;
}

export function etlContext(
  log: (m: string) => void,
  progress?: EtlContext["progress"],
): EtlContext {
  const { wh, http } = env();
  return { wh, http, today: todayCN(), log, progress };
}

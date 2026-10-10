/**
 * worker 进程级单例：配置、行情仓（DuckDB，唯一持有者）、应用库（SQLite）、抓取客户端。
 */
import { type Config, loadConfig } from "@ivan/core/config";
import { type DateStr, todayCN } from "@ivan/core";
import { type EtlContext, Http, type HttpLike, Warehouse } from "@ivan/data";
import { type AppDbHandle, openAppDb } from "@ivan/db";
import type { LanguageModel } from "ai";

export interface WorkerEnv {
  cfg: Config;
  wh: Warehouse;
  app: AppDbHandle;
  http: HttpLike;
  /** 「今天」（北京时间）；测试注入固定日期 */
  today?: () => DateStr;
  /** 简报用的模型；测试注入假模型（平时按配置建） */
  briefModel?: LanguageModel;
}

let handle: WorkerEnv | undefined;

/**
 * migrate：worker 启动默认 light——行情仓要改大表时不升级、进维护状态（D76），等 scripts/migrate.sh；
 * WAREHOUSE_MIGRATE_ON_BOOT=1 时用 auto（开发机）。
 */
export async function initEnv(opts: { migrate?: "auto" | "light" } = {}): Promise<WorkerEnv> {
  if (handle) return handle;
  const cfg = loadConfig();
  const wh = await Warehouse.open(cfg.warehousePath, { ...cfg.duckdb, migrate: opts.migrate });
  const app = openAppDb(cfg.appDbPath);
  const http = new Http({
    concurrencyPerHost: cfg.fetch.concurrency,
    minIntervalMs: cfg.fetch.minIntervalMs,
  });
  handle = { cfg, wh, app, http };
  return handle;
}

/** 测试用：直接换掉进程级单例（传 undefined 清空）。 */
export function setWorkerEnvForTest(e: WorkerEnv | undefined): void {
  handle = e;
}

/** worker 眼里的「今天」：ETL 上下文、简报、市场当日状态都用它，测试可以固定。 */
export function todayOf(): DateStr {
  return handle?.today?.() ?? todayCN();
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
  return { wh, http, today: todayOf(), log, progress };
}

/**
 * 应用库连接：server 与 worker 各开一个连接（WAL 模式允许多进程读写）。
 * 迁移文件由 drizzle-kit 生成在 packages/db/migrations，启动时自动执行。
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.ts";

export * from "./schema.ts";
export {
  COMPUTE_EXCLUSIVE,
  COMPUTE_PAUSED_TEXT,
  computeBlocked,
  WAREHOUSE_WRITERS,
} from "./jobs-gate.ts";
export { schema };
export { newId, packJson, unpackJson } from "./util.ts";
export * from "./ledger.ts";
export * from "./plans.ts";
export * from "./briefs.ts";
export * from "./bundle.ts";

const MIGRATIONS = resolve(fileURLToPath(new URL("..", import.meta.url)), "migrations");

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;

export interface AppDbHandle {
  sqlite: Database.Database;
  db: AppDb;
}

export function openAppDb(
  path: string,
  opts: { migrate?: boolean; migrationsFolder?: string } = {},
): AppDbHandle {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  if (opts.migrate !== false) migrateWithRetry(db, opts.migrationsFolder ?? MIGRATIONS);
  return { sqlite, db };
}

/**
 * 部署时 server 与 worker 同时启动、同时迁移：drizzle 在事务外读「已经做到哪一条」，后到的进程可能按旧的读数
 * 再跑一遍已经做过的 ALTER（duplicate column）。迁移整体在一个事务里，失败会整体回滚，所以出错时等一下重来：
 * 重来时重新读进度，先到的进程已经做完就什么都不用做。最多试 6 次（约 10 秒）。
 */
export function migrateWithRetry(db: AppDb, folder: string, run: typeof migrate = migrate): void {
  for (let attempt = 1; ; attempt++) {
    try {
      run(db, { migrationsFolder: folder });
      return;
    } catch (e) {
      if (attempt >= 6) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300 * attempt);
    }
  }
}

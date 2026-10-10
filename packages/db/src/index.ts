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
export { COMPUTE_PAUSED_TEXT, computeBlocked, WAREHOUSE_WRITERS } from "./jobs-gate.ts";
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

export function openAppDb(path: string, opts: { migrate?: boolean } = {}): AppDbHandle {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  if (opts.migrate !== false) migrate(db, { migrationsFolder: MIGRATIONS });
  return { sqlite, db };
}

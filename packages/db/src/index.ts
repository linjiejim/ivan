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
import { deflateSync, inflateSync } from "node:zlib";
import * as schema from "./schema.ts";

export * from "./schema.ts";
export { COMPUTE_PAUSED_TEXT, computeBlocked, WAREHOUSE_WRITERS } from "./jobs-gate.ts";
export { schema };

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

/** 大 JSON（净值序列、持仓快照）压缩存储 */
export function packJson(v: unknown): Buffer {
  return deflateSync(Buffer.from(JSON.stringify(v)));
}

export function unpackJson<T>(b: Buffer | null | undefined): T | null {
  if (!b) return null;
  return JSON.parse(inflateSync(b).toString("utf8")) as T;
}

export function newId(prefix = ""): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${prefix}${t}${r}`;
}

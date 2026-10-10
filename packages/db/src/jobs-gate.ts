/**
 * 行情仓写库期间暂停回测（D60）：etl 道里有夜间更新（etl）或每周抽检（check）排队或在跑时，
 * compute 道（回测、扫描、复核）不认领新任务。worker 的 runner 用它决定认不认领，
 * server 用它告诉用户「行情正在更新，回测会在更新完成后开始」。两边读的是同一张 jobs 表。
 */
import type Database from "better-sqlite3";

/** 会写行情仓的任务 */
export const WAREHOUSE_WRITERS: ReadonlySet<string> = new Set(["etl", "check"]);

/** 排队或在跑的第一个写库任务（null = 没有，compute 道可以认领） */
export function computeBlocked(sqlite: Database.Database): { kind: string; since: number } | null {
  const kinds = [...WAREHOUSE_WRITERS].map((k) => `'${k}'`).join(",");
  const row = sqlite
    .prepare(
      `SELECT kind, coalesce(started_at, created_at) AS since FROM jobs
       WHERE kind IN (${kinds}) AND status IN ('running', 'queued')
       ORDER BY created_at LIMIT 1`,
    )
    .get() as { kind: string; since: number } | undefined;
  return row ? { kind: row.kind, since: row.since } : null;
}

/** 暂停回测时给用户看的一句话（定义在 @ivan/core，模型摘要也用它） */
export { COMPUTE_PAUSED_TEXT } from "@ivan/core";

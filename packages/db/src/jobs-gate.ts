/**
 * 行情仓写库期间暂停回测（D60）：etl 道里有夜间更新（etl）、每周抽检（check）或事件因子列补算（event_cols，S15b）排队或在跑时，
 * compute 道（回测、扫描、复核）不认领新任务。worker 的 runner 用它决定认不认领，
 * server 用它告诉用户「行情正在更新，回测会在更新完成后开始」。两边读的是同一张 jobs 表。
 */
import type Database from "better-sqlite3";

/** 会写行情仓的任务（events 回填只写事件表、回测不读，不算；event_cols 改 factors_daily，算） */
export const WAREHOUSE_WRITERS: ReadonlySet<string> = new Set(["etl", "check", "event_cols"]);

/**
 * 排队或在跑的第一个写库任务（null = 没有，compute 道可以认领）。
 * 排着队等自动重跑、还没到时间的（not_before 在未来，D73）不算：等重跑的 45 分钟里回测照常。
 */
export function computeBlocked(
  sqlite: Database.Database,
  now: number = Date.now(),
): { kind: string; since: number } | null {
  const kinds = [...WAREHOUSE_WRITERS].map((k) => `'${k}'`).join(",");
  const row = sqlite
    .prepare(
      `SELECT kind, coalesce(started_at, created_at) AS since FROM jobs
       WHERE kind IN (${kinds}) AND status IN ('running', 'queued')
         AND (status = 'running' OR not_before IS NULL OR not_before <= ?)
       ORDER BY created_at LIMIT 1`,
    )
    .get(now) as { kind: string; since: number } | undefined;
  return row ? { kind: row.kind, since: row.since } : null;
}

/** 暂停回测时给用户看的一句话（定义在 @ivan/core，模型摘要也用它） */
export { COMPUTE_PAUSED_TEXT } from "@ivan/core";

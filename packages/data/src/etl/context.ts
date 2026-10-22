import type { DateStr, Market } from "@ivan/core";
import type { HttpLike } from "../http.ts";
import type { FetchLedger } from "../sources/chain.ts";
import type { RateLimitWaitBudget } from "./rate-limit.ts";
import type { Warehouse } from "../warehouse/db.ts";

export type LogFn = (msg: string) => void;

export interface EtlContext {
  wh: Warehouse;
  http: HttpLike;
  today: DateStr;
  log: LogFn;
  /** 进度回调（0–1），任务页面展示用 */
  progress?: (fraction: number, note?: string) => void;
  /** 当前打开的数据版本号（D60）：写入方给每行盖章（表尾的 ver 列）；不在版本里写（调试命令）时为空 */
  ver?: number;
  /** 这次任务的取数台账（D72）：夜间增量与回填才有，提交数据版本时写进 data_versions.sources */
  ledger?: FetchLedger;
  /**
   * 等风控解封的总预算（D108）：worker 里的夜间更新与每周抽检才有；用完了被拦的股票不再等、记成 rate_limited 缺失。
   * 不给（命令行回填，worker 停着）= 照旧等到解封
   */
  rateLimitBudget?: RateLimitWaitBudget;
}

export interface SecurityRow {
  code: string;
  market: Market;
  name: string | null;
  board: string | null;
  list_date: DateStr | null;
  delist_date: DateStr | null;
  lot_size: number | null;
  industry_l1: string | null;
  industry: string | null;
  sec_type: string | null;
}

export async function loadSecurities(
  wh: Warehouse,
  market: Market,
  activeSince?: DateStr,
): Promise<SecurityRow[]> {
  const where = activeSince
    ? `AND (delist_date IS NULL OR delist_date >= DATE '${activeSince}')`
    : "";
  return wh.all<SecurityRow>(
    `SELECT code, market, name, board, list_date::VARCHAR AS list_date,
            delist_date::VARCHAR AS delist_date, lot_size, industry_l1, industry, sec_type
     FROM securities WHERE market = $m ${where} ORDER BY code`,
    { m: market },
  );
}

/**
 * 库里至少有一根日线的股票。夜间增量、财报增量、每周抽检都只管这些：
 * 用 --top 回填的库里，其余股票从没回填过，增量不替它们补历史。
 */
export async function filledCodes(wh: Warehouse, market: Market): Promise<Set<string>> {
  const rows = await wh.all<{ code: string }>(
    `SELECT DISTINCT code FROM bars_daily WHERE code ${market === "HK" ? "" : "NOT "}LIKE '%.HK'`,
  );
  return new Set(rows.map((r) => r.code));
}

/** 断点续跑：记录每个（任务, 键）的完成状态。 */
export async function doneKeys(wh: Warehouse, task: string): Promise<Set<string>> {
  const rows = await wh.all<{ key: string }>(
    `SELECT key FROM etl_progress WHERE task = $t AND status = 'done'`,
    { t: task },
  );
  return new Set(rows.map((r) => r.key));
}

export async function markDone(wh: Warehouse, task: string, key: string, detail = ""): Promise<void> {
  await wh.run(
    `INSERT OR REPLACE INTO etl_progress (task, key, status, detail, updated_at)
     VALUES ($t, $k, 'done', $d, current_timestamp)`,
    { t: task, k: key, d: detail },
  );
}

/**
 * 写进去了但不算完成（两融只拿到一个交易所，D81）：之后的回填照样重取；回填完成判断里「done 或 partial」都算覆盖。
 */
export async function markPartial(wh: Warehouse, task: string, key: string, detail = ""): Promise<void> {
  await wh.run(
    `INSERT OR REPLACE INTO etl_progress (task, key, status, detail, updated_at)
     VALUES ($t, $k, 'partial', $d, current_timestamp)`,
    { t: task, k: key, d: detail },
  );
}

export async function markFailed(wh: Warehouse, task: string, key: string, err: string): Promise<void> {
  await wh.run(
    `INSERT OR REPLACE INTO etl_progress (task, key, status, detail, updated_at)
     VALUES ($t, $k, 'failed', $d, current_timestamp)`,
    { t: task, k: key, d: err.slice(0, 500) },
  );
}

export async function resetTask(wh: Warehouse, task: string): Promise<void> {
  await wh.run(`DELETE FROM etl_progress WHERE task = $t`, { t: task });
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 已提交的数据版本（D60）：回测、结算、选股、证据只读到这里。单独成文件，让 ETL 一侧（etl/event-columns.ts）
 * 也能引用而不和 query/backtest.ts 互相引用。
 */
import type { DateStr } from "@ivan/core";
import type { Warehouse } from "../warehouse/db.ts";

export interface DataVersionInfo {
  id: number | null;
  asOf: DateStr | null;
}

/**
 * 最新的已提交数据版本（D60）：只认 ok（旧行 status 为空也算 ok）；open、incomplete、failed、skipped 都不会被引用。
 */
export async function latestDataVersion(wh: Warehouse, market: string): Promise<DataVersionInfo> {
  const r = await wh.one<{ id: number; as_of: string }>(
    `SELECT id, as_of::VARCHAR AS as_of FROM data_versions
     WHERE market = $m AND coalesce(status, 'ok') = 'ok' ORDER BY id DESC LIMIT 1`,
    { m: market },
  );
  return { id: r?.id ?? null, asOf: r?.as_of ?? null };
}

/**
 * 「读到哪一天」（D60）：最新 ok 版本的截至日。回测终点、跟踪结算、选股默认日期都用它——
 * 某晚写了因子却失败时，读的人还停在上一个提交过的版本上。
 */
export async function committedAsOf(wh: Warehouse, market: string): Promise<DateStr | null> {
  return (await latestDataVersion(wh, market)).asOf;
}


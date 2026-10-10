/**
 * 行情仓升级测试用：把新建的库退回旧版表结构。
 */
import { EVENT_FACTOR_KEYS } from "@ivan/core";
import type { Warehouse } from "../warehouse/db.ts";
import { PROVENANCE_TABLES } from "../warehouse/schema.ts";

/** 第 4 版（S15）加的点时事件表 */
export const V4_TABLES = ["margin_daily", "holder_counts", "lockups", "block_trades", "pit_sync", "pit_batches"] as const;

/**
 * 把新建的（第 5 版）行情仓退回第 2 版（916a43c）的样子：删掉第 3 版加的列与表、第 4 版的事件表与序列、
 * 第 5 版的 7 个事件因子列，版本号写回 2。线上的旧库就是这个形状，升级要一次 auto 走到第 5 版。
 */
export async function downgradeWarehouseToV2(wh: Warehouse): Promise<void> {
  for (const t of PROVENANCE_TABLES) {
    await wh.run(`ALTER TABLE ${t} DROP COLUMN src`);
    await wh.run(`ALTER TABLE ${t} DROP COLUMN ver`);
  }
  await wh.run(`ALTER TABLE trade_calendar DROP COLUMN ver`);
  for (const c of ["status", "started_at", "completeness", "sources", "registry_version"]) {
    await wh.run(`ALTER TABLE data_versions DROP COLUMN ${c}`);
  }
  for (const t of ["bar_status", "data_issues", "attr_history", "financials_seen", ...V4_TABLES]) {
    await wh.run(`DROP TABLE ${t}`);
  }
  await wh.run(`DROP SEQUENCE data_issue_seq`);
  await wh.run(`DROP SEQUENCE pit_batch_seq`);
  for (const k of EVENT_FACTOR_KEYS) await wh.run(`ALTER TABLE factors_daily DROP COLUMN ${k}`);
  await wh.setMeta("schema_version", "2");
}

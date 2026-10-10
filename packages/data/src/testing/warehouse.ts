/**
 * 行情仓升级测试用：把新建的库退回旧版表结构。
 */
import type { Warehouse } from "../warehouse/db.ts";
import { PROVENANCE_TABLES } from "../warehouse/schema.ts";

/** 把新建的第 3 版行情仓退回第 2 版的样子：删掉第 3 版加的列与表，版本号写回 2 */
export async function downgradeWarehouseToV2(wh: Warehouse): Promise<void> {
  for (const t of PROVENANCE_TABLES) {
    await wh.run(`ALTER TABLE ${t} DROP COLUMN src`);
    await wh.run(`ALTER TABLE ${t} DROP COLUMN ver`);
  }
  await wh.run(`ALTER TABLE trade_calendar DROP COLUMN ver`);
  for (const c of ["status", "started_at", "completeness", "sources", "registry_version"]) {
    await wh.run(`ALTER TABLE data_versions DROP COLUMN ${c}`);
  }
  for (const t of ["bar_status", "data_issues", "attr_history", "financials_seen"]) {
    await wh.run(`DROP TABLE ${t}`);
  }
  await wh.run(`DROP SEQUENCE data_issue_seq`);
  await wh.setMeta("schema_version", "2");
}

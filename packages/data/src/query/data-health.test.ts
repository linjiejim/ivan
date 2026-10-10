/**
 * 数据质量卡片（S13）：缺失只数按原因计数加总（存下的名单最多 200 只）；周检的版本不占「最近 5 晚」的名额。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Warehouse } from "../warehouse/db.ts";
import { dataQuality } from "./data-health.ts";

let wh: Warehouse;
beforeAll(async () => {
  wh = await Warehouse.open(":memory:");
  const night = (date: string, missing: number) =>
    JSON.stringify({
      date,
      expected: 5000,
      updated: 5000 - missing,
      noTrade: 10,
      missing: Array.from({ length: Math.min(missing, 200) }, (_, i) => `6${String(i).padStart(5, "0")}.SH`),
      missingReasons: { no_bar: missing },
      missingCritical: [],
      accepted: [],
      ok: missing < 100,
      reasons: [],
    });
  const rows: Array<[string, string]> = [
    ["daily", night("2026-09-28", 3)],
    ["daily", night("2026-09-29", 4)],
    ["daily", night("2026-09-30", 5)],
    ["daily", night("2026-10-08", 6)],
    ["daily", night("2026-10-09", 450)],
    // 周检：只记了事件数据补扫
    ["check", JSON.stringify({ date: "2026-10-10", soft: [] })],
  ];
  for (const [kind, c] of rows) {
    await wh.run(
      `INSERT INTO data_versions (id, market, as_of, kind, status, started_at, completeness)
       VALUES (nextval('data_version_seq'), 'A', DATE '2026-10-09', $k, 'ok', current_timestamp, $c)`,
      { k: kind, c },
    );
  }
});
afterAll(() => wh.close());

describe("数据质量卡片", () => {
  it("最近 5 晚不被周检占位；缺失只数按原因计数加总，不被 200 只的名单截断", async () => {
    const q = await dataQuality(wh);
    const a = q.lastVersions.filter((v) => v.market === "A");
    expect(a.map((v) => v.date)).toEqual(["2026-10-09", "2026-10-08", "2026-09-30", "2026-09-29", "2026-09-28"]);
    expect(a[0]!.missing).toBe(450);
    expect(a[1]!.missing).toBe(6);
  });
});

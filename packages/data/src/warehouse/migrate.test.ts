/**
 * 行情仓升级方式（D76）：worker 启动用 light，遇到要改大表的升级进入维护状态；auto 才真正升级；
 * 判断看列在不在、不看 meta 里的版本号（回滚后版本号被写回 2 也不会再进维护状态）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { downgradeWarehouseToV2, V4_TABLES } from "../testing/warehouse.ts";
import { EVENT_FACTOR_KEYS } from "@ivan/core";
import { MAINTENANCE_V3, MAINTENANCE_V5, Warehouse } from "./db.ts";
import { FACTOR_COLUMNS, SCHEMA_VERSION } from "./schema.ts";

const dir = mkdtempSync(join(tmpdir(), "ivan-migrate-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function columns(wh: Warehouse, table: string): Promise<string[]> {
  return (
    await wh.all<{ name: string }>(
      `SELECT column_name AS name FROM information_schema.columns WHERE table_name = $t ORDER BY ordinal_position`,
      { t: table },
    )
  ).map((r) => r.name);
}

async function makeV2(name: string): Promise<string> {
  const path = join(dir, name);
  const wh = await Warehouse.open(path);
  await downgradeWarehouseToV2(wh);
  await wh.checkpoint();
  wh.close();
  return path;
}

describe("行情仓第 3 版升级", () => {
  it("第 2 版的库用 light 打开：进入维护状态，表结构不动", async () => {
    const path = await makeV2("light.duckdb");
    const wh = await Warehouse.open(path, { migrate: "light" });
    expect(wh.maintenance).toBe(MAINTENANCE_V3);
    expect(await columns(wh, "bars_daily")).not.toContain("src");
    expect(await wh.meta("schema_version")).toBe("2");
    wh.close();
  });

  it("用 auto 打开（pnpm ivan migrate）：升级到第 3 版，之后 light 打开也不再维护", async () => {
    const path = await makeV2("auto.duckdb");
    let wh = await Warehouse.open(path, { migrate: "auto" });
    expect(wh.maintenance).toBeNull();
    expect(await wh.meta("schema_version")).toBe(String(SCHEMA_VERSION));
    expect((await columns(wh, "bars_daily")).slice(-2)).toEqual(["src", "ver"]);
    expect(await columns(wh, "attr_history")).toContain("valid_to");
    wh.close();
    wh = await Warehouse.open(path, { migrate: "light" });
    expect(wh.maintenance).toBeNull();
    wh.close();
  });

  it("回滚过的库（列都在、版本号被旧代码写回 2）：light 不进维护，第 3 版语句重跑无害", async () => {
    const path = join(dir, "rollback.duckdb");
    let wh = await Warehouse.open(path);
    await wh.append("bars_daily", [["600000.SH", "2026-09-29", 1, 1, 1, 1, 1, 1, 1, "em", 3]]);
    await wh.setMeta("schema_version", "2");
    await wh.checkpoint();
    wh.close();
    wh = await Warehouse.open(path, { migrate: "light" });
    expect(wh.maintenance).toBeNull();
    expect(await wh.meta("schema_version")).toBe(String(SCHEMA_VERSION));
    expect(await wh.all(`SELECT src, ver FROM bars_daily`)).toEqual([{ src: "em", ver: 3 }]);
    wh.close();
  });

  it("线上的真实路径（R0 的第 2 版：没有事件表、没有事件因子列）：light 进第 3 版维护，一次 auto 直接到第 5 版", async () => {
    const p2 = await makeV2("v2-to-v5.duckdb");
    let wh = await Warehouse.open(p2, { migrate: "light" });
    expect(wh.maintenance).toBe(MAINTENANCE_V3);
    const base = await columns(wh, "factors_daily");
    for (const k of EVENT_FACTOR_KEYS) expect(base).not.toContain(k);
    expect(await columns(wh, "margin_daily")).toEqual([]);
    wh.close();
    wh = await Warehouse.open(p2, { migrate: "auto" });
    expect(wh.maintenance).toBeNull();
    expect(await wh.meta("schema_version")).toBe(String(SCHEMA_VERSION));
    expect(await columns(wh, "factors_daily")).toEqual([...base, ...EVENT_FACTOR_KEYS]);
    for (const t of V4_TABLES) expect((await columns(wh, t)).length, t).toBeGreaterThan(0);
    expect(Number(await wh.scalar(`SELECT nextval('pit_batch_seq')`))).toBe(1);
    wh.close();
    wh = await Warehouse.open(p2, { migrate: "light" });
    expect(wh.maintenance).toBeNull();
    wh.close();
  });

  it("升级在 src 与 ver 两句 ALTER 之间被打断：light 仍进维护（不在启动时改大表）", async () => {
    const path = await makeV2("half.duckdb");
    let wh = await Warehouse.open(path, { migrate: "light" });
    await wh.run(`ALTER TABLE bars_daily ADD COLUMN src VARCHAR`);
    await wh.checkpoint();
    wh.close();
    wh = await Warehouse.open(path, { migrate: "light" });
    expect(wh.maintenance).toBe(MAINTENANCE_V3);
    expect(await columns(wh, "bars_daily")).not.toContain("ver");
    wh.close();
  });

  it("全新的库用 light 打开：没有大表要改，直接建到第 3 版", async () => {
    const wh = await Warehouse.open(join(dir, "fresh.duckdb"), { migrate: "light" });
    expect(wh.maintenance).toBeNull();
    expect((await columns(wh, "bars_daily")).at(-1)).toBe("ver");
    wh.close();
  });
});

describe("行情仓第 4 版（S15）：只加表、轻量升级", () => {
  const V4_TABLES: Record<string, string[]> = {
    margin_daily: [
      "code", "date", "avail_date", "rzye", "rzmre", "rzche", "rqye", "rqyl", "float_mcap", "rzyezb",
      "src", "ver", "batch",
    ],
    holder_counts: [
      "code", "end_date", "notice_date", "avail_date", "holder_num", "pre_holder_num", "pre_end_date",
      "first_seen", "last_seen", "gone_from", "src", "ver", "batch",
    ],
    lockups: [
      "code", "free_date", "type", "unlock_shares", "able_shares", "float_after", "ratio_float", "ratio_total",
      "avail_date", "avail_rule", "first_seen", "last_seen", "gone_from", "src", "ver", "batch",
    ],
    block_trades: [
      "code", "trade_date", "seq", "avail_date", "deal_price", "close_price", "premium", "deal_volume",
      "deal_amount", "buyer_inst", "seller_inst", "src", "ver", "batch",
    ],
    pit_sync: [
      "dataset", "backfill_from", "covered_from", "window_through", "synced_at", "nightly_since", "last_ok_at",
      "last_status", "last_detail", "canary",
    ],
    pit_batches: [
      "id", "kind", "datasets", "data_version", "started_at", "finished_at", "status", "chunks", "rows",
      "requests", "note",
    ],
  };

  it("第 3 版的库用 light 打开：不进维护状态，建好 6 张表（列顺序是约定）", async () => {
    const path = join(dir, "v3.duckdb");
    let wh = await Warehouse.open(path);
    for (const t of Object.keys(V4_TABLES)) await wh.run(`DROP TABLE ${t}`);
    await wh.run(`DROP SEQUENCE pit_batch_seq`);
    await wh.append("bars_daily", [["600000.SH", "2026-09-29", 1, 1, 1, 1, 1, 1, 1, "em", 3]]);
    await wh.setMeta("schema_version", "3");
    await wh.checkpoint();
    wh.close();

    wh = await Warehouse.open(path, { migrate: "light" });
    // 第 5 版（S15b）只加因子列：这个库的因子列本来就全，一起升到第 5 版
    expect(wh.maintenance).toBeNull();
    expect(await wh.meta("schema_version")).toBe(String(SCHEMA_VERSION));
    for (const [t, cols] of Object.entries(V4_TABLES)) expect(await columns(wh, t)).toEqual(cols);
    expect(Number(await wh.scalar(`SELECT nextval('pit_batch_seq')`))).toBe(1);
    // 已有数据原样
    expect(await wh.all(`SELECT src, ver FROM bars_daily`)).toEqual([{ src: "em", ver: 3 }]);
    wh.close();
  });
});

describe("行情仓第 5 版（S15b）：factors_daily 表尾加 7 个事件因子列，重迁移", () => {
  const OLD = ["code", "date", "market", "close", ...FACTOR_COLUMNS.filter((k) => !EVENT_FACTOR_KEYS.includes(k))];

  /** 第 4 版的库：没有事件因子列，带一行旧因子 */
  async function makeV4(name: string): Promise<string> {
    const path = join(dir, name);
    const wh = await Warehouse.open(path);
    await wh.migrateDown(4);
    expect(await columns(wh, "factors_daily")).toEqual(OLD);
    const row: unknown[] = OLD.map(() => null);
    row[0] = "600000.SH";
    row[1] = "2026-09-29";
    row[2] = "A";
    row[3] = 10.5;
    row[OLD.indexOf("pe_ttm")] = 7.25;
    await wh.append("factors_daily", [row]);
    await wh.setMeta("event_factors:A", JSON.stringify({ v: 1, sig: "x", complete: true }));
    await wh.checkpoint();
    wh.close();
    return path;
  }

  it("第 4 版的库用 light 打开：进维护状态，提示运行 scripts/migrate.sh，表结构不动", async () => {
    const path = await makeV4("v4-light.duckdb");
    const wh = await Warehouse.open(path, { migrate: "light" });
    expect(SCHEMA_VERSION).toBe(5);
    expect(wh.maintenance).toBe(MAINTENANCE_V5);
    expect(MAINTENANCE_V5).toBe("行情仓需要升级到第 5 版（新增 7 个因子列），请运行 scripts/migrate.sh");
    expect(await columns(wh, "factors_daily")).toEqual(OLD);
    expect(await wh.meta("schema_version")).toBe("4");
    wh.close();
  });

  it("auto（pnpm ivan migrate）：按注册表顺序在表尾加 7 列，旧值原样，之后 light 不再维护", async () => {
    const path = await makeV4("v4-auto.duckdb");
    let wh = await Warehouse.open(path, { migrate: "auto" });
    expect(wh.maintenance).toBeNull();
    expect(await wh.meta("schema_version")).toBe("5");
    expect(await columns(wh, "factors_daily")).toEqual([...OLD, ...EVENT_FACTOR_KEYS]);
    expect(
      await wh.all(`SELECT code, close, pe_ttm, margin_ratio, unlock_days FROM factors_daily`),
    ).toEqual([{ code: "600000.SH", close: 10.5, pe_ttm: 7.25, margin_ratio: null, unlock_days: null }]);
    wh.close();
    wh = await Warehouse.open(path, { migrate: "light" });
    expect(wh.maintenance).toBeNull();
    wh.close();
  });

  it("--down 4：删掉 7 列、版本号写回 4、清掉补算进度与完成标记；旧代码的 INSERT SELECT <旧列> 能写", async () => {
    const path = join(dir, "v5-down.duckdb");
    let wh = await Warehouse.open(path);
    await wh.setMeta("event_factors:A", "{}");
    await wh.run(
      `INSERT INTO etl_progress (task, key, status) VALUES ('event_cols:v1:abcd1234', '2020', 'done'), ('pit:margin', 'x', 'done')`,
    );
    await wh.migrateDown(4);
    expect(await columns(wh, "factors_daily")).toEqual(OLD);
    expect(await wh.meta("schema_version")).toBe("4");
    expect(await wh.meta("event_factors:A")).toBeUndefined();
    expect(await wh.all(`SELECT task FROM etl_progress`)).toEqual([{ task: "pit:margin" }]);
    // R4 的写法：暂存表按旧列建，INSERT INTO factors_daily SELECT 全部旧列
    await wh.run(`CREATE TABLE factors_stage AS SELECT * FROM factors_daily LIMIT 0`);
    await wh.run(
      `INSERT INTO factors_stage (code, date, market, close) VALUES ('600000.SH', DATE '2026-09-29', 'A', 1)`,
    );
    await wh.run(`INSERT INTO factors_daily SELECT ${OLD.map((c) => `s.${c}`).join(", ")} FROM factors_stage s`);
    expect(Number(await wh.scalar(`SELECT count(*) FROM factors_daily`))).toBe(1);
    // 事件表留着
    expect(await columns(wh, "margin_daily")).toContain("avail_date");
    await expect(wh.migrateDown(3)).rejects.toThrow(/只支持降到第 4 版/);
    wh.close();
    // 再部署 R5：light 打开进维护状态
    wh = await Warehouse.open(path, { migrate: "light" });
    expect(wh.maintenance).toBe(MAINTENANCE_V5);
    wh.close();
  });
});

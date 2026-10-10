/**
 * 行情仓升级方式（D76）：worker 启动用 light，遇到要改大表的升级进入维护状态；auto 才真正升级；
 * 判断看列在不在、不看 meta 里的版本号（回滚后版本号被写回 2 也不会再进维护状态）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { downgradeWarehouseToV2 } from "../testing/warehouse.ts";
import { MAINTENANCE_V3, Warehouse } from "./db.ts";
import { SCHEMA_VERSION } from "./schema.ts";

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

  it("全新的库用 light 打开：没有大表要改，直接建到第 3 版", async () => {
    const wh = await Warehouse.open(join(dir, "fresh.duckdb"), { migrate: "light" });
    expect(wh.maintenance).toBeNull();
    expect((await columns(wh, "bars_daily")).at(-1)).toBe("ver");
    wh.close();
  });
});

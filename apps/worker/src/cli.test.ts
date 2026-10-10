/**
 * `pnpm ivan events --estimate`：只是估算，不顺手做重迁移；行情仓还没升级时给维护说明退出，库不动；
 * worker 占着行情仓时给「worker 正在运行时会被独占」的说明（指向管理页），不报 DuckDB 的原文了事。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Warehouse } from "@ivan/data";
import { describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

describe("pnpm ivan events --estimate", () => {
  it("第 4 版的行情仓：报「需要升级到第 5 版」退出，不在命令行里跑重迁移", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ivan-cli-"));
    const path = join(dir, "market.duckdb");
    let wh = await Warehouse.open(path);
    await wh.migrateDown(4);
    await wh.checkpoint();
    wh.close();
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", CLI, "events", "--market", "A", "--estimate"],
      {
        encoding: "utf8",
        env: { ...process.env, DATA_DIR: dir },
      },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("行情仓需要升级到第 5 版");
    wh = await Warehouse.open(path, { migrate: "light" });
    expect(await wh.meta("schema_version")).toBe("4");
    wh.close();
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("行情仓被另一个进程（运行中的 worker）占着：给和 doctor 同样的说明，指向管理页", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ivan-cli-"));
    const path = join(dir, "market.duckdb");
    // 第 4 版：万一没被占住，命令行也只会报维护说明退出，不会去发估算请求
    const wh = await Warehouse.open(path);
    await wh.migrateDown(4);
    await wh.checkpoint();
    try {
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", CLI, "events", "--market", "A", "--estimate"],
        { encoding: "utf8", env: { ...process.env, DATA_DIR: dir } },
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("行情仓打不开（worker 正在运行时会被独占）");
      expect(r.stderr).toContain("请用管理页");
    } finally {
      wh.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

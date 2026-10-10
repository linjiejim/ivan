/**
 * `pnpm admin verify-bundle`（D71）：固定的导出文件离线校验通过（退出码 0）；改一个值的副本报出位置（退出码 1）。
 * 夹具 __fixtures__/trace-bundle.json 是一份真实的导出（packages/db/src/testing/trace.ts 的 seedTrace），
 * 哈希规则一变它就校验不过：旧的导出文件不能因为程序升级就验不了。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verifyBundleFile } from "./lib/verify-bundle.ts";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/trace-bundle.json", import.meta.url));
const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "ivan-cli-"));

function tampered(): string {
  const b = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
    entries: Array<{ seq: number; kind?: string }>;
    payloads: Record<string, { items?: Array<{ estWeight: number }> }>;
  };
  const plan = b.entries.find((e) => e.kind === "plan")!;
  b.payloads[String(plan.seq)]!.items![0]!.estWeight = 0.06;
  const p = join(dir, "tampered.json");
  writeFileSync(p, JSON.stringify(b));
  return p;
}

describe("verify-bundle", () => {
  it("夹具校验通过；改一个计划项的值报出那一条", () => {
    expect(verifyBundleFile(FIXTURE)).toEqual({ code: 0, message: "校验通过：7 条" });
    expect(verifyBundleFile(tampered())).toEqual({ code: 1, message: "第 3 条出错：内容哈希不符" });
    expect(verifyBundleFile(join(dir, "nope.json")).code).toBe(1);
  });

  it("命令行：退出码 0 / 1，不需要应用库", () => {
    const run = (file: string) =>
      spawnSync(process.execPath, ["--import", "tsx", CLI, "verify-bundle", file], {
        encoding: "utf8",
        // 指向一个不存在的数据目录：verify-bundle 不该打开应用库
        env: { ...process.env, DATA_DIR: join(dir, "no-data") },
      });
    const ok = run(FIXTURE);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("校验通过：7 条");
    const bad = run(tampered());
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("第 3 条出错");
    expect(existsSync(join(dir, "no-data"))).toBe(false);
  });
});

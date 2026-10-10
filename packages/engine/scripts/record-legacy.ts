/**
 * 记录引擎 1.1.0 金标准（D56）：对每个夹具跑 simulate，把 legacyView 的 sha256Canonical 写进
 * src/__fixtures__/legacy-1.1.0.json。只在第一处引擎改动之前跑一次；已存在时要加 --force 才覆盖。
 *
 *   pnpm tsx packages/engine/scripts/record-legacy.ts [--force]
 */
import { existsSync, writeFileSync } from "node:fs";
import { sha256Canonical } from "@ivan/core/node";
import { ENGINE_VERSION, simulate } from "../src/simulate.ts";
import { LEGACY_FIXTURES } from "../src/testing/fixtures.ts";
import { legacyView } from "../src/testing/legacy-view.ts";

const out = new URL("../src/__fixtures__/legacy-1.1.0.json", import.meta.url);
if (existsSync(out) && !process.argv.includes("--force")) {
  console.error("legacy-1.1.0.json 已存在：金标准不能随手改。确实要重录请加 --force。");
  process.exit(1);
}
// 引擎已升到 1.2.0（S02）：这个脚本从此只会拒绝运行，金标准永远是 1.1.0 录下的那份
if ((ENGINE_VERSION as string) !== "1.1.0") {
  console.error(`当前引擎版本是 ${ENGINE_VERSION}，金标准只能从 1.1.0 录。`);
  process.exit(1);
}
const hashes: Record<string, string> = {};
for (const [name, build] of Object.entries(LEGACY_FIXTURES)) {
  hashes[name] = sha256Canonical(legacyView(simulate(build())));
}
writeFileSync(out, `${JSON.stringify(hashes, null, 2)}\n`);
console.log(`已写入 ${Object.keys(hashes).length} 个夹具的指纹：${out.pathname}`);

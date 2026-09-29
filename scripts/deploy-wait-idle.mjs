#!/usr/bin/env node
/**
 * 部署前的空闲检查（CI 在服务器上、拉代码之前调用）：部署会重启 worker，
 * 正在跑的夜间任务、回测、回填会被打断。所以先等：
 *
 *   - 数据目录里有 .maintenance 标记（手动回填、维护时放的）→ 忙
 *   - 应用库里有 3 小时内开始、还在 running 的任务 → 忙（更早的当成崩溃留下的，不等）
 *
 * 每 20 秒看一次，最多等 WAIT_MINUTES（默认 15）分钟；空闲就退出 0，还忙就退出 1——
 * 这时部署什么都还没动（代码没拉、进程没重启），过会儿重跑 workflow 即可。
 *
 * 用法：node --no-warnings scripts/deploy-wait-idle.mjs   （仓库根目录；读 .env 里的 DATA_DIR）
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const envFile = resolve(root, ".env");
const env = existsSync(envFile)
  ? Object.fromEntries(
      readFileSync(envFile, "utf8")
        .split("\n")
        .map((l) => /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(l))
        .filter(Boolean)
        .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
    )
  : {};
const dataDir = env.DATA_DIR ?? "./data";
const dir = isAbsolute(dataDir) ? dataDir : resolve(root, dataDir);
const marker = resolve(dir, ".maintenance");
const dbPath = resolve(dir, "app.sqlite");
const maxMs = Number(process.env.WAIT_MINUTES ?? 15) * 60_000;

function busy() {
  if (existsSync(marker)) return `维护中：${readFileSync(marker, "utf8").trim() || marker}`;
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT count(*) AS n, group_concat(kind) AS kinds FROM jobs
         WHERE status = 'running' AND started_at > (unixepoch() - 3 * 3600) * 1000`,
      )
      .get();
    return row.n > 0 ? `${row.n} 个任务在跑（${row.kinds}）` : null;
  } finally {
    db.close();
  }
}

const start = Date.now();
for (;;) {
  const why = busy();
  if (!why) {
    console.log("worker 空闲，可以部署");
    process.exit(0);
  }
  if (Date.now() - start >= maxMs) {
    console.error(
      `等了 ${Math.round(maxMs / 60_000)} 分钟还在忙（${why}），这次不部署；稍后重跑 workflow`,
    );
    process.exit(1);
  }
  console.log(`等待：${why}`);
  await new Promise((r) => setTimeout(r, 20_000));
}

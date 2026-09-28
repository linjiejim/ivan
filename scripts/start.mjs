#!/usr/bin/env node
/**
 * 自部署最简启动：同时拉起 server 与 worker，任一退出则全部退出（交给外层 pm2 / systemd / docker 重启）。
 * 生产环境推荐用 pm2：pm2 start ecosystem.config.cjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsx = `${root}node_modules/.bin/tsx`;
const procs = [
  ["worker", "apps/worker/src/main.ts"],
  ["server", "apps/server/src/main.ts"],
].map(([name, entry]) => {
  const p = spawn(tsx, [entry], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production" },
  });
  const prefix = (chunk) =>
    chunk
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((l) => `[${name}] ${l}`)
      .join("\n");
  p.stdout.on("data", (c) => console.log(prefix(c)));
  p.stderr.on("data", (c) => console.error(prefix(c)));
  p.on("exit", (code) => {
    console.error(`[${name}] 退出（${code}），关闭全部进程`);
    for (const q of procs) q.kill("SIGTERM");
    process.exit(code ?? 1);
  });
  return p;
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const p of procs) p.kill("SIGTERM");
  });
}

/**
 * 生产环境托管前端构建产物：带哈希的文件永久缓存，页面和 /version.json 每次回源，
 * /version.json 不存在时（部署中前端正在重新构建）是 404、不回退成页面。
 * 用临时目录假装一份 apps/web/dist，起真的 node 服务去请求：缓存头是 serveStatic 在 onFound 里补上的，
 * 只有 @hono/node-server 的 Response 带得出去，app.request() 看不到。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { loadConfig } from "@ivan/core/config";
import { openAppDb } from "@ivan/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { setEnvForTest } from "./env.ts";

const root = mkdtempSync(join(tmpdir(), "ivan-static-"));
const dist = join(root, "apps/web/dist");
const cfg = { ...loadConfig(), root, dataDir: root, appDbPath: join(root, "app.sqlite") };
const handle = openAppDb(cfg.appDbPath);
setEnvForTest(cfg, handle);
let server: ServerType;
let base = "";

beforeAll(async () => {
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>Ivan</title>");
  writeFileSync(join(dist, "version.json"), `{"commit":"abc123"}\n`);
  writeFileSync(join(dist, "assets/index-1a2b3c.js"), "console.log(1)");
  const app = createApp(
    createAuth({
      sqlite: handle.sqlite,
      secret: "test-secret-test-secret-test-secret-00",
      baseURL: "http://localhost:18905",
    }),
  );
  await new Promise<void>((done) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
      base = `http://127.0.0.1:${info.port}`;
      done();
    });
  });
});

afterAll(() => new Promise<void>((done) => server.close(() => done())));

describe("前端构建产物", () => {
  it("/version.json 是 JSON，每次回源", async () => {
    const res = await fetch(`${base}/version.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.json()).toEqual({ commit: "abc123" });
  });

  it("页面每次回源，带哈希的文件永久缓存", async () => {
    const page = await fetch(`${base}/strategies/s_1`);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-cache");
    expect(await page.text()).toContain("<title>Ivan</title>");
    const asset = await fetch(`${base}/assets/index-1a2b3c.js`);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    await asset.body?.cancel();
  });

  it("还没有 /version.json 时是 404，不回退成页面", async () => {
    rmSync(join(dist, "version.json"));
    const res = await fetch(`${base}/version.json`);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("content-type")).toContain("application/json");
    await res.body?.cancel();
  });
});

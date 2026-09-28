/**
 * 运行配置（server 与 worker 共用）。只在 Node 里用：`import { loadConfig } from "@ivan/core/config"`。
 * 启动时读仓库根目录的 .env（不存在就只用进程环境变量）。
 */
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export interface Config {
  root: string;
  port: number;
  workerPort: number;
  internalSecret: string;
  publicUrl: string;
  authSecret: string;
  dataDir: string;
  appDbPath: string;
  warehousePath: string;
  llm: {
    provider: "openai-compatible" | "anthropic";
    baseUrl: string;
    apiKey: string;
    model: string;
    briefModel: string;
  };
  quota: { chatMessages: number; backtests: number };
  duckdb: { memoryLimit: string; threads: number };
  backtestPoolSize: number;
  fetch: { concurrency: number; minIntervalMs: number };
  schedulerEnabled: boolean;
}

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;
  const envFile = resolve(REPO_ROOT, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const e = process.env;
  const int = (k: string, d: number) => (e[k] ? Number.parseInt(e[k]!, 10) : d);
  const dataDir = resolveFromRoot(e.DATA_DIR ?? "./data");
  const port = int("PORT", 18905);
  cached = {
    root: REPO_ROOT,
    port,
    workerPort: int("WORKER_PORT", 18915),
    internalSecret: e.INTERNAL_SECRET ?? "dev-internal-secret",
    publicUrl: e.PUBLIC_URL ?? `http://localhost:${port}`,
    authSecret: e.BETTER_AUTH_SECRET ?? "dev-auth-secret-dev-auth-secret-0000",
    dataDir,
    appDbPath: resolve(dataDir, "app.sqlite"),
    warehousePath: resolve(dataDir, "market.duckdb"),
    llm: {
      provider: e.LLM_PROVIDER === "anthropic" ? "anthropic" : "openai-compatible",
      baseUrl: e.LLM_BASE_URL ?? "https://api.deepseek.com/v1",
      apiKey: e.LLM_API_KEY ?? "",
      model: e.LLM_MODEL ?? "deepseek-chat",
      briefModel: e.LLM_MODEL_BRIEF || e.LLM_MODEL || "deepseek-chat",
    },
    quota: {
      chatMessages: int("QUOTA_CHAT_MESSAGES", 100),
      backtests: int("QUOTA_BACKTESTS", 50),
    },
    duckdb: { memoryLimit: e.DUCKDB_MEMORY_LIMIT ?? "512MB", threads: int("DUCKDB_THREADS", 2) },
    backtestPoolSize: int("BACKTEST_POOL_SIZE", 1),
    fetch: {
      concurrency: int("FETCH_CONCURRENCY", 4),
      minIntervalMs: int("FETCH_MIN_INTERVAL_MS", 50),
    },
    schedulerEnabled: (e.SCHEDULER_ENABLED ?? "true") !== "false",
  };
  return cached;
}

function resolveFromRoot(p: string): string {
  return isAbsolute(p) ? p : resolve(REPO_ROOT, p);
}

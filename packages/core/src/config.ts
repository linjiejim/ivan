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
  /** server 监听的地址：自部署默认所有网卡；放在反向代理后面时设 127.0.0.1，只让代理访问 */
  host: string;
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
  /** 每人每日额度；analyses = 复核、个股证据这类要 worker 组装数据的读请求（D59） */
  quota: { chatMessages: number; backtests: number; analyses: number };
  duckdb: { memoryLimit: string; threads: number };
  backtestPoolSize: number;
  /** 单次回测在线程里最多跑多久（毫秒），超时终止并重建线程 */
  backtestTimeoutMs: number;
  /** 回测线程的堆上限（MB，resourceLimits.maxOldGenerationSizeMb）；转交的价格面板不算在里面 */
  backtestThreadMemoryMb: number;
  fetch: { concurrency: number; minIntervalMs: number };
  schedulerEnabled: boolean;
  /** 试用申请（D109）：登录页能不能申请邀请码，申请提醒发给谁（空 = 只记在管理页） */
  trial: { enabled: boolean; notifyTo: string };
  /** 发信（D109）：经 Resend 的 HTTP 接口；没有 key 就不发信 */
  mail: { resendApiKey: string; from: string };
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
    host: e.HOST || "0.0.0.0",
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
      analyses: int("QUOTA_ANALYSES", 100),
    },
    duckdb: { memoryLimit: e.DUCKDB_MEMORY_LIMIT ?? "512MB", threads: int("DUCKDB_THREADS", 2) },
    backtestPoolSize: int("BACKTEST_POOL_SIZE", 1),
    backtestTimeoutMs: int("BACKTEST_TIMEOUT_MS", 120_000),
    backtestThreadMemoryMb: int("BACKTEST_THREAD_MEMORY_MB", 256),
    fetch: {
      concurrency: int("FETCH_CONCURRENCY", 4),
      minIntervalMs: int("FETCH_MIN_INTERVAL_MS", 50),
    },
    schedulerEnabled: (e.SCHEDULER_ENABLED ?? "true") !== "false",
    trial: {
      enabled: e.TRIAL_REQUESTS_ENABLED === "true",
      notifyTo: e.TRIAL_NOTIFY_TO?.trim() ?? "",
    },
    mail: {
      resendApiKey: e.RESEND_API_KEY?.trim() ?? "",
      from: e.MAIL_FROM?.trim() || "Ivan <onboarding@resend.dev>",
    },
  };
  return cached;
}

function resolveFromRoot(p: string): string {
  return isAbsolute(p) ? p : resolve(REPO_ROOT, p);
}

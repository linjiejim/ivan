/**
 * server → worker 内部调用（127.0.0.1，共享密钥）。worker 独占行情仓，所有行情查询都经这里。
 */
import { env } from "../env.ts";
import { AppError } from "./errors.ts";

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { cfg } = env();
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${cfg.workerPort}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-internal-secret": cfg.internalSecret,
        ...init.headers,
      },
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new AppError(503, "行情服务（worker）没有运行");
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok)
    throw new AppError(res.status === 404 ? 404 : 500, body.error ?? `worker 返回 ${res.status}`);
  return body as T;
}

export const worker = {
  get: <T>(path: string) => call<T>(path),
  post: <T>(path: string, body: unknown) =>
    call<T>(path, { method: "POST", body: JSON.stringify(body) }),
  /** 有新任务入队：叫醒 worker（失败没关系，worker 自己也会轮询） */
  kick: () => call("/internal/jobs/kick", { method: "POST" }).catch(() => undefined),
};

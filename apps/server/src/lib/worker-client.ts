/**
 * server → worker 内部调用（127.0.0.1，共享密钥）。worker 独占行情仓，所有行情查询都经这里。
 */
import { env } from "../env.ts";
import { AppError } from "./errors.ts";

const PASS_THROUGH = new Set<number>([400, 404, 409, 503]);

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
  if (!res.ok) {
    // 400 参数或数据不对、404 不存在、409 冲突（比如已经有一个事件数据回填在排队）、503 维护中：
    // 都是 worker 有意给出的中文原因，原样转给前端；其余（500）是 worker 内部出错，原文（SQL、文件路径）只记日志
    if (PASS_THROUGH.has(res.status) && body.error)
      throw new AppError(res.status as 400 | 404 | 409 | 503, body.error);
    console.error(`worker ${path} 返回 ${res.status}：${body.error ?? ""}`);
    throw new AppError(500, "行情服务出错，请稍后再试");
  }
  return body as T;
}

export const worker = {
  get: <T>(path: string) => call<T>(path),
  post: <T>(path: string, body: unknown) =>
    call<T>(path, { method: "POST", body: JSON.stringify(body) }),
  /** 有新任务入队：叫醒 worker（失败没关系，worker 自己也会轮询） */
  kick: () => call("/internal/jobs/kick", { method: "POST" }).catch(() => undefined),
};

/**
 * 进程级单例：配置 + 应用库。
 */
import { type Config, loadConfig } from "@ivan/core/config";
import { type AppDbHandle, openAppDb } from "@ivan/db";

let handle: { cfg: Config; app: AppDbHandle } | undefined;

export function env() {
  if (!handle) {
    const cfg = loadConfig();
    handle = { cfg, app: openAppDb(cfg.appDbPath) };
  }
  return handle;
}

/** 测试用：换成指定路径的库 */
export function setEnvForTest(cfg: Config, app: AppDbHandle) {
  handle = { cfg, app };
}

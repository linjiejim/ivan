/**
 * worker 退出（SIGINT / SIGTERM，D110）。pm2 发出信号后最多等 kill_timeout（10 秒）就发 SIGKILL：
 * 被 SIGKILL 的 worker 留下没并回的 WAL，下次启动要重放，还会把在跑的任务留成「运行中」。所以要在那之前干净退出：
 *
 * 停止认领与调度 → 关内部接口 → 终止回测线程 → 打断行情仓上在跑的查询 → 等在跑的任务收尾（最多 drainMs）
 * → CHECKPOINT 并关行情仓（最多 closeMs）→ 关应用库 → 退出码 0。
 *
 * 兜底：从收到信号起 hardMs 还没退完就直接退出（退出码 1）；退出中再收到一次信号立刻退出。
 * 主线程被同步代码长时间占住时信号处理排不上队，兜底也无从生效——所以大结果都逐块流式读（streamColumns），不在主线程整表转数组。
 * 依赖都注入，单测用假的。
 */

export interface ShutdownDeps {
  /** 停止认领新任务 */
  stopRunner(): void;
  /** 停掉定时任务 */
  stopScheduler(): void;
  /** 内部接口不再接新连接 */
  closeServer(): void;
  /** 终止回测线程（进行中的调用报「worker 重启」） */
  stopPool(): Promise<void>;
  /** 打断行情仓上在跑的查询 */
  interruptWarehouse(): void;
  /** 还在跑的任务数 */
  runningJobs(): number;
  /** CHECKPOINT 并关行情仓 */
  closeWarehouse(): Promise<void>;
  closeAppDb(): void;
  exit(code: number): void;
  log(msg: string): void;
}

export interface ShutdownTimings {
  /** 从收到信号到强制退出（毫秒）；要小于 pm2 的 kill_timeout（10 秒） */
  hardMs: number;
  /** 等在跑的任务收尾最多多久 */
  drainMs: number;
  /** CHECKPOINT 并关库最多多久 */
  closeMs: number;
}

export const SHUTDOWN_TIMINGS: ShutdownTimings = { hardMs: 8000, drainMs: 2000, closeMs: 3000 };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** p 在 ms 毫秒内完成返回 true，超时返回 false（p 继续在后台跑，不管它） */
async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  try {
    return await Promise.race([p.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** 返回信号处理函数：(signal) => Promise<void>，第二次调用立刻退出 */
export function createShutdown(
  d: ShutdownDeps,
  t: ShutdownTimings = SHUTDOWN_TIMINGS,
): (signal: string) => Promise<void> {
  let started = false;
  return async (signal) => {
    if (started) {
      d.log(`退出中再次收到 ${signal}，立即退出`);
      d.exit(1);
      return;
    }
    started = true;
    d.log(`ivan-worker 正在退出（${signal}）…`);
    const hard = setTimeout(() => {
      d.log(`退出超过 ${t.hardMs / 1000} 秒还没完成，强制退出`);
      d.exit(1);
    }, t.hardMs);
    try {
      d.stopRunner();
      d.stopScheduler();
      d.closeServer();
      await d.stopPool();
      d.interruptWarehouse();
      const t0 = Date.now();
      while (d.runningJobs() > 0 && Date.now() - t0 < t.drainMs) await sleep(50);
      if (d.runningJobs() > 0)
        d.log(`还有 ${d.runningJobs()} 个任务没收尾，不再等（下次启动记为失败）`);
      if (!(await within(d.closeWarehouse(), t.closeMs))) {
        d.log(`行情仓 ${t.closeMs / 1000} 秒内没关好，直接退出（下次启动重放 WAL）`);
      }
      d.closeAppDb();
      clearTimeout(hard);
      d.exit(0);
    } catch (e) {
      clearTimeout(hard);
      d.log(`退出时出错：${e instanceof Error ? e.message : String(e)}`);
      d.exit(1);
    }
  };
}

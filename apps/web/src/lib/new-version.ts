/**
 * 新版本提示（jim-uiux 1.7.0 updates.md 的 web 部分）：每次 push 到 main 都部署、没有版本号，
 * 所以拿包里的提交号和服务端 /version.json 的比，不一样就说一次「新版本已发布，刷新后生效 · 刷新页面」。
 * 这里只有比较和节流；挂事件、出提示在 components/new-version.tsx。
 */

/** 两次检查至少隔一分钟：标签页来回切很频繁 */
export const VERSION_CHECK_GAP_MS = 60_000;
/** 一直开着的页面每 10 分钟查一次 */
export const VERSION_CHECK_EVERY_MS = 10 * 60_000;

/** 服务端的提交号：只认非空字符串；null（构建时没有 git）、格式不对都当拿不到 */
export function liveCommit(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const v = (body as { commit?: unknown }).commit;
  return typeof v === "string" && v ? v : null;
}

/**
 * 一个页面的检查：`check()` 在切回标签页和定时器上调，一分钟内只真查一次；发现新版本后只回调一次，
 * 之后不再查。读失败（断网、部署到一半 404、拿到的不是 JSON）不说话，下一次再查。
 */
export function createVersionCheck({
  current,
  load,
  onFound,
  gap = VERSION_CHECK_GAP_MS,
  now = Date.now,
}: {
  /** 这个包来自哪个提交 */
  current: string;
  /** 读服务端的 /version.json；失败就抛 */
  load: () => Promise<unknown>;
  onFound: () => void;
  gap?: number;
  now?: () => number;
}) {
  let last = -Infinity;
  let found = false;
  let stopped = false;
  return {
    async check(): Promise<void> {
      if (found || stopped || now() - last < gap) return;
      last = now();
      let live: string | null;
      try {
        live = liveCommit(await load());
      } catch {
        return;
      }
      if (found || stopped || live === null || live === current) return;
      found = true;
      onFound();
    },
    /** 卸载时调：还在路上的那次回来了也不再提示 */
    stop() {
      stopped = true;
    },
  };
}

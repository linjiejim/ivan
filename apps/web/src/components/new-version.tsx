/**
 * 新版本提示：部署了新版本、这个页面还是旧的，就在右上角留一条「新版本已发布，刷新后生效 · 刷新页面」。
 * 只在生产构建里查：切回标签页时（一分钟最多一次）和每 10 分钟。发现一次就不再查，也不自己刷新
 * （输入框里可能有没保存的内容）；读不到就不说话。比较和节流在 lib/new-version.ts。
 */
import { useEffect, useState } from "react";
import { createVersionCheck, VERSION_CHECK_EVERY_MS } from "../lib/new-version.ts";
import { Toast } from "./ui.tsx";

/** 构建时写进包里的提交号（vite.config.ts）；没有 git 时是 null */
declare const __APP_COMMIT__: string | null;

/** 开发时（vite dev）不查：没有 /version.json，代码也一直在变 */
const CURRENT = import.meta.env.PROD ? __APP_COMMIT__ : null;

async function loadVersion(): Promise<unknown> {
  const res = await fetch("/version.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function NewVersionPrompt() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!CURRENT) return;
    const watch = createVersionCheck({
      current: CURRENT,
      load: loadVersion,
      onFound: () => setOpen(true),
    });
    const onVisible = () => {
      if (document.visibilityState === "visible") void watch.check();
    };
    const timer = setInterval(() => void watch.check(), VERSION_CHECK_EVERY_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      watch.stop();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!CURRENT) return null;
  return (
    <Toast
      open={open}
      action={{ label: "刷新页面", onClick: () => window.location.reload() }}
      onClose={() => setOpen(false)}
    >
      新版本已发布，刷新后生效
    </Toast>
  );
}

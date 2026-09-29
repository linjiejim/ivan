import { useEffect } from "react";

const BASE = "Ivan";

/** 标签页标题：「页面 · Ivan」；没传就是默认标题 */
export function usePageTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · ${BASE}` : `${BASE} · 选股策略回测与跟踪`;
  }, [title]);
}

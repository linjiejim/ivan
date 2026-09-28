/**
 * 全局对话上下文（spec §9、D40）：首页常驻，其他页面是可收起的侧栏（默认展开），自动带上当前页面的上下文；
 * 图表框选「问 AI」通过 ask() 把区间和提问送进对话。
 */
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

export interface PageContext {
  strategyId?: string;
  versionId?: string;
  runId?: string;
  trackingId?: string;
  /** 框选的区间 */
  range?: { from: string; to: string };
  /** 给人看的上下文标签，显示在输入框上方 */
  label?: string;
}

interface ChatState {
  open: boolean;
  setOpen: (v: boolean) => void;
  page: PageContext;
  setPage: (c: PageContext) => void;
  /** 待发送的提问（ChatPanel 读取后清空） */
  pending: { text: string; context: PageContext } | null;
  ask: (text: string, context?: PageContext) => void;
  takePending: () => { text: string; context: PageContext } | null;
  threadId: string | null;
  setThreadId: (id: string | null) => void;
}

const Ctx = createContext<ChatState | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(() => localStorage.getItem("ivan.chat.open") !== "0");
  const [page, setPage] = useState<PageContext>({});
  const [pending, setPending] = useState<ChatState["pending"]>(null);
  const [threadId, setThreadIdState] = useState<string | null>(() =>
    localStorage.getItem("ivan.chat.thread"),
  );
  const setOpenPersist = useCallback((v: boolean) => {
    localStorage.setItem("ivan.chat.open", v ? "1" : "0");
    setOpen(v);
  }, []);
  const setThreadId = useCallback((id: string | null) => {
    if (id) localStorage.setItem("ivan.chat.thread", id);
    else localStorage.removeItem("ivan.chat.thread");
    setThreadIdState(id);
  }, []);
  const value = useMemo<ChatState>(
    () => ({
      open,
      setOpen: setOpenPersist,
      page,
      setPage,
      pending,
      ask: (text, context) => {
        setPending({ text, context: { ...page, ...context } });
        setOpenPersist(true);
      },
      takePending: () => {
        const p = pending;
        if (p) setPending(null);
        return p;
      },
      threadId,
      setThreadId,
    }),
    [open, setOpenPersist, page, pending, threadId, setThreadId],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useChatUi(): ChatState {
  const c = useContext(Ctx);
  if (!c) throw new Error("ChatProvider 缺失");
  return c;
}

/**
 * 外框（D40）：导航只留「看板 · 策略」，其余收进账户菜单。
 * 首页 = 看板 + 常驻对话；其他页面在宽屏上对话是可收起的侧栏，窄屏上走全屏对话页。
 */
import { useQuery } from "@tanstack/react-query";
import { BarChart3, LogOut, MessageSquare, Moon, Settings, Sun, Upload } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useChatUi } from "../chat/chat-context.tsx";
import { api } from "../lib/api.ts";
import { authClient } from "../lib/auth.ts";
import type { Me } from "../lib/types.ts";
import { cx, Spinner, useAnchoredLayer, useDismiss, useMediaQuery, WIDE_QUERY } from "./ui.tsx";

// 对话面板（含 AI SDK）按需加载，首屏不背这部分
const ChatPanel = lazy(() =>
  import("../chat/chat-panel.tsx").then((m) => ({ default: m.ChatPanel })),
);

function useTheme() {
  const [theme, setTheme] = useState<string | null>(() => localStorage.getItem("ivan.theme"));
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, [theme]);
  const dark = theme ? theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  const toggle = () => {
    const next = dark ? "light" : "dark";
    localStorage.setItem("ivan.theme", next);
    setTheme(next);
  };
  return { dark, toggle };
}

const CHAT_MIN = 320;
const CHAT_DEFAULT = 440;
/** 主区域至少留这么宽，拖不过去 */
const MAIN_MIN = 480;

/** 对话栏宽度（D45）：左边缘可拖、方向键可调、双击复位；记在本机 */
function useChatWidth() {
  const clamp = (v: number) =>
    Math.round(Math.max(CHAT_MIN, Math.min(v, Math.max(CHAT_MIN, window.innerWidth - MAIN_MIN))));
  const [width, setWidth] = useState(() =>
    clamp(Number(localStorage.getItem("ivan.chat.width")) || CHAT_DEFAULT),
  );
  useEffect(() => {
    localStorage.setItem("ivan.chat.width", String(width));
  }, [width]);
  useEffect(() => {
    const onResize = () => setWidth((w) => clamp(w));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const set = (v: number) => setWidth(clamp(v));
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => setWidth(clamp(window.innerWidth - ev.clientX));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  return { width, set, startDrag };
}

export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/me"), staleTime: 30_000 });
}

/** 账户菜单：今日用量、信号集、管理、主题、退出——都是偶尔才用的东西 */
function AccountMenu({ me }: { me: Me | undefined }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [refs] = useState(() => [btn, layer]);
  const [close] = useState(() => () => setOpen(false));
  useDismiss(open, close, refs);
  const style = useAnchoredLayer(open, btn, 232, "end");
  const theme = useTheme();
  const navigate = useNavigate();
  const initial = (me?.user.name || me?.user.email || "?").slice(0, 1).toUpperCase();
  const item =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2";
  return (
    <>
      <button
        ref={btn}
        onClick={() => setOpen(!open)}
        aria-label="账户菜单"
        aria-expanded={open}
        className="flex size-8 items-center justify-center rounded-full bg-surface-2 text-sm font-medium text-ink-2 hover:text-ink"
      >
        {initial}
      </button>
      {open &&
        style &&
        createPortal(
          <div
            ref={layer}
            style={style}
            className="rounded-xl border border-line bg-surface p-1.5 shadow-lg"
            onClick={() => setOpen(false)}
          >
            {me && (
              <div className="px-2 pt-1 pb-2">
                <div className="truncate text-sm font-medium">{me.user.name}</div>
                <div className="truncate text-xs text-muted">{me.user.email}</div>
                <div className="mt-1.5 text-xs text-ink-2">
                  今日已用：对话 {me.usage.chatMessages}/{me.quota.chatMessages} · 回测{" "}
                  {me.usage.backtests}/{me.quota.backtests}
                </div>
              </div>
            )}
            <div className="border-t border-line pt-1">
              <Link to="/signals" className={item}>
                <Upload className="size-4 text-muted" />
                信号集
              </Link>
              {me?.user.role === "admin" && (
                <Link to="/admin" className={item}>
                  <Settings className="size-4 text-muted" />
                  管理
                </Link>
              )}
              <button className={item} onClick={theme.toggle}>
                {theme.dark ? (
                  <Sun className="size-4 text-muted" />
                ) : (
                  <Moon className="size-4 text-muted" />
                )}
                {theme.dark ? "浅色模式" : "深色模式"}
              </button>
              <button
                className={item}
                onClick={async () => {
                  await authClient.signOut();
                  navigate("/login");
                }}
              >
                <LogOut className="size-4 text-muted" />
                退出登录
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export function Layout() {
  const me = useMe();
  const chat = useChatUi();
  const location = useLocation();
  const navigate = useNavigate();
  const wide = useMediaQuery(WIDE_QUERY);
  const isHome = location.pathname === "/";
  const onChatPage = location.pathname.startsWith("/chat");
  const docked = wide && !onChatPage && (isHome || chat.open);
  const chatWidth = useChatWidth();

  // 窄屏没有侧栏：图表「问 AI」这类外部提问转到全屏对话页
  useEffect(() => {
    if (!wide && chat.pending && !onChatPage) navigate("/chat");
  }, [wide, chat.pending, onChatPage, navigate]);

  const link = ({ isActive }: { isActive: boolean }) =>
    cx(
      "whitespace-nowrap rounded-lg px-3 py-1.5 text-sm",
      isActive ? "bg-surface-2 font-medium text-ink" : "text-ink-2 hover:text-ink",
    );
  const showAskButton = !onChatPage && !(wide && isHome);
  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-line bg-page/90 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4">
            <NavLink to="/" className="mr-2 flex items-center gap-2 font-semibold">
              <span className="flex size-7 items-center justify-center rounded-lg bg-accent text-white">
                <BarChart3 className="size-4" />
              </span>
              Ivan
            </NavLink>
            <nav className="flex items-center gap-1">
              <NavLink to="/" end className={link}>
                看板
              </NavLink>
              <NavLink to="/strategies" className={link}>
                策略
              </NavLink>
            </nav>
            <div className="ml-auto flex items-center gap-2">
              {showAskButton && (
                <button
                  onClick={() => (wide ? chat.setOpen(!chat.open) : navigate("/chat"))}
                  className={cx(
                    "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-sm font-medium",
                    wide && chat.open
                      ? "bg-surface-2 text-ink"
                      : "bg-accent text-white hover:opacity-90",
                  )}
                >
                  <MessageSquare className="size-4" />问 AI
                </button>
              )}
              <AccountMenu me={me.data} />
            </div>
          </div>
        </header>
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="@container mx-auto max-w-6xl px-4 py-5">
            <Outlet />
          </div>
          <footer className="mx-auto max-w-6xl px-4 pb-6 text-[11px] text-muted">
            仅供研究，不构成投资建议；数据来自第三方公开接口，可能有误差与延迟。
          </footer>
        </main>
      </div>
      {docked && (
        <aside
          className="relative flex h-full shrink-0 flex-col border-l border-line bg-surface"
          style={{ width: chatWidth.width }}
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调整对话栏宽度（双击复位）"
            aria-valuenow={chatWidth.width}
            tabIndex={0}
            title="拖动调整宽度，双击复位"
            onPointerDown={chatWidth.startDrag}
            onDoubleClick={() => chatWidth.set(CHAT_DEFAULT)}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") chatWidth.set(chatWidth.width + 24);
              if (e.key === "ArrowRight") chatWidth.set(chatWidth.width - 24);
            }}
            className="group absolute inset-y-0 -left-1.5 z-20 w-3 cursor-col-resize touch-none outline-none"
          >
            <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full transition-colors group-hover:bg-accent/60 group-focus-visible:bg-accent group-active:bg-accent" />
          </div>
          <Suspense fallback={<Spinner />}>
            <ChatPanel docked={isHome} />
          </Suspense>
        </aside>
      )}
    </div>
  );
}

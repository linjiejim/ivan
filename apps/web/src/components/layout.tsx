/**
 * 外框（D40）：导航只留「看板 · 策略」，其余收进账户菜单。
 * 首页 = 看板 + 常驻对话；其他页面在宽屏上对话是可收起的侧栏，窄屏上走全屏对话页。
 */
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useChatUi } from "../chat/chat-context.tsx";
import { api } from "../lib/api.ts";
import { authClient } from "../lib/auth.ts";
import { type ThemePref, useTheme } from "../lib/theme.ts";
import type { Me } from "../lib/types.ts";
import { LogoGlyph, Wordmark } from "./brand.tsx";
import {
  IconAdmin,
  IconAI,
  IconBoard,
  IconDark,
  IconLight,
  IconSignals,
  IconSignOut,
  IconStrategy,
  IconSystem,
  type Icon,
} from "./icons.tsx";
import { cx, MenuItem, MenuLink, Popover, Spinner, useMediaQuery, WIDE_QUERY } from "./ui.tsx";

// 对话面板（含 AI SDK）按需加载，首屏不背这部分
const ChatPanel = lazy(() =>
  import("../chat/chat-panel.tsx").then((m) => ({ default: m.ChatPanel })),
);

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
  const [dragging, setDragging] = useState(false);
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
    setDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => setWidth(clamp(window.innerWidth - ev.clientX));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setDragging(false);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  return { width, set, startDrag, dragging };
}

export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/me"), staleTime: 30_000 });
}

const THEMES: Array<[ThemePref, string, Icon]> = [
  ["light", "浅色", IconLight],
  ["dark", "深色", IconDark],
  ["system", "跟随系统", IconSystem],
];

/** 今日用量：数字 + 一道很细的刻度（没有底色轨道），接近上限时变赭色 */
function Quota({ label, used, total }: { label: string; used: number; total: number }) {
  const ratio = total > 0 ? Math.min(used / total, 1) : 0;
  const near = ratio >= 0.8;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-7 text-muted">{label}</span>
      <span className="relative h-1 flex-1">
        <span
          className={cx("absolute inset-y-0 left-0 rounded-full", near ? "bg-warn" : "bg-ink/35")}
          style={{ width: `${Math.max(ratio * 100, used > 0 ? 3 : 0)}%` }}
        />
      </span>
      <span className={cx("tabular w-14 text-right", near ? "text-warn" : "text-ink-2")}>
        {used}/{total}
      </span>
    </div>
  );
}

/** 账户菜单：今日用量、信号集、管理、主题、退出——都是偶尔才用的东西 */
function AccountMenu({ me }: { me: Me | undefined }) {
  const theme = useTheme();
  const navigate = useNavigate();
  const initial = (me?.user.name || me?.user.email || "?").slice(0, 1).toUpperCase();
  return (
    <Popover
      width={260}
      align="end"
      label="账户菜单"
      trigger={({ ref, open, toggle }) => (
        <button
          ref={ref}
          onClick={toggle}
          aria-label="账户菜单"
          aria-haspopup="menu"
          aria-expanded={open}
          className={cx(
            "flex size-8 items-center justify-center rounded-lg text-[13px] font-semibold text-ink-2 ring-1 ring-line-strong transition-colors ring-inset hover:bg-surface-2 hover:text-ink",
            open && "bg-surface-2 text-ink",
          )}
        >
          {initial}
        </button>
      )}
    >
      {(close) => (
        <>
          {me && (
            <div className="px-2 pt-1.5 pb-3">
              <div className="flex items-center gap-2.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-sm font-semibold text-ink-2">
                  {initial}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-ink">{me.user.name}</div>
                  <div className="truncate text-xs text-muted">{me.user.email}</div>
                </div>
              </div>
              <div className="mt-3 space-y-1.5">
                <div className="text-2xs text-muted">今日用量</div>
                <Quota label="对话" used={me.usage.chatMessages} total={me.quota.chatMessages} />
                <Quota label="回测" used={me.usage.backtests} total={me.quota.backtests} />
                <Quota label="数据查询" used={me.usage.analyses ?? 0} total={me.quota.analyses} />
              </div>
            </div>
          )}
          <div className="border-t border-line pt-1.5" onClick={close}>
            <MenuLink to="/signals" icon={IconSignals}>
              信号集
            </MenuLink>
            {me?.user.role === "admin" && (
              <MenuLink to="/admin" icon={IconAdmin}>
                管理
              </MenuLink>
            )}
          </div>
          <div className="mt-1.5 border-t border-line px-2 pt-2.5 pb-1.5">
            <div className="mb-1.5 text-2xs text-muted">外观</div>
            <div role="radiogroup" aria-label="外观" className="grid grid-cols-3 gap-1">
              {THEMES.map(([value, label, Ico]) => {
                const on = theme.pref === value;
                return (
                  <button
                    key={value}
                    role="radio"
                    aria-checked={on}
                    onClick={() => theme.set(value)}
                    className={cx(
                      "flex h-12 flex-col items-center justify-center gap-1 rounded-lg text-2xs transition-colors",
                      on
                        ? "bg-surface-2 font-medium text-ink ring-1 ring-line-strong ring-inset"
                        : "text-muted hover:bg-surface-2 hover:text-ink",
                    )}
                  >
                    <Ico size={16} />
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="mt-1.5 border-t border-line pt-1.5">
            <MenuItem
              icon={IconSignOut}
              onClick={async () => {
                close();
                await authClient.signOut();
                navigate("/login");
              }}
            >
              退出登录
            </MenuItem>
          </div>
        </>
      )}
    </Popover>
  );
}

function NavItem({ to, icon: Ico, children }: { to: string; icon: Icon; children: string }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        cx(
          "group/nav inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm whitespace-nowrap transition-colors duration-150",
          isActive
            ? "bg-surface-2 font-medium text-ink"
            : "text-muted hover:bg-surface-2/60 hover:text-ink",
        )
      }
    >
      {({ isActive }) => (
        <>
          <Ico
            size={16}
            weight={isActive ? "fill" : "regular"}
            className={cx(isActive ? "text-ink" : "text-faint group-hover/nav:text-ink-2")}
          />
          {children}
        </>
      )}
    </NavLink>
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

  const showAskButton = !onChatPage && !(wide && isHome);
  return (
    <div className="flex h-full">
      <a
        href="#main"
        className="fixed top-2 left-2 z-(--z-popover) -translate-y-16 rounded-lg bg-primary px-3 py-2 text-sm text-primary-ink shadow-pop transition-transform focus:translate-y-0"
      >
        跳到正文
      </a>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-(--z-header) border-b border-line bg-page/85 backdrop-blur-md backdrop-saturate-150">
          <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
            <NavLink
              to="/"
              aria-label="Ivan 首页"
              className="mr-1 rounded-md py-1 pr-1 transition-opacity hover:opacity-80"
            >
              <Wordmark className="max-sm:hidden" />
              <LogoGlyph className="size-6 text-ink sm:hidden" />
            </NavLink>
            <span aria-hidden className="h-4 w-px bg-line-strong max-sm:hidden" />
            <nav aria-label="主导航" className="flex items-center gap-0.5">
              <NavItem to="/" icon={IconBoard}>
                看板
              </NavItem>
              <NavItem to="/strategies" icon={IconStrategy}>
                策略
              </NavItem>
            </nav>
            <div className="ml-auto flex items-center gap-2">
              {showAskButton && (
                <button
                  onClick={() => (wide ? chat.setOpen(!chat.open) : navigate("/chat"))}
                  aria-pressed={wide ? chat.open : undefined}
                  className={cx(
                    "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150",
                    wide && chat.open
                      ? "bg-surface-2 text-ink ring-1 ring-line-strong ring-inset"
                      : "bg-accent-wash text-accent ring-1 ring-accent-line ring-inset hover:bg-accent/15",
                  )}
                >
                  <IconAI size={16} weight={wide && chat.open ? "regular" : "fill"} />问 AI
                </button>
              )}
              <AccountMenu me={me.data} />
            </div>
          </div>
        </header>
        <main id="main" className="min-w-0 flex-1 overflow-y-auto">
          <div
            key={location.pathname}
            className="@container mx-auto max-w-6xl animate-enter px-4 pt-6 pb-10 sm:px-6"
          >
            <Outlet />
          </div>
          <footer className="mx-auto flex max-w-6xl items-center gap-2 px-4 pb-8 text-2xs text-muted sm:px-6">
            <LogoGlyph className="size-3.5 text-faint" />
            仅供研究，不构成投资建议；数据来自第三方公开接口，可能有误差与延迟。
          </footer>
        </main>
      </div>
      {docked && (
        <aside
          aria-label="问 AI"
          className="relative flex h-full shrink-0 flex-col border-l border-line bg-surface"
          style={{ width: chatWidth.width }}
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调整对话栏宽度（双击复位）"
            aria-valuenow={chatWidth.width}
            aria-valuemin={CHAT_MIN}
            tabIndex={0}
            title="拖动调整宽度，双击复位"
            onPointerDown={chatWidth.startDrag}
            onDoubleClick={() => chatWidth.set(CHAT_DEFAULT)}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") chatWidth.set(chatWidth.width + 24);
              if (e.key === "ArrowRight") chatWidth.set(chatWidth.width - 24);
            }}
            className="group absolute inset-y-0 -left-1.5 z-(--z-rail) w-3 cursor-col-resize touch-none outline-none"
          >
            <span
              className={cx(
                "absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full transition-colors duration-150 group-hover:bg-accent/50 group-focus-visible:bg-accent",
                chatWidth.dragging && "bg-accent",
              )}
            />
          </div>
          <Suspense fallback={<Spinner className="px-4" />}>
            <ChatPanel docked={isHome} />
          </Suspense>
        </aside>
      )}
    </div>
  );
}

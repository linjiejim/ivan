/**
 * 基础组件（设计系统「墨」）：克制、细线、留白——数据才是唯一允许「大声」的东西。
 * 规则都在 docs/design-system.md；这里的每个组件只用 styles.css 里的语义 token。
 *
 * 圆角只有三档：6px（徽标、小控件）· 8px（按钮、输入框、菜单项）· 12px（卡片、浮层），弹窗 16px。
 * 主按钮用墨；花青只给 AI、链接、焦点、选中。
 */
import { clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import {
  type ButtonHTMLAttributes,
  type ComponentPropsWithRef,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import bambooArt from "../assets/ink/bamboo.webp";
import lostArt from "../assets/ink/lost.webp";
import startArt from "../assets/ink/start.webp";
import { NA } from "../lib/format.ts";
import type { Check } from "../lib/types.ts";
import {
  type Icon,
  IconCheck,
  IconChevronLeft,
  IconCopy,
  IconClose,
  IconError,
  IconInfo,
  IconSelect,
  IconSpinner,
  IconWarn,
} from "./icons.tsx";

/** 组件自带的 class 可以被调用方覆盖：冲突的工具类以后写的为准（tailwind-merge） */
const merge = extendTailwindMerge({
  extend: { theme: { animate: ["enter", "pop", "fade", "modal", "shimmer", "live"] } },
});

export function cx(...a: Parameters<typeof clsx>) {
  return merge(clsx(...a));
}

export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

/** 宽屏（≥1024px）才常驻对话栏；窄屏对话走全屏页 */
export const WIDE_QUERY = "(min-width: 1024px)";

/**
 * 浮层定位：挂到 body 上、fixed 定位，不会被卡片的 overflow 裁掉；下方放不下就翻到上方。
 */
export function useAnchoredLayer(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  width: number,
  align: "center" | "end" | "start" = "center",
): CSSProperties | null {
  const [style, setStyle] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!open || !anchor.current) {
      setStyle(null);
      return;
    }
    const r = anchor.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(width, vw - 16);
    let left =
      align === "end" ? r.right - w : align === "start" ? r.left : r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, vw - w - 8));
    const next: CSSProperties = { position: "fixed", left, width: w, zIndex: "var(--z-popover)" };
    const below = vh - r.bottom;
    if (below < 240 && r.top > below) next.bottom = vh - r.top + 6;
    else next.top = r.bottom + 6;
    setStyle(next);
  }, [open, anchor, width, align]);
  return style;
}

/** 点外面、按 Esc、滚动或改窗口大小时关掉浮层 */
export function useDismiss(
  open: boolean,
  close: () => void,
  refs: Array<RefObject<HTMLElement | null>>,
): void {
  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) =>
      refs.some((r) => r.current && t instanceof Node && r.current.contains(t));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: MouseEvent) => {
      if (!inside(e.target)) close();
    };
    const onScroll = (e: Event) => {
      if (!inside(e.target)) close();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open, close, refs]);
}

// ── 浮层 ─────────────────────────────────────────────

/**
 * 通用浮层：触发按钮 + 挂在 body 上的面板（菜单、历史列表都用它）。
 * trigger 拿到 ref / 开关状态，children 拿到 close。
 */
export function Popover({
  trigger,
  children,
  width = 240,
  align = "end",
  className,
  label,
}: {
  trigger: (p: {
    ref: RefObject<HTMLButtonElement | null>;
    open: boolean;
    toggle: () => void;
  }) => ReactNode;
  children: (close: () => void) => ReactNode;
  width?: number;
  align?: "center" | "end" | "start";
  className?: string;
  /** 面板的无障碍名称 */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [refs] = useState(() => [btn, layer]);
  const [close] = useState(() => () => setOpen(false));
  useDismiss(open, close, refs);
  const style = useAnchoredLayer(open, btn, width, align);
  return (
    <>
      {trigger({ ref: btn, open, toggle: () => setOpen((o) => !o) })}
      {open &&
        style &&
        createPortal(
          <div
            ref={layer}
            role="menu"
            aria-label={label}
            style={style}
            className={cx(
              "animate-pop rounded-xl border border-line bg-surface p-1.5 shadow-pop",
              className,
            )}
          >
            {children(close)}
          </div>,
          document.body,
        )}
    </>
  );
}

/** 菜单项：图标 + 文字（+ 右侧提示），按下有反馈 */
export function MenuItem({
  icon: Ico,
  children,
  hint,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: Icon; hint?: ReactNode }) {
  return (
    <button
      role="menuitem"
      {...rest}
      className={cx(
        "flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-sm text-ink transition-colors duration-100 hover:bg-surface-2 active:bg-surface-3",
        className,
      )}
    >
      {Ico && <Ico className="shrink-0 text-muted" size={16} />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-xs text-muted">{hint}</span>}
    </button>
  );
}

/** 同上，但是个链接 */
export function MenuLink({
  to,
  icon: Ico,
  children,
}: {
  to: string;
  icon?: Icon;
  children: ReactNode;
}) {
  return (
    <Link
      role="menuitem"
      to={to}
      className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-sm text-ink transition-colors duration-100 hover:bg-surface-2 active:bg-surface-3"
    >
      {Ico && <Ico className="shrink-0 text-muted" size={16} />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </Link>
  );
}

/**
 * ⓘ 按需说明：次要信息（口径、元数据、次要指标）收在这里，悬停或点一下才出来。
 * 页面上只留回答「现在怎么样」的数字。
 */
export function Info({
  children,
  label = "说明",
  width = 280,
  className,
}: {
  children: ReactNode;
  label?: string;
  width?: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const openedAt = useRef(0);
  const [refs] = useState(() => [btn, layer]);
  const style = useAnchoredLayer(open, btn, width);
  const [close] = useState(() => () => setOpen(false));
  const tipId = useId();
  useDismiss(open, close, refs);
  const show = () => {
    window.clearTimeout(timer.current);
    if (!open) openedAt.current = Date.now();
    setOpen(true);
  };
  const hideSoon = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), 150);
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? tipId : undefined}
        className={cx(
          "inline-flex size-4 shrink-0 cursor-help items-center justify-center rounded-full align-[-3px] text-faint transition-colors hover:text-ink-2",
          open && "text-ink-2",
          className,
        )}
        onMouseEnter={show}
        onMouseLeave={hideSoon}
        onFocus={show}
        onBlur={hideSoon}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // 触屏上 hover 和 click 会连着来：刚被 hover 打开的不要立刻关
          if (open && Date.now() - openedAt.current > 400) setOpen(false);
          else show();
        }}
      >
        <IconInfo size={14} />
      </button>
      {open &&
        style &&
        createPortal(
          <div
            ref={layer}
            id={tipId}
            role="tooltip"
            style={style}
            onMouseEnter={show}
            onMouseLeave={hideSoon}
            className="animate-pop rounded-xl border border-line bg-surface px-3.5 py-2.5 text-xs leading-5 text-ink-2 shadow-pop"
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

/** ⓘ 里的「标签 · 值」小表 */
export function InfoRows({ rows }: { rows: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="tabular text-right font-medium text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── 按钮 ─────────────────────────────────────────────

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "ai";

const BUTTON_BASE =
  "relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-lg font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:translate-y-px disabled:pointer-events-none disabled:opacity-45";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-ink shadow-raise hover:bg-primary-hover",
  secondary: "border border-line-strong bg-surface text-ink hover:bg-surface-2",
  ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
  danger:
    "border border-line-strong bg-surface text-danger hover:border-danger/40 hover:bg-danger/[0.06]",
  ai: "bg-accent-wash text-accent ring-1 ring-accent-line ring-inset hover:bg-accent/15",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  icon: Ico,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  loading?: boolean;
  /** 前置图标（Phosphor 组件）；加载中会换成转圈，按钮宽度不跳 */
  icon?: Icon;
}) {
  const iconSize = size === "sm" ? 14 : 16;
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        BUTTON_BASE,
        size === "sm" ? "h-7 gap-1 px-2.5 text-xs" : "h-9 gap-1.5 px-3.5 text-sm",
        BUTTON_VARIANT[variant],
        className,
      )}
    >
      {loading ? (
        <IconSpinner size={iconSize} className="shrink-0 animate-spin" />
      ) : (
        Ico && <Ico size={iconSize} className="shrink-0" />
      )}
      {children}
    </button>
  );
}

/** 只有图标的按钮：必须给 label（读屏 + 悬停提示） */
export function IconButton({
  icon: Ico,
  label,
  size = "md",
  active,
  className,
  ...rest
}: ComponentPropsWithRef<"button"> & {
  icon: Icon;
  label: string;
  size?: "sm" | "md";
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-lg text-ink-2 transition-[background-color,color,transform] duration-150 hover:bg-surface-2 hover:text-ink active:translate-y-px disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "size-7" : "size-8",
        active && "bg-surface-2 text-ink",
        className,
      )}
    >
      <Ico size={size === "sm" ? 15 : 17} />
    </button>
  );
}

/** 复制按钮：点了之后 1.6 秒内显示「已复制」，不用弹窗打扰 */
export function CopyButton({
  text,
  label = "复制",
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(false), 1600);
    return () => window.clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
      }}
      className={cx(
        "inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium transition-colors",
        done ? "text-down" : "text-accent hover:bg-accent-wash",
        className,
      )}
    >
      {done ? <IconCheck size={14} weight="bold" /> : <IconCopy size={14} />}
      <span aria-live="polite">{done ? "已复制" : label}</span>
    </button>
  );
}

/** 文字链接（花青）：「完整报告 ›」这类去别处看的入口 */
const TEXT_LINK =
  "group/link inline-flex items-center gap-0.5 whitespace-nowrap text-xs font-medium text-accent transition-colors hover:text-accent-strong";

/**
 * 文字链接。站内跳转用 `to`；下载文件（如运行卡）用 `href` + `download`，不带箭头、前面可放图标；
 * 就地的小操作（「恢复默认」）用 `onClick`，渲染成按钮。
 */
export function TextLink(
  props:
    | { to: string; children: ReactNode; className?: string }
    | {
        href: string;
        download: string;
        icon?: Icon;
        children: ReactNode;
        className?: string;
      }
    | { onClick: () => void; children: ReactNode; className?: string },
) {
  if ("onClick" in props) {
    // 就地操作（「恢复默认」这类）：同样的花青文字，不带去别处的箭头
    return (
      <button type="button" onClick={props.onClick} className={cx(TEXT_LINK, props.className)}>
        {props.children}
      </button>
    );
  }
  if ("href" in props) {
    const Icon = props.icon;
    return (
      <a
        href={props.href}
        download={props.download}
        className={cx(TEXT_LINK, "gap-1", props.className)}
      >
        {Icon && <Icon size={14} />}
        {props.children}
      </a>
    );
  }
  return (
    <Link to={props.to} className={cx(TEXT_LINK, props.className)}>
      {props.children}
      <span
        aria-hidden
        className="inline-block transition-transform duration-150 ease-out group-hover/link:translate-x-0.5"
      >
        ›
      </span>
    </Link>
  );
}

// ── 容器 ─────────────────────────────────────────────

export function Card({
  className,
  children,
  title,
  action,
  subtitle,
  info,
  icon: Ico,
  flush,
  id,
}: {
  className?: string;
  children: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  /** 标题旁的 ⓘ：口径、数据来源这类按需才看的说明 */
  info?: ReactNode;
  /** 标题前的小图标（帮助扫读，不承载信息） */
  icon?: Icon;
  /** 内容贴边（列表、表格自己管内边距） */
  flush?: boolean;
  id?: string;
}) {
  const headingId = useId();
  return (
    <section
      id={id}
      aria-labelledby={title ? headingId : undefined}
      className={cx(
        "min-w-0 rounded-xl border border-line bg-surface shadow-[var(--edge)]",
        className,
      )}
    >
      {(title || action) && (
        <header className="flex min-h-12 items-center justify-between gap-3 px-4 pt-3">
          <div className="min-w-0">
            {title && (
              <h2
                id={headingId}
                className="flex items-center gap-2 text-sm font-semibold leading-5 text-ink"
              >
                {Ico && <Ico size={16} className="shrink-0 text-muted" />}
                {title}
                {info && <Info>{info}</Info>}
              </h2>
            )}
            {subtitle && (
              <p className={cx("mt-0.5 text-xs text-muted", Ico && "pl-6")}>{subtitle}</p>
            )}
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </header>
      )}
      <div className={cx(flush ? "pb-1.5" : "px-4 pt-2.5 pb-4", !title && !action && "pt-4")}>
        {children}
      </div>
    </section>
  );
}

/** 页头：标题 + 元信息 + 右侧动作；可带返回上一级 */
export function PageHeader({
  title,
  badges,
  meta,
  actions,
  back,
}: {
  title: ReactNode;
  badges?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
}) {
  return (
    <header className="flex flex-wrap items-end gap-x-4 gap-y-4">
      {/* 标题区至少占 18rem（或整行）：窄屏时动作按钮换到下一行，而不是把标题挤成一列 */}
      <div className="min-w-[min(100%,18rem)] flex-1">
        {back && (
          <Link
            to={back.to}
            className="group/back mb-2 inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-ink"
          >
            <IconChevronLeft
              size={12}
              className="transition-transform duration-150 group-hover/back:-translate-x-0.5"
            />
            {back.label}
          </Link>
        )}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <h1 className="text-[22px] leading-8 font-semibold tracking-[-0.01em] text-ink">
            {title}
          </h1>
          {badges}
        </div>
        {meta && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            {meta}
          </div>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

// ── 标签 ─────────────────────────────────────────────

export type Tone = "neutral" | "accent" | "warn" | "up" | "down";

/** 状态徽标（有底色）：运行中、失败、待确认、买卖…… */
export function Badge({
  children,
  tone = "neutral",
  icon: Ico,
  iconWeight = "bold",
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  icon?: Icon;
  /** 警示类状态（如判词「可能失效」）用 fill，和设计系统的「警示用 fill」一致 */
  iconWeight?: "bold" | "fill";
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-[11px] font-medium leading-none",
        tone === "neutral" && "bg-surface-2 text-ink-2",
        tone === "accent" && "bg-accent-wash text-accent",
        tone === "warn" && "bg-warn-bg text-warn",
        tone === "up" && "bg-up/10 text-up",
        tone === "down" && "bg-down/10 text-down",
        className,
      )}
    >
      {Ico && <Ico size={12} weight={iconWeight} className="shrink-0" />}
      {children}
    </span>
  );
}

/** 分类标签（描边、无底色）：市场、版本号这类元数据，和状态徽标区分开 */
export function Tag({
  children,
  mono,
  className,
}: {
  children: ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-5 items-center whitespace-nowrap rounded-md px-1.5 text-[11px] leading-none font-medium text-ink-2 ring-1 ring-line-strong ring-inset",
        mono && "font-mono tracking-tight",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** 策略色圆点：列表、选择按钮、图里的线同一个颜色；没分到颜色的是灰点 */
export function SeriesDot({ color, className }: { color?: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cx("inline-block size-2 shrink-0 rounded-full", className)}
      style={{ background: color ?? "var(--faint)" }}
    />
  );
}

/** 「运行中」的实时点：只在真正在跑的跟踪上出现 */
export function LiveDot({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cx("relative inline-flex size-1.5", className)}>
      <span className="absolute inset-0 animate-live rounded-full bg-current" />
      <span className="relative inline-flex size-1.5 rounded-full bg-current" />
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-line-strong bg-surface-2 px-1 font-mono text-[10px] leading-none text-muted">
      {children}
    </kbd>
  );
}

// ── 表单 ─────────────────────────────────────────────

const FIELD_BASE =
  "rounded-lg border border-line-strong bg-surface text-sm text-ink outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-muted hover:border-ink/25 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-wash)] disabled:cursor-not-allowed disabled:opacity-55";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={cx(
        FIELD_BASE,
        "h-9 px-3",
        // 调用方给了宽度就用调用方的，否则撑满
        !/(^|\s)w-/.test(className ?? "") && "w-full",
        className,
      )}
    />
  );
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea {...rest} className={cx(FIELD_BASE, "block w-full px-3 py-2 leading-6", className)} />
  );
}

/** 原生下拉（键盘、读屏都是现成的），只换掉箭头；宽度 class 加在外层 */
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={cx("relative inline-flex", className)}>
      <select {...rest} className={cx(FIELD_BASE, "h-9 w-full appearance-none pr-8 pl-3")}>
        {children}
      </select>
      <IconSelect
        size={14}
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted"
      />
    </span>
  );
}

/** 标签在上、说明在下、错误在最下（不用 placeholder 当标签） */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1.5 block text-xs font-medium text-ink-2">{label}</span>
      {children}
      {hint && !error && <span className="mt-1.5 block text-xs text-muted">{hint}</span>}
      {error && (
        <span className="mt-1.5 flex items-center gap-1 text-xs text-warn">
          <IconError size={13} className="shrink-0" />
          {error}
        </span>
      )}
    </label>
  );
}

/** 复选框 + 文字（原生控件，主题色走墨） */
export function Checkbox({
  label,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label
      className={cx(
        "inline-flex cursor-pointer items-center gap-2 whitespace-nowrap text-sm text-ink select-none",
        className,
      )}
    >
      <input type="checkbox" {...rest} className="size-[15px] cursor-pointer accent-ink" />
      {label}
    </label>
  );
}

// ── 状态：加载、空、错误 ─────────────────────────────

export function Spinner({ label, className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={cx("flex items-center gap-2 py-6 text-sm text-muted", className)}>
      <IconSpinner size={16} className="animate-spin" />
      {label ?? "加载中…"}
    </div>
  );
}

/** 骨架块：形状贴合最终布局，不用转圈 */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div aria-hidden className={cx("skeleton", className)} style={style} />;
}

/** 整页首屏加载：页头 + 指标 + 大卡片的骨架 */
export function PageSkeleton({ stats = 4 }: { stats?: number }) {
  return (
    <div role="status" aria-label="加载中" className="space-y-5">
      <div className="space-y-2.5">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-7 w-64" />
      </div>
      {stats > 0 && (
        <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
          {Array.from({ length: stats }, (_, i) => (
            <div key={i} className="space-y-3 rounded-xl border border-line bg-surface p-4">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-7 w-24" />
            </div>
          ))}
        </div>
      )}
      <div className="space-y-4 rounded-xl border border-line bg-surface p-4">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-56 w-full rounded-lg" />
      </div>
    </div>
  );
}

/** 列表骨架：n 行「标题 + 副标题 + 右侧数字」 */
export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-label="加载中" className="space-y-4 py-1">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-2 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-40" style={{ width: `${40 - i * 6}%` }} />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-5 w-14" />
        </div>
      ))}
    </div>
  );
}

const ART = { start: startArt, lost: lostArt, bamboo: bambooArt } as const;

/** 水墨插画：浅色直接落在纸上，深色整体反相（.ink-art） */
export function InkArt({
  name,
  className,
  alt = "",
}: {
  name: keyof typeof ART;
  className?: string;
  alt?: string;
}) {
  return (
    <img
      src={ART[name]}
      alt={alt}
      draggable={false}
      loading="lazy"
      decoding="async"
      className={cx("ink-art pointer-events-none", className)}
    />
  );
}

/** 空状态：说清楚「为什么是空的、怎么让它不空」；大块留白的地方配一幅水墨 */
export function Empty({
  title,
  children,
  art,
  icon: Ico,
  action,
  className,
}: {
  title: ReactNode;
  children?: ReactNode;
  art?: keyof typeof ART;
  icon?: Icon;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex flex-col items-center px-6 text-center",
        art ? "py-8" : "rounded-lg border border-dashed border-line-strong py-8",
        className,
      )}
    >
      {art ? (
        <InkArt name={art} className="mb-3 size-32 object-contain" />
      ) : (
        Ico && (
          <span className="mb-3 flex size-10 items-center justify-center rounded-xl bg-surface-2 text-muted">
            <Ico size={20} />
          </span>
        )
      )}
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && (
        <div className="mt-1.5 max-w-sm text-xs leading-5 text-balance text-muted">{children}</div>
      )}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

/** 带水墨插画的引导卡：首次使用这类「说一句话、给一个入口」的时刻 */
export function ArtCard({
  art,
  title,
  body,
  action,
}: {
  art: keyof typeof ART;
  title: ReactNode;
  body: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--edge)]">
      <div className="grid items-center gap-4 p-6 @2xl:grid-cols-[minmax(0,1fr)_208px] @2xl:gap-10 @2xl:px-8 @2xl:py-6">
        <div className="max-w-[48ch]">
          <h2 className="text-lg leading-7 font-semibold text-ink">{title}</h2>
          <p className="mt-2 text-sm leading-6 text-ink-2">{body}</p>
          {action && <div className="mt-5 flex flex-wrap gap-2">{action}</div>}
        </div>
        {/* 插画是横构图：用横框 + cover 裁掉上下透明的留白 */}
        <InkArt
          name={art}
          className="order-first mx-auto aspect-[16/10] w-44 object-cover @2xl:order-none @2xl:w-52"
        />
      </div>
    </section>
  );
}

/** 提示条：info（花青）/ warn（赭）/ neutral；图标 + 文字，从不只靠颜色 */
export function Callout({
  tone = "info",
  icon,
  title,
  children,
  action,
  className,
}: {
  tone?: "info" | "warn" | "neutral";
  icon?: Icon;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const Ico = icon ?? (tone === "warn" ? IconWarn : IconInfo);
  return (
    <div
      role={tone === "warn" ? "alert" : undefined}
      className={cx(
        "flex items-start gap-2.5 rounded-lg px-3.5 py-2.5 text-sm leading-6",
        tone === "info" && "bg-accent-wash text-ink-2",
        tone === "warn" && "bg-warn-bg text-ink-2 ring-1 ring-warn-line ring-inset",
        tone === "neutral" && "bg-surface-2 text-ink-2",
        className,
      )}
    >
      <Ico
        size={16}
        weight={tone === "warn" ? "fill" : "regular"}
        className={cx(
          "mt-[0.2em] shrink-0",
          tone === "info" && "text-accent",
          tone === "warn" && "text-warn",
          tone === "neutral" && "text-muted",
        )}
      />
      <div className="min-w-0 flex-1">
        {title && <span className="font-medium text-ink">{title}</span>}
        {title && children ? <span className="text-ink-2">：</span> : null}
        {children}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <Callout tone="warn" className={cx("mt-3", className)}>
      <span className="whitespace-pre-wrap">{msg}</span>
    </Callout>
  );
}

// ── 数字 ─────────────────────────────────────────────

/**
 * 大数字的排版：「+15.4%」里正负号与单位退后一步。只拆开明确的结构（符号 / 数 / % 万 亿 倍 天），
 * 其余原样输出；空值显示「--」。
 */
export function Figure({ text }: { text: ReactNode }) {
  if (typeof text !== "string") return <>{text}</>;
  if (text === NA) return <span className="text-muted">{NA}</span>;
  const m = /^([+\-−]?)([\d.,]+)\s?(%|万|亿|倍|天)?$/.exec(text);
  if (!m) return <>{text}</>;
  const [, sign, n, unit] = m;
  return (
    <>
      {sign && <span className="figure-sign">{sign}</span>}
      {n}
      {unit && <span className="figure-unit">{unit}</span>}
    </>
  );
}

/** 一行字里的日期（YYYY-MM-DD）用等宽字（§10），其余原样输出：管理页数据卡这类由函数拼好的整行文字 */
export function MonoDates({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\d{4}-\d{2}-\d{2})/).map((part, i) =>
        i % 2 ? (
          <span key={i} className="font-mono">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** 指标卡：标签 · 大数字 · 注释（dataviz stat tile：大数字用比例数字，不用 tabular） */
export function Stat({
  label,
  value,
  note,
  valueClass,
  info,
  icon: Ico,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  valueClass?: string;
  info?: ReactNode;
  icon?: Icon;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface px-4 py-3.5 shadow-[var(--edge)]">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        {Ico && <Ico size={14} className="shrink-0" />}
        {label}
        {info && <Info>{info}</Info>}
      </div>
      <div
        className={cx(
          "mt-2 truncate text-[26px] leading-8 font-semibold tracking-[-0.02em] text-ink",
          valueClass,
        )}
      >
        <Figure text={value} />
      </div>
      {note && <div className="mt-1 truncate text-xs text-muted">{note}</div>}
    </div>
  );
}

// ── 切换 ─────────────────────────────────────────────

/** 页内分页（下划线式）：可带图标与计数 */
export function Tabs<T extends string>({
  value,
  onChange,
  items,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  items: Array<{ value: T; label: ReactNode; icon?: Icon; count?: number }>;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cx(
        "flex gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]",
        className,
      )}
    >
      {items.map((it) => {
        const on = value === it.value;
        const Ico = it.icon;
        return (
          <button
            key={it.value}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(it.value)}
            className={cx(
              "relative inline-flex h-10 shrink-0 items-center gap-1.5 rounded-t-lg px-3 text-sm whitespace-nowrap transition-colors duration-150",
              "after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:transition-colors after:duration-150",
              on
                ? "font-medium text-ink after:bg-ink"
                : "text-muted after:bg-transparent hover:text-ink",
            )}
          >
            {Ico && <Ico size={15} className={on ? "text-ink" : "text-faint"} />}
            {it.label}
            {it.count !== undefined && (
              <span
                className={cx(
                  "tabular rounded-md px-1 text-[11px] leading-4",
                  on ? "bg-surface-3 text-ink-2" : "bg-surface-2 text-muted",
                )}
              >
                {it.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** 分段切换（图表视图这类「同一块内容换个看法」） */
export function Segmented<T extends string>({
  value,
  onChange,
  items,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  items: Array<[T, ReactNode]>;
  label?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-surface-2 p-0.5"
    >
      {items.map(([v, text]) => {
        const on = v === value;
        return (
          <button
            key={v}
            role="radio"
            aria-checked={on}
            onClick={() => onChange(v)}
            className={cx(
              "h-6 rounded-md px-2.5 text-xs whitespace-nowrap transition-[background-color,color,box-shadow] duration-150",
              on ? "bg-surface font-medium text-ink shadow-raise" : "text-muted hover:text-ink",
            )}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}

// ── 弹窗 ─────────────────────────────────────────────

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
  icon: Ico,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  icon?: Icon;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // 调用方常传内联的 onClose：用 effect event 读最新的，焦点只在开 / 关时移动，不会在输入时被抢走
  const onEscape = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  });
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => onEscape(e);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ zIndex: "var(--z-modal)" }}
    >
      <div
        aria-hidden
        className="absolute inset-0 animate-fade bg-(--scrim) backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          "relative flex max-h-[88vh] w-full animate-modal flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-modal outline-none",
          wide ? "max-w-3xl" : "max-w-lg",
        )}
      >
        <header className="flex items-center gap-2.5 border-b border-line py-3 pr-3 pl-5">
          {Ico && <Ico size={18} className="shrink-0 text-muted" />}
          <h3 id={titleId} className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">
            {title}
          </h3>
          <IconButton icon={IconClose} label="关闭" size="sm" onClick={onClose} />
        </header>
        <div className="min-h-0 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <footer className="flex justify-end gap-2 border-t border-line bg-page/50 px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ── 诚实检查 ─────────────────────────────────────────

/** 诚实检查：warn 用警示色 + 图标 + 文字，从不只靠颜色；compact 只露标题，细节收进 ⓘ */
export function Checks({ checks, compact }: { checks: Check[]; compact?: boolean }) {
  if (!checks.length)
    return compact ? null : <p className="text-xs text-muted">没有发现需要特别注意的问题。</p>;
  if (compact) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {checks.map((c, i) => (
          <span
            key={`${c.id}-${i}`}
            className={cx(
              "inline-flex h-6 items-center gap-1.5 rounded-md pr-1.5 pl-2 text-xs font-medium",
              c.level === "warn"
                ? "bg-warn-bg text-warn ring-1 ring-warn-line ring-inset"
                : "bg-accent-wash text-accent",
            )}
          >
            {c.level === "warn" ? (
              <IconWarn size={13} weight="fill" className="shrink-0" />
            ) : (
              <IconInfo size={13} className="shrink-0" />
            )}
            {c.title}
            <Info label={`${c.title}：说明`}>{c.detail}</Info>
          </span>
        ))}
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {checks.map((c, i) => (
        <li key={`${c.id}-${i}`}>
          <Callout tone={c.level === "warn" ? "warn" : "info"} title={c.title}>
            {c.detail}
          </Callout>
        </li>
      ))}
    </ul>
  );
}

export function CheckBadges({ checks }: { checks: Check[] }) {
  const warns = checks.filter((c) => c.level === "warn");
  if (!warns.length) return null;
  return (
    <Badge tone="warn" icon={IconWarn}>
      {warns.length} 项提示
    </Badge>
  );
}

// ── 表格 ─────────────────────────────────────────────

/** 表格外壳：窄屏横向滚动，数字等宽对齐 */
export function DataTable({
  children,
  minWidth,
  className,
}: {
  children: ReactNode;
  minWidth?: number;
  className?: string;
}) {
  return (
    <div className={cx("-mx-1 overflow-x-auto px-1", className)}>
      <table className="tabular w-full border-collapse text-sm" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export function Th({
  children,
  align = "left",
  className,
}: {
  children?: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={cx(
        "h-9 border-b border-line px-2.5 text-xs font-normal whitespace-nowrap text-muted first:pl-0 last:pr-0",
        align === "right" && "text-right",
        align === "center" && "text-center",
        align === "left" && "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = "left",
  className,
  colSpan,
}: {
  children?: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={cx(
        "h-10 border-b border-line px-2.5 first:pl-0 last:pr-0 [tr:last-child_&]:border-b-0",
        align === "right" && "text-right",
        align === "center" && "text-center",
        className,
      )}
    >
      {children}
    </td>
  );
}

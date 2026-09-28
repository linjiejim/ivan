/**
 * 基础组件：克制、细线、留白（dataviz：数据才是唯一允许「大声」的东西）。
 */
import { clsx } from "clsx";
import { AlertTriangle, Info as InfoIcon, Loader2, X } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { Check } from "../lib/types.ts";

export function cx(...a: Parameters<typeof clsx>) {
  return clsx(...a);
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
  align: "center" | "end" = "center",
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
    let left = align === "end" ? r.right - w : r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, vw - w - 8));
    const next: CSSProperties = { position: "fixed", left, width: w, zIndex: 60 };
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
        className={cx(
          "inline-flex size-4 shrink-0 cursor-help items-center justify-center rounded-full align-[-3px] text-muted transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-accent",
          open && "text-ink",
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
        <InfoIcon className="size-3.5" />
      </button>
      {open &&
        style &&
        createPortal(
          <div
            ref={layer}
            role="tooltip"
            style={style}
            onMouseEnter={show}
            onMouseLeave={hideSoon}
            className="rounded-lg border border-line bg-surface px-3 py-2 text-xs leading-5 text-ink-2 shadow-lg"
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
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="tabular text-right text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
export function Button({
  variant = "secondary",
  size = "md",
  loading,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "sm" | "md";
  loading?: boolean;
}) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        variant === "primary" && "bg-accent text-white hover:opacity-90",
        variant === "secondary" && "border border-line bg-surface text-ink hover:bg-surface-2",
        variant === "ghost" && "text-ink-2 hover:bg-surface-2 hover:text-ink",
        variant === "danger" && "border border-line bg-surface text-up hover:bg-surface-2",
        className,
      )}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" />}
      {children}
    </button>
  );
}

export function Card({
  className,
  children,
  title,
  action,
  subtitle,
  info,
}: {
  className?: string;
  children: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  /** 标题旁的 ⓘ：口径、数据来源这类按需才看的说明 */
  info?: ReactNode;
}) {
  return (
    <section className={cx("rounded-xl border border-line bg-surface", className)}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-1">
          <div className="min-w-0">
            {title && (
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                {title}
                {info && <Info>{info}</Info>}
              </h2>
            )}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      <div className="px-4 pb-4 pt-2">{children}</div>
    </section>
  );
}

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "warn" | "up" | "down";
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-4",
        tone === "neutral" && "bg-surface-2 text-ink-2",
        tone === "accent" && "bg-info-bg text-accent",
        tone === "warn" && "bg-warn-bg text-warn",
        tone === "up" && "bg-surface-2 text-up",
        tone === "down" && "bg-surface-2 text-down",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={cx(
        "h-9 rounded-lg border border-line bg-surface px-3 text-sm text-ink outline-none placeholder:text-muted focus:border-accent",
        // 调用方给了宽度就用调用方的，否则撑满
        !/(^|\s)w-/.test(className ?? "") && "w-full",
        className,
      )}
    />
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={cx(
        "h-9 rounded-lg border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-accent",
        className,
      )}
    >
      {children}
    </select>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-muted">
      <Loader2 className="size-4 animate-spin" />
      {label ?? "加载中…"}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-4 py-8 text-center">
      <p className="text-sm font-medium text-ink-2">{title}</p>
      {children && <div className="mt-2 text-xs text-muted">{children}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="flex items-start gap-2 rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span className="whitespace-pre-wrap">{msg}</span>
    </div>
  );
}

/** 指标卡：标签 · 值 · 可选注释（dataviz stat tile：大数字用比例数字，不用 tabular） */
export function Stat({
  label,
  value,
  note,
  valueClass,
  info,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  valueClass?: string;
  info?: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface px-3 py-2.5">
      <div className="flex items-center gap-1 text-xs text-muted">
        {label}
        {info && <Info>{info}</Info>}
      </div>
      <div className={cx("mt-0.5 truncate text-xl font-semibold", valueClass)}>{value}</div>
      {note && <div className="mt-0.5 truncate text-xs text-muted">{note}</div>}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (v: T) => void;
  items: Array<{ value: T; label: ReactNode }>;
}) {
  return (
    <div className="flex gap-1 border-b border-line">
      {items.map((it) => (
        <button
          key={it.value}
          onClick={() => onChange(it.value)}
          className={cx(
            "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
            value === it.value
              ? "border-accent font-medium text-ink"
              : "border-transparent text-ink-2 hover:text-ink",
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <div
        className={cx(
          "max-h-[90vh] w-full overflow-auto rounded-xl border border-line bg-surface shadow-xl",
          wide ? "max-w-3xl" : "max-w-lg",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h3 className="text-sm font-semibold">{title}</h3>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted hover:bg-surface-2"
            aria-label="关闭"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="px-4 py-4">{children}</div>
        {footer && (
          <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

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
              "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs",
              c.level === "warn" ? "bg-warn-bg text-warn" : "bg-info-bg text-accent",
            )}
          >
            {c.level === "warn" ? (
              <AlertTriangle className="size-3.5" />
            ) : (
              <InfoIcon className="size-3.5" />
            )}
            {c.title}
            <Info label={`${c.title}：说明`}>{c.detail}</Info>
          </span>
        ))}
      </div>
    );
  }
  return (
    <ul className="space-y-1.5">
      {checks.map((c, i) => (
        <li
          key={`${c.id}-${i}`}
          className={cx(
            "flex items-start gap-2 rounded-lg px-3 py-2 text-sm",
            c.level === "warn" ? "bg-warn-bg" : "bg-info-bg",
          )}
        >
          {c.level === "warn" ? (
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
          ) : (
            <InfoIcon className="mt-0.5 size-4 shrink-0 text-accent" />
          )}
          <div className="min-w-0">
            <span className="font-medium text-ink">{c.title}</span>
            <span className="text-ink-2">：{c.detail}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function CheckBadges({ checks }: { checks: Check[] }) {
  const warns = checks.filter((c) => c.level === "warn");
  if (!warns.length) return null;
  return (
    <Badge tone="warn" className="whitespace-nowrap">
      <AlertTriangle className="size-3" />
      {warns.length} 项提示
    </Badge>
  );
}

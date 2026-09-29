/**
 * 品牌（设计系统）：Ivan 的标志是一条被竖笔分开的线——
 * 竖笔是「I」，也是上线那一天；左边渐细的发丝线是回测，右边上扬的实线是上线后的跟踪。
 * 两种形态：完整标志（和字标并排用）、紧凑图形（图标、头像这类方形位置）。颜色一律跟随 currentColor。
 */
import type { SVGProps } from "react";
import { cx } from "./ui.tsx";

type SvgProps = Omit<SVGProps<SVGSVGElement>, "viewBox">;

/** 完整标志，宽高比约 1.8 : 1 */
export function LogoMark({ className, ...rest }: SvgProps) {
  // 默认 18px 高；调用方给的高度会覆盖它（cx 走 tailwind-merge）
  return (
    <svg
      viewBox="0 0 40 22"
      fill="none"
      aria-hidden="true"
      className={cx("h-[18px] w-auto shrink-0", className)}
      {...rest}
    >
      <path d="M.5 12.4 18 11.75v1.3z" fill="currentColor" />
      <g stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 1.5v19" />
        <path d="M18 12.4h3.5c6.9 0 6.9-5.4 13.8-5.4h3.2" />
      </g>
    </svg>
  );
}

/** 紧凑图形：放进方形位置（图标、头像） */
export function LogoGlyph({ className, strokeWidth = 2, ...rest }: SvgProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className} {...rest}>
      <path d="M2.25 13.1 9 12.4v1.4z" fill="currentColor" />
      <g
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 5v14" />
        <path d="M9 13.1h2.1c4 0 4-3.9 8-3.9h1.3" />
      </g>
    </svg>
  );
}

/** 标志 + 字标 */
export function Wordmark({ className, size = "md" }: { className?: string; size?: "md" | "lg" }) {
  return (
    <span
      className={cx(
        "inline-flex items-center font-semibold tracking-[-0.02em] text-ink",
        size === "lg" ? "gap-3 text-[22px]" : "gap-2.5 text-[15px]",
        className,
      )}
    >
      <LogoMark className={size === "lg" ? "h-6" : "h-[17px]"} />
      <span className="leading-none">Ivan</span>
    </span>
  );
}

/** AI 的头像：花青底上的紧凑图形（AI 说话的地方才出现） */
export function AiAvatar({ className, size = "sm" }: { className?: string; size?: "sm" | "md" }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-flex shrink-0 items-center justify-center bg-accent-wash text-accent ring-1 ring-accent-line ring-inset",
        size === "md" ? "size-8 rounded-lg" : "size-6 rounded-md",
        className,
      )}
    >
      <LogoGlyph className={size === "md" ? "size-5" : "size-4"} strokeWidth={2.2} />
    </span>
  );
}

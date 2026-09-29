/**
 * 小图：迷你曲线（SVG）、月度收益表（红涨蓝跌的发散色格子 + 数字，本身就是表格视图）、
 * 盈亏条（HTML 横条，正负两色 + 符号）。发散色取 token：正 = --up、负 = --neg（蓝），中间是纸色。
 */
import { useMemo } from "react";
import { NA, pct } from "../../lib/format.ts";
import { cx } from "../ui.tsx";

export function Sparkline({
  values,
  width = 96,
  height = 28,
  color = "var(--series-1)",
}: {
  values: number[];
  width?: number;
  height?: number;
  /** 看板上跟策略的颜色走，和对照图一致 */
  color?: string;
}) {
  const geo = useMemo(() => {
    const xs = values.filter((v) => Number.isFinite(v));
    if (xs.length < 2) return null;
    const min = Math.min(...xs);
    const max = Math.max(...xs);
    const span = max - min || 1;
    const pts = xs.map((v, i) => [
      (i / (xs.length - 1)) * (width - 6) + 2,
      height - 4 - ((v - min) / span) * (height - 8),
    ]);
    const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x!.toFixed(1)},${y!.toFixed(1)}`).join(" ");
    return { d, end: pts.at(-1)! };
  }, [values, width, height]);
  if (!geo) return <span className="text-xs text-muted">{NA}</span>;
  return (
    <svg width={width} height={height} aria-hidden="true" className="overflow-visible">
      <path
        d={geo.d}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* 线尾一个点：「今天在这儿」 */}
      <circle cx={geo.end[0]} cy={geo.end[1]} r={2.25} fill={color} />
      <circle
        cx={geo.end[0]}
        cy={geo.end[1]}
        r={4}
        fill="none"
        stroke={color}
        strokeOpacity={0.25}
      />
    </svg>
  );
}

/** 发散色：正（涨）红、负（跌）蓝，越深幅度越大；按 ±cap 截断 */
function cellStyle(v: number, cap = 0.1): React.CSSProperties {
  if (!Number.isFinite(v)) return {};
  const a = Math.min(Math.abs(v) / cap, 1);
  const mix = Math.round(8 + a * 40);
  return {
    background: `color-mix(in oklab, var(${v >= 0 ? "--up" : "--neg"}) ${mix}%, transparent)`,
  };
}

export function MonthlyTable({
  monthly,
  yearly,
}: {
  monthly: Array<{ month: string; ret: number; bench: number }>;
  yearly: Array<{ year: string; ret: number; bench: number }>;
}) {
  const years = [...new Set(monthly.map((m) => m.month.slice(0, 4)))];
  const byKey = new Map(monthly.map((m) => [m.month, m]));
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="tabular w-full min-w-[760px] border-separate border-spacing-[3px] text-xs">
        <thead>
          <tr className="text-muted">
            <th className="px-1.5 py-1 text-left font-normal">年份</th>
            {Array.from({ length: 12 }, (_, i) => (
              <th key={i} className="px-1.5 py-1 text-right font-normal">
                {i + 1}月
              </th>
            ))}
            <th className="px-1.5 py-1 text-right font-medium text-ink-2">全年</th>
            <th className="px-1.5 py-1 text-right font-normal">基准</th>
          </tr>
        </thead>
        <tbody>
          {years.map((y) => {
            const yr = yearly.find((r) => r.year === y);
            return (
              <tr key={y}>
                <td className="px-1.5 py-1.5 font-mono text-[11px] text-ink-2">{y}</td>
                {Array.from({ length: 12 }, (_, i) => {
                  const m = byKey.get(`${y}-${String(i + 1).padStart(2, "0")}`);
                  return (
                    <td
                      key={i}
                      className={cx(
                        "rounded-[5px] px-1.5 py-1.5 text-right",
                        m ? "text-ink" : "bg-surface-2/60",
                      )}
                      style={m ? cellStyle(m.ret) : undefined}
                      title={m ? `基准 ${pct(m.bench)}` : undefined}
                    >
                      {m ? pct(m.ret, 1) : ""}
                    </td>
                  );
                })}
                <td
                  className="rounded-[5px] px-1.5 py-1.5 text-right font-semibold text-ink"
                  style={yr ? cellStyle(yr.ret, 0.4) : undefined}
                >
                  {yr ? pct(yr.ret, 1) : ""}
                </td>
                <td className="px-1.5 py-1.5 text-right text-muted">
                  {yr ? pct(yr.bench, 1) : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-2 flex items-center gap-2 text-2xs text-muted">
        <span className="inline-flex items-center gap-1">
          <span className="size-2.5 rounded-[3px] bg-up/45" />涨
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-2.5 rounded-[3px] bg-(--neg)/45" />跌
        </span>
        <span>颜色越深幅度越大；格子里是实际涨跌，悬停看同月基准。</span>
      </div>
    </div>
  );
}

/** 盈亏横条：长度 = 金额，正红负蓝，数字带符号放在条外 */
export function PnlBars({
  rows,
  format,
}: {
  rows: Array<{ label: string; sub?: string; value: number }>;
  format: (v: number) => string;
}) {
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li
          key={r.label}
          className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-xs"
        >
          <span className="truncate text-ink-2" title={r.label}>
            {r.label}
            {r.sub && <span className="ml-1.5 font-mono text-[10.5px] text-muted">{r.sub}</span>}
          </span>
          <span className="relative h-2">
            <span
              className="absolute top-0 left-0 h-2 rounded-r-[3px] rounded-l-[1px]"
              style={{
                width: `${Math.max((Math.abs(r.value) / max) * 100, 1.5)}%`,
                background: r.value >= 0 ? "var(--up)" : "var(--neg)",
                opacity: 0.8,
              }}
            />
          </span>
          <span
            className={cx(
              "tabular min-w-16 text-right font-medium",
              r.value >= 0 ? "text-up" : "text-ink-2",
            )}
          >
            {format(r.value)}
          </span>
        </li>
      ))}
    </ul>
  );
}

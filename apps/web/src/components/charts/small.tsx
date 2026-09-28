/**
 * 小图：迷你曲线（SVG）、月度收益表（红涨蓝跌的发散色格子 + 数字，本身就是表格视图）、
 * 盈亏条（HTML 横条，正负两色 + 符号）、参数扫描柱。
 */
import { useMemo } from "react";
import { pct } from "../../lib/format.ts";
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
  const path = useMemo(() => {
    const xs = values.filter((v) => Number.isFinite(v));
    if (xs.length < 2) return "";
    const min = Math.min(...xs);
    const max = Math.max(...xs);
    const span = max - min || 1;
    return xs
      .map(
        (v, i) =>
          `${i ? "L" : "M"}${((i / (xs.length - 1)) * (width - 4) + 2).toFixed(1)},${(height - 3 - ((v - min) / span) * (height - 6)).toFixed(1)}`,
      )
      .join(" ");
  }, [values, width, height]);
  if (!path) return <span className="text-xs text-muted">—</span>;
  return (
    <svg width={width} height={height} aria-hidden="true">
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 发散色：正（涨）红、负（跌）蓝，中间灰；按 ±cap 截断 */
function cellStyle(v: number, cap = 0.1): React.CSSProperties {
  if (!Number.isFinite(v)) return {};
  const a = Math.min(Math.abs(v) / cap, 1);
  const color = v >= 0 ? "208, 59, 59" : "42, 120, 214";
  return { background: `rgba(${color}, ${0.08 + a * 0.42})` };
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
    <div className="overflow-x-auto">
      <table className="tabular w-full min-w-[720px] border-separate border-spacing-[2px] text-xs">
        <thead>
          <tr className="text-muted">
            <th className="px-1 py-1 text-left font-normal">年份</th>
            {Array.from({ length: 12 }, (_, i) => (
              <th key={i} className="px-1 py-1 text-right font-normal">
                {i + 1}月
              </th>
            ))}
            <th className="px-1 py-1 text-right font-normal">全年</th>
            <th className="px-1 py-1 text-right font-normal">基准</th>
          </tr>
        </thead>
        <tbody>
          {years.map((y) => {
            const yr = yearly.find((r) => r.year === y);
            return (
              <tr key={y}>
                <td className="px-1 py-1 text-ink-2">{y}</td>
                {Array.from({ length: 12 }, (_, i) => {
                  const m = byKey.get(`${y}-${String(i + 1).padStart(2, "0")}`);
                  return (
                    <td
                      key={i}
                      className="rounded px-1 py-1 text-right text-ink"
                      style={m ? cellStyle(m.ret) : undefined}
                      title={m ? `基准 ${pct(m.bench)}` : undefined}
                    >
                      {m ? pct(m.ret, 1) : ""}
                    </td>
                  );
                })}
                <td
                  className="rounded px-1 py-1 text-right font-medium text-ink"
                  style={yr ? cellStyle(yr.ret, 0.4) : undefined}
                >
                  {yr ? pct(yr.ret, 1) : ""}
                </td>
                <td className="px-1 py-1 text-right text-ink-2">{yr ? pct(yr.bench, 1) : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-1 text-[11px] text-muted">
        格子颜色：红 = 涨、蓝 = 跌，越深幅度越大；数字即实际涨跌。
      </p>
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
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li
          key={r.label}
          className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-xs"
        >
          <span className="truncate text-ink-2" title={r.label}>
            {r.label}
            {r.sub && <span className="ml-1 text-muted">{r.sub}</span>}
          </span>
          <span className="relative h-2.5">
            <span
              className="absolute top-0 h-2.5 rounded-r-[4px]"
              style={{
                left: 0,
                width: `${(Math.abs(r.value) / max) * 100}%`,
                background: r.value >= 0 ? "var(--up)" : "var(--series-1)",
                opacity: 0.85,
              }}
            />
          </span>
          <span className={cx("tabular text-right", r.value >= 0 ? "text-up" : "text-ink-2")}>
            {format(r.value)}
          </span>
        </li>
      ))}
    </ul>
  );
}

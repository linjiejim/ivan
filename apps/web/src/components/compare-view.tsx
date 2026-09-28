/**
 * 回测对比（2–4 个）：指标表 + 净值叠加图（分类色按固定顺序 1–4，直接在线尾标名）。
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../lib/api.ts";
import { pct, tone } from "../lib/format.ts";
import type { RunSummary, SeriesPoint } from "../lib/types.ts";
import {
  axisStyle,
  EChart,
  esc,
  readTokens,
  tooltipStyle,
  useThemeVersion,
} from "./charts/echart.tsx";
import { ErrorNote, Spinner } from "./ui.tsx";

type CompareRow = RunSummary & { versionN: number | null; series: SeriesPoint[] };

export function CompareChart({ rows }: { rows: CompareRow[] }) {
  const themeV = useThemeVersion();
  const option = useMemo(() => {
    void themeV;
    const t = readTokens();
    const colors = [t.s1, t.s2, t.s3, t.s4];
    const dates = [...new Set(rows.flatMap((r) => r.series.map((p) => p.date)))].sort();
    const ax = axisStyle(t);
    return {
      animation: false,
      grid: { left: 8, right: 56, top: 28, bottom: 8, containLabel: true },
      legend: {
        top: 0,
        left: 0,
        icon: "path://M0,5 L20,5 L20,7 L0,7 Z",
        itemWidth: 16,
        itemHeight: 3,
        textStyle: { color: t.ink2, fontSize: 12 },
      },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: t.axis } },
        ...tooltipStyle(t),
        formatter: (
          ps: Array<{ axisValue: string; seriesName: string; value: number | null; color: string }>,
        ) =>
          `<div style="color:${t.muted};font-size:11px">${esc(ps[0]?.axisValue)}</div>` +
          ps
            .filter((p) => p.value !== null)
            .map(
              (p) =>
                `<div><span style="display:inline-block;width:12px;height:2px;background:${p.color};margin-right:6px;vertical-align:middle"></span><b>${Number(p.value).toFixed(3)}</b> <span style="color:${t.ink2}">${esc(p.seriesName)}</span></div>`,
            )
            .join(""),
      },
      xAxis: {
        type: "category",
        data: dates,
        boundaryGap: false,
        ...ax,
        splitLine: { show: false },
      },
      yAxis: { type: "value", scale: true, ...ax, axisLine: { show: false } },
      series: rows.map((r, i) => {
        const m = new Map(r.series.map((p) => [p.date, p.nav]));
        const name = `v${r.versionN ?? "?"} ${r.params.start.slice(0, 4)}–${r.params.end.slice(0, 4)}`;
        return {
          name,
          type: "line",
          showSymbol: false,
          connectNulls: true,
          data: dates.map((d) => m.get(d) ?? null),
          lineStyle: { width: 2, color: colors[i] },
          itemStyle: { color: colors[i] },
          endLabel: { show: true, formatter: () => name, color: t.ink, fontSize: 11 },
          emphasis: { disabled: true },
        };
      }),
    };
  }, [rows, themeV]);
  return <EChart option={option} height={260} />;
}

export function CompareTable({ rows }: { rows: CompareRow[] }) {
  const lines: Array<[string, (r: CompareRow) => number | null | undefined, boolean]> = [
    ["年化", (r) => r.headline?.cagr, true],
    ["年化超额", (r) => r.headline?.excessCagr, true],
    ["最大回撤", (r) => r.headline?.maxDrawdown, false],
    ["总收益", (r) => r.headline?.totalReturn, true],
  ];
  return (
    <table className="tabular w-full text-sm">
      <thead>
        <tr className="border-b border-line text-xs text-muted">
          <th className="py-2 text-left font-normal">指标</th>
          {rows.map((r) => (
            <th key={r.id} className="py-2 text-right font-normal">
              v{r.versionN ?? "?"}
              <div className="text-[11px]">
                {r.params.start}~{r.params.end}
              </div>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {lines.map(([label, get, signed]) => (
          <tr key={label} className="border-b border-line">
            <td className="py-1.5 text-ink-2">{label}</td>
            {rows.map((r) => (
              <td key={r.id} className={`py-1.5 text-right ${signed ? tone(get(r)) : ""}`}>
                {pct(get(r), 1, signed)}
              </td>
            ))}
          </tr>
        ))}
        <tr className="border-b border-line">
          <td className="py-1.5 text-ink-2">夏普</td>
          {rows.map((r) => (
            <td key={r.id} className="py-1.5 text-right">
              {r.headline?.sharpe.toFixed(2) ?? "—"}
            </td>
          ))}
        </tr>
        <tr>
          <td className="py-1.5 text-ink-2">提示</td>
          {rows.map((r) => (
            <td key={r.id} className="py-1.5 text-right text-xs text-warn">
              {r.checks
                .filter((c) => c.level === "warn")
                .map((c) => c.title)
                .join("、") || "—"}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

export function CompareView({ ids }: { ids: string[] }) {
  const q = useQuery({
    queryKey: ["compare", ...ids],
    queryFn: () => api.post<CompareRow[]>("/api/runs/compare", { ids }),
  });
  if (q.isLoading) return <Spinner />;
  if (!q.data) return <ErrorNote error={q.error} />;
  return (
    <div className="space-y-4">
      <CompareChart rows={q.data} />
      <CompareTable rows={q.data} />
    </div>
  );
}

/**
 * 回测对比（2–4 个）：指标表 + 净值叠加图（分类色按固定顺序 1–4，直接在线尾标名）。
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../lib/api.ts";
import { NA, pct, tone } from "../lib/format.ts";
import type { RunSummary, SeriesPoint } from "../lib/types.ts";
import {
  axisStyle,
  EChart,
  readTokens,
  tipHead,
  tipRow,
  tooltipStyle,
  useThemeVersion,
} from "./charts/echart.tsx";
import { cx, DataTable, ErrorNote, SeriesDot, Skeleton, Td, Th } from "./ui.tsx";

type CompareRow = RunSummary & { versionN: number | null; series: SeriesPoint[] };

const SLOTS = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)"];

function seriesName(r: CompareRow): string {
  return `v${r.versionN ?? "?"} ${r.params.start.slice(0, 4)}-${r.params.end.slice(0, 4)}`;
}

export function CompareChart({ rows }: { rows: CompareRow[] }) {
  const themeV = useThemeVersion();
  const option = useMemo(() => {
    void themeV;
    const t = readTokens();
    const colors = [t.s1, t.s2, t.s3, t.s4];
    const dates = [...new Set(rows.flatMap((r) => r.series.map((p) => p.date)))].sort();
    const ax = axisStyle(t);
    // 版本号各不相同时线尾只标「v2」（完整名字在图例里），省出画图的宽度；否则标全名
    const distinct = new Set(rows.map((r) => r.versionN)).size === rows.length;
    const tail = (r: CompareRow) => (distinct ? `v${r.versionN ?? "?"}` : seriesName(r));
    return {
      animation: false,
      grid: { left: 8, right: distinct ? 36 : 96, top: 30, bottom: 8, containLabel: true },
      legend: {
        top: 0,
        left: 0,
        icon: "path://M0,5 L20,5 L20,7 L0,7 Z",
        itemWidth: 14,
        itemHeight: 3,
        itemGap: 16,
        textStyle: { color: t.ink2, fontSize: 12 },
      },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: t.axis } },
        ...tooltipStyle(t),
        formatter: (
          ps: Array<{ axisValue: string; seriesName: string; value: number | null; color: string }>,
        ) =>
          tipHead(t, ps[0]?.axisValue ?? "") +
          ps
            .filter((p) => p.value !== null)
            .map((p) => tipRow(t, p.color, Number(p.value).toFixed(3), p.seriesName))
            .join(""),
      },
      xAxis: {
        type: "category",
        data: dates,
        boundaryGap: false,
        ...ax,
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        scale: true,
        ...ax,
        axisLine: { show: false },
        axisLabel: { ...ax.axisLabel, formatter: (v: number) => v.toFixed(2) },
      },
      series: rows.map((r, i) => {
        const m = new Map(r.series.map((p) => [p.date, p.nav]));
        const name = seriesName(r);
        return {
          name,
          type: "line",
          showSymbol: false,
          connectNulls: true,
          data: dates.map((d) => m.get(d) ?? null),
          lineStyle: { width: 2, color: colors[i] },
          itemStyle: { color: colors[i] },
          endLabel: { show: true, formatter: () => tail(r), color: t.ink, fontSize: 11 },
          labelLayout: { moveOverlap: "shiftY" },
          emphasis: { disabled: true },
        };
      }),
    };
  }, [rows, themeV]);
  return <EChart option={option} height={280} />;
}

export function CompareTable({ rows }: { rows: CompareRow[] }) {
  const lines: Array<[string, (r: CompareRow) => number | null | undefined, boolean]> = [
    ["年化", (r) => r.headline?.cagr, true],
    ["年化超额", (r) => r.headline?.excessCagr, true],
    ["最大回撤", (r) => r.headline?.maxDrawdown, false],
    ["总收益", (r) => r.headline?.totalReturn, true],
  ];
  return (
    <DataTable>
      <thead>
        <tr>
          <Th>指标</Th>
          {rows.map((r, i) => (
            <Th key={r.id} align="right">
              <span className="inline-flex items-center gap-1.5 font-medium text-ink-2">
                <SeriesDot color={SLOTS[i]} />v{r.versionN ?? "?"}
              </span>
              <div className="font-mono text-[10.5px]">
                {r.params.start} ~ {r.params.end}
              </div>
            </Th>
          ))}
        </tr>
      </thead>
      <tbody>
        {lines.map(([label, get, signed]) => (
          <tr key={label}>
            <Td className="text-ink-2">{label}</Td>
            {rows.map((r) => (
              <Td
                key={r.id}
                align="right"
                className={cx(
                  signed ? tone(get(r)) : "text-ink",
                  label === "年化超额" && "font-medium",
                )}
              >
                {pct(get(r), 1, signed)}
              </Td>
            ))}
          </tr>
        ))}
        <tr>
          <Td className="text-ink-2">夏普</Td>
          {rows.map((r) => (
            <Td key={r.id} align="right" className="text-ink">
              {r.headline?.sharpe.toFixed(2) ?? NA}
            </Td>
          ))}
        </tr>
        <tr>
          <Td className="text-ink-2">提示</Td>
          {rows.map((r) => {
            const warns = r.checks.filter((c) => c.level === "warn").map((c) => c.title);
            return (
              <Td
                key={r.id}
                align="right"
                className={cx("text-xs", warns.length ? "text-warn" : "text-muted")}
              >
                {warns.join("、") || NA}
              </Td>
            );
          })}
        </tr>
      </tbody>
    </DataTable>
  );
}

export function CompareView({ ids }: { ids: string[] }) {
  const q = useQuery({
    queryKey: ["compare", ...ids],
    queryFn: () => api.post<CompareRow[]>("/api/runs/compare", { ids }),
  });
  if (q.isLoading)
    return (
      <div className="space-y-4">
        <Skeleton className="h-[280px] w-full rounded-lg" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  if (!q.data) return <ErrorNote error={q.error} />;
  return (
    <div className="space-y-5">
      <CompareChart rows={q.data} />
      <CompareTable rows={q.data} />
    </div>
  );
}

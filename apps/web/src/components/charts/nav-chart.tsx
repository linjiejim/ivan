/**
 * 净值图（spec §11）：策略 vs 基准（强调策略、基准灰色作背景），可选「回测段 + 跟踪段」同一条曲线，
 * 三种视图：净值 / 超额 / 回撤。十字准线提示框列出同一天所有系列；可框选区间「问 AI」。
 */
import { MessageSquare } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { pct } from "../../lib/format.ts";
import { Button, cx } from "../ui.tsx";
import {
  axisStyle,
  EChart,
  type EChartsInstance,
  esc,
  readTokens,
  tooltipStyle,
  useThemeVersion,
} from "./echart.tsx";

export interface NavPoint {
  date: string;
  nav: number;
  bench: number;
}

type View = "nav" | "excess" | "drawdown";

export function NavChart({
  points,
  splitDate,
  benchLabel = "基准",
  strategyLabel = "策略",
  height = 280,
  onAsk,
  defaultView = "nav",
}: {
  points: NavPoint[];
  /** 从这天起是向前跟踪（换色 + 竖线） */
  splitDate?: string;
  benchLabel?: string;
  strategyLabel?: string;
  height?: number;
  onAsk?: (range: { from: string; to: string }) => void;
  defaultView?: View;
}) {
  const [view, setView] = useState<View>(defaultView);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const themeV = useThemeVersion();
  const chartRef = useRef<EChartsInstance | null>(null);

  const option = useMemo(() => {
    void themeV;
    const t = readTokens();
    const dates = points.map((p) => p.date);
    const splitIdx = splitDate ? dates.findIndex((d) => d >= splitDate) : -1;
    let strat: number[];
    let bench: number[] | null = null;
    if (view === "nav") {
      strat = points.map((p) => p.nav);
      bench = points.map((p) => p.bench);
    } else if (view === "excess") {
      strat = points.map((p) => p.nav / p.bench - 1);
    } else {
      let peak = -Infinity;
      strat = points.map((p) => {
        peak = Math.max(peak, p.nav);
        return p.nav / peak - 1;
      });
    }
    const fmtY = (v: number) => (view === "nav" ? v.toFixed(2) : pct(v, 0, false));
    // 回测段 / 跟踪段拆成两条线（跟踪段从分界前一天接上，保证连续）
    const back = splitIdx > 0 ? strat.map((v, i) => (i <= splitIdx ? v : null)) : strat;
    const fwd = splitIdx > 0 ? strat.map((v, i) => (i >= splitIdx - 1 ? v : null)) : null;
    const series: object[] = [];
    if (bench) {
      series.push({
        name: benchLabel,
        type: "line",
        data: bench,
        showSymbol: false,
        lineStyle: { width: 2, color: t.bench, cap: "round", join: "round" },
        itemStyle: { color: t.bench },
        endLabel: { show: true, formatter: () => benchLabel, color: t.ink2, fontSize: 11 },
        emphasis: { disabled: true },
        z: 1,
      });
    }
    series.push({
      name: fwd ? "回测" : strategyLabel,
      type: "line",
      data: back,
      showSymbol: false,
      lineStyle: { width: 2, color: t.s1, cap: "round", join: "round" },
      itemStyle: { color: t.s1 },
      areaStyle: view === "drawdown" ? { color: t.wash } : undefined,
      endLabel: fwd
        ? undefined
        : { show: true, formatter: () => strategyLabel, color: t.ink, fontSize: 11 },
      emphasis: { disabled: true },
      markLine:
        view !== "nav"
          ? {
              silent: true,
              symbol: "none",
              lineStyle: { color: t.axis, type: "solid", width: 1 },
              label: { show: false },
              data: [{ yAxis: 0 }],
            }
          : undefined,
      z: 2,
    });
    if (fwd) {
      series.push({
        name: "跟踪",
        type: "line",
        data: fwd,
        showSymbol: false,
        lineStyle: { width: 2, color: t.s2, cap: "round", join: "round" },
        itemStyle: { color: t.s2 },
        areaStyle: view === "drawdown" ? { color: t.wash } : undefined,
        endLabel: { show: true, formatter: () => "跟踪", color: t.ink, fontSize: 11 },
        emphasis: { disabled: true },
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: t.axis, type: "solid", width: 1 },
          label: {
            show: true,
            formatter: "上线",
            color: t.muted,
            fontSize: 11,
            position: "insideEndTop",
          },
          data: [{ xAxis: splitIdx }],
        },
        z: 3,
      });
    }
    const ax = axisStyle(t);
    return {
      animation: false,
      grid: { left: 8, right: 64, top: 28, bottom: 8, containLabel: true },
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
        axisPointer: { type: "line", lineStyle: { color: t.axis, width: 1 } },
        ...tooltipStyle(t),
        formatter: (
          params: Array<{
            axisValue: string;
            seriesName: string;
            value: number | null;
            color: string;
          }>,
        ) => {
          const rows = params
            .filter((p) => p.value !== null && p.value !== undefined)
            .filter((p, i, arr) => arr.findIndex((q) => q.seriesName === p.seriesName) === i)
            .map(
              (p) =>
                `<div style="display:flex;align-items:center;gap:8px;margin-top:2px">` +
                `<span style="display:inline-block;width:12px;height:2px;background:${p.color}"></span>` +
                `<b style="min-width:56px">${esc(fmtY(p.value as number))}</b>` +
                `<span style="color:${t.ink2}">${esc(p.seriesName)}</span></div>`,
            )
            .join("");
          return `<div style="color:${t.muted};font-size:11px">${esc(params[0]?.axisValue)}</div>${rows}`;
        },
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
        scale: view === "nav",
        ...ax,
        axisLine: { show: false },
        axisLabel: { ...ax.axisLabel, formatter: fmtY },
      },
      brush: onAsk
        ? {
            xAxisIndex: 0,
            brushType: "lineX",
            brushMode: "single",
            throttleType: "debounce",
            brushStyle: { color: t.wash, borderColor: t.s1, borderWidth: 1 },
            outOfBrush: { colorAlpha: 1 },
          }
        : undefined,
      toolbox: onAsk ? { show: false } : undefined,
      series,
    };
  }, [points, splitDate, benchLabel, strategyLabel, view, themeV, onAsk]);

  const onReady = useCallback(
    (chart: EChartsInstance) => {
      chartRef.current = chart;
      if (!onAsk) return;
      chart.off("brushEnd");
      chart.on("brushEnd", (e: unknown) => {
        const area = (e as { areas?: Array<{ coordRange?: [number, number] }> }).areas?.[0];
        if (!area?.coordRange) return setRange(null);
        const [a, b] = area.coordRange;
        const from = points[Math.max(0, a)]?.date;
        const to = points[Math.min(points.length - 1, b)]?.date;
        if (from && to && from < to) setRange({ from, to });
      });
      chart.dispatchAction({
        type: "takeGlobalCursor",
        key: "brush",
        brushOption: { brushType: "lineX", brushMode: "single" },
      });
    },
    [onAsk, points],
  );

  if (!points.length) return <div className="py-10 text-center text-sm text-muted">还没有数据</div>;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex gap-1">
          {(["nav", "excess", "drawdown"] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cx(
                "rounded-md px-2 py-0.5 text-xs",
                view === v ? "bg-surface-2 font-medium text-ink" : "text-muted hover:text-ink",
              )}
            >
              {v === "nav" ? "净值" : v === "excess" ? "超额" : "回撤"}
            </button>
          ))}
        </div>
        {onAsk && (
          <div className="flex items-center gap-2 text-xs text-muted">
            {range ? (
              <>
                <span>
                  已选 {range.from} ~ {range.to}
                </span>
                <Button size="sm" variant="primary" onClick={() => onAsk(range)}>
                  <MessageSquare className="size-3.5" />问 AI 这段
                </Button>
                <button
                  className="hover:text-ink"
                  onClick={() => {
                    chartRef.current?.dispatchAction({ type: "brush", areas: [] });
                    setRange(null);
                  }}
                >
                  清除
                </button>
              </>
            ) : null}
          </div>
        )}
      </div>
      <EChart option={option} height={height} onReady={onReady} />
    </div>
  );
}

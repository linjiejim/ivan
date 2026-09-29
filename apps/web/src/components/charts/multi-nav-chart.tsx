/**
 * 看板多策略对照图（D44）：每个策略一种颜色（跟着策略走，不跟排名走）；淡色 = 上线前的回测，
 * 实色 = 上线后的跟踪；灰线 = 基准（含分红），不同市场各一条。
 * 三种视图：累计收益 / 超额（相对各自的基准）/ 回撤；「含回测 / 只看跟踪」切换起算点。
 * 只选一个策略时标出上线日；可以框选一段问 AI。
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { pct } from "../../lib/format.ts";
import {
  type MultiRange,
  type MultiView,
  prepareMulti,
  type StrategyLine,
  valueAt,
} from "../../lib/multi-series.ts";
import { Segmented, useMediaQuery } from "../ui.tsx";
import { BrushBar } from "./brush-bar.tsx";
import {
  axisStyle,
  EChart,
  type EChartsInstance,
  readTokens,
  tipHead,
  tipRow,
  type Tokens,
  tooltipStyle,
  useThemeVersion,
} from "./echart.tsx";

/** 一张图最多同时对照几个策略：6 个颜色槽（绿、红留给涨跌，不做策略色） */
export const MAX_LINES = 6;

/** CSS 里用的策略色（列表圆点、选择按钮），和图里的线同一套 */
export const SLOT_VARS = [1, 2, 3, 4, 5, 6].map((i) => `var(--series-${i})`);

function slotColor(t: Tokens, slot: number): string {
  return [t.s1, t.s2, t.s3, t.s4, t.s5, t.s6][slot] ?? t.muted;
}

const VIEWS: Array<[MultiView, string]> = [
  ["nav", "累计收益"],
  ["excess", "超额"],
  ["drawdown", "回撤"],
];
const RANGES: Array<[MultiRange, string]> = [
  ["all", "含回测"],
  ["tracking", "只看跟踪"],
];

export function MultiNavChart({
  lines,
  height = 280,
  onAsk,
}: {
  lines: StrategyLine[];
  height?: number;
  onAsk?: (range: { from: string; to: string }) => void;
}) {
  const [view, setView] = useState<MultiView>("nav");
  const [range, setRange] = useState<MultiRange>("all");
  const [brushed, setBrushed] = useState<{ from: string; to: string } | null>(null);
  const themeV = useThemeVersion();
  const chartRef = useRef<EChartsInstance | null>(null);
  const prepared = useMemo(() => prepareMulti(lines, view, range), [lines, view, range]);
  const single = prepared.series.length === 1;
  // 手机上线尾名字会挤掉一大块画图区：窄屏不标，靠上面带色点的选择按钮当图例
  const narrow = useMediaQuery("(max-width: 639px)");

  const option = useMemo(() => {
    void themeV;
    const t = readTokens();
    const ax = axisStyle(t);
    const { dates, series, benches } = prepared;
    // 4 条以内直接在线尾标名字（dataviz：≤4 条直接标注），再多就靠上面的选择按钮和提示框
    const labels = series.length <= 4 && !narrow;
    const short = (s: string, n = 7) => (s.length > n ? `${s.slice(0, n)}…` : s);
    const out: object[] = [];
    benches.forEach((b, i) =>
      out.push({
        name: b.label,
        type: "line",
        data: b.values,
        connectNulls: true,
        showSymbol: false,
        lineStyle: { width: 1.5, color: t.bench, type: i === 0 ? "solid" : "dashed" },
        itemStyle: { color: t.bench },
        endLabel: {
          show: !narrow,
          formatter: () => short(b.label.replace(/（.*）/, ""), 8),
          color: t.muted,
          fontSize: 11,
        },
        labelLayout: { moveOverlap: "shiftY" },
        emphasis: { disabled: true },
        z: 1,
      }),
    );
    series.forEach((s, i) => {
      const color = slotColor(t, s.slot);
      const tracked = s.tracking.some((v) => v !== null);
      const endLabel = labels
        ? { show: true, formatter: () => short(s.name), color: t.ink, fontSize: 11 }
        : undefined;
      out.push({
        name: s.name,
        type: "line",
        data: s.backtest,
        connectNulls: true,
        showSymbol: false,
        lineStyle: { width: 2, color, opacity: 0.4 },
        itemStyle: { color },
        endLabel: tracked ? undefined : endLabel,
        labelLayout: { moveOverlap: "shiftY" },
        emphasis: { disabled: true },
        markLine:
          i === 0 && view === "excess"
            ? {
                silent: true,
                symbol: "none",
                lineStyle: { color: t.axis, type: "solid", width: 1 },
                label: {
                  show: true,
                  formatter: "基准",
                  color: t.muted,
                  fontSize: 11,
                  position: "insideStartTop",
                },
                data: [{ yAxis: 0 }],
              }
            : undefined,
        z: 2,
      });
      if (!tracked) return;
      out.push({
        name: s.name,
        type: "line",
        data: s.tracking,
        connectNulls: true,
        showSymbol: false,
        lineStyle: { width: 2.25, color },
        itemStyle: { color },
        endLabel,
        // 线尾名字挨得近时上下错开，不叠在一起
        labelLayout: { moveOverlap: "shiftY" },
        emphasis: { disabled: true },
        markPoint:
          s.goLive && !single
            ? {
                silent: true,
                symbol: "circle",
                symbolSize: 7,
                label: { show: false },
                itemStyle: { color, borderColor: t.surface, borderWidth: 1.5 },
                data: [{ coord: [s.goLive.index, s.goLive.value] }],
              }
            : undefined,
        markLine:
          s.goLive && single
            ? {
                silent: true,
                symbol: "none",
                lineStyle: { color: t.axis, type: "solid", width: 1 },
                label: {
                  show: true,
                  formatter: "上线",
                  color: t.ink2,
                  fontSize: 11,
                  fontWeight: 500,
                  // 竖线的标签横着写在顶端，不跟着线转 90°
                  position: "end",
                  distance: 6,
                },
                data: [{ xAxis: s.goLive.index }],
              }
            : undefined,
        z: 3,
      });
    });
    return {
      animation: false,
      grid: {
        left: 8,
        right: labels ? 84 : 40,
        top: single ? 26 : 12,
        bottom: 8,
        containLabel: true,
      },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: t.axis, width: 1 } },
        ...tooltipStyle(t),
        formatter: (params: Array<{ dataIndex: number }>) => {
          const i = params[0]?.dataIndex ?? 0;
          const rows = series.map((s) => {
            const v = valueAt(s.tracking, i) ?? valueAt(s.backtest, i);
            if (v === null) return "";
            const live = !!s.goLive && i > s.goLive.index;
            const tag = s.goLive ? (live ? "跟踪" : "回测") : "";
            return tipRow(t, slotColor(t, s.slot), pct(v), s.name, {
              tag,
              faded: !!s.goLive && !live,
            });
          });
          const bench = benches.map((b, k) => {
            const v = valueAt(b.values, i);
            return v === null ? "" : tipRow(t, t.bench, pct(v), b.label, { dash: k > 0 });
          });
          return tipHead(t, dates[i] ?? "") + rows.join("") + bench.join("");
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
        ...ax,
        axisLine: { show: false },
        axisLabel: { ...ax.axisLabel, formatter: (v: number) => pct(v, 0) },
      },
      brush: onAsk
        ? {
            xAxisIndex: 0,
            brushType: "lineX",
            brushMode: "single",
            throttleType: "debounce",
            brushStyle: { color: t.wash, borderColor: t.accent, borderWidth: 1 },
            outOfBrush: { colorAlpha: 1 },
          }
        : undefined,
      toolbox: onAsk ? { show: false } : undefined,
      series: out,
    };
  }, [prepared, view, single, narrow, themeV, onAsk]);

  const onReady = useCallback(
    (chart: EChartsInstance) => {
      chartRef.current = chart;
      if (!onAsk) return;
      chart.off("brushEnd");
      chart.on("brushEnd", (e: unknown) => {
        const area = (e as { areas?: Array<{ coordRange?: [number, number] }> }).areas?.[0];
        if (!area?.coordRange) return setBrushed(null);
        const [a, b] = area.coordRange;
        const from = prepared.dates[Math.max(0, a)];
        const to = prepared.dates[Math.min(prepared.dates.length - 1, b)];
        if (from && to && from < to) setBrushed({ from, to });
      });
      chart.dispatchAction({
        type: "takeGlobalCursor",
        key: "brush",
        brushOption: { brushType: "lineX", brushMode: "single" },
      });
    },
    [onAsk, prepared],
  );

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented label="视图" items={VIEWS} value={view} onChange={setView} />
          <Segmented label="起算点" items={RANGES} value={range} onChange={setRange} />
        </div>
        {onAsk && (
          <BrushBar
            range={brushed}
            onAsk={() => brushed && onAsk(brushed)}
            onClear={() => {
              chartRef.current?.dispatchAction({ type: "brush", areas: [] });
              setBrushed(null);
            }}
          />
        )}
      </div>
      {prepared.dates.length ? (
        <>
          <EChart option={option} height={height} onReady={onReady} className="cursor-crosshair" />
          {narrow && prepared.benches.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-muted">
              {prepared.benches.map((b, i) => (
                <span key={b.label} className="inline-flex items-center gap-1">
                  <span
                    aria-hidden
                    className="inline-block w-3.5"
                    style={{ borderTop: `1.5px ${i ? "dashed" : "solid"} var(--bench)` }}
                  />
                  {b.label}
                </span>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="py-12 text-center text-sm text-muted">
          {range === "tracking" ? "选中的策略还没有跟踪数据" : "还没有数据"}
        </div>
      )}
    </div>
  );
}

/**
 * ECharts 薄封装：按需引入、随容器缩放、跟随明暗主题（颜色从 CSS 变量读，主题切换时重绘）。
 */
import { BarChart, LineChart } from "echarts/charts";
import {
  BrushComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  ToolboxComponent,
  TooltipComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { LabelLayout } from "echarts/features";
import { SVGRenderer } from "echarts/renderers";
import { useEffect, useRef, useState } from "react";

echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  MarkAreaComponent,
  BrushComponent,
  ToolboxComponent,
  // 线尾名字挨得近时上下错开（labelLayout.moveOverlap）
  LabelLayout,
  SVGRenderer,
]);

export type EChartsOption = echarts.EChartsCoreOption;
export type EChartsInstance = echarts.ECharts;

export interface Tokens {
  surface: string;
  ink: string;
  ink2: string;
  muted: string;
  grid: string;
  axis: string;
  s1: string;
  s2: string;
  s3: string;
  s4: string;
  s5: string;
  s6: string;
  bench: string;
  up: string;
  down: string;
  wash: string;
}

export function readTokens(): Tokens {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    surface: v("--surface"),
    ink: v("--ink"),
    ink2: v("--ink-2"),
    muted: v("--muted"),
    grid: v("--grid"),
    axis: v("--axis"),
    s1: v("--series-1"),
    s2: v("--series-2"),
    s3: v("--series-3"),
    s4: v("--series-4"),
    s5: v("--series-5"),
    s6: v("--series-6"),
    bench: v("--bench"),
    up: v("--up"),
    down: v("--down"),
    wash: v("--wash"),
  };
}

/** 主题变化（系统深浅色或手动切换）时返回新的计数，用来触发重绘 */
export function useThemeVersion(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const bump = () => setN((x) => x + 1);
    mq.addEventListener("change", bump);
    const mo = new MutationObserver(bump);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mq.removeEventListener("change", bump);
      mo.disconnect();
    };
  }, []);
  return n;
}

export function EChart({
  option,
  height,
  onReady,
  className,
}: {
  option: EChartsOption;
  height: number;
  onReady?: (chart: EChartsInstance) => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsInstance | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: "svg" });
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.setOption(option, { notMerge: true });
    onReady?.(chart);
  }, [option, onReady]);
  return <div ref={ref} className={className} style={{ height, width: "100%" }} />;
}

/** 提示框里的文字一律转义（系列名可能来自用户输入） */
export function esc(s: unknown): string {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** 轴与网格：细线、实线、退后 */
export function axisStyle(t: Tokens) {
  return {
    axisLine: { lineStyle: { color: t.axis, width: 1 } },
    axisTick: { show: false },
    axisLabel: { color: t.muted, fontSize: 11 },
    splitLine: { lineStyle: { color: t.grid, width: 1, type: "solid" as const } },
  };
}

export function tooltipStyle(t: Tokens) {
  return {
    backgroundColor: t.surface,
    borderColor: t.grid,
    borderWidth: 1,
    padding: [8, 10],
    textStyle: { color: t.ink, fontSize: 12 },
    extraCssText: "box-shadow: 0 4px 16px rgba(0,0,0,0.08); border-radius: 8px;",
  };
}

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
import { LabelLayout, LegacyGridContainLabel } from "echarts/features";
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
  // 各图的 grid 都用 containLabel 留出坐标轴文字（ECharts 6 起要显式引入，否则控制台报弃用）
  LegacyGridContainLabel,
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
  neg: string;
  wash: string;
  accent: string;
  line: string;
}

/** 图里的字：正文走 Geist + 系统黑体，坐标轴数字走 Geist Mono（和界面同一套字） */
export const CHART_FONT = `"Geist Variable", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`;
export const CHART_MONO = `"Geist Mono Variable", "SF Mono", ui-monospace, monospace`;

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
    neg: v("--neg"),
    wash: v("--wash"),
    accent: v("--accent"),
    line: v("--line-strong"),
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
    chart.setOption({ textStyle: { fontFamily: CHART_FONT }, ...option }, { notMerge: true });
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
    axisLabel: { color: t.muted, fontSize: 10.5, fontFamily: CHART_MONO },
    splitLine: { lineStyle: { color: t.grid, width: 1, type: "solid" as const } },
  };
}

/** 提示框：和界面上的浮层同一种质感（纸色底、细边、带色调的阴影） */
export function tooltipStyle(t: Tokens) {
  return {
    backgroundColor: t.surface,
    borderColor: t.line,
    borderWidth: 1,
    padding: [9, 12],
    textStyle: { color: t.ink, fontSize: 12, fontFamily: CHART_FONT },
    extraCssText:
      "box-shadow: var(--elev-pop); border-radius: 10px; font-variant-numeric: tabular-nums;",
  };
}

/** 提示框里的一行：色标 + 数值 + 名字（dash = 第二条基准的虚线） */
export function tipRow(
  t: Tokens,
  color: string,
  value: string,
  name: string,
  opts: { tag?: string; dash?: boolean; faded?: boolean } = {},
): string {
  return (
    `<div style="display:flex;align-items:center;gap:8px;margin-top:3px">` +
    `<span style="display:inline-block;width:12px;height:0;border-top:2px ${opts.dash ? "dashed" : "solid"} ${color};opacity:${opts.faded ? 0.45 : 1}"></span>` +
    `<b style="min-width:54px;font-weight:600">${esc(value)}</b>` +
    `<span style="color:${t.ink2}">${esc(name)}</span>` +
    (opts.tag ? `<span style="color:${t.muted};font-size:11px">${esc(opts.tag)}</span>` : "") +
    `</div>`
  );
}

/** 提示框的日期抬头 */
export function tipHead(t: Tokens, text: string): string {
  return `<div style="color:${t.muted};font-size:11px;font-family:${CHART_MONO.replace(/"/g, "'")};margin-bottom:2px">${esc(text)}</div>`;
}

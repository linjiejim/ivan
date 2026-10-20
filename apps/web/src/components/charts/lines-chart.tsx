/**
 * 对话分析卡片的走势图（spec 20261020）：几条「归一到起点」的累计涨跌线放在一张图上（个股 vs 基准、多只对比）。
 * 时间轴按日期（A 股、港股交易日不同也能画在一起）；第一条线用强调色，基准用灰色，其余按系列色槽。
 */
import { useMemo } from "react";
import { pct } from "../../lib/format.ts";
import {
  axisStyle,
  EChart,
  readTokens,
  tipHead,
  tipRow,
  tooltipStyle,
  useThemeVersion,
} from "./echart.tsx";

export interface Line {
  name: string;
  /** 归一到起点 = 1 的值 */
  points: Array<{ d: string; v: number }>;
  /** 基准线：灰色、细一点 */
  bench?: boolean;
}

export function LinesChart({ lines, height = 200 }: { lines: Line[]; height?: number }) {
  const themeVersion = useThemeVersion();
  const option = useMemo(() => {
    void themeVersion;
    const t = readTokens();
    const slots = [t.s1, t.s2, t.s3, t.s4, t.s5, t.s6];
    let slot = 0;
    const ax = axisStyle(t);
    const series = lines.map((l) => {
      const color = l.bench ? t.bench : (slots[slot++ % slots.length] ?? t.s1);
      return {
        name: l.name,
        type: "line",
        data: l.points.map((p) => [p.d, p.v - 1]),
        showSymbol: false,
        connectNulls: true,
        lineStyle: { width: l.bench ? 1.5 : 2, color, cap: "round", join: "round" },
        itemStyle: { color },
        emphasis: { disabled: true },
        z: l.bench ? 1 : 2,
      };
    });
    return {
      animation: false,
      grid: { left: 8, right: 12, top: lines.length > 1 ? 28 : 10, bottom: 6, containLabel: true },
      legend:
        lines.length > 1
          ? {
              top: 0,
              left: 0,
              icon: "path://M0,5 L20,5 L20,7 L0,7 Z",
              itemWidth: 14,
              itemHeight: 3,
              itemGap: 14,
              textStyle: { color: t.ink2, fontSize: 11.5 },
            }
          : undefined,
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: t.axis, width: 1 } },
        ...tooltipStyle(t),
        formatter: (
          params: Array<{ seriesName: string; value: [string, number]; color: string }>,
        ) =>
          tipHead(t, params[0]?.value[0] ?? "") +
          params.map((p) => tipRow(t, p.color, pct(p.value[1], 1), p.seriesName)).join(""),
      },
      xAxis: { type: "time", ...ax, splitLine: { show: false } },
      yAxis: {
        type: "value",
        ...ax,
        axisLine: { show: false },
        axisLabel: { ...ax.axisLabel, formatter: (v: number) => pct(v, 0, false) },
      },
      // 0 线挂在第一条线上（单独一个空系列会在图例里多出一个没名字的项）
      series: series.map((x, i) =>
        i === 0
          ? {
              ...x,
              markLine: {
                silent: true,
                symbol: "none",
                lineStyle: { color: t.axis, type: "solid", width: 1 },
                label: { show: false },
                data: [{ yAxis: 0 }],
              },
            }
          : x,
      ),
    };
  }, [lines, themeVersion]);
  return <EChart option={option} height={height} />;
}

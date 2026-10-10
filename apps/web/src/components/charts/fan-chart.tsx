/**
 * 未来一年的净值区间（D65，设计系统 §11 的例外）：按历史日收益成段重抽样的 5–95、25–75 分位带，
 * 两条分位线之间低透明度填充、不从 0 起；中位数 2px 实线。按绝对净值（起点 1，不扣基准）。
 * 这是区间，不是预测；文案不说「盈利概率」。按需加载（run.tsx 里 lazy）。
 */
import { useMemo } from "react";
import { pct } from "../../lib/format.ts";
import type { Fan } from "../../lib/types.ts";
import {
  axisStyle,
  EChart,
  readTokens,
  tipHead,
  tipRow,
  tooltipStyle,
  useThemeVersion,
} from "./echart.tsx";

/** 分位带的填充透明度（§11：不超过 0.12） */
const OUTER_ALPHA = 0.07;
const INNER_ALPHA = 0.12;

export function FanChart({ fan, height = 260 }: { fan: Fan; height?: number }) {
  const themeV = useThemeVersion();
  const option = useMemo(() => {
    void themeV;
    const t = readTokens();
    const ax = axisStyle(t);
    // 起点（第 0 天）五条线都是 1
    const days = [0, ...fan.days];
    const at = (xs: number[]) => [1, ...xs];
    const p5 = at(fan.p5);
    const p25 = at(fan.p25);
    const p50 = at(fan.p50);
    const p75 = at(fan.p75);
    const p95 = at(fan.p95);
    const line = (name: string, data: number[], width: number, opacity: number) => ({
      name,
      type: "line",
      data,
      symbol: "none",
      lineStyle: { color: t.s1, width, opacity },
      emphasis: { disabled: true },
      z: 3,
    });
    // 分位带：下沿一条不画的基线，上面叠一层「上沿 − 下沿」并填色，填的只是两条线之间
    const band = (stack: string, lo: number[], hi: number[], alpha: number) => [
      {
        type: "line",
        stack,
        data: lo,
        symbol: "none",
        lineStyle: { opacity: 0 },
        silent: true,
        tooltip: { show: false },
      },
      {
        type: "line",
        stack,
        data: hi.map((v, i) => v - lo[i]!),
        symbol: "none",
        lineStyle: { opacity: 0 },
        areaStyle: { color: t.s1, opacity: alpha },
        silent: true,
        tooltip: { show: false },
      },
    ];
    return {
      animation: false,
      grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
      tooltip: {
        trigger: "axis",
        ...tooltipStyle(t),
        axisPointer: { type: "line", lineStyle: { color: t.axis } },
        formatter: (ps: Array<{ dataIndex: number }>) => {
          const i = ps[0]?.dataIndex ?? 0;
          const v = (x: number) => pct(x - 1);
          return (
            tipHead(t, `${days[i]} 个交易日后`) +
            tipRow(t, t.s1, v(p95[i]!), "95 分位", { faded: true }) +
            tipRow(t, t.s1, v(p75[i]!), "75 分位", { faded: true }) +
            tipRow(t, t.s1, v(p50[i]!), "中位数") +
            tipRow(t, t.s1, v(p25[i]!), "25 分位", { faded: true }) +
            tipRow(t, t.s1, v(p5[i]!), "5 分位", { faded: true })
          );
        },
      },
      xAxis: {
        type: "category",
        data: days,
        boundaryGap: false,
        ...ax,
        splitLine: { show: false },
        axisLabel: { ...ax.axisLabel, formatter: (d: string) => `${d} 天` },
      },
      yAxis: {
        type: "value",
        // 净值轴不从 0 起（§11）
        scale: true,
        ...ax,
        axisLine: { show: false },
        axisLabel: { ...ax.axisLabel, formatter: (x: number) => pct(x - 1, 0) },
      },
      series: [
        ...band("outer", p5, p95, OUTER_ALPHA),
        ...band("inner", p25, p75, INNER_ALPHA),
        line("5 分位", p5, 1, 0.35),
        line("95 分位", p95, 1, 0.35),
        line("中位数", p50, 2, 1),
      ],
    };
  }, [fan, themeV]);
  return (
    <figure>
      <figcaption className="mb-2 text-xs font-medium text-ink-2">
        未来一年的净值区间（按历史重抽样）
      </figcaption>
      <EChart option={option} height={height} />
      <p className="mt-2 text-xs text-muted">
        一年内最大回撤：中位数 <span className="tabular text-ink-2">{pct(fan.mdd.p50)}</span>
        ，较深的 5% 路径超过 <span className="tabular text-ink-2">{pct(fan.mdd.p5)}</span>
        。一年后净值低于起点的路径占{" "}
        <span className="tabular text-ink-2">{pct(fan.probLoss, 0, false)}</span>。 深色带是 25–75
        分位，浅色带是 5–95 分位，按绝对净值（不扣基准）。
        {fan.horizon < 243 && `回测不到一年，只画到 ${fan.horizon} 个交易日。`}
      </p>
    </figure>
  );
}

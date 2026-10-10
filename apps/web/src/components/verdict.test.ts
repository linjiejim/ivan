/**
 * 判词徽标与对话的跟踪卡（D70）：徽标始终有字、颜色按设计系统；跟踪卡读 beatBacktestPct（旧消息读 deviationPct）。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { TrackingCard, type TrackingOutput } from "../chat/cards.tsx";
import { VerdictBadge } from "./verdict.tsx";

describe("判词徽标", () => {
  it("正常 down、可能失效 warn 且有图标、观察期 neutral，都写字", () => {
    const ok = renderToStaticMarkup(createElement(VerdictBadge, { verdict: "ON_TRACK" }));
    expect(ok).toContain("正常");
    expect(ok).toContain("text-down");
    const decayed = renderToStaticMarkup(createElement(VerdictBadge, { verdict: "DECAYED" }));
    expect(decayed).toContain("可能失效");
    expect(decayed).toContain("text-warn");
    expect(decayed).toContain("<svg");
    const warm = renderToStaticMarkup(createElement(VerdictBadge, { verdict: "WARMING_UP" }));
    expect(warm).toContain("观察期");
    expect(warm).toContain("bg-surface-2");
  });
});

describe("对话的跟踪卡", () => {
  const output: TrackingOutput = {
    trackingId: "t_1",
    strategyName: "低估值",
    market: "A",
    startDate: "2026-08-03",
    days: 42,
    lastDate: "2026-09-30",
    excess: -0.021,
    beatBacktestPct: 3,
    verdict: "DRIFTING",
    health: {
      state: "monitoring",
      signal: "warning",
      perMetric: { beatBacktestPct: { value: 3, signal: "warning" } },
    },
    lastError: null,
  };
  const render = (o: TrackingOutput) =>
    renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(TrackingCard, { output: o })),
    );

  it("名字、判词、跟踪超额、跑赢回测同期、天数与去详情的链接", () => {
    const html = render(output);
    expect(html).toContain("「低估值」");
    expect(html).toContain("偏离");
    expect(html).toContain('<span class="figure-sign">-</span>2.1');
    expect(html).toContain("跑赢回测同期");
    // Figure 把单位拆进小号的 span
    expect(html).toContain('>3<span class="figure-unit">%');
    expect(html).toContain('>42<span class="figure-unit">天');
    expect(html).toContain('href="/trackings/t_1"');
  });

  it("早于 S10 的消息：没有判词，跑赢回测同期读 deviationPct", () => {
    const { beatBacktestPct: _, verdict: __, health: ___, ...old } = output;
    const html = render({ ...old, deviationPct: 18 });
    expect(html).toContain('>18<span class="figure-unit">%');
    expect(html).not.toContain("偏离");
  });
});

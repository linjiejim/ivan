/**
 * 上线第一晚按历史补算（D70）：已经落后很久的跟踪第一晚就是偏离或可能失效，不会先报几天正常。
 */
import type { SeriesPoint } from "@ivan/core";
import { describe, expect, it } from "vitest";
import { backfillHealth, maxDrawdownOf } from "./health.ts";
import { weekdays } from "./testing/fixtures.ts";

/** 基准回测：每天稳定跑赢基准 0.1%，任何窗口的超额都是正的 */
function baseline(days: number): SeriesPoint[] {
  const dates = weekdays("2020-01-01", days + 1);
  return dates.map((date, i) => ({
    date,
    nav: 1.002 ** i * (1 + 0.01 * Math.sin(i / 7)),
    bench: 1.001 ** i * (1 + 0.01 * Math.sin(i / 7)),
    cash: 0,
    positions: 10,
  }));
}

/** 跟踪：每天跑输基准，超额低于基准回测里每一个同长度窗口 */
function lagging(days: number): SeriesPoint[] {
  const dates = weekdays("2026-06-01", days + 1);
  return dates.map((date, i) => ({
    date,
    nav: 0.999 ** i,
    bench: 1.001 ** i,
    cash: 0,
    positions: 10,
  }));
}

describe("健康度补算", () => {
  it("60 天、超额低于每个基准窗口：补算到偏离或可能失效，从不经过正常", () => {
    const base = baseline(600);
    const track = lagging(60);
    const rows = backfillHealth(track, base, maxDrawdownOf(base));
    // 第 20 天起每天一行，最后一行是今晚
    expect(rows).toHaveLength(41);
    expect(rows[0]!.date).toBe(track[20]!.date);
    expect(rows.at(-1)!.date).toBe(track.at(-1)!.date);
    expect(rows.every((r) => r.inputs.backfilled)).toBe(true);
    expect(rows.some((r) => r.state === "active")).toBe(false);
    expect(["monitoring", "decayed"]).toContain(rows.at(-1)!.state);
    expect(rows.at(-1)!.state).toBe("decayed");
    expect(rows[0]!.perMetric.beatBacktestPct!.value).toBe(0);
  });

  it("不到 20 天：没有补算行", () => {
    const base = baseline(600);
    expect(backfillHealth(lagging(15), base, maxDrawdownOf(base))).toEqual([]);
  });
});

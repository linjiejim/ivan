import type { HealthReading, HealthState } from "@ivan/core";
import { describe, expect, it } from "vitest";
import { classify, transition, verdictOf, type VerdictInput } from "./health.ts";

const at = (beatBacktestPct: number | null, ddRatio?: number) =>
  classify({
    days: 30,
    beatBacktestPct,
    trackingMaxDD: ddRatio === undefined ? null : -ddRatio,
    baselineMaxDD: ddRatio === undefined ? null : -1,
  });

/** 从 prev 起按读数逐个走状态机，返回每一步之后的状态 */
function walk(prev: HealthState, readings: HealthReading[], before: HealthReading[] = []) {
  const history = [...before];
  const out: HealthState[] = [];
  let s = prev;
  for (const r of readings) {
    history.push(r);
    s = transition(s, history).next;
    out.push(s);
  }
  return out;
}

const H = "healthy" as const;
const W = "warning" as const;
const D = "decayed" as const;
const C = "critical" as const;
const I = "insufficient_data" as const;

describe("健康度分级（D70）", () => {
  it("跑赢回测同期：≥ 5 正常、≥ 1 注意、≥ 0.5 衰减、再低严重", () => {
    expect(at(5).signal).toBe("healthy");
    expect(at(4.99).signal).toBe("warning");
    expect(at(1).signal).toBe("warning");
    expect(at(0.99).signal).toBe("decayed");
    expect(at(0.5).signal).toBe("decayed");
    expect(at(0.49).signal).toBe("critical");
  });

  it("回撤比：≤ 1.2 正常、≤ 1.5 注意、≤ 2.0 衰减、再高严重；整体取最差", () => {
    expect(at(null, 1.2).signal).toBe("healthy");
    expect(at(null, 1.21).signal).toBe("warning");
    expect(at(null, 1.5).signal).toBe("warning");
    expect(at(null, 1.51).signal).toBe("decayed");
    expect(at(null, 2.0).signal).toBe("decayed");
    expect(at(null, 2.01).signal).toBe("critical");
    const r = at(50, 1.6);
    expect(r.signal).toBe("decayed");
    expect(r.perMetric.beatBacktestPct).toEqual({ value: 50, signal: "healthy" });
    expect(r.perMetric.ddRatio!.signal).toBe("decayed");
  });

  it("不足 20 天或没有可用指标：样本不足，从不算正常", () => {
    expect(
      classify({ days: 19, beatBacktestPct: 60, trackingMaxDD: 0, baselineMaxDD: -0.2 }).signal,
    ).toBe("insufficient_data");
    expect(
      classify({ days: 40, beatBacktestPct: null, trackingMaxDD: null, baselineMaxDD: null })
        .signal,
    ).toBe("insufficient_data");
    // 基准回测没有回撤：回撤比不可用
    expect(
      classify({ days: 40, beatBacktestPct: null, trackingMaxDD: -0.1, baselineMaxDD: 0 }).signal,
    ).toBe("insufficient_data");
  });
});

describe("健康状态机（滞回）", () => {
  it("观察期：第一个够样本的读数正常 → 正常；注意 → 偏离；样本不足时不动", () => {
    expect(walk("warming_up", [I, I])).toEqual(["warming_up", "warming_up"]);
    expect(walk("warming_up", [I, H])).toEqual(["warming_up", "active"]);
    expect(walk("warming_up", [W])).toEqual(["monitoring"]);
    expect(transition("warming_up", [I, W]).reason).toContain("不正常");
  });

  it("补算的历史里最近 5 个都是衰减或严重：观察期直接到可能失效", () => {
    expect(transition("warming_up", [D, C, D, D, D]).next).toBe("decayed");
    expect(transition("warming_up", [D, C, D, D]).next).toBe("monitoring");
  });

  it("正常：连续 5 个不正常在第 5 个时转偏离；正常与注意来回跳不转", () => {
    expect(walk("active", [W, D, W, C, W])).toEqual([
      "active",
      "active",
      "active",
      "active",
      "monitoring",
    ]);
    expect(walk("active", [H, W, H, W, H, W, H, W])).toEqual(new Array(8).fill("active"));
  });

  it("偏离：最新读数正常 → 正常；连续 5 个衰减或严重 → 可能失效", () => {
    expect(walk("monitoring", [H])).toEqual(["active"]);
    expect(walk("monitoring", [D, C, D, D, C])).toEqual([
      "monitoring",
      "monitoring",
      "monitoring",
      "monitoring",
      "decayed",
    ]);
    expect(walk("monitoring", [D, D, W, D, D])).toEqual(new Array(5).fill("monitoring"));
  });

  it("可能失效：连续 3 个正常或注意 → 偏离", () => {
    expect(walk("decayed", [H, W, H], [D, D, D, D, D])).toEqual([
      "decayed",
      "decayed",
      "monitoring",
    ]);
    expect(walk("decayed", [H, D, W], [D, D, D, D, D])).toEqual(["decayed", "decayed", "decayed"]);
  });
});

describe("判词", () => {
  const base: VerdictInput = {
    state: "active",
    lastDate: "2026-09-30",
    committedAsOf: "2026-09-30",
    settleError: null,
    marketDay: "traded",
    staleCodes: [],
  };

  it("按顺序：结算失败 > 数据未更新 > 状态", () => {
    expect(verdictOf(base)).toBe("ON_TRACK");
    expect(verdictOf({ ...base, state: "monitoring" })).toBe("DRIFTING");
    expect(verdictOf({ ...base, state: "decayed" })).toBe("DECAYED");
    expect(verdictOf({ ...base, state: "warming_up" })).toBe("WARMING_UP");
    expect(verdictOf({ ...base, state: "decayed", marketDay: "stale" })).toBe("STALE_DATA");
    expect(verdictOf({ ...base, committedAsOf: "2026-10-09" })).toBe("STALE_DATA");
    expect(verdictOf({ ...base, staleCodes: ["600001.SH"] })).toBe("STALE_DATA");
    expect(verdictOf({ ...base, marketDay: "stale", settleError: { date: "2026-09-30" } })).toBe(
      "SETTLE_FAILED",
    );
    // 休市、进行中都不算数据没更新；还没开始结算（没有 lastDate）也不算
    expect(verdictOf({ ...base, marketDay: "closed" })).toBe("ON_TRACK");
    expect(verdictOf({ ...base, marketDay: "pending" })).toBe("ON_TRACK");
    expect(verdictOf({ ...base, lastDate: null, state: "warming_up" })).toBe("WARMING_UP");
  });
});

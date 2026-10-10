/**
 * 健康度阈值的校准（D70）：阈值以这个测试为准。改 HEALTH_THRESHOLDS 必须让它保持通过，并加 HEALTH_VERSION。
 *
 * 20 条合成基准回测（mulberry32 种子 1..20，2000 天；策略日收益 0.0007 + 0.015·(0.85·zb + 0.527·ze)，
 * 基准 0.0003 + 0.013·zb）× 每条 10 个同分布的跟踪 × 250 天：
 * - 同分布的跟踪：够样本的读数里处在偏离或可能失效的占比 < 10%，可能失效 < 5%（误报率）；
 * - 均值减 0.0004（超额去掉）的跟踪：被标出的占比至少是同分布的 2 倍（检出率有限，ⓘ 里写明）。
 * 为了快，每条基准按窗口长度预先排好全部窗口超额，读数用二分查百分位（与 deviationPercentile 同一口径）。
 */
import type { HealthReading, HealthState, SeriesPoint } from "@ivan/core";
import { describe, expect, it } from "vitest";
import { windowExcesses } from "./deviation.ts";
import {
  backfillHealth,
  classify,
  HEALTH_THRESHOLDS,
  maxDrawdownOf,
  transition,
} from "./health.ts";
import { mulberry32 } from "./stats/prng.ts";

const BASE_DAYS = 2000;
const TRACK_DAYS = 250;
const PER_BASELINE = 10;

function gaussian(rand: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    while (u === 0) u = rand();
    const v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

/** 合成一段净值：nav[0] = bench[0] = 1；alphaCut 从策略日收益均值里减掉 */
function synth(seed: number, days: number, alphaCut = 0): SeriesPoint[] {
  const z = gaussian(mulberry32(seed));
  const out: SeriesPoint[] = [{ date: "d0", nav: 1, bench: 1, cash: 0, positions: 0 }];
  let nav = 1;
  let bench = 1;
  for (let t = 1; t <= days; t++) {
    const zb = z();
    const ze = z();
    nav *= 1 + 0.0007 - alphaCut + 0.015 * (0.85 * zb + 0.527 * ze);
    bench *= 1 + 0.0003 + 0.013 * zb;
    out.push({ date: `d${t}`, nav, bench, cash: 0, positions: 0 });
  }
  return out;
}

function lowerBound(xs: Float64Array, x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m]! < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

function upperBound(xs: Float64Array, x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m]! <= x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

interface Tally {
  sufficient: number;
  flagged: number;
  decayed: number;
  trackings: number;
  trackingsFlagged: number;
}

const tally = (): Tally => ({
  sufficient: 0,
  flagged: 0,
  decayed: 0,
  trackings: 0,
  trackingsFlagged: 0,
});

/** 走一遍跟踪的逐日读数与状态机，记进 tally；返回每天的状态 */
function run(
  track: SeriesPoint[],
  sorted: Float64Array[],
  baselineMaxDD: number,
  t: Tally,
): HealthState[] {
  const history: HealthReading[] = [];
  const states: HealthState[] = [];
  let state: HealthState = "warming_up";
  let any = false;
  for (let d = HEALTH_THRESHOLDS.minDays; d <= TRACK_DAYS; d++) {
    const p = track[d]!;
    const xs = sorted[d]!;
    const x = p.nav / p.bench - 1;
    const lo = lowerBound(xs, x);
    const eq = upperBound(xs, x) - lo;
    const pct = ((lo + eq / 2) / xs.length) * 100;
    const { signal } = classify({
      days: d,
      beatBacktestPct: pct,
      trackingMaxDD: maxDrawdownOf(track, d),
      baselineMaxDD,
    });
    history.push(signal);
    state = transition(state, history).next;
    states.push(state);
    if (signal === "insufficient_data") continue;
    t.sufficient++;
    if (state === "monitoring" || state === "decayed") {
      t.flagged++;
      any = true;
    }
    if (state === "decayed") t.decayed++;
  }
  t.trackings++;
  if (any) t.trackingsFlagged++;
  return states;
}

describe("健康度阈值校准（D70）", () => {
  it("同分布误报 < 10%（可能失效 < 5%）；超额去掉后被标出的占比至少翻倍", () => {
    const same = tally();
    const decay = tally();
    let crossChecked = false;
    for (let b = 1; b <= 20; b++) {
      const baseline = synth(b, BASE_DAYS);
      const baselineMaxDD = maxDrawdownOf(baseline);
      const sorted: Float64Array[] = [];
      for (let k = HEALTH_THRESHOLDS.minDays; k <= TRACK_DAYS; k++) {
        sorted[k] = Float64Array.from(windowExcesses(baseline, k)).sort();
      }
      for (let j = 1; j <= PER_BASELINE; j++) {
        const seed = 1000 * b + j;
        const track = synth(seed, TRACK_DAYS);
        const states = run(track, sorted, baselineMaxDD, same);
        run(synth(seed, TRACK_DAYS, 0.0004), sorted, baselineMaxDD, decay);
        // 快速路径与 backfillHealth（逐日调 deviationPercentile）同一口径
        if (!crossChecked) {
          const rows = backfillHealth(track, baseline, baselineMaxDD);
          expect(rows.map((r) => r.state)).toEqual(states);
          crossChecked = true;
        }
      }
    }
    const sameShare = same.flagged / same.sufficient;
    const sameDecayed = same.decayed / same.sufficient;
    const decayShare = decay.flagged / decay.sufficient;
    expect(same.sufficient).toBe(20 * PER_BASELINE * (TRACK_DAYS - HEALTH_THRESHOLDS.minDays + 1));
    expect(sameShare).toBeLessThan(0.1);
    expect(sameDecayed).toBeLessThan(0.05);
    expect(decayShare).toBeGreaterThanOrEqual(2 * sameShare);
    // 实测（HEALTH_VERSION 1）：同分布 7.6%（可能失效 3.2%）；超额去掉后 19%，一年内约一半的跟踪至少被标出一次
    expect(decay.trackingsFlagged / decay.trackings).toBeGreaterThan(0.3);
  });
});

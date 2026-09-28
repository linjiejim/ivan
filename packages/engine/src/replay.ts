import type { SeriesPoint } from "@ivan/core";

/**
 * 重放与已存历史天的对照（验收 4）：同一版本 + 同一数据，重放出的每一天应和上次存的完全一致。
 * 不一致只可能来自数据修订（全收益基准晚到、公司行动更正……），照常按最新数据改写，但记下来可查。
 */
export interface ReplayCheck {
  compared: number;
  /** 净值不一致的天数（含上次有、这次没有的日子） */
  navDrift: number;
  benchDrift: number;
  firstDrift: string | null;
  maxNavDiff: number;
}

export function compareReplay(
  stored: readonly { date: string; nav: number; bench: number }[],
  series: readonly SeriesPoint[],
): ReplayCheck {
  const byDate = new Map(series.map((p) => [p.date, p]));
  const r: ReplayCheck = {
    compared: 0,
    navDrift: 0,
    benchDrift: 0,
    firstDrift: null,
    maxNavDiff: 0,
  };
  for (const s of [...stored].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    r.compared++;
    const p = byDate.get(s.date);
    const dn = p ? Math.abs(p.nav - s.nav) : Infinity;
    const db = p ? Math.abs(p.bench - s.bench) : Infinity;
    if (dn > 1e-9) {
      r.navDrift++;
      if (p) r.maxNavDiff = Math.max(r.maxNavDiff, dn);
    }
    if (db > 1e-9) r.benchDrift++;
    if ((dn > 1e-9 || db > 1e-9) && !r.firstDrift) r.firstDrift = s.date;
  }
  return r;
}

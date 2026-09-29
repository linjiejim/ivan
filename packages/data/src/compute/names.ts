/**
 * 简称历史 → 点时 ST 判定（D21）。
 * - 深市：深交所官方简称变更记录（有变更前后简称），任意日期都能判定。
 * - 沪市：东财每日简称（2018 起，只记变化），更早返回 null，由调用方回退到年报连亏近似。
 */
import type { DateStr } from "@ivan/core";

export interface NameChange {
  date: DateStr;
  before: string | null;
  after: string | null;
  source: "szse" | "em_daily";
}

/** 风险警示：ST、*ST、SST，以及退市整理期的「退市××」。 */
export const ST_NAME_RE = /ST|退市|^退/i;

export function stResolver(
  code: string,
  changes: readonly NameChange[],
  currentName: string | null,
): (date: DateStr) => boolean | null {
  if (code.endsWith(".SZ")) {
    const cs = changes.filter((c) => c.source === "szse").sort(byDate);
    return (d) => {
      let name: string | null = null;
      for (const c of cs) {
        if (c.date <= d) name = c.after;
        else break;
      }
      if (name === null) name = cs.length ? cs[0]!.before : currentName;
      return name ? ST_NAME_RE.test(name) : false;
    };
  }
  const daily = changes.filter((c) => c.source === "em_daily").sort(byDate);
  if (!daily.length) return () => null;
  const first = daily[0]!.date;
  return (d) => {
    if (d < first) return null;
    let name: string | null = null;
    for (const c of daily) {
      if (c.date <= d) name = c.after;
      else break;
    }
    return name ? ST_NAME_RE.test(name) : null;
  };
}

function byDate(a: NameChange, b: NameChange): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
}

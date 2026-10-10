/**
 * 点时属性快照（D61）：区间的开、关、幂等、整批变化保护，以及点时读取。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Warehouse } from "../warehouse/db.ts";
import { attrAsOf, attrFirstDate, captureStatus, upsertSnapshot } from "./snapshots.ts";

let wh: Warehouse;
beforeEach(async () => {
  wh = await Warehouse.open(":memory:");
});
afterEach(() => wh.close());

const D1 = "2026-10-20";
const D2 = "2026-10-21";
const D3 = "2026-10-22";
const D4 = "2026-10-23";

/** 10 只股票的行业，覆盖默认值 */
function names(over: Record<string, string | null> = {}, drop: string[] = []) {
  const m = new Map<string, string | null>();
  for (let i = 0; i < 10; i++) m.set(`60000${i}.SH`, i < 5 ? "银行" : "电子");
  for (const [k, v] of Object.entries(over)) m.set(k, v);
  for (const k of drop) m.delete(k);
  return m;
}

const snap = (current: Map<string, string | null>, d: string, ver = 1) =>
  upsertSnapshot(wh, "industry", current, d, "em", ver, { market: "A" });

async function intervals(code: string) {
  return wh.all<{ value: string | null; valid_from: string; valid_to: string | null }>(
    `SELECT value, valid_from::VARCHAR AS valid_from, valid_to::VARCHAR AS valid_to
     FROM attr_history WHERE attr = 'industry' AND code = $c ORDER BY valid_from`,
    { c: code },
  );
}

describe("upsertSnapshot", () => {
  it("第一次快照从当天起算（不回填），第二天没变化什么都不写", async () => {
    expect(await snap(names(), D1)).toEqual({ opened: 10, closed: 0, skipped: false, changedPct: 0 });
    expect(await intervals("600000.SH")).toEqual([{ value: "银行", valid_from: D1, valid_to: null }]);
    expect(await snap(names(), D2)).toEqual({ opened: 0, closed: 0, skipped: false, changedPct: 0 });
    expect(await wh.scalar(`SELECT count(*) FROM attr_history`)).toBe(10);
    expect(await attrFirstDate(wh, "industry", "A")).toBe(D1);
    expect(await attrFirstDate(wh, "industry", "HK")).toBeNull();
  });

  it("值变了：旧区间在当天关上、开新区间；消失的关区间；重新出现的开新区间", async () => {
    await snap(names(), D1);
    const r = await snap(names({ "600001.SH": "保险" }, ["600009.SH"]), D2, 2);
    expect(r).toMatchObject({ opened: 1, closed: 2, skipped: false });
    expect(await intervals("600001.SH")).toEqual([
      { value: "银行", valid_from: D1, valid_to: D2 },
      { value: "保险", valid_from: D2, valid_to: null },
    ]);
    expect(await intervals("600009.SH")).toEqual([{ value: "电子", valid_from: D1, valid_to: D2 }]);
    await snap(names({ "600001.SH": "保险" }), D3);
    expect(await intervals("600009.SH")).toEqual([
      { value: "电子", valid_from: D1, valid_to: D2 },
      { value: "电子", valid_from: D3, valid_to: null },
    ]);
    expect(
      await wh.one(`SELECT src, ver FROM attr_history WHERE code = '600001.SH' AND valid_from = $d::DATE`, {
        d: D2,
      }),
    ).toEqual({ src: "em", ver: 2 });
  });

  it("同一天重跑幂等；同一天里值又变了就改当天的区间，变回原值时并回前一段", async () => {
    await snap(names(), D1);
    const changed = names({ "600001.SH": "保险" });
    await snap(changed, D2);
    const before = await wh.all(`SELECT * FROM attr_history ORDER BY code, valid_from`);
    expect(await snap(changed, D2)).toMatchObject({ opened: 0, closed: 0 });
    expect(await wh.all(`SELECT * FROM attr_history ORDER BY code, valid_from`)).toEqual(before);
    await snap(names({ "600001.SH": "证券" }), D2);
    expect(await intervals("600001.SH")).toEqual([
      { value: "银行", valid_from: D1, valid_to: D2 },
      { value: "证券", valid_from: D2, valid_to: null },
    ]);
    await snap(names(), D2);
    expect(await intervals("600001.SH")).toEqual([{ value: "银行", valid_from: D1, valid_to: null }]);
  });

  it("一天里超过 30% 的代码同时变化：整批不记，写进 meta", async () => {
    await snap(names(), D1);
    const renamed = new Map([...names()].map(([k, v]) => [k, v === "银行" ? "银行Ⅱ" : v]));
    const r = await snap(renamed, D2);
    expect(r).toEqual({ opened: 0, closed: 0, skipped: true, changedPct: 0.5 });
    expect(await wh.scalar(`SELECT count(*) FROM attr_history`)).toBe(10);
    expect(JSON.parse((await wh.meta("snapshot_skip:industry:A"))!)).toEqual({ date: D2, pct: 0.5 });
    const status = await captureStatus(wh, "A", D2);
    expect(status.attrs.find((a) => a.attr === "industry")).toEqual({
      attr: "industry",
      firstDate: D1,
      openRows: 10,
      changes7d: 0,
      lastSkipped: { date: D2, pct: 0.5 },
    });
  });

  it("近 7 天变化数不含首次快照那天", async () => {
    await snap(names(), D1);
    await snap(names({ "600001.SH": "保险" }, ["600009.SH"]), D2);
    const s = await captureStatus(wh, "A", D2);
    expect(s.attrs.find((a) => a.attr === "industry")?.changes7d).toBe(2);
    expect(s.financialsSeen).toEqual({ rows: 0, new7d: 0 });
  });
});

describe("attrAsOf", () => {
  it("点时读取：区间内取当时的值；首次快照之前取首次名单并标 preSnapshot；快照开始后不在名单上是 null", async () => {
    await snap(names(), D2);
    await snap(names({ "600001.SH": "保险" }, ["600009.SH"]), D3);
    expect(await attrAsOf(wh, "industry", "600001.SH", D2)).toEqual({
      value: "银行",
      from: D2,
      preSnapshot: false,
    });
    expect(await attrAsOf(wh, "industry", "600001.SH", D4)).toEqual({
      value: "保险",
      from: D3,
      preSnapshot: false,
    });
    expect(await attrAsOf(wh, "industry", "600001.SH", D1)).toEqual({
      value: "银行",
      from: D2,
      preSnapshot: true,
    });
    expect(await attrAsOf(wh, "industry", "600009.SH", D3)).toBeNull();
    // 首次快照之后才出现的代码：之前的日子不在名单上
    await snap(names({ "600010.SH": "电子" }), D4);
    expect(await attrAsOf(wh, "industry", "600010.SH", D1)).toBeNull();
  });
});

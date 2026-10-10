/**
 * 每周抽检的复权因子与成交量比对（D74）：只标记、不自动修；后来比对一致时关掉（resolved_by = check）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeHttp } from "../testing/fake-http.ts";
import { emDailyRoute } from "../testing/nightly.ts";
import { seedSyntheticMarket } from "../testing/seed.ts";
import { Warehouse } from "../warehouse/db.ts";
import { compareAdjVolume, weeklyCheck } from "./pipeline.ts";

let wh: Warehouse;
beforeEach(async () => {
  wh = await Warehouse.open(":memory:");
  await seedSyntheticMarket(wh, {
    market: "A",
    start: "2026-09-21",
    days: 10,
    stocks: [{ code: "600000.SH", name: "合成一号", close: () => 10 }],
  });
});
afterEach(() => wh.close());

const issues = () =>
  wh.all<{ rule: string; severity: string; resolved_by: string | null }>(
    `SELECT rule, severity, resolved_by FROM data_issues ORDER BY id`,
  );

describe("每周抽检", () => {
  it("成交量差 10 倍：标记 check_volume、不改库；下一次比对一致时关掉", async () => {
    const http = new FakeHttp([emDailyRoute({ "1.600000": 10 })]);
    // 重拉的成交量是 1000 手 = 10 万股，库里是 100 万股
    const r = await weeklyCheck({ wh, http, today: "2026-10-05", log: () => {} }, "A");
    expect(r).toMatchObject({ checked: 1, revisedRows: 0, repaired: [], flagged: 1 });
    expect(await issues()).toEqual([{ rule: "check_volume", severity: "flag", resolved_by: null }]);
    expect(await wh.scalar(`SELECT max(volume) FROM bars_daily`)).toBe(1e6);
    await wh.run(`UPDATE bars_daily SET volume = 100000`);
    const again = await weeklyCheck({ wh, http, today: "2026-10-05", log: () => {} }, "A");
    expect(again.flagged).toBe(0);
    expect(await issues()).toEqual([{ rule: "check_volume", severity: "flag", resolved_by: "check" }]);
  });

  it("compareAdjVolume：因子按第一个共同日归一后比，差 > 0.1% 才标记", () => {
    const stored = new Map([
      ["2026-09-21", { adj: 2, volume: 100 }],
      ["2026-09-22", { adj: 2, volume: 100 }],
      ["2026-09-23", { adj: 2.2, volume: 100 }],
    ]);
    const fresh = [
      { date: "2026-09-21", adj: 1, volume: 100 },
      { date: "2026-09-22", adj: 1.0005, volume: 100.5 },
      { date: "2026-09-23", adj: 1, volume: 100 },
    ];
    expect(compareAdjVolume(stored, fresh)).toEqual([
      {
        rule: "check_adj",
        severity: "flag",
        date: "2026-09-23",
        detail: "重拉的复权因子和库里不一致，共 1 天（差超过 0.1%）",
      },
    ]);
  });
});

/**
 * 辅助数据失败要看得见（D73）：财报接口连续三晚 500，completeness.soft 每晚都记下失败，
 * 连续失败晚数 = 3（管理页横幅），回测加 stale_fundamentals 提示。
 */
import { StrategySpecSchema } from "@ivan/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSimInput } from "../query/backtest.ts";
import { softStepStatus } from "../query/data-health.ts";
import { FakeHttp } from "../testing/fake-http.ts";
import { A_INDEX_SECIDS, emDailyRoute } from "../testing/nightly.ts";
import { seedSyntheticMarket } from "../testing/seed.ts";
import { Warehouse } from "../warehouse/db.ts";
import type { Completeness } from "./completeness.ts";
import { daily } from "./pipeline.ts";

let wh: Warehouse;
beforeEach(async () => {
  wh = await Warehouse.open(":memory:");
  // 2026-09-21 起 14 个工作日，最后一天 2026-10-08
  await seedSyntheticMarket(wh, {
    market: "A",
    start: "2026-09-21",
    days: 14,
    stocks: [
      { code: "600000.SH", name: "合成一号", close: () => 10 },
      { code: "600001.SH", name: "合成二号", close: () => 20 },
    ],
  });
});
afterEach(() => wh.close());

describe("财报接口连续三晚失败", () => {
  it("每晚的 completeness.soft 记下失败；连续失败 3 晚；回测带 stale_fundamentals", async () => {
    const http = new FakeHttp([
      // 报价接口挂了：全部走逐股日 K
      { match: /qt\.gtimg\.cn/, status: 500 },
      { match: /RPT_F10_FINANCE_MAINFINADATA/, status: 500 },
      emDailyRoute({ ...A_INDEX_SECIDS, "1.600000": 10, "1.600001": 20 }),
    ]);
    const nights = ["2026-10-09", "2026-10-12", "2026-10-13"];
    for (const today of nights) {
      const r = await daily({ wh, http, today, log: () => {} }, "A");
      expect(r).toMatchObject({ tradingDay: true, latest: today });
      const c = r.completeness!;
      expect(c).toMatchObject({ ok: true, expected: 2, updated: 2, date: today });
      expect(c.soft!.find((s) => s.step === "fundamentals")).toMatchObject({ ok: false });
      expect(c.soft!.find((s) => s.step === "fundamentals")!.error).toContain("500");
      const stored = JSON.parse(
        (await wh.scalar<string>(`SELECT completeness FROM data_versions WHERE id = $id`, {
          id: r.dataVersion!,
        }))!,
      ) as Completeness;
      expect(stored.soft).toEqual(c.soft);
    }
    const st = await softStepStatus(wh, "A");
    expect(st.find((s) => s.step === "fundamentals")).toEqual({
      step: "fundamentals",
      lastOkDate: null,
      failingNights: 3,
      firstFailDate: "2026-10-09",
    });

    const spec = StrategySpecSchema.parse({
      name: "低价",
      market: "A",
      rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 1 },
      rebalance: { every: "week", buffer: 1 },
    });
    const built = await buildSimInput(wh, spec, {
      start: "2026-09-22",
      end: "2026-10-13",
      capital: 1e6,
      oosMonths: 0,
    });
    const caveat = built.input.dataCaveats!.find((c) => c.id === "stale_fundamentals");
    expect(caveat).toEqual({
      id: "stale_fundamentals",
      level: "warn",
      title: "财报与股本久未更新",
      detail: "财报与股本已经 3 个交易日没更新成功，估值、ROE、市值可能是旧的。",
    });
    // 区间在第一晚失败之前结束：不提示
    const early = await buildSimInput(wh, spec, {
      start: "2026-09-22",
      end: "2026-10-02",
      capital: 1e6,
      oosMonths: 0,
    });
    expect(early.input.dataCaveats!.some((c) => c.id === "stale_fundamentals")).toBe(false);
  });

  it("中间成功一晚就重新计数", async () => {
    const http = (finOk: boolean) =>
      new FakeHttp([
        { match: /qt\.gtimg\.cn/, status: 500 },
        finOk
          ? { match: /RPT_F10_FINANCE_MAINFINADATA|RPT_F10_EH_EQUITY/, reply: { result: { data: [], pages: 1 } } }
          : { match: /RPT_F10_FINANCE_MAINFINADATA/, status: 500 },
        emDailyRoute({ ...A_INDEX_SECIDS, "1.600000": 10, "1.600001": 20 }),
      ]);
    await daily({ wh, http: http(false), today: "2026-10-09", log: () => {} }, "A");
    await daily({ wh, http: http(true), today: "2026-10-12", log: () => {} }, "A");
    await daily({ wh, http: http(false), today: "2026-10-13", log: () => {} }, "A");
    expect((await softStepStatus(wh, "A")).find((s) => s.step === "fundamentals")).toEqual({
      step: "fundamentals",
      lastOkDate: "2026-10-12",
      failingNights: 1,
      firstFailDate: "2026-10-13",
    });
  });
});

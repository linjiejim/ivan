/**
 * 夜间顺序（D73）：完整性闸门在日线之后、简称 / 财报与因子之前。闸门没过时版本提交 incomplete、抛 IncompleteDataError，
 * 不拉财报、不算因子（今天的因子表一行都没有），缺的股票记 bar_status = missing。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { committedAsOf } from "../query/backtest.ts";
import { FakeHttp } from "../testing/fake-http.ts";
import { A_INDEX_SECIDS, emDailyRoute, emSecidOf } from "../testing/nightly.ts";
import { seedSyntheticMarket } from "../testing/seed.ts";
import { Warehouse } from "../warehouse/db.ts";
import { IncompleteDataError } from "./completeness.ts";
import { daily } from "./pipeline.ts";

const CODES = Array.from({ length: 20 }, (_, i) => `${600000 + i}.SH`);
/** 这 5 只今晚所有来源都没有 */
const LOST = CODES.slice(0, 5);

let wh: Warehouse;
beforeEach(async () => {
  wh = await Warehouse.open(":memory:");
  await seedSyntheticMarket(wh, {
    market: "A",
    start: "2026-09-21",
    days: 14,
    stocks: CODES.map((code, k) => ({ code, name: `股${k}`, close: () => 10 + k })),
  });
});
afterEach(() => wh.close());

function httpOf() {
  const base: Record<string, number> = { ...A_INDEX_SECIDS };
  CODES.forEach((c, k) => {
    if (!LOST.includes(c)) base[emSecidOf(c)] = 10 + k;
  });
  return new FakeHttp([
    { match: /qt\.gtimg\.cn/, status: 500 },
    { match: /ifzq\.gtimg\.cn|web\.ifzq/, status: 500 },
    emDailyRoute(base),
  ]);
}

describe("闸门在财报与因子之前", () => {
  it("缺 5 只（阈值 3）：版本 incomplete、抛 IncompleteDataError，不拉财报、不算今天的因子", async () => {
    const http = httpOf();
    const err = await daily({ wh, http, today: "2026-10-09", log: () => {} }, "A").catch((e) => e);
    expect(err).toBeInstanceOf(IncompleteDataError);
    expect(err.retryable).toBe(true);
    expect(err.message).toBe("A 股有 5 只股票今天的日线没拿到，已停止更新，以免被当成停牌");
    // 深交所简称、财报与股本一个请求都没发
    expect(
      http.calls.some((c) => /szse\.cn|RPT_F10_FINANCE_MAINFINADATA|RPT_F10_EH_EQUITY/.test(c.url)),
    ).toBe(false);
    expect(Number(await wh.scalar(`SELECT count(*) FROM factors_daily WHERE date = DATE '2026-10-09'`))).toBe(0);
    const v = await wh.one<{ status: string; completeness: string; note: string }>(
      `SELECT status, completeness, note FROM data_versions WHERE kind = 'daily'`,
    );
    expect(v!.status).toBe("incomplete");
    expect(v!.note).toBe(err.message);
    const c = JSON.parse(v!.completeness);
    expect(c).toMatchObject({
      ok: false,
      expected: 20,
      updated: 15,
      missing: LOST,
      missingReasons: { quote_omitted: 5 },
      date: "2026-10-09",
    });
    // 读的人还停在上一个提交过的版本上
    expect(await committedAsOf(wh, "A")).toBe("2026-10-08");
    expect(
      await wh.all(`SELECT code, status, reason FROM bar_status ORDER BY code`),
    ).toEqual(LOST.map((code) => ({ code, status: "missing", reason: "quote_omitted" })));
  });

  it("缺的都是持仓股：不让整晚失败，记进 missingCritical，照常算因子", async () => {
    const http = httpOf();
    const r = await daily({ wh, http, today: "2026-10-09", log: () => {} }, "A", {
      critical: LOST,
    });
    expect(r.completeness).toMatchObject({ ok: true, missingCritical: LOST });
    // 过了闸门才拉简称与财报
    expect(http.calls.some((c) => /szse\.cn/.test(c.url))).toBe(true);
    expect(http.calls.some((c) => /RPT_F10_FINANCE_MAINFINADATA/.test(c.url))).toBe(true);
    expect(Number(await wh.scalar(`SELECT count(*) FROM factors_daily WHERE date = DATE '2026-10-09'`))).toBe(15);
    expect(await committedAsOf(wh, "A")).toBe("2026-10-09");
  });

  it("ETL_ACCEPT_MISSING 放行：通过，记进 accepted", async () => {
    const r = await daily({ wh, http: httpOf(), today: "2026-10-09", log: () => {} }, "A", {
      acceptMissing: LOST.slice(0, 3),
    });
    expect(r.completeness).toMatchObject({ ok: true, accepted: LOST.slice(0, 3) });
  });
});

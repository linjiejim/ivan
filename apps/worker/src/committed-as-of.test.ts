/**
 * 「读到哪一天」只看提交过的版本（D60）：失败那晚写进来的日线与因子，结算与 /internal/screen 的默认日期都不用。
 * （回测输入的同类测试在 packages/data/src/query/committed-as-of.test.ts）
 */
import { StrategySpecSchema } from "@ivan/core";
import { seedSyntheticMarket } from "@ivan/data/testing";
import { trackingDays, trackings } from "@ivan/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInternalApp } from "./internal.ts";
import { settleMarket } from "./jobs/settle.ts";
import { fakeJobContext, makeTestEnv, seedTracking } from "./testing/harness.ts";

const spec = StrategySpecSchema.parse({
  name: "低估值",
  market: "A",
  rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 1 },
});

let t: Awaited<ReturnType<typeof makeTestEnv>>;
let calendar: string[];
let committed: string;
beforeEach(async () => {
  t = await makeTestEnv({ cfg: { internalSecret: "s" } });
  ({ calendar } = await seedSyntheticMarket(t.env.wh, {
    market: "A",
    start: "2026-03-02",
    days: 20,
    dataVersion: false,
    stocks: [
      { code: "600001.SH", name: "甲", close: (i) => 10 + i * 0.1, factors: () => ({ pe_ttm: 8 }) },
      { code: "600002.SH", name: "乙", close: (i) => 20 + i * 0.1, factors: () => ({ pe_ttm: 5 }) },
    ],
  }));
  // 提交到倒数第 3 天；之后两天是失败那晚写进来的
  committed = calendar.at(-3)!;
  await t.env.wh.run(
    `INSERT INTO data_versions (id, market, as_of, kind, status)
     VALUES (nextval('data_version_seq'), 'A', $d::DATE, 'daily', 'ok'),
            (nextval('data_version_seq'), 'A', NULL, 'daily', 'failed')`,
    { d: committed },
  );
});
afterEach(() => t.cleanup());

describe("committedAsOf：结算与选股", () => {
  it("settleMarket 只结算到已提交的截至日", async () => {
    const { trackingId } = seedTracking(t.env.app, { spec, startDate: calendar[2]! });
    expect(await settleMarket("A", fakeJobContext("settle", { market: "A" }))).toEqual({
      settled: 1,
      failed: 0,
    });
    const days = t.env.app.db
      .select({ date: trackingDays.date })
      .from(trackingDays)
      .where(eq(trackingDays.trackingId, trackingId))
      .all()
      .map((r) => r.date)
      .sort();
    expect(days.at(-1)).toBe(committed);
    const row = t.env.app.db.select().from(trackings).where(eq(trackings.id, trackingId)).get()!;
    expect((row.summary as { lastDate: string }).lastDate).toBe(committed);
  });

  it("/internal/screen 不传日期时用已提交的截至日", async () => {
    const res = await createInternalApp().request("/internal/screen", {
      method: "POST",
      headers: { "x-internal-secret": "s", "content-type": "application/json" },
      body: JSON.stringify({ spec }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { date: string; rows: Array<{ code: string }> };
    expect(body.date).toBe(committed);
    expect(body.rows.map((r) => r.code)).toEqual(["600002.SH", "600001.SH"]);
  });

  it("/internal/screen 给了日期也截到已提交的截至日；格式不对或不存在的日子 400", async () => {
    const post = (body: unknown) =>
      createInternalApp().request("/internal/screen", {
        method: "POST",
        headers: { "x-internal-secret": "s", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const later = await post({ spec, date: calendar.at(-1) });
    expect(later.status).toBe(200);
    expect(((await later.json()) as { date: string }).date).toBe(committed);
    const earlier = await post({ spec, date: calendar[5] });
    expect(((await earlier.json()) as { date: string }).date).toBe(calendar[5]);
    for (const date of ["2024-13-45", "2026-02-30", "x"]) {
      const bad = await post({ spec, date });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toBe("日期格式要是 YYYY-MM-DD");
    }
  });

  it("/internal/securities/:code 的因子行不晚于已提交的截至日", async () => {
    const res = await createInternalApp().request("/internal/securities/600001.SH", {
      headers: { "x-internal-secret": "s" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { factors: { date: string } | null };
    expect(body.factors!.date).toBe(committed);
  });
});

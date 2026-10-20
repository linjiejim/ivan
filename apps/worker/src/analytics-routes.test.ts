/**
 * 对话分析工具的内部接口（spec 20261020）：参数错误转 4xx 中文原因；当天更新失败时 notes 最前面写明数据没更新。
 */
import { seedSyntheticMarket } from "@ivan/data/testing";
import { jobs } from "@ivan/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInternalApp } from "./internal.ts";
import { makeTestEnv } from "./testing/harness.ts";

let t: Awaited<ReturnType<typeof makeTestEnv>>;
let calendar: string[];
const TODAY = "2026-10-20";

beforeEach(async () => {
  t = await makeTestEnv({ cfg: { internalSecret: "s" }, today: TODAY });
  ({ calendar } = await seedSyntheticMarket(t.env.wh, {
    market: "HK",
    start: "2026-01-05",
    days: 200,
    stocks: [
      {
        code: "00700.HK",
        name: "腾讯控股",
        industry_l1: "资讯科技业",
        close: (i) => 300 + i,
        factors: () => ({ pe_ttm: 20, pb: 4, mcap: 30000 }),
      },
      {
        code: "00005.HK",
        name: "汇丰控股",
        industry_l1: "金融业",
        close: (i) => 60 - i * 0.01,
        factors: () => ({ pe_ttm: 8, pb: 1, mcap: 10000 }),
      },
    ],
  }));
});
afterEach(() => t.cleanup());

const post = (path: string, body: unknown) =>
  createInternalApp().request(path, {
    method: "POST",
    headers: { "x-internal-secret": "s", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("对话分析工具的内部接口", () => {
  it("走势：按名称找到港股；指数叫法也行", async () => {
    const res = await post("/internal/analytics/price-history", { query: "腾讯", period: "3m" });
    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      instrument: { code: string };
      currency: string;
      benchmark: { key: string };
    };
    expect(b.instrument.code).toBe("00700.HK");
    expect(b.currency).toBe("HKD");
    expect(b.benchmark.key).toBe("hsi");
    const idx = (await (
      await post("/internal/analytics/price-history", { query: "恒指" })
    ).json()) as {
      instrument: { sym: string };
    };
    expect(idx.instrument.sym).toBe("hsi");
  });

  it("参数不对 400、找不到 404，都带中文原因", async () => {
    const bad = await post("/internal/analytics/price-history", { query: "腾讯", period: "7y" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/不认识的区间/);
    const none = await post("/internal/analytics/factor-history", { query: "不存在" });
    expect(none.status).toBe(404);
    const mk = await post("/internal/analytics/market", { market: "US" });
    expect(mk.status).toBe(400);
    const cmp = await post("/internal/analytics/compare", { queries: ["腾讯"] });
    expect(cmp.status).toBe(400);
  });

  it("今天的更新失败了：notes 最前面写明数据没更新", async () => {
    t.env.app.db
      .insert(jobs)
      .values({
        id: "j_fail",
        kind: "etl",
        payload: { market: "HK" },
        status: "failed",
        error: "风控",
        createdAt: Date.parse(`${TODAY}T10:00:00Z`),
      })
      .run();
    const b = (await (await post("/internal/analytics/market", { market: "HK" })).json()) as {
      date: string;
      notes: string[];
      breadth: { traded: number };
    };
    expect(b.date).toBe(calendar.at(-1));
    expect(b.notes[0]).toMatch(/港股的数据没更新成功/);
    expect(b.breadth.traded).toBe(2);
  });

  it("行业、因子历史、财报都能走通", async () => {
    const ind = await post("/internal/analytics/industries", { market: "HK", period: "1m" });
    expect(ind.status).toBe(200);
    const fh = (await (
      await post("/internal/analytics/factor-history", { query: "00700", factors: ["pe_ttm"] })
    ).json()) as {
      factors: Array<{ key: string; current: number }>;
    };
    expect(fh.factors[0]).toMatchObject({ key: "pe_ttm", current: 20 });
    const fin = await post("/internal/analytics/financials", { query: "00700" });
    expect(fin.status).toBe(404);
    expect(((await fin.json()) as { error: string }).error).toMatch(/没有腾讯控股的财报/);
  });
});

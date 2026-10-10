/**
 * 回填估算（验收 22）：每个数据集一次计数请求（带同一份列清单），请求数下限 ⌈行数 ÷ 500⌉、上限再加块数，时长按 0.6 秒 / 次。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emPage, eventColumnViolations } from "../testing/events.ts";
import { FakeHttp } from "../testing/fake-http.ts";
import { seedSyntheticMarket } from "../testing/seed.ts";
import { Warehouse } from "../warehouse/db.ts";
import { estimatePitBackfill } from "./pit-runner.ts";

let wh: Warehouse;
beforeEach(async () => {
  wh = await Warehouse.open(":memory:");
  // 交易日历：2026-09-21 起 10 个工作日
  await seedSyntheticMarket(wh, {
    market: "A",
    start: "2026-09-21",
    days: 10,
    stocks: [{ code: "600519.SH", name: "茅台", close: () => 1500 }],
  });
});
afterEach(() => wh.close());

const COUNTS: Record<string, number> = {
  RPTA_WEB_RZRQ_GGMX: 6_000_000,
  RPT_HOLDERNUM_DET: 441_010,
  RPT_LIFT_STAGE: 28_468,
  RPT_DATA_BLOCKTRADE: 649_801,
};

describe("estimatePitBackfill", () => {
  it("4 次计数请求；每个数据集一行中文，含行数、请求区间与时长", async () => {
    const http = new FakeHttp([
      {
        match: /datacenter-web/,
        reply: ({ url }) => emPage([], { count: COUNTS[new URL(url).searchParams.get("reportName")!] }),
      },
    ]);
    const r = await estimatePitBackfill(
      { wh, http, today: "2026-10-02", log: () => {} },
      ["margin", "holders", "lockups", "blocks"],
      "2026-09-21",
    );
    expect(r.requests).toBe(4);
    expect(http.calls).toHaveLength(4);
    expect(http.calls.every((c) => new URL(c.url).searchParams.get("pageSize") === "1")).toBe(true);
    expect(eventColumnViolations(http.calls)).toEqual([]);
    const margin = r.datasets.find((d) => d.id === "margin")!;
    // 两融按天分块：9-21 ~ 10-01 共 9 个交易日
    expect(margin).toMatchObject({ rows: 6_000_000, chunks: 9, requestsLow: 12_000, requestsHigh: 12_009 });
    expect(margin.line).toBe("两融明细：约 600 万行，12,000-12,009 次请求，按 0.6 秒 / 次约 2.0-2.0 小时");
    const holders = r.datasets.find((d) => d.id === "holders")!;
    expect(holders).toMatchObject({ requestsLow: 883, chunks: 2, requestsHigh: 885 });
    expect(holders.line).toBe("股东户数：约 44 万行，883-885 次请求，按 0.6 秒 / 次约 9-9 分钟");
    expect(r.datasets.find((d) => d.id === "lockups")!.line).toBe(
      "限售解禁：约 3 万行，57-59 次请求，按 0.6 秒 / 次约 1-1 分钟",
    );
    expect(r.lines.at(-1)).toBe("合计：14,240-14,255 次请求，约 2.4-2.4 小时");
    // 计数请求的窗口就是回填的范围
    const f = (report: string) =>
      new URL(http.calls.find((c) => c.url.includes(report))!.url).searchParams.get("filter");
    expect(f("RPTA_WEB_RZRQ_GGMX")).toBe("(DATE>='2026-09-21')(DATE<='2026-10-01')");
    expect(f("RPT_LIFT_STAGE")).toBe("(FREE_DATE>='2026-09-21')(FREE_DATE<='2027-12-31')");
  });
});

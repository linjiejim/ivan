/**
 * 夜间日线增量的报价韧性（D72、验收 9）：一批报价出错、或报价漏了请求的代码，都不让整晚失败——
 * 这些股票转去沿日线链逐股补（东财，src = em）；报价拿到的照常 src = txq；台账记各来源服务的股票数，
 * 夜间增量提交时写进 data_versions.sources。
 */
import { addDays, type DateStr, weekday } from "@ivan/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lastFetchSources } from "../query/backtest.ts";
import { FetchLedger } from "../sources/chain.ts";
import { FakeHttp, type FakeRoute, loadFixture } from "../testing/fake-http.ts";
import { seedSyntheticMarket } from "../testing/seed.ts";
import { Warehouse } from "../warehouse/db.ts";
import { updateBars } from "./bars.ts";
import { type EtlContext, loadSecurities } from "./context.ts";
import { daily } from "./pipeline.ts";

let wh: Warehouse;
beforeEach(async () => {
  wh = await Warehouse.open(":memory:");
  // 2026-09-21 起 14 个工作日，最后一天 2026-10-08；今晚（10-09）只差一天，走批量报价
  await seedSyntheticMarket(wh, {
    market: "A",
    start: "2026-09-21",
    days: 14,
    stocks: [
      { code: "600000.SH", name: "浦发银行", close: () => 10 },
      { code: "600001.SH", name: "合成二号", close: () => 20 },
      { code: "600002.SH", name: "合成三号", close: () => 30 },
    ],
  });
  // 夜间增量先更新指数与日历再补日线：直接调 updateBars 时日历里也要有今天（体检 R3 认日历）
  await wh.run(`INSERT INTO trade_calendar (market, date) VALUES ('A', DATE '2026-10-09')`);
});
afterEach(() => wh.close());

const BASE: Record<string, number> = {
  "1.600000": 10,
  "1.600001": 20,
  "1.600002": 30,
  "1.000300": 4000,
  "1.000001": 3000,
  "0.399006": 2000,
};

/** 东财日 K：按请求的 secid 与起止日现算工作日的行（今天收盘比前一天高 5%，没有除权） */
const emReply: FakeRoute["reply"] = ({ url }) => {
  const q = new URL(url).searchParams;
  const secid = q.get("secid")!;
  const iso = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` as DateStr;
  const end = iso(q.get("end")!);
  const lines: string[] = [];
  let prev = BASE[secid]!;
  for (let d = iso(q.get("beg")!); d <= end; d = addDays(d, 1)) {
    if (weekday(d) === 0 || weekday(d) === 6) continue;
    const close = d === "2026-10-09" ? Math.round(BASE[secid]! * 105) / 100 : BASE[secid]!;
    lines.push(`${d},${close},${close},${close},${close},1000,${close * 100_000},0,0,${(close - prev).toFixed(2)}`);
    prev = close;
  }
  return { rc: 0, data: { code: secid.slice(2), decimal: 2, klines: lines } };
};

const EM: FakeRoute = { match: /push2his\.eastmoney\.com/, reply: emReply };

function ctxOf(http: FakeHttp, logs: string[], ledger?: FetchLedger): EtlContext {
  return { wh, http, today: "2026-10-09", log: (m) => logs.push(m), ver: 9, ledger };
}

const rowsOn = (d: string) =>
  wh.all<{ code: string; close: number; src: string; ver: number }>(
    `SELECT code, close, src, ver FROM bars_daily WHERE date = $d::DATE ORDER BY code`,
    { d },
  );

describe("updateBars 的报价韧性", () => {
  it("一批报价 HTTP 500：这批股票逐股从东财补，src = em，不让任务失败", async () => {
    const http = new FakeHttp([{ match: /qt\.gtimg\.cn/, status: 500 }, EM]);
    const logs: string[] = [];
    const ledger = new FetchLedger();
    const secs = await loadSecurities(wh, "A");
    const r = await updateBars(ctxOf(http, logs, ledger), "A", secs, "2026-10-09", "2026-10-08");
    expect(r).toMatchObject({ viaQuote: 0, viaKline: 3, failed: 0, quoteFallback: 3 });
    expect(logs.some((l) => l.startsWith("报价批次失败，改逐股补日线："))).toBe(true);
    expect(await rowsOn("2026-10-09")).toEqual([
      { code: "600000.SH", close: 10.5, src: "em", ver: 9 },
      { code: "600001.SH", close: 21, src: "em", ver: 9 },
      { code: "600002.SH", close: 31.5, src: "em", ver: 9 },
    ]);
    // 只走了东财，没碰腾讯日 K
    expect(http.calls.some((c) => /ifzq\.gtimg/.test(c.url))).toBe(false);
    expect(ledger.toJSON()).toMatchObject({ served: { em: 3 }, fallbacks: 0, failed: 0 });
  });

  it("报价漏了一只：报价拿到的 src = txq，漏掉的逐股从东财补", async () => {
    const http = new FakeHttp([{ match: /qt\.gtimg\.cn/, reply: loadFixture("tx-quote-batch.txt") }, EM]);
    const logs: string[] = [];
    const ledger = new FetchLedger();
    const secs = await loadSecurities(wh, "A");
    const r = await updateBars(ctxOf(http, logs, ledger), "A", secs, "2026-10-09", "2026-10-08");
    expect(r).toMatchObject({ viaQuote: 2, viaKline: 1, failed: 0, quoteFallback: 1 });
    expect(logs).toContain("报价漏了 1 只，改逐股补日线");
    expect(await rowsOn("2026-10-09")).toEqual([
      { code: "600000.SH", close: 10.1, src: "txq", ver: 9 },
      { code: "600001.SH", close: 20.3, src: "txq", ver: 9 },
      { code: "600002.SH", close: 31.5, src: "em", ver: 9 },
    ]);
    // 东财只为漏掉的那只请求了一次
    expect(http.calls.filter((c) => /push2his/.test(c.url))).toHaveLength(1);
    expect(ledger.toJSON().served).toEqual({ txq: 2, em: 1 });
  });
});

describe("夜间增量把取数台账写进数据版本", () => {
  it("data_versions.sources 记各来源服务的股票数与各指数的来源；管理页读最近一晚", async () => {
    const http = new FakeHttp([{ match: /qt\.gtimg\.cn/, reply: loadFixture("tx-quote-batch.txt") }, EM]);
    const logs: string[] = [];
    const r = await daily({ wh, http, today: "2026-10-09", log: (m) => logs.push(m) }, "A");
    expect(r).toMatchObject({ tradingDay: true, latest: "2026-10-09" });
    const v = await wh.one<{ status: string; sources: string }>(
      `SELECT status, sources FROM data_versions WHERE id = $id`,
      { id: r.dataVersion! },
    );
    expect(v!.status).toBe("ok");
    const sources = JSON.parse(v!.sources);
    expect(sources).toMatchObject({
      v: 2,
      served: { txq: 2, em: 1 },
      fallbacks: 0,
      failed: 0,
      index: { csi300: "em", sse: "em", chinext: "em" },
    });
    // 全收益指数只有中证官网一家，这里没配，跳过且不算进来源
    expect(sources.index.csi300_tr).toBeUndefined();
    const summary = await lastFetchSources(wh, "A");
    expect(summary).toMatchObject({ versionId: r.dataVersion, status: "ok", served: { txq: 2, em: 1 }, fallbacks: 0 });
    expect(await lastFetchSources(wh, "HK")).toBeNull();
  });
});

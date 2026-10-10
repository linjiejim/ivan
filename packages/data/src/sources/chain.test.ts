/**
 * 沿回退链取数（D72，FakeHttp）：被封、空结果、报错都换下一家；台账记各来源服务数与回退次数；
 * 整条链被封时抛最早解封时间的 BlockedError。
 */
import { describe, expect, it } from "vitest";
import { BlockedError } from "../http.ts";
import { FakeHttp, loadFixture } from "../testing/fake-http.ts";
import { ChainError, FetchLedger, fetchWithChain } from "./chain.ts";
import { resolveChain } from "./registry.ts";
import type { SourceBars, SourceCtx } from "./types.ts";

const EM = /push2his\.eastmoney\.com/;
const TX_RAW = /fqkline\/get\?param=sh600519,day,.*,640,$/;
const TX_HFQ = /fqkline\/get\?param=sh600519,day,.*,640,hfq$/;
const txRoutes = [
  { match: TX_RAW, reply: loadFixture("tx-kline-raw.json") },
  { match: TX_HFQ, reply: loadFixture("tx-kline-hfq.json") },
];

const run = (http: FakeHttp) => {
  const sctx: SourceCtx = { http, today: "2025-06-30", log: () => {} };
  return fetchWithChain<SourceBars>(
    resolveChain("bars", "A", {}),
    "日线 600519.SH",
    (a) => a.dailyBars!(sctx, "600519.SH", "2025-06-19", "2025-06-30"),
    (sb) => !sb.bars.length,
    http,
  );
};

describe("fetchWithChain", () => {
  it("东财正常：东财服务，不回退", async () => {
    const http = new FakeHttp([{ match: EM, reply: loadFixture("em-kline-a-raw.json") }, ...txRoutes]);
    const r = await run(http);
    expect(r.servedBy).toBe("eastmoney");
    expect(r.value.caliber).toBe("raw+ref_prev_close");
    expect(r.value.bars).toHaveLength(8);
    expect(r.attempts.map((a) => a.outcome)).toEqual(["ok"]);
    expect(http.calls.some((c) => /gtimg/.test(c.url))).toBe(false);
  });

  it("东财被封：腾讯服务，台账记 1 次回退", async () => {
    const http = new FakeHttp(txRoutes);
    http.setBlocked("push2his.eastmoney.com", Date.now() + 600_000);
    const r = await run(http);
    expect(r.servedBy).toBe("tencent");
    expect(r.value.caliber).toBe("raw+hfq_affine");
    expect(r.attempts.map((a) => [a.source, a.outcome])).toEqual([
      ["eastmoney", "blocked"],
      ["tencent", "ok"],
    ]);
    // 被封的域名不再发请求
    expect(http.calls.some((c) => EM.test(c.url))).toBe(false);
    const ledger = new FetchLedger();
    ledger.record("600519.SH", r);
    expect(ledger.toJSON()).toMatchObject({ v: 1, served: { tx: 1 }, fallbacks: 1, failed: 0 });
  });

  it("东财请求中途触发风控：同样换腾讯", async () => {
    const http = new FakeHttp([{ match: EM, block: { untilMs: Date.now() + 600_000 } }, ...txRoutes]);
    const r = await run(http);
    expect(r.servedBy).toBe("tencent");
    expect(r.attempts[0]!.outcome).toBe("blocked");
  });

  it("东财返回空日 K：换下一家", async () => {
    const http = new FakeHttp([{ match: EM, reply: loadFixture("em-kline-empty.json") }, ...txRoutes]);
    const r = await run(http);
    expect(r.servedBy).toBe("tencent");
    expect(r.empty).toBe(false);
    expect(r.attempts.map((a) => a.outcome)).toEqual(["empty", "ok"]);
  });

  it("每家都正常答了「没有」：返回空结果，不算失败", async () => {
    const http = new FakeHttp([
      { match: EM, reply: loadFixture("em-kline-empty.json") },
      { match: /gtimg/, reply: { code: 0, msg: "", data: { sh600519: { day: [] } } } },
    ]);
    const r = await run(http);
    expect(r.empty).toBe(true);
    expect(r.value.bars).toEqual([]);
    const ledger = new FetchLedger();
    ledger.record("600519.SH", r);
    expect(ledger.toJSON()).toMatchObject({ served: {}, empty: 1, failed: 0 });
  });

  it("整条链被封：抛 BlockedError，解封时间取最早的那家", async () => {
    const http = new FakeHttp([]);
    const now = Date.now();
    http.setBlocked("push2his.eastmoney.com", now + 3_600_000);
    http.setBlocked("web.ifzq.gtimg.cn", now + 900_000);
    const e = await run(http).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BlockedError);
    expect((e as BlockedError).until).toBe(now + 900_000);
    expect(http.calls).toHaveLength(0);
  });

  it("都报错：「所有数据源都失败」带上每家的结局，台账记失败明细", async () => {
    const http = new FakeHttp([
      { match: EM, status: 500 },
      { match: /gtimg/, status: 502 },
    ]);
    const e = await run(http).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ChainError);
    const msg = (e as ChainError).message;
    expect(msg).toContain("日线 600519.SH 所有数据源都失败");
    expect(msg).toContain("东财 出错（HTTP 500）");
    expect(msg).toContain("腾讯 出错（HTTP 502）");
    expect((e as ChainError).attempts.map((a) => a.outcome)).toEqual(["error", "error"]);
    const ledger = new FetchLedger();
    ledger.recordFailure("600519.SH", e);
    const j = ledger.toJSON();
    expect(j.failed).toBe(1);
    expect(j.failures[0]!.attempts).toHaveLength(2);
  });
});

describe("FetchLedger", () => {
  it("同一只股票以最后一次来源为准；失败明细最多 50 条", () => {
    const ledger = new FetchLedger();
    ledger.served("00700.HK", "txq");
    ledger.served("00700.HK", "em");
    ledger.served("00005.HK", "txq");
    for (let i = 0; i < 60; i++) ledger.recordFailure(`6000${String(i).padStart(2, "0")}.SH`, new Error("x"));
    const j = ledger.toJSON();
    expect(j.served).toEqual({ em: 1, txq: 1 });
    expect(j.failed).toBe(60);
    expect(j.failures).toHaveLength(50);
    expect(JSON.parse(JSON.stringify(ledger))).toEqual(j);
  });
});

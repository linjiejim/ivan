/**
 * 港股证券表刷新顺手采集点时属性（D61）：行业、每手股数、深港通名单（GANGGUTONGBIAODISHEN 只是深港通）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeHttp, loadFixture } from "../testing/fake-http.ts";
import { Warehouse } from "../warehouse/db.ts";
import type { EtlContext } from "./context.ts";
import { refreshSecuritiesHK } from "./securities.ts";

let wh: Warehouse;
const logs: string[] = [];
beforeEach(async () => {
  wh = await Warehouse.open(":memory:");
  logs.length = 0;
});
afterEach(() => wh.close());

function http(info = loadFixture("em-hk-securityinfo.json")) {
  return new FakeHttp([
    { match: /reportName=RPT_HKF10_INFO_SECURITYINFO/, reply: info },
    { match: /reportName=RPT_HKF10_INFO_ORGPROFILE/, reply: loadFixture("em-hk-orgprofile.json") },
  ]);
}

const ctxOf = (h: FakeHttp, today = "2026-10-20"): EtlContext => ({
  wh,
  http: h,
  today,
  log: (m) => logs.push(m),
  ver: 9,
});

async function attr(a: string) {
  return wh.all<{ code: string; value: string | null }>(
    `SELECT code, value FROM attr_history WHERE attr = $a AND valid_to IS NULL ORDER BY code`,
    { a },
  );
}

describe("refreshSecuritiesHK 的属性快照", () => {
  it("请求带上深港通列；记下行业、每手股数与深港通名单（是 → Y，其余 → N），带来源与版本号", async () => {
    const h = http();
    await refreshSecuritiesHK(ctxOf(h));
    const req = h.calls.find((c) => c.url.includes("RPT_HKF10_INFO_SECURITYINFO"))!;
    expect(new URL(req.url).searchParams.get("columns")).toContain("GANGGUTONGBIAODISHEN");
    expect(await attr("hk_connect_sz")).toEqual([
      { code: "00005.HK", value: "N" },
      { code: "00700.HK", value: "Y" },
      { code: "00939.HK", value: "Y" },
      { code: "08083.HK", value: "N" },
    ]);
    expect(await attr("lot_size")).toEqual([
      { code: "00005.HK", value: "400" },
      { code: "00700.HK", value: "100" },
      { code: "00939.HK", value: "1000" },
      { code: "08083.HK", value: "4000" },
    ]);
    expect((await attr("industry_l1")).map((r) => r.value)).toEqual(["银行", "软件服务", "银行", "软件服务"]);
    // 不写成笼统的「港股通」
    expect(await attr("hk_connect")).toEqual([]);
    expect(
      await wh.all(`SELECT DISTINCT src, ver, valid_from::VARCHAR AS d FROM attr_history`),
    ).toEqual([{ src: "em", ver: 9, d: "2026-10-20" }]);
    // 第二天同样的名单：不新增区间
    await refreshSecuritiesHK(ctxOf(http(), "2026-10-21"));
    expect(await wh.scalar(`SELECT count(*) FROM attr_history`)).toBe(12);
  });

  it("整批都拿不到深港通列时不记深港通名单（行业、每手照记）", async () => {
    const raw = JSON.parse(loadFixture("em-hk-securityinfo.json")) as {
      result: { data: Array<Record<string, unknown>> };
    };
    for (const r of raw.result.data) r.GANGGUTONGBIAODISHEN = null;
    await refreshSecuritiesHK(ctxOf(http(JSON.stringify(raw))));
    expect(await attr("hk_connect_sz")).toEqual([]);
    expect((await attr("lot_size")).length).toBe(4);
    expect((await attr("industry_l1")).length).toBe(4);
    expect(logs.some((l) => l.includes("没有深港通标记"))).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { BlockedError, HttpError } from "../http.ts";
import { emQuery } from "../sources/eastmoney.ts";
import { FakeHttp, loadFixture } from "./fake-http.ts";

describe("FakeHttp", () => {
  it("按正则与方法路由；字符串原样、对象转 JSON、函数按请求现算；记录每次请求", async () => {
    const http = new FakeHttp([
      { match: /example\.com\/a/, method: "POST", reply: (r) => ({ echo: r.body }) },
      { match: /example\.com\/a/, reply: "plain" },
      { match: /example\.com\/b\?x=1/, reply: { ok: 1 } },
    ]);
    expect(await http.text("https://example.com/a")).toBe("plain");
    expect(await http.json("https://example.com/a", { method: "POST", body: "hi" })).toEqual({
      echo: "hi",
    });
    expect(await http.json("https://example.com/b?x=1")).toEqual({ ok: 1 });
    expect(http.calls).toEqual([
      { url: "https://example.com/a", method: "GET" },
      { url: "https://example.com/a", method: "POST", body: "hi" },
      { url: "https://example.com/b?x=1", method: "GET" },
    ]);
  });

  it("times 用完后交给后面的路由", async () => {
    const http = new FakeHttp([
      { match: /x\.com/, reply: "first", times: 2 },
      { match: /x\.com/, reply: "later" },
    ]);
    const got = [];
    for (let i = 0; i < 4; i++) got.push(await http.text("https://x.com/q"));
    expect(got).toEqual(["first", "first", "later", "later"]);
  });

  it("block：抛 BlockedError 并把域名封到指定时刻；之后同域名的请求都被拒", async () => {
    let now = 1_000;
    const http = new FakeHttp(
      [
        { match: /waf\.com/, block: { untilMs: 5_000 }, times: 1 },
        { match: /waf\.com/, reply: "ok" },
        { match: /other\.com/, reply: "ok" },
      ],
      { now: () => now },
    );
    const err = await http.text("https://waf.com/q").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockedError);
    expect(err).toMatchObject({ host: "waf.com", until: 5_000, reason: "waf" });
    expect(http.isBlocked("waf.com")).toBe(true);
    await expect(http.text("https://waf.com/q")).rejects.toBeInstanceOf(BlockedError);
    // 和 Http 一样：有一个没被封就返回 0，全都被封返回最早解封时刻
    expect(http.earliestUnblock(["waf.com", "other.com"])).toBe(0);
    http.setBlocked("other.com", 3_000);
    expect(http.earliestUnblock(["waf.com", "other.com"])).toBe(3_000);
    now = 6_000;
    expect(http.isBlocked("waf.com")).toBe(false);
    expect(http.earliestUnblock(["waf.com"])).toBe(0);
    expect(await http.text("https://waf.com/q")).toBe("ok");
  });

  it("block 可以标成连不上", async () => {
    const http = new FakeHttp([{ match: /em\.com/, block: { untilMs: Date.now() + 60_000, reason: "unreachable" } }]);
    await expect(http.text("https://em.com/x")).rejects.toMatchObject({ reason: "unreachable" });
    // 封住之后的请求不再走路由，原因要保留
    await expect(http.text("https://em.com/y")).rejects.toMatchObject({ reason: "unreachable" });
    http.setBlocked("sz.com", Date.now() + 60_000, "unreachable");
    await expect(http.text("https://sz.com/z")).rejects.toMatchObject({ reason: "unreachable" });
  });

  it("status：抛 HttpError（不带查询串）", async () => {
    const http = new FakeHttp([{ match: /svc/, status: 503 }]);
    const err = await http.text("https://svc.com/p?token=abc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ message: "HTTP 503", url: "https://svc.com/p", status: 503 });
  });

  it("没有配置的请求：中文报错，绝不放行", async () => {
    const http = new FakeHttp([]);
    const err = await http.text("https://push2his.eastmoney.com/api/qt?secid=1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message).toBe(
      "FakeHttp：没有配置这个请求 https://push2his.eastmoney.com/api/qt",
    );
    expect((err as HttpError).status).toBe(599);
  });

  it("json 解析失败报 HttpError", async () => {
    const http = new FakeHttp([{ match: /x/, reply: "<html>" }]);
    await expect(http.json("https://x.com")).rejects.toBeInstanceOf(HttpError);
  });

  it("配合夹具驱动真实的数据源代码：东财分页取完两页；空结果是正常的", async () => {
    const http = new FakeHttp([
      { match: /pageNumber=1&/, reply: loadFixture("em-datacenter-page1.json") },
      { match: /pageNumber=2&/, reply: loadFixture("em-datacenter-page2.json") },
    ]);
    const rows = await emQuery(http, { report: "RPT_F10_EH_EQUITY", host: "sec", pageSize: 2 });
    expect(rows.map((r) => r.SECUCODE)).toEqual(["600519.SH", "000001.SZ", "00700.HK"]);
    expect(http.calls).toHaveLength(2);
    expect(http.calls[0]!.url).toMatch(/^https:\/\/datacenter\.eastmoney\.com\/securities\//);

    const empty = new FakeHttp([{ match: /datacenter/, reply: loadFixture("em-datacenter-empty.json") }]);
    expect(await emQuery(empty, { report: "RPT_X" })).toEqual([]);
  });
});

/**
 * 东财的点时事件数据实现（D80–D82）：入库单位（万股 × 1e4、比例存小数、RZYEZB 原样 %）、解禁比例按股数算成解禁前口径、
 * 缺键算结构变了、列清单断言（禁用列、ALL）、金丝雀的单位自检与失败分类（两融取最近一条已公布的）、两融按交易所计数。
 */
import { describe, expect, it } from "vitest";
import { emEventsServer, emPage, emReportRoute, eventColumnViolations } from "../testing/events.ts";
import { FakeHttp, loadFixture } from "../testing/fake-http.ts";
import type { HolderRow, LockupRow, MarginRow, BlockRow, SourceCtx } from "./types.ts";
import {
  assertColumns,
  EASTMONEY_EVENTS,
  EM_EVENT_DEFS,
  LOCKUPS_DEF,
  MARGIN_DEF,
} from "./adapters/eastmoney-events.ts";
import { type EmRow, SchemaDriftError } from "./eastmoney.ts";

const fx = (name: string) => JSON.parse(loadFixture(name)) as { result: { data: Record<string, unknown>[] } };
const sctx = (http: FakeHttp): SourceCtx => ({ http, today: "2026-10-09", log: () => {} });
const chunk = (from: string, to = from) => ({ id: from, from, to });

describe("东财事件数据：规范化与单位", () => {
  it("两融：金额元、RZYEZB 原样 %、SZ = 流通市值（ETF 为空）；按交易所数原始行", async () => {
    const http = new FakeHttp([emReportRoute("RPTA_WEB_RZRQ_GGMX", loadFixture("em-rzrq-2026-09-29.json"))]);
    const r = await EASTMONEY_EVENTS.margin.fetchChunk(sctx(http), chunk("2026-09-29"));
    expect(r.rawCount).toBe(5);
    expect(r.byExchange).toEqual({ sh: 3, sz: 2 });
    const rows = r.rows as MarginRow[];
    expect(rows.find((x) => x.code === "600519.SH")).toEqual({
      code: "600519.SH",
      date: "2026-09-29",
      rzye: 17233521533,
      rzmre: 905000000,
      rzche: 887000000,
      rqye: 101000000,
      rqyl: 70300,
      floatMcap: 1573377704650,
      rzyezb: 1.09532005,
    });
    expect(rows.find((x) => x.code === "510050.SH")!.floatMcap).toBeNull();
    // 只请求列清单，过滤是那一个交易日，排序 SECUCODE
    const q = new URL(http.calls[0]!.url).searchParams;
    expect(q.get("columns")).toBe(MARGIN_DEF.columns.join(","));
    expect(q.get("filter")).toBe("(DATE='2026-09-29')");
    expect(q.get("sortColumns")).toBe("SECUCODE");
    expect(q.get("pageSize")).toBe("500");
  });

  it("股东户数：截至日与公告日分开，户数是计数", async () => {
    const http = new FakeHttp([emReportRoute("RPT_HOLDERNUM_DET", loadFixture("em-holdernum.json"))]);
    const r = await EASTMONEY_EVENTS.holders.fetchChunk(sctx(http), chunk("2026-08-01", "2026-08-31"));
    expect((r.rows as HolderRow[])[0]).toEqual({
      code: "000603.SZ",
      endDate: "2026-06-30",
      noticeDate: "2026-08-01",
      holderNum: 66961,
      preHolderNum: 74197,
      preEndDate: "2026-05-29",
    });
    const q = new URL(http.calls[0]!.url).searchParams;
    expect(q.get("sortColumns")).toBe("HOLD_NOTICE_DATE,SECUCODE,END_DATE");
    expect(q.get("sortTypes")).toBe("1,1,1");
    expect(q.get("filter")).toBe("(HOLD_NOTICE_DATE>='2026-08-01')(HOLD_NOTICE_DATE<='2026-08-31')");
  });

  it("户数：没有公告日、户数不是正数的行跳过", async () => {
    const rows = fx("em-holdernum.json").result.data;
    const bad = [
      { ...rows[0], HOLD_NOTICE_DATE: null },
      { ...rows[1], HOLDER_NUM: 0 },
    ];
    const http = new FakeHttp([emReportRoute("RPT_HOLDERNUM_DET", emPage(bad))]);
    const r = await EASTMONEY_EVENTS.holders.fetchChunk(sctx(http), chunk("2026-08-01", "2026-08-31"));
    expect(r).toMatchObject({ rawCount: 2, rows: [] });
  });

  it("限售解禁：万股 × 1e4；占流通比例按股数算成解禁前口径（解禁日过了的行也一样）；类型为空记「未知」", async () => {
    const rows = fx("em-lift-stage.json").result.data;
    const http = new FakeHttp([
      emReportRoute("RPT_LIFT_STAGE", emPage([...rows, { ...rows[1], SECUCODE: "002151.SZ", FREE_SHARES_TYPE: null }])),
    ]);
    const r = (await EASTMONEY_EVENTS.lockups.fetchChunk(sctx(http), chunk("2013-01-01", "2027-12-31")))
      .rows as LockupRow[];
    const x = r.find((l) => l.code === "301358.SZ")!;
    expect(x.unlockShares).toBeCloseTo(82_537_493, 3);
    expect(x.ableShares).toBeCloseTo(82_537_493, 3);
    expect(x.floatAfter).toBeCloseTo(845_815_647, 3);
    // 本次 ÷（FREE_SHARES − 本次）= 8253.7493 ÷ 76327.8154，和解禁日没到时东财给的 FREE_RATIO 一致
    expect(x.ratioFloat).toBeCloseTo(0.108135536917, 12);
    expect(x.ratioTotal).toBe(0.097582);
    expect(x.type).toBe("定向增发机构配售股份");
    expect(r.find((l) => l.code === "002151.SZ")!.type).toBe("未知");
    expect(r.find((l) => l.code === "300005.SZ")).toMatchObject({ freeDate: "2013-01-04", type: "首发原股东限售股份" });
    // 2016 年已过解禁日的实测行：FREE_RATIO 0.5828 = 本次 ÷ FREE_SHARES（解禁后口径），入库的仍是 4656.5 ÷ 3334
    const past = r.find((l) => l.code === "300465.SZ")!;
    expect(past).toMatchObject({ freeDate: "2016-06-01", unlockShares: 46_565_000, floatAfter: 79_905_000, ratioTotal: null });
    expect(past.ratioFloat).toBeCloseTo(4656.5 / 3334, 12);
    expect(past.ratioFloat).not.toBeCloseTo(0.582754520994, 2);
  });

  it("同一笔解禁过了解禁日被东财改写（FREE_RATIO 换成解禁后口径）：入库的比例不变", async () => {
    const before = fx("em-lift-stage.json").result.data[2]!;
    // 2026-10-10 实测：301358.SZ 解禁日（2026-10-09）过后同一行的 FREE_RATIO 从 0.108135536917 变成 0.097583312975 = 本次 ÷ FREE_SHARES
    const after = { ...before, FREE_RATIO: 0.097583312975 };
    const ratio = async (row: object) => {
      const http = new FakeHttp([emReportRoute(LOCKUPS_DEF.report, emPage([row]))]);
      const r = await EASTMONEY_EVENTS.lockups.fetchChunk(sctx(http), chunk("2026-01-01", "2026-12-31"));
      return (r.rows as LockupRow[])[0]!.ratioFloat;
    };
    expect(await ratio(after)).toBe(await ratio(before));
    expect(await ratio(after)).toBeCloseTo(8253.7493 / (84581.5647 - 8253.7493), 12);
  });

  it("解禁股数或解禁后流通股缺了、或解禁后流通股不大于本次：比例为空，不退回用 FREE_RATIO", () => {
    const row = fx("em-lift-stage.json").result.data[2] as EmRow;
    const bad: EmRow[] = [
      { CURRENT_FREE_SHARES: null },
      { FREE_SHARES: null },
      { FREE_SHARES: row.CURRENT_FREE_SHARES! },
      { FREE_SHARES: 100 },
    ];
    for (const b of bad) expect(LOCKUPS_DEF.mapRow({ ...row, ...b })!.ratioFloat).toBeNull();
  });

  it("大宗交易：折溢价是比例、成交额元、买方机构专用", async () => {
    const http = new FakeHttp([emReportRoute("RPT_DATA_BLOCKTRADE", loadFixture("em-blocktrade.json"))]);
    const r = (await EASTMONEY_EVENTS.blocks.fetchChunk(sctx(http), chunk("2026-09-29", "2026-09-30")))
      .rows as BlockRow[];
    expect(r[0]).toMatchObject({ code: "001309.SZ", premium: 0, buyerInst: false, sellerInst: false });
    expect(r[1]).toEqual({
      code: "001366.SZ",
      tradeDate: "2026-09-29",
      dealPrice: 11.84,
      closePrice: 13.13,
      premium: -0.098248286367,
      dealVolume: 500000,
      dealAmount: 5920000,
      buyerInst: true,
      sellerInst: false,
    });
    expect(r).toHaveLength(3);
  });

  it("两笔完全相同的大宗（同价同量、买卖席位都一样）：重取一次、两次一样 → 都留下，不算翻页漂移", async () => {
    const http = new FakeHttp([emReportRoute("RPT_DATA_BLOCKTRADE", loadFixture("em-blocktrade-identical.json"))]);
    const logs: string[] = [];
    const r = await EASTMONEY_EVENTS.blocks.fetchChunk(
      { ...sctx(http), log: (m) => logs.push(m) },
      chunk("2026-09-29", "2026-09-30"),
    );
    expect(r.rawCount).toBe(3);
    expect(r.requests).toBe(2);
    const rows = r.rows as BlockRow[];
    expect(rows.filter((x) => x.code === "001366.SZ")).toHaveLength(2);
    expect(rows[1]).toEqual(rows[2]);
    expect(logs.some((m) => m.includes("1 行与别的行完全相同"))).toBe(true);
  });

  it("没给 PREMIUM_RATIO 时按成交价 ÷ 收盘 − 1 算", async () => {
    const row = { ...fx("em-blocktrade.json").result.data[1], PREMIUM_RATIO: null };
    const http = new FakeHttp([emReportRoute("RPT_DATA_BLOCKTRADE", emPage([row]))]);
    const r = (await EASTMONEY_EVENTS.blocks.fetchChunk(sctx(http), chunk("2026-09-29"))).rows as BlockRow[];
    expect(r[0]!.premium).toBeCloseTo(11.84 / 13.13 - 1, 12);
  });

  it("请求过的键缺失 → SchemaDriftError（结构变了）", async () => {
    const rows = fx("em-rzrq-2026-09-29.json").result.data.map((r) => {
      const { RZYEZB: _drop, ...rest } = r;
      return rest;
    });
    const http = new FakeHttp([emReportRoute("RPTA_WEB_RZRQ_GGMX", emPage(rows))]);
    const err = await EASTMONEY_EVENTS.margin.fetchChunk(sctx(http), chunk("2026-09-29")).catch((e) => e);
    expect(err).toBeInstanceOf(SchemaDriftError);
    expect(err.message).toBe("两融明细缺少字段 RZYEZB");
  });
});

describe("列清单断言", () => {
  const base = { report: "RPT_X", forbidden: [] as string[] };
  it.each([["LIFT_MARKET_CAP"], ["CHANGE_RATE_5DAYS"], ["NEW"], ["ALL"], ["B20_ADJCHRATE"], ["ALIFT_MARKET_CAP"]])(
    "%s 不能出现在列清单里",
    (col) => {
      expect(() => assertColumns({ ...base, columns: ["SECUCODE", col] })).toThrow();
    },
  );
  it("空清单与报表自己的禁用列也不行；四个报表的常量都合规", () => {
    expect(() => assertColumns({ ...base, columns: [] })).toThrow("列清单是空的");
    expect(() => assertColumns({ ...base, columns: ["CLOSE_PRICE"], forbidden: ["CLOSE_PRICE"] })).toThrow(
      "禁用列 CLOSE_PRICE",
    );
    for (const def of Object.values(EM_EVENT_DEFS)) expect(() => assertColumns(def)).not.toThrow();
  });
});

describe("金丝雀（D82）", () => {
  const routesOk = () => [
    emReportRoute("RPTA_WEB_RZRQ_GGMX", ({ url }) => {
      const rows = fx("em-rzrq-2026-09-29.json").result.data.filter((r) => r.SECUCODE === "600519.SH");
      // 上一个交易日（10-08）往前 15 天起、600519.SH 最近一条
      expect(new URL(url).searchParams.get("filter")).toBe(
        `(DATE>='2026-09-23')(DATE<='2026-10-09')(SECUCODE="600519.SH")`,
      );
      return emPage(rows);
    }),
    emReportRoute("RPT_HOLDERNUM_DET", loadFixture("em-holdernum.json")),
    emReportRoute("RPT_LIFT_STAGE", loadFixture("em-lift-stage.json")),
    emReportRoute("RPT_DATA_BLOCKTRADE", loadFixture("em-blocktrade.json")),
  ];

  it("四个报表各一次请求、取 5 行样本、同一份列常量；字段与单位都对 → ok", async () => {
    const http = new FakeHttp(routesOk());
    for (const id of ["margin", "holders", "lockups", "blocks"] as const) {
      const c = await EASTMONEY_EVENTS[id].canary(sctx(http), "2026-10-09", "2026-10-08");
      expect(c).toMatchObject({ status: "ok", source: "eastmoney" });
    }
    expect(http.calls).toHaveLength(4);
    for (const call of http.calls) {
      const q = new URL(call.url).searchParams;
      expect(q.get("pageSize")).toBe("5");
      const def = Object.values(EM_EVENT_DEFS).find((d) => d.report === q.get("reportName"))!;
      expect(q.get("columns")).toBe(def.columns.join(","));
    }
    // 两融样本按日期倒序、户数样本按截至日倒序
    const m = new URL(http.calls[0]!.url).searchParams;
    expect([m.get("sortColumns"), m.get("sortTypes")]).toEqual(["DATE", "-1"]);
    const h = new URL(http.calls[1]!.url).searchParams;
    expect([h.get("sortColumns"), h.get("sortTypes")]).toEqual(["END_DATE", "-1"]);
    expect(eventColumnViolations(http.calls)).toEqual([]);
  });

  it("两融：上一个交易日还没公布（周六取 10-09 回 9201）→ 取 600519.SH 最近一条已公布的，照样 ok；窗口里一条都没有才出错", async () => {
    // 2026-10-10（周六）实测：DATE='2026-10-09' 回 9201；600519.SH 最近两条是 10-08 与 09-30（SZ 没记，按 RZYE ÷ RZYEZB 反推）
    const base = fx("em-rzrq-2026-09-29.json").result.data.find((r) => r.SECUCODE === "600519.SH")!;
    const latest = { ...base, DATE: "2026-10-08 00:00:00", RZYE: 17229986025, SZ: 1569839975321, RZYEZB: 1.09756321 };
    const rows = [{ ...base, DATE: "2026-09-30 00:00:00" }, latest];
    const http = new FakeHttp([emEventsServer({ RPTA_WEB_RZRQ_GGMX: rows })]);
    expect(await EASTMONEY_EVENTS.margin.canary(sctx(http), "2026-10-10", "2026-10-09")).toMatchObject({
      status: "ok",
      detail: "字段与单位正常",
    });
    const q = new URL(http.calls[0]!.url).searchParams;
    expect(q.get("filter")).toBe(`(DATE>='2026-09-24')(DATE<='2026-10-10')(SECUCODE="600519.SH")`);
    expect([q.get("sortColumns"), q.get("sortTypes")]).toEqual(["DATE", "-1"]);
    // 核对的是最新那条（10-08）：只把它的 RZYEZB 改成两倍就报单位异常
    const drifted = new FakeHttp([
      emEventsServer({ RPTA_WEB_RZRQ_GGMX: [rows[0]!, { ...latest, RZYEZB: latest.RZYEZB * 2 }] }),
    ]);
    expect((await EASTMONEY_EVENTS.margin.canary(sctx(drifted), "2026-10-10", "2026-10-09")).status).toBe("unit_drift");
    const old = new FakeHttp([emEventsServer({ RPTA_WEB_RZRQ_GGMX: [{ ...base, DATE: "2026-09-01 00:00:00" }] })]);
    expect(await EASTMONEY_EVENTS.margin.canary(sctx(old), "2026-10-10", "2026-10-09")).toMatchObject({
      status: "error",
      detail: "样本没有返回数据",
    });
  });

  it("RZYEZB 被改成两倍 → unit_drift", async () => {
    const row = fx("em-rzrq-2026-09-29.json").result.data.find((r) => r.SECUCODE === "600519.SH")!;
    const http = new FakeHttp([
      emReportRoute("RPTA_WEB_RZRQ_GGMX", emPage([{ ...row, RZYEZB: (row.RZYEZB as number) * 2 }])),
    ]);
    const c = await EASTMONEY_EVENTS.margin.canary(sctx(http), "2026-10-09", "2026-10-08");
    expect(c).toMatchObject({ status: "unit_drift", detail: "融资余额占流通市值对不上（单位可能变了）" });
  });

  it("解禁股数单位变了（FREE_RATIO 对不上）→ unit_drift", async () => {
    const row = fx("em-lift-stage.json").result.data[2]!;
    const http = new FakeHttp([
      emReportRoute(LOCKUPS_DEF.report, emPage([{ ...row, CURRENT_FREE_SHARES: (row.CURRENT_FREE_SHARES as number) * 1e4 }])),
    ]);
    const c = await EASTMONEY_EVENTS.lockups.canary(sctx(http), "2026-10-09", "2026-10-08");
    expect(c.status).toBe("unit_drift");
  });

  it("解禁 FREE_RATIO 两种分母都认：解禁日过了的（本次 ÷ FREE_SHARES）与还没到的（本次 ÷（FREE_SHARES − 本次））；两种都对不上才 unit_drift", async () => {
    const rows = fx("em-lift-stage.json").result.data;
    const canary = (row: object) =>
      EASTMONEY_EVENTS.lockups.canary(
        sctx(new FakeHttp([emReportRoute(LOCKUPS_DEF.report, emPage([row]))])),
        "2026-10-10",
        "2026-10-09",
      );
    // 2016-06-01 已过解禁日的实测行：0.582754520994 = 4656.5 ÷ 7990.5（2026-10-10 线上的金丝雀就是在这种行上报了单位异常）
    expect(await canary(rows[3]!)).toMatchObject({ status: "ok", detail: "字段与单位正常" });
    // 还没到的：0.108135536917 = 8253.7493 ÷（84581.5647 − 8253.7493）；同一行过了解禁日改写成 0.097583312975 也认
    expect((await canary(rows[2]!)).status).toBe("ok");
    expect((await canary({ ...rows[2]!, FREE_RATIO: 0.097583312975 })).status).toBe("ok");
    // 比例变成 %（× 100）：两种分母都对不上
    for (const row of [rows[2]!, rows[3]!]) {
      expect(await canary({ ...row, FREE_RATIO: (row.FREE_RATIO as number) * 100 })).toMatchObject({
        status: "unit_drift",
        detail: "解禁占流通比例对不上（单位可能变了）",
      });
    }
  });

  it("第一行缺比例（最新的解禁常缺 FREE_RATIO）：换下一行核对；都缺时只说没能核对，不算单位变了", async () => {
    const rows = fx("em-lift-stage.json").result.data;
    const noRatio = { ...rows[2]!, FREE_RATIO: null };
    const mixed = new FakeHttp([emReportRoute(LOCKUPS_DEF.report, emPage([noRatio, rows[2]!]))]);
    expect((await EASTMONEY_EVENTS.lockups.canary(sctx(mixed), "2026-10-09", "2026-10-08")).status).toBe("ok");
    const drifted = new FakeHttp([
      emReportRoute(LOCKUPS_DEF.report, emPage([noRatio, { ...rows[2]!, CURRENT_FREE_SHARES: (rows[2]!.CURRENT_FREE_SHARES as number) * 1e4 }])),
    ]);
    expect((await EASTMONEY_EVENTS.lockups.canary(sctx(drifted), "2026-10-09", "2026-10-08")).status).toBe("unit_drift");
    const allMissing = new FakeHttp([emReportRoute(LOCKUPS_DEF.report, emPage([noRatio, noRatio]))]);
    const c = await EASTMONEY_EVENTS.lockups.canary(sctx(allMissing), "2026-10-09", "2026-10-08");
    expect(c).toMatchObject({ status: "ok", detail: "字段正常；样本行缺少解禁股数或比例，没能核对单位" });
  });

  it("9501 → schema_drift，详情里没有 URL 与查询串", async () => {
    const http = new FakeHttp([emReportRoute("RPT_HOLDERNUM_DET", loadFixture("em-9501-schema-drift.json"))]);
    const c = await EASTMONEY_EVENTS.holders.canary(sctx(http), "2026-10-09", "2026-10-08");
    expect(c.status).toBe("schema_drift");
    expect(c.detail).toContain("字段不存在");
    expect(c.detail).not.toMatch(/https?:|reportName|\?/);
  });

  it("9201 空结果：大宗、解禁算 empty（通过），两融、户数不行", async () => {
    const http = new FakeHttp([{ match: /datacenter-web/, reply: loadFixture("em-9201-empty.json") }]);
    const st = async (id: "margin" | "holders" | "lockups" | "blocks") =>
      (await EASTMONEY_EVENTS[id].canary(sctx(http), "2026-10-09", "2026-10-08")).status;
    expect(await st("blocks")).toBe("empty");
    expect(await st("lockups")).toBe("empty");
    expect(await st("margin")).toBe("error");
    expect(await st("holders")).toBe("error");
  });

  it("被风控 → blocked；连不上 → error，详情不带地址", async () => {
    const blocked = new FakeHttp([{ match: /datacenter-web/, block: { untilMs: Date.now() + 60_000 } }]);
    expect((await EASTMONEY_EVENTS.blocks.canary(sctx(blocked), "2026-10-09", "2026-10-08")).status).toBe("blocked");
    const down = new FakeHttp([]);
    const c = await EASTMONEY_EVENTS.blocks.canary(sctx(down), "2026-10-09", "2026-10-08");
    expect(c.status).toBe("error");
    expect(c.detail).not.toMatch(/https?:/);
  });
});

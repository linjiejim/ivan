/**
 * 夜间的事件数据软步骤（D81、D82，验收 19）：A 股在财报之后、因子之前同步四个数据集，结果进 completeness.soft 与
 * completeness.datasets、台账进 data_versions.sources；金丝雀失败不让整晚失败；港股不发事件请求；周检补扫记 lateRows。
 */
import { afterEach, describe, expect, it } from "vitest";
import { committedAsOf } from "../query/backtest.ts";
import { softStepStatus } from "../query/data-health.ts";
import { emEventsServer, eventColumnViolations } from "../testing/events.ts";
import { FakeHttp, loadFixture } from "../testing/fake-http.ts";
import { A_INDEX_SECIDS, emDailyRoute } from "../testing/nightly.ts";
import { seedSyntheticMarket } from "../testing/seed.ts";
import { Warehouse } from "../warehouse/db.ts";
import type { Completeness } from "./completeness.ts";
import { daily, weeklyCheck } from "./pipeline.ts";

type Row = Record<string, string | number | null>;
const fx = (name: string) => (JSON.parse(loadFixture(name)) as { result: { data: Row[] } }).result.data;
const marginOn = (d: string) => fx("em-rzrq-2026-09-29.json").map((r) => ({ ...r, DATE: `${d} 00:00:00` }));

let wh: Warehouse;
afterEach(() => wh.close());

async function seedA() {
  wh = await Warehouse.open(":memory:");
  // 2026-09-21 起 14 个工作日（最后一天 10-08）
  await seedSyntheticMarket(wh, {
    market: "A",
    start: "2026-09-21",
    days: 14,
    stocks: ["600519.SH", "000001.SZ", "000002.SZ", "688981.SH", "001366.SZ", "301358.SZ", "000603.SZ"].map(
      (code) => ({ code, name: code, close: () => 10 }),
    ),
  });
}

function eventData(): Record<string, Row[]> {
  return {
    RPTA_WEB_RZRQ_GGMX: [...marginOn("2026-10-07"), ...marginOn("2026-10-08")],
    RPT_HOLDERNUM_DET: [
      {
        SECUCODE: "600519.SH",
        END_DATE: "2026-09-30 00:00:00",
        HOLD_NOTICE_DATE: "2026-10-01 00:00:00",
        HOLDER_NUM: 160000,
        PRE_HOLDER_NUM: 200000,
        PRE_END_DATE: "2026-06-30 00:00:00",
        HOLDER_NUM_RATIO: -20,
      },
    ],
    RPT_LIFT_STAGE: fx("em-lift-stage.json"),
    RPT_DATA_BLOCKTRADE: fx("em-blocktrade.json").map((r) => ({ ...r, TRADE_DATE: "2026-10-08 00:00:00" })),
  };
}

const nightHttp = (data: Record<string, Row[]>, override?: Parameters<typeof emEventsServer>[1]) =>
  new FakeHttp([
    { match: /qt\.gtimg\.cn/, status: 500 },
    { match: /RPT_F10_FINANCE_MAINFINADATA|RPT_F10_EH_EQUITY/, reply: { result: { data: [], pages: 1 } } },
    emEventsServer(data, override),
    emDailyRoute({
      ...A_INDEX_SECIDS,
      "1.600519": 10,
      "0.000001": 10,
      "0.000002": 10,
      "1.688981": 10,
      "0.001366": 10,
      "0.301358": 10,
      "0.000603": 10,
    }),
  ]);

describe("夜间的事件数据软步骤", () => {
  it("财报之后、因子之前同步四个数据集；结果进 soft、datasets 与台账；行盖今晚的版本号", async () => {
    await seedA();
    const http = nightHttp(eventData());
    const logs: string[] = [];
    const r = await daily({ wh, http, today: "2026-10-09", log: (m) => logs.push(m) }, "A");
    const c = r.completeness!;
    expect(c.ok).toBe(true);
    for (const step of ["margin", "holders", "lockups", "blocks"]) {
      expect(c.soft!.find((s) => s.step === step)).toMatchObject({ ok: true });
    }
    expect(c.datasets!.margin).toMatchObject({ ok: true, canary: "ok", partial: [] });
    // 001309.SZ 不在证券表里：丢掉
    expect(c.datasets!.blocks).toMatchObject({ ok: true, canary: "ok", rows: 2 });
    // 顺序：财报 → 事件 → 因子
    const at = (re: RegExp) => logs.findIndex((l) => re.test(l));
    expect(at(/财报增量/)).toBeGreaterThanOrEqual(0);
    expect(at(/财报增量/)).toBeLessThan(at(/^两融明细（nightly）/));
    expect(at(/^大宗交易（nightly）/)).toBeLessThan(at(/^因子 A：/));
    const firstEvent = http.calls.findIndex((x) =>
      /RPTA_WEB_RZRQ_GGMX|RPT_HOLDERNUM_DET|RPT_LIFT_STAGE|RPT_DATA_BLOCKTRADE/.test(x.url),
    );
    const lastFin = http.calls.map((x) => /RPT_F10_/.test(x.url)).lastIndexOf(true);
    expect(lastFin).toBeLessThan(firstEvent);
    // 行盖今晚的版本号；批次记在 pit_batches
    expect(await wh.all(`SELECT DISTINCT ver FROM margin_daily`)).toEqual([{ ver: r.dataVersion }]);
    expect(
      await wh.one(`SELECT kind, data_version, status, datasets FROM pit_batches`),
    ).toEqual({ kind: "nightly", data_version: r.dataVersion, status: "ok", datasets: "margin,holders,lockups,blocks" });
    const sources = JSON.parse(
      (await wh.scalar<string>(`SELECT sources FROM data_versions WHERE id = $id`, { id: r.dataVersion! }))!,
    );
    expect(sources.v).toBe(2);
    expect(sources.datasets.margin).toMatchObject({ servedBy: "em", rows: 8 });
    expect(Object.keys(sources.datasets)).toEqual(["margin", "holders", "lockups", "blocks"]);
    expect(eventColumnViolations(http.calls)).toEqual([]);
    expect(await committedAsOf(wh, "A")).toBe("2026-10-09");
  });

  it("两融接口字段变了（9501）：两融这晚不删不写，整晚照常提交；连续 3 晚失败看得到", async () => {
    await seedA();
    const nights = ["2026-10-09", "2026-10-12", "2026-10-13"];
    const data = eventData();
    data.RPTA_WEB_RZRQ_GGMX!.push(...marginOn("2026-10-09"), ...marginOn("2026-10-12"));
    // 第一晚之前已有的两融行
    await daily({ wh, http: nightHttp(data), today: "2026-10-09", log: () => {} }, "A");
    const before = Number(await wh.scalar(`SELECT count(*) FROM margin_daily`));
    expect(before).toBeGreaterThan(0);
    const drift = (report: string) =>
      report === "RPTA_WEB_RZRQ_GGMX" ? loadFixture("em-9501-schema-drift.json") : undefined;
    for (const today of nights.slice(1).concat("2026-10-14")) {
      const r = await daily({ wh, http: nightHttp(data, drift), today, log: () => {} }, "A");
      const c = r.completeness as Completeness;
      expect(c.ok).toBe(true);
      expect(c.soft!.find((s) => s.step === "margin")).toMatchObject({ ok: false });
      expect(c.soft!.find((s) => s.step === "margin")!.error).toMatch(/^东财「两融明细」接口字段变了：.*今晚没更新$/);
      expect(c.soft!.find((s) => s.step === "blocks")).toMatchObject({ ok: true });
      expect(c.datasets!.margin).toMatchObject({ ok: false, canary: "schema_drift", rows: 0 });
      expect(await committedAsOf(wh, "A")).toBe(today);
    }
    expect(Number(await wh.scalar(`SELECT count(*) FROM margin_daily`))).toBe(before);
    expect(await wh.scalar(`SELECT last_status FROM pit_sync WHERE dataset = 'margin'`)).toBe("canary_failed");
    expect((await softStepStatus(wh, "A")).find((s) => s.step === "margin")).toMatchObject({
      failingNights: 3,
      lastOkDate: "2026-10-09",
    });
  });

  it("港股不发任何事件请求", async () => {
    wh = await Warehouse.open(":memory:");
    await seedSyntheticMarket(wh, {
      market: "HK",
      start: "2026-09-21",
      days: 14,
      stocks: [{ code: "00700.HK", name: "腾讯控股", close: () => 400 }],
    });
    const http = new FakeHttp([
      { match: /qt\.gtimg\.cn/, status: 500 },
      emDailyRoute({ "100.HSI": 20000, "116.02800": 20, "116.00700": 400 }),
    ]);
    await daily({ wh, http, today: "2026-10-09", log: () => {} }, "HK").catch(() => undefined);
    expect(http.calls.length).toBeGreaterThan(0);
    expect(http.calls.some((c) => /RPTA_WEB_RZRQ_GGMX|RPT_HOLDERNUM_DET|RPT_LIFT_STAGE|RPT_DATA_BLOCKTRADE/.test(c.url))).toBe(
      false,
    );
    expect(Number(await wh.scalar(`SELECT count(*) FROM pit_batches`))).toBe(0);
  });
});

describe("周检的更宽补扫", () => {
  it("东财晚入库的行由周检补上，新找到的行数记进那次检查版本的 lateRows", async () => {
    await seedA();
    const data = eventData();
    await daily({ wh, http: nightHttp(data), today: "2026-10-09", log: () => {} }, "A");
    // 夜间窗口（近 14 天）之外、120 天之内晚入库的一行户数，30 天内晚入库的一笔大宗
    data.RPT_HOLDERNUM_DET!.push({
      SECUCODE: "000603.SZ",
      END_DATE: "2026-06-30 00:00:00",
      HOLD_NOTICE_DATE: "2026-08-01 00:00:00",
      HOLDER_NUM: 66961,
      PRE_HOLDER_NUM: 74197,
      PRE_END_DATE: "2026-05-29 00:00:00",
      HOLDER_NUM_RATIO: -9.752415866,
    });
    data.RPT_DATA_BLOCKTRADE!.push({ ...fx("em-blocktrade.json")[1]!, TRADE_DATE: "2026-09-21 00:00:00" });
    await weeklyCheck({ wh, http: nightHttp(data), today: "2026-10-09", log: () => {} }, "A", 1);
    const c = JSON.parse(
      (await wh.scalar<string>(`SELECT completeness FROM data_versions WHERE kind = 'check'`))!,
    ) as Completeness;
    expect(c.datasets!.holders).toMatchObject({ ok: true, lateRows: 1 });
    expect(c.datasets!.blocks).toMatchObject({ ok: true, lateRows: 1 });
    expect(c.datasets!.lockups).toMatchObject({ ok: true, lateRows: 0 });
    // 两融没有要补扫的段：周检不跑它（不花金丝雀请求、不改写夜间记下的同步状态）
    expect(c.datasets!.margin).toBeUndefined();
    expect(await wh.scalar(`SELECT datasets FROM pit_batches ORDER BY id DESC LIMIT 1`)).toBe("holders,lockups,blocks");
    expect(
      await wh.scalar(`SELECT kind FROM pit_batches ORDER BY id DESC LIMIT 1`),
    ).toBe("check");
    // 周检的版本不算一晚：连续失败统计不受影响
    expect((await softStepStatus(wh, "A")).find((s) => s.step === "holders")).toMatchObject({ failingNights: 0 });
  });
});

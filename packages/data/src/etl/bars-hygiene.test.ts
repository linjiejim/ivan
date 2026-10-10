/**
 * 写入日线时的体检（D74）：坏行不入库、记数据问题与 bar_status 缺失；好行照写；
 * 同一（代码, 日期）后来重写且没再触发同一条规则时，之前版本的问题记为已解决（refetch）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeHttp } from "../testing/fake-http.ts";
import { Warehouse } from "../warehouse/db.ts";
import { type BarRow, fetchBars, type FetchedBars, writeBars } from "./bars.ts";
import type { EtlContext } from "./context.ts";

let wh: Warehouse;
beforeEach(async () => {
  wh = await Warehouse.open(":memory:");
  await wh.run(
    `INSERT INTO trade_calendar (market, date) VALUES
       ('A', DATE '2026-09-24'), ('A', DATE '2026-09-25'), ('A', DATE '2026-09-28'),
       ('A', DATE '2026-09-29'), ('A', DATE '2026-09-30')`,
  );
});
afterEach(() => wh.close());

const ctxOf = (http: FakeHttp, ver: number): EtlContext => ({
  wh,
  http,
  today: "2026-09-30",
  log: () => {},
  ver,
});

/** 东财日 K 一行：日期,开,收,高,低,成交量（手）,成交额,振幅,涨跌幅,涨跌额 */
const k = (d: string, o: number, c: number, h: number, l: number, chg: number) =>
  `${d},${o},${c},${h},${l},1000,${c * 1000 * 100},0,0,${chg}`;

const issues = () =>
  wh.all<{ date: string; rule: string; severity: string; ver: number; src: string; resolved_ver: number | null; resolved_by: string | null }>(
    `SELECT date::VARCHAR AS date, rule, severity, ver, src, resolved_ver, resolved_by FROM data_issues ORDER BY id`,
  );

describe("writeBars 的体检", () => {
  it("一行高价低于低价：其余行照写，这一行不入库，记 data_issues 与 bar_status 缺失 rejected:ohlc", async () => {
    const http = new FakeHttp([
      {
        match: /push2his\.eastmoney\.com/,
        reply: {
          rc: 0,
          data: {
            code: "600000",
            decimal: 2,
            klines: [
              k("2026-09-28", 10, 10, 10, 10, 0),
              k("2026-09-29", 10.1, 10.2, 9.9, 10.3, 0.2),
              k("2026-09-30", 10.2, 10.3, 10.3, 10.2, 0.1),
            ],
          },
        },
      },
    ]);
    const ctx = ctxOf(http, 3);
    const fetched = await fetchBars(ctx, "600000.SH", "2026-09-28", "2026-09-30");
    const r = await writeBars(ctx, "600000.SH", "2026-09-28", fetched);
    expect(r.accepted.map((x) => x[1])).toEqual(["2026-09-28", "2026-09-30"]);
    expect(await wh.all(`SELECT date::VARCHAR AS d FROM bars_daily ORDER BY d`)).toEqual([
      { d: "2026-09-28" },
      { d: "2026-09-30" },
    ]);
    expect(await issues()).toEqual([
      {
        date: "2026-09-29",
        rule: "ohlc",
        severity: "reject",
        ver: 3,
        src: "em",
        resolved_ver: null,
        resolved_by: null,
      },
    ]);
    expect(
      await wh.all(`SELECT code, date::VARCHAR AS d, status, reason, src, ver FROM bar_status`),
    ).toEqual([
      { code: "600000.SH", d: "2026-09-29", status: "missing", reason: "rejected:ohlc", src: "em", ver: 3 },
    ]);
  });

  it("R5 标记在版本 1 记下；版本 2 重写这一天且不再超限时关掉（refetch），缺失状态也删掉", async () => {
    const rows = (ver: number, close30: number): FetchedBars => ({
      source: "em",
      actions: [],
      rows: [
        ["600000.SH", "2026-09-28", 10, 10, 10, 10, 1000, 1e4, 1, "em", ver],
        ["600000.SH", "2026-09-29", 10, 10, 10, 10, 1100, 1e4, 1, "em", ver],
        ["600000.SH", "2026-09-30", close30, close30, close30, close30, 1200, 1e4, 1, "em", ver],
      ] satisfies BarRow[],
    });
    const http = new FakeHttp([]);
    await writeBars(ctxOf(http, 1), "600000.SH", "2026-09-28", rows(1, 11.5));
    expect(await issues()).toEqual([
      {
        date: "2026-09-30",
        rule: "limit_breach",
        severity: "flag",
        ver: 1,
        src: "em",
        resolved_ver: null,
        resolved_by: null,
      },
    ]);
    // 标记不阻断：这一天照样入库
    expect(Number(await wh.scalar(`SELECT count(*) FROM bars_daily`))).toBe(3);
    // 同一版本里重写同样的数据：问题不重复记，也不关
    await writeBars(ctxOf(http, 1), "600000.SH", "2026-09-28", rows(1, 11.5));
    expect(await issues()).toHaveLength(1);
    // 版本 2 重写成正常的数
    await wh.run(
      `INSERT INTO bar_status VALUES ('600000.SH', DATE '2026-09-30', 'missing', 'chain_failed', NULL, 1)`,
    );
    await writeBars(ctxOf(http, 2), "600000.SH", "2026-09-28", rows(2, 10.3));
    expect(await issues()).toEqual([
      {
        date: "2026-09-30",
        rule: "limit_breach",
        severity: "flag",
        ver: 1,
        src: "em",
        resolved_ver: 2,
        resolved_by: "refetch",
      },
    ]);
    expect(Number(await wh.scalar(`SELECT count(*) FROM bar_status`))).toBe(0);
  });

  it("版本 2 重写后仍然超限：问题保持未解决，不重复记", async () => {
    const fetched = (ver: number): FetchedBars => ({
      source: "em",
      actions: [],
      rows: [
        ["600000.SH", "2026-09-29", 10, 10, 10, 10, 1100, 1e4, 1, "em", ver],
        ["600000.SH", "2026-09-30", 11.5, 11.5, 11.5, 11.5, 1200, 1e4, 1, "em", ver],
      ],
    });
    await writeBars(ctxOf(new FakeHttp([]), 1), "600000.SH", "2026-09-29", fetched(1));
    await writeBars(ctxOf(new FakeHttp([]), 2), "600000.SH", "2026-09-29", fetched(2));
    expect(await issues()).toMatchObject([{ rule: "limit_breach", ver: 1, resolved_by: null }]);
  });
});

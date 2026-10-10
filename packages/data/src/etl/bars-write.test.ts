/**
 * 行级来源与版本（第 3 版）：日线、报价、公司行动、财报、股本的写入方都在表尾盖上 src、ver；
 * 财报首见留底只在（代码, 报告期, 数值指纹）第一次出现时追加。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeHttp } from "../testing/fake-http.ts";
import { Warehouse } from "../warehouse/db.ts";
import { fetchBars, updateBars, writeBars } from "./bars.ts";
import type { EtlContext, SecurityRow } from "./context.ts";
import { type FinTuple, writeFundamentals } from "./fundamentals.ts";

let wh: Warehouse;
beforeEach(async () => {
  wh = await Warehouse.open(":memory:");
});
afterEach(() => wh.close());

const ctxOf = (http: FakeHttp, ver: number | undefined = 5, today = "2026-09-30"): EtlContext => ({
  wh,
  http,
  today,
  log: () => {},
  ver,
});

/** 东财日 K 一行：日期,开,收,高,低,成交量（手）,成交额,振幅,涨跌幅,涨跌额 */
const k = (d: string, close: number, chg: number) =>
  `${d},${close},${close},${close},${close},1000,${close * 1000 * 100},0,0,${chg}`;

describe("日线写入盖章", () => {
  it("东财日 K：日线与公司行动的 src = em、ver = 当前版本", async () => {
    const http = new FakeHttp([
      {
        match: /push2his\.eastmoney\.com/,
        reply: {
          rc: 0,
          data: {
            code: "600000",
            decimal: 2,
            // 第三天除息：参考前收 9.5 ≠ 前一天收盘 10.2
            klines: [k("2026-09-28", 10, 0), k("2026-09-29", 10.2, 0.2), k("2026-09-30", 9.8, 0.3)],
          },
        },
      },
    ]);
    const ctx = ctxOf(http);
    const fetched = await fetchBars(ctx, "600000.SH", "2026-09-28", "2026-09-30");
    expect(fetched.source).toBe("em");
    expect(fetched.rows[0]).toHaveLength(11);
    await writeBars(ctx, "600000.SH", "2026-09-28", fetched);
    expect(await wh.all(`SELECT DISTINCT src, ver FROM bars_daily`)).toEqual([{ src: "em", ver: 5 }]);
    expect(
      await wh.all(`SELECT date::VARCHAR AS d, prev_close, ref_price, src, ver FROM corp_actions`),
    ).toEqual([{ d: "2026-09-30", prev_close: 10.2, ref_price: 9.5, src: "em", ver: 5 }]);
    // 成交量按成交额判断为「手」，换成股；其余列也没有错位
    expect(await wh.one(`SELECT close, volume, amount FROM bars_daily WHERE date = DATE '2026-09-29'`)).toEqual({
      close: 10.2,
      volume: 100_000,
      amount: 1_020_000,
    });
  });

  it("夜间报价：src = txq、ver = 当前版本", async () => {
    await wh.append("bars_daily", [
      ["600000.SH", "2026-09-29", 10, 10, 10, 10, 1e6, 1e7, 1.5, "em", 4],
    ]);
    await wh.run(
      `INSERT INTO securities (code, market, name, board) VALUES ('600000.SH', 'A', '浦发银行', 'main')`,
    );
    const f = Array.from({ length: 40 }, () => "0");
    f[3] = "10.3"; // 现价
    f[4] = "10"; // 前收
    f[5] = "10.1"; // 开
    f[6] = "5000"; // 成交量（手）
    f[30] = "20260930150003";
    f[33] = "10.4";
    f[34] = "10";
    f[35] = "10.3/5000/5150000";
    const http = new FakeHttp([{ match: /qt\.gtimg\.cn/, reply: `v_sh600000="${f.join("~")}";` }]);
    const sec: SecurityRow = {
      code: "600000.SH",
      market: "A",
      name: "浦发银行",
      board: "main",
      list_date: "1999-11-10",
      delist_date: null,
      lot_size: 100,
      industry_l1: null,
      industry: null,
      sec_type: null,
    };
    const r = await updateBars(ctxOf(http, 6), "A", [sec], "2026-09-30", "2026-09-29");
    expect(r.viaQuote).toBe(1);
    expect(
      await wh.one(`SELECT close, adj, src, ver FROM bars_daily WHERE date = DATE '2026-09-30'`),
    ).toEqual({ close: 10.3, adj: 1.5, src: "txq", ver: 6 });
  });
});

/** 一行 A 股财报（19 列，按 financials 的列序，不含表尾） */
function fin(report: string, np: number): FinTuple {
  return [
    "600000.SH",
    report,
    "FY",
    `${report.slice(0, 4)}-01-01`,
    "2026-04-20",
    "2026-04-20",
    "CNY",
    1e10,
    np,
    np * 0.9,
    0.05,
    0.03,
    0.02,
    0.1,
    null,
    null,
    5e9,
    6e10,
    2.9e10,
  ];
}

describe("财报与股本写入", () => {
  it("financials、share_changes 表尾 src = em、ver；financials_seen 只记新的（代码, 报告期, 数值指纹）", async () => {
    const http = new FakeHttp([]);
    const shares = [["600000.SH", "2025-12-31", "2026-01-05", 2.9e10, "定期报告"]];
    await writeFundamentals(ctxOf(http, 7, "2026-04-21"), "600000.SH", [fin("2025-12-31", 4e9)], shares);
    expect(await wh.all(`SELECT np, src, ver FROM financials`)).toEqual([{ np: 4e9, src: "em", ver: 7 }]);
    expect(await wh.all(`SELECT total_shares, reason, src, ver FROM share_changes`)).toEqual([
      { total_shares: 2.9e10, reason: "定期报告", src: "em", ver: 7 },
    ]);
    const seen = async () =>
      wh.all<{ report_date: string; first_seen: string; ver: number; row_json: string }>(
        `SELECT report_date::VARCHAR AS report_date, first_seen::VARCHAR AS first_seen, ver, row_json
         FROM financials_seen ORDER BY first_seen, report_date`,
      );
    expect(await seen()).toHaveLength(1);
    expect(JSON.parse((await seen())[0]!.row_json)).toMatchObject({
      report_date: "2025-12-31",
      period: "FY",
      np: 4e9,
      shares: 2.9e10,
    });
    // 第二天同样的数值：不新增；多了一期：只记新的那期
    await writeFundamentals(
      ctxOf(http, 8, "2026-04-22"),
      "600000.SH",
      [fin("2025-12-31", 4e9), fin("2026-03-31", 1e9)],
      null,
    );
    expect((await seen()).map((r) => [r.report_date, r.first_seen, r.ver])).toEqual([
      ["2025-12-31", "2026-04-21", 7],
      ["2026-03-31", "2026-04-22", 8],
    ]);
    // 年报被重述（净利改了）：同一报告期再记一条，原来那条保留
    await writeFundamentals(ctxOf(http, 9, "2026-05-10"), "600000.SH", [fin("2025-12-31", 3.8e9)], null);
    expect((await seen()).map((r) => [r.report_date, r.first_seen])).toEqual([
      ["2025-12-31", "2026-04-21"],
      ["2026-03-31", "2026-04-22"],
      ["2025-12-31", "2026-05-10"],
    ]);
    // 股本没传（null）时不动
    expect(await wh.scalar(`SELECT count(*) FROM share_changes`)).toBe(1);
  });

  it("财报行的列数不对：报错，且这只股票原有的财报不被删掉", async () => {
    const http = new FakeHttp([]);
    const shares = [["600000.SH", "2025-12-31", "2026-01-05", 2.9e10, "定期报告"]];
    await writeFundamentals(ctxOf(http, 7, "2026-04-21"), "600000.SH", [fin("2025-12-31", 4e9)], shares);
    const bad = [fin("2026-03-31", 1e9).slice(0, -1) as FinTuple];
    await expect(writeFundamentals(ctxOf(http, 8, "2026-04-22"), "600000.SH", bad, null)).rejects.toThrow(/财报行有/);
    expect(await wh.all(`SELECT np, ver FROM financials`)).toEqual([{ np: 4e9, ver: 7 }]);
    // 股本行同样先校验再删：列数不对时财报、股本都不动
    const badShares = [["600000.SH", "2026-03-31", "2026-04-02", 3e10]];
    await expect(
      writeFundamentals(ctxOf(http, 8, "2026-04-22"), "600000.SH", [fin("2026-03-31", 1e9)], badShares),
    ).rejects.toThrow(/股本行有/);
    expect(await wh.all(`SELECT np, ver FROM financials`)).toEqual([{ np: 4e9, ver: 7 }]);
    expect(await wh.all(`SELECT total_shares, ver FROM share_changes`)).toEqual([{ total_shares: 2.9e10, ver: 7 }]);
  });
});

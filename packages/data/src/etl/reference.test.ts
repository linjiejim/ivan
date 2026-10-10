/**
 * 指数更新（D24、D75）：中证官网全收益的解析、新加的指数第一次更新从 2013-01-01 拉全、
 * 全收益晚发布时用价格孪生临时补齐（新加的三对也覆盖）。全部离线：FakeHttp + 内存行情仓。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeHttp, type FakeRoute, loadFixture } from "../testing/fake-http.ts";
import { A_INDEX_SECIDS, emDailyRoute } from "../testing/nightly.ts";
import { seedSyntheticMarket } from "../testing/seed.ts";
import { Warehouse } from "../warehouse/db.ts";
import type { EtlContext } from "./context.ts";
import { DEFAULT_SINCE, fillProvisionalTr, PROVISIONAL_PAIRS, updateIndexes } from "./reference.ts";

let wh: Warehouse;
beforeEach(async () => {
  wh = await Warehouse.open(":memory:");
});
afterEach(() => wh.close());

/** 中证官网：H00905 回夹具，其余全收益代码回空 */
const CSINDEX: FakeRoute = {
  match: /csindex\.com\.cn/,
  reply: ({ url }) =>
    new URL(url).searchParams.get("indexCode") === "H00905"
      ? loadFixture("csindex-h00905.json")
      : { code: "200", msg: "Success", data: [] },
};
/** 东财价格指数：原来三个加上新的三个价格孪生 */
const EM = emDailyRoute({ ...A_INDEX_SECIDS, "1.000905": 6000, "1.000852": 6500, "1.000922": 5000 });

function ctxOf(http: FakeHttp, logs: string[], today = "2026-10-02"): EtlContext {
  return { wh, http, today, log: (m) => logs.push(m), ver: 7 };
}

const startOf = (http: FakeHttp, re: RegExp, key: "startDate" | "beg") =>
  http.calls.filter((c) => re.test(c.url)).map((c) => new URL(c.url).searchParams.get(key));

describe("中证官网全收益指数", () => {
  it("H00905 的夹具按 H00300 同样的方式解析：日期、收盘，src = csi，盖版本章", async () => {
    await seedSyntheticMarket(wh, { market: "A", start: "2026-09-21", days: 10, stocks: [] });
    const http = new FakeHttp([CSINDEX, EM]);
    const logs: string[] = [];
    await updateIndexes(ctxOf(http, logs), "A", "2026-09-21");
    const rows = await wh.all<{ d: string; close: number; provisional: boolean; src: string; ver: number }>(
      `SELECT date::VARCHAR AS d, close, provisional, src, ver FROM index_bars WHERE sym = 'csi500_tr' ORDER BY date`,
    );
    const fixture = JSON.parse(loadFixture("csindex-h00905.json")) as {
      data: Array<{ tradeDate: string; close: number }>;
    };
    expect(rows).toEqual(
      fixture.data.map((r) => ({
        d: `${r.tradeDate.slice(0, 4)}-${r.tradeDate.slice(4, 6)}-${r.tradeDate.slice(6, 8)}`,
        close: r.close,
        provisional: false,
        src: "csi",
        ver: 7,
      })),
    );
    // 价格孪生走东财
    expect(
      await wh.scalar(`SELECT count(*) FROM index_bars WHERE sym = 'csi500' AND src = 'em'`),
    ).toBeGreaterThan(0);
  });
});

describe("新加的指数第一次更新从 2013-01-01 拉全（D75）", () => {
  it("库里没有的指数从 DEFAULT_SINCE 请求，已有的只拉夜间窗口；日历只换窗口内的部分", async () => {
    // 合成市场只写了 csi300_tr / csi300 / sse；创业板指和三对新指数库里都没有
    await seedSyntheticMarket(wh, { market: "A", start: "2026-09-21", days: 10, stocks: [] });
    const calBefore = Number(await wh.scalar(`SELECT count(*) FROM trade_calendar WHERE market = 'A'`));
    const http = new FakeHttp([CSINDEX, EM]);
    const logs: string[] = [];
    await updateIndexes(ctxOf(http, logs), "A", "2026-09-28");

    expect(DEFAULT_SINCE).toBe("2013-01-01");
    expect(startOf(http, /indexCode=H00300/, "startDate")).toEqual(["20260928"]);
    for (const code of ["H00905", "H00852", "H00922"]) {
      expect(startOf(http, new RegExp(`indexCode=${code}`), "startDate")).toEqual(["20130101"]);
    }
    expect(startOf(http, /secid=1\.000300/, "beg")).toEqual(["20260928"]);
    expect(startOf(http, /secid=1\.000001/, "beg")).toEqual(["20260928"]);
    for (const secid of ["1.000905", "1.000852", "1.000922", "0.399006"]) {
      expect(startOf(http, new RegExp(`secid=${secid.replace(".", "\\.")}`), "beg")).toEqual([
        "20130101",
      ]);
    }
    expect(logs).toContain("指数 csi500_tr 第一次更新，从 2013-01-01 补齐");
    expect(logs).toContain("指数 csi1000 第一次更新，从 2013-01-01 补齐");
    expect(logs.some((l) => l.startsWith("指数 csi300 第一次更新"))).toBe(false);

    // 新指数拉回了 2013 年起的全段；日历没有因此多出 2013 年的日子
    expect(
      await wh.scalar<string>(`SELECT min(date)::VARCHAR FROM index_bars WHERE sym = 'csi500'`),
    ).toBe("2013-01-01");
    expect(Number(await wh.scalar(`SELECT count(*) FROM trade_calendar WHERE market = 'A'`))).toBe(
      calBefore,
    );

    // 第二晚：都有行了，只拉窗口
    const http2 = new FakeHttp([CSINDEX, EM]);
    await updateIndexes(ctxOf(http2, []), "A", "2026-09-28");
    expect(startOf(http2, /indexCode=H00905/, "startDate")).toEqual(["20260928"]);
    expect(startOf(http2, /secid=1\.000905/, "beg")).toEqual(["20260928"]);
  });
});

describe("全收益晚发布时的临时补齐（D24）", () => {
  it("新加的三对都在配对表里；csi500_tr 缺的日子按 csi500 的涨跌补齐并标 provisional", async () => {
    expect(PROVISIONAL_PAIRS.A).toEqual([
      ["csi300_tr", "csi300"],
      ["csi500_tr", "csi500"],
      ["csi1000_tr", "csi1000"],
      ["csi_div_tr", "csi_div"],
    ]);
    const { calendar } = await seedSyntheticMarket(wh, {
      market: "A",
      start: "2026-09-21",
      days: 10,
      stocks: [],
      index: { sse: () => 3000, csi500: (i) => 6000 + 60 * i },
    });
    // 全收益只到倒数第三天
    await wh.append(
      "index_bars",
      calendar.slice(0, -2).map((d, i) => ["csi500_tr", d, 9000 + 90 * i, false, "csi", 1]),
    );
    await fillProvisionalTr(ctxOf(new FakeHttp([]), []), "A");
    const rows = await wh.all<{ d: string; close: number; provisional: boolean; src: string }>(
      `SELECT date::VARCHAR AS d, close, provisional, src FROM index_bars
       WHERE sym = 'csi500_tr' AND date >= $d::DATE ORDER BY date`,
      { d: calendar.at(-3)! },
    );
    const lastTr = 9000 + 90 * 7;
    const px7 = 6000 + 60 * 7;
    expect(rows.map((r) => r.d)).toEqual(calendar.slice(-3));
    expect(rows[0]).toMatchObject({ provisional: false, close: lastTr });
    expect(rows[1]!.provisional).toBe(true);
    expect(rows[1]!.src).toBe("prov");
    expect(rows[1]!.close).toBeCloseTo((lastTr * (6000 + 60 * 8)) / px7, 6);
    expect(rows[2]!.close).toBeCloseTo((lastTr * (6000 + 60 * 9)) / px7, 6);
  });
});

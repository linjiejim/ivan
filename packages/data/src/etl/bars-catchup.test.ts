/**
 * 补数据能收敛（D111）：日线停在昨天之前、但中间每天都记着没成交的股票直接走报价（停牌续上）；逐股日 K 窗口里没有的日子
 * 记成没成交（窗口之后的那段要报价说之后没再成交过）；报价说今天有成交、日 K 里还没有今天的记缺失（kline_behind）；
 * 逐股补按日线停得最早的先补；缺得多时截至日提交到之前齐全的那天，下一晚接着补齐。
 */
import { type DateStr, MARKET_LABEL } from "@ivan/core";
import { afterEach, describe, expect, it } from "vitest";
import { catchUpState, committedAsOf } from "../query/backtest.ts";
import { FakeHttp, type FakeRoute } from "../testing/fake-http.ts";
import { A_INDEX_SECIDS, emDailyRoute, emSecidOf } from "../testing/nightly.ts";
import { seedSyntheticMarket, syntheticCalendar } from "../testing/seed.ts";
import { Warehouse } from "../warehouse/db.ts";
import { completeThrough, klineOrder, updateBars } from "./bars.ts";
import { loadSecurities } from "./context.ts";
import { daily } from "./pipeline.ts";

const CAL = syntheticCalendar("2026-09-21", 15); // … 10-06、10-07、10-08、10-09（今天）
const TODAY = CAL.at(-1)!;
const PREV = CAL.at(-2)!;
const idx = (d: DateStr) => CAL.indexOf(d);
const CODES = Array.from({ length: 10 }, (_, i) => `${600000 + i}.SH`);
const closeOf = (code: string) => 10 + CODES.indexOf(code);

let wh: Warehouse;
afterEach(() => wh.close());

/** 每只股票最后一根 K 线在哪天（没列的到昨天） */
async function market(lastBar: Record<string, DateStr>): Promise<void> {
  wh = await Warehouse.open(":memory:");
  await seedSyntheticMarket(wh, {
    market: "A",
    start: CAL[0]!,
    days: CAL.length - 1,
    stocks: CODES.map((code) => ({
      code,
      name: code,
      close: (i: number) => (i <= idx(lastBar[code] ?? PREV) ? closeOf(code) : NaN),
    })),
  });
  await wh.run(`INSERT INTO trade_calendar (market, date) VALUES ('A', DATE '${TODAY}')`);
}

/** 腾讯 A 股报价一行；time 是最后成交的时刻（停牌的股票停在那天） */
function quoteLine(code: string, time: string, traded = true, high?: string, prevClose?: number): string {
  const c = closeOf(code);
  const f: string[] = new Array(38).fill("0");
  f[0] = "1";
  f[1] = code;
  f[2] = code.slice(0, 6);
  f[3] = String(c);
  f[4] = String(prevClose ?? c);
  f[5] = traded ? String(c) : "0";
  f[6] = traded ? "1000" : "0";
  f[30] = time;
  f[33] = high ?? String(c);
  f[34] = String(c);
  f[35] = `${c}/1000/${c * 100_000}`;
  return `v_sh${code.slice(0, 6)}="${f.join("~")}";`;
}
const at = (d: DateStr) => `${d.replaceAll("-", "")}150003`;

function routes(quotes: string[], skip: (code: string, d: DateStr) => boolean): FakeRoute[] {
  const base: Record<string, number> = { ...A_INDEX_SECIDS };
  for (const c of CODES) base[emSecidOf(c)] = closeOf(c);
  const codeOf = new Map(CODES.map((c) => [emSecidOf(c), c]));
  return [
    { match: /qt\.gtimg\.cn/, reply: quotes.join("\n") },
    emDailyRoute(base, (secid, d) => {
      const code = codeOf.get(secid);
      return code ? skip(code, d) : false;
    }),
  ];
}

const emCalls = (http: FakeHttp) =>
  http.calls
    .filter((c) => /push2his/.test(c.url))
    .map((c) => CODES.find((x) => emSecidOf(x) === new URL(c.url).searchParams.get("secid")))
    .filter(Boolean);

const statusOf = (code: string) =>
  wh.all<{ d: string; status: string; reason: string | null }>(
    `SELECT date::VARCHAR AS d, status, reason FROM bar_status WHERE code = $c ORDER BY date`,
    { c: code },
  );

describe("updateBars：停牌续上与补数据（D111）", () => {
  it("中间每天都记着没成交：走报价，不逐股请求；没记的照旧逐股补", async () => {
    const [RESUMED, LAGGING] = [CODES[0]!, CODES[1]!];
    const last = CAL[idx(PREV) - 2]!;
    await market({ [RESUMED]: last, [LAGGING]: last });
    for (const d of CAL.slice(idx(last) + 1, idx(PREV) + 1)) {
      await wh.run(`INSERT INTO bar_status (code, date, status) VALUES ($c, $d::DATE, 'no_trade')`, {
        c: RESUMED,
        d,
      });
    }
    const http = new FakeHttp(
      routes(
        CODES.map((c) => quoteLine(c, at(TODAY))),
        () => false,
      ),
    );
    const r = await updateBars(
      { wh, http, today: TODAY, log: () => {}, ver: 9 },
      "A",
      await loadSecurities(wh, "A"),
      TODAY,
      PREV,
    );
    expect(r).toMatchObject({ resumed: 1, updated: 10, missing: [] });
    expect(emCalls(http)).toEqual([LAGGING]);
    expect(
      await wh.one(`SELECT src FROM bars_daily WHERE code = $c AND date = $d::DATE`, { c: RESUMED, d: TODAY }),
    ).toEqual({ src: "txq" });
  });

  it("逐股日 K 窗口里没有的日子记没成交：报价说之后没再成交才记到昨天；下一晚就能走报价", async () => {
    // 三只都停在 3 个交易日前：SUSPENDED 报价停在那天（一直停牌）；LAGGED 报价说昨天成交过（日 K 滞后）；
    // BEHIND 报价说今天成交了，日 K 里却还没有今天
    // 港股零成交的小票：报价时间是今天、量是 0；ZERO 前收就是最后一根的收盘，MOVED 前收变了（中间成交过）
    const [SUSPENDED, LAGGED, BEHIND, ZERO, MOVED] = CODES as [string, string, string, string, string];
    const last = CAL[idx(PREV) - 2]!;
    const stale = [SUSPENDED, LAGGED, BEHIND, ZERO, MOVED];
    await market(Object.fromEntries(stale.map((c) => [c, last])));
    const quotes = CODES.map((c) =>
      c === SUSPENDED
        ? quoteLine(c, at(last))
        : c === LAGGED
          ? quoteLine(c, at(PREV))
          : c === ZERO
            ? quoteLine(c, at(TODAY), false)
            : c === MOVED
              ? quoteLine(c, at(TODAY), false, undefined, closeOf(c) + 0.3)
              : quoteLine(c, at(TODAY)),
    );
    const http = new FakeHttp(routes(quotes, (code, d) => stale.includes(code) && d > last));
    const r = await updateBars(
      { wh, http, today: TODAY, log: () => {}, ver: 9 },
      "A",
      await loadSecurities(wh, "A"),
      TODAY,
      PREV,
    );
    expect(r.noTrade).toBe(4);
    expect(r.missing).toEqual([{ code: BEHIND, reason: "kline_behind" }]);
    // 一直停牌的：之后每天都记没成交，齐到昨天；日 K 滞后的、今天成交了的都只齐到最后一根
    const after = CAL.slice(idx(last) + 1, idx(PREV) + 1);
    expect((await statusOf(SUSPENDED)).map((s) => [s.d, s.status])).toEqual([
      ...after.map((d) => [d, "no_trade"]),
      [TODAY, "no_trade"],
    ]);
    expect(await statusOf(LAGGED)).toEqual([{ d: TODAY, status: "no_trade", reason: null }]);
    const through = await completeThrough(wh, "A", stale, PREV);
    expect(Object.fromEntries(through)).toEqual({
      [SUSPENDED]: PREV,
      [LAGGED]: last,
      [BEHIND]: last,
      [ZERO]: PREV,
      [MOVED]: last,
    });
    expect(r.behind).toEqual(new Map([[BEHIND, last]]));
    // 今天记成没成交、之前的日子没确认的：不算今天的缺失，但补数据时截至日不能越过它们
    expect(r.unverified).toEqual(
      new Map([
        [LAGGED, last],
        [MOVED, last],
      ]),
    );
  });

  it("逐股补的顺序：除权日的在前，其余按日线停得最早的在前，同一只只补一次", () => {
    const last: Record<string, DateStr> = { a: "2026-10-07", b: "2026-10-01", c: "2026-10-05" };
    const s = (code: string) => ({ code });
    expect(
      klineOrder([s("x")], [s("a"), s("b"), s("new"), s("c"), s("x")], (c) => last[c]).map((r) => r.code),
    ).toEqual(["x", "new", "b", "c", "a"]);
  });
});

describe("daily()：缺得多时截至日提交到之前齐全的那天，下一晚补齐（D111）", () => {
  it("5 只没补上（阈值 3）：截至日提交到第 4 早的那只齐到的那天；补上后提交到今天", async () => {
    const early = CAL[idx(PREV) - 3]!;
    const later = CAL[idx(PREV) - 1]!;
    const stuck = CODES.slice(0, 5);
    await market(Object.fromEntries(stuck.map((c, i) => [c, i < 2 ? early : later])));
    // 停了好几晚：已提交的截至日在 early 之前
    const committed = CAL[idx(early) - 2]!;
    await wh.run(`UPDATE data_versions SET as_of = $d::DATE`, { d: committed });
    const quotes = CODES.map((c) => quoteLine(c, at(TODAY)));
    // 第一晚：这 5 只东财说没有数据（被限流时常见的空结果），腾讯日 K 没配（出错）
    const night1 = new FakeHttp([
      { match: /qt\.gtimg\.cn/, reply: quotes.join("\n") },
      ...stuck.map((c) => ({ match: new RegExp(`secid=${emSecidOf(c).replace(".", "\\.")}&`), reply: { rc: 0, data: null } })),
      ...routes([], () => false).slice(1),
    ]);
    const logs: string[] = [];
    const r1 = await daily({ wh, http: night1, today: TODAY, log: (m) => logs.push(m) }, "A");
    expect(r1.catchUp).toMatchObject({
      since: committed,
      asOf: later,
      latest: TODAY,
      done: idx(later) - idx(committed),
      total: idx(TODAY) - idx(committed),
      behind: 5,
    });
    expect(await committedAsOf(wh, "A")).toBe(later);
    expect(logs.some((l) => l.startsWith(`${MARKET_LABEL.A}补数据中：日线齐全到 ${later}`))).toBe(true);
    const v1 = await wh.one<{ status: string; c: string }>(
      `SELECT status, completeness AS c FROM data_versions WHERE id = $id`,
      { id: r1.dataVersion! },
    );
    expect(v1!.status).toBe("ok");
    expect(JSON.parse(v1!.c)).toMatchObject({ ok: false, missingFailed: true, behind: 5, catchUp: { asOf: later } });

    // 第二晚（同一天的自动重跑）：东财放开了，全部补齐，截至日到今天
    const night2 = new FakeHttp(routes(quotes, () => false));
    const r2 = await daily({ wh, http: night2, today: TODAY, log: () => {} }, "A");
    expect(r2.catchUp).toBeUndefined();
    expect(r2.completeness?.ok).toBe(true);
    expect(await committedAsOf(wh, "A")).toBe(TODAY);
  });

  it("缺的都只缺今天（之前都齐）：不提交，照旧整晚不通过", async () => {
    await market({});
    const bad = CODES.slice(0, 5);
    // 5 只报价坏了（最高价不是数）被体检拒收：只缺今天
    const quotes = CODES.map((c) => quoteLine(c, at(TODAY), true, bad.includes(c) ? "-" : undefined));
    const http = new FakeHttp(routes(quotes, () => false));
    await expect(daily({ wh, http, today: TODAY, log: () => {} }, "A")).rejects.toThrow(
      /有 5 只股票今天的日线没拿到，已停止更新/,
    );
    expect(await committedAsOf(wh, "A")).toBe(PREV);
  });
});

describe("港股复权轮换让路（D111）", () => {
  it("轮换排在补数据之后；日 K 一被风控就停，不算失败、不记缺失、不等解封", async () => {
    const hkCodes = Array.from({ length: 20 }, (_, i) => `${String(i + 1).padStart(5, "0")}.HK`);
    const LAG = hkCodes[0]!;
    wh = await Warehouse.open(":memory:");
    await seedSyntheticMarket(wh, {
      market: "HK",
      start: CAL[0]!,
      days: CAL.length - 1,
      stocks: hkCodes.map((code) => ({
        code,
        name: code,
        close: (i: number) => (code === LAG && i > idx(PREV) - 2 ? NaN : 10),
      })),
    });
    await wh.run(`INSERT INTO trade_calendar (market, date) VALUES ('HK', DATE '${TODAY}')`);
    const hkQuote = (code: string) => {
      const f: string[] = new Array(38).fill("0");
      f[1] = code;
      f[3] = "10";
      f[4] = "10";
      f[5] = "10";
      f[6] = "1000";
      f[30] = `${TODAY.replaceAll("-", "/")} 16:08:10`;
      f[33] = "10";
      f[34] = "10";
      f[37] = "10000";
      return `v_hk${code.slice(0, 5)}="${f.join("~")}";`;
    };
    const em = emDailyRoute(Object.fromEntries(hkCodes.map((c) => [`116.${c.slice(0, 5)}`, 10])));
    const http = new FakeHttp([
      { match: /qt\.gtimg\.cn/, reply: hkCodes.map(hkQuote).join("\n") },
      // 补数据的那只（不复权 + 后复权两次请求）拿到了，之后东财、腾讯日 K 都被风控
      { ...em, times: 2 },
      { match: /push2his\.eastmoney\.com/, block: { untilMs: Date.now() + 3_600_000 } },
      { match: /web\.ifzq\.gtimg\.cn/, block: { untilMs: Date.now() + 3_600_000 } },
    ]);
    const logs: string[] = [];
    const t0 = Date.now();
    const r = await updateBars(
      { wh, http, today: TODAY, log: (m) => logs.push(m), ver: 9 },
      "HK",
      await loadSecurities(wh, "HK"),
      TODAY,
      PREV,
    );
    expect(Date.now() - t0).toBeLessThan(5_000);
    const slot = Number(TODAY.replaceAll("-", "")) % 5;
    const rotating = hkCodes.slice(1).filter((c) => {
      let h = 0;
      for (const ch of c) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return h % 5 === slot;
    });
    expect(rotating.length).toBeGreaterThan(1);
    expect(r).toMatchObject({ failed: 0, missing: [], updated: 20, rotation: { done: 0, skipped: rotating.length } });
    // 第一次东财请求是补数据的那只
    const first = http.calls.find((c) => /push2his/.test(c.url))!;
    expect(new URL(first.url).searchParams.get("secid")).toBe(`116.${LAG.slice(0, 5)}`);
    expect(logs.some((l) => l.includes(`${rotating.length} 只这次跳过`))).toBe(true);
  });
});

describe("catchUpState（D111）：最近一次尝试还在补数据才带进度", () => {
  const night = (status: string, c: object) =>
    wh.run(
      `INSERT INTO data_versions (id, market, as_of, kind, status, completeness)
       VALUES (nextval('data_version_seq'), 'HK', NULL, 'daily', $s, $c)`,
      { s: status, c: JSON.stringify(c) },
    );
  const progress = { since: "2026-10-21", asOf: "2026-10-27", latest: "2026-11-04", done: 4, total: 10, behind: 300 };
  const backlog = { missingFailed: true, behind: 300 };

  it("补数据时的提交、之后只因缺得多没通过：都带进度；之后无成交不对或出错：让真的失败显示出来", async () => {
    wh = await Warehouse.open(":memory:");
    expect(await catchUpState(wh, "HK")).toEqual({ catchUp: null, behind: 0 });
    await night("ok", { ...backlog, catchUp: progress });
    expect(await catchUpState(wh, "HK")).toEqual({ catchUp: progress, behind: 300 });
    await night("incomplete", { missingFailed: true, behind: 280 });
    expect(await catchUpState(wh, "HK")).toEqual({ catchUp: progress, behind: 280 });
    await night("incomplete", { missingFailed: true, noTradeFailed: true, behind: 5 });
    expect(await catchUpState(wh, "HK")).toEqual({ catchUp: null, behind: 0 });
    await night("failed", {});
    expect(await catchUpState(wh, "HK")).toEqual({ catchUp: null, behind: 0 });
    // 补齐了：完整的一晚
    await night("ok", { ok: true });
    expect(await catchUpState(wh, "HK")).toEqual({ catchUp: null, behind: 0 });
  });
});

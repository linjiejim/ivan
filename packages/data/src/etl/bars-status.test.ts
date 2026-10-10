/**
 * 夜间日线增量给每只股票今天的结果分类（D73、D74）：有了日线 / 没成交（停牌）/ 缺（带原因）。
 * 这是完整性闸门两条规则（缺失数、没成交突增）的输入，所以逐个分支钉住：
 * 报价说没成交 → no_trade（src txq）；报价被体检拒收 → missing rejected:<规则>，不再逐股补；
 * 除权日逐股日 K 没有今天 → missing chain_failed；口径换算不成 → missing rejected:caliber + 一条 caliber 问题；
 * 逐股补成功但没有今天 → no_trade；并且 expected = updated + noTrade + missing。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eastmoneyAdapter } from "../sources/adapters/eastmoney.ts";
import { FakeHttp } from "../testing/fake-http.ts";
import { A_INDEX_SECIDS, emDailyRoute, emSecidOf } from "../testing/nightly.ts";
import { seedSyntheticMarket } from "../testing/seed.ts";
import { Warehouse } from "../warehouse/db.ts";
import { updateBars } from "./bars.ts";
import { loadSecurities } from "./context.ts";

const TODAY = "2026-10-09";
/** 600000 起 7 只，收盘 10、11、…、16（种子里每天不变） */
const CODES = Array.from({ length: 7 }, (_, i) => `${600000 + i}.SH`);
const closeOf = (code: string) => 10 + CODES.indexOf(code);
const [OK, STALE_TIME, ZERO_OPEN, BAD_OHLC, EX_RIGHTS, OMITTED, CALIBER] = CODES as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

let wh: Warehouse;
beforeEach(async () => {
  wh = await Warehouse.open(":memory:");
  // 2026-09-21 起 14 个工作日，最后一天 2026-10-08；今晚（10-09）只差一天，走批量报价
  await seedSyntheticMarket(wh, {
    market: "A",
    start: "2026-09-21",
    days: 14,
    stocks: CODES.map((code, k) => ({ code, name: `股${k}`, close: () => 10 + k })),
  });
  // 直接调 updateBars：日历里也要有今天（体检 R3 认日历）
  await wh.run(`INSERT INTO trade_calendar (market, date) VALUES ('A', DATE '${TODAY}')`);
});
afterEach(() => {
  vi.restoreAllMocks();
  wh.close();
});

/** 腾讯报价一行（只填 updateBars 读的字段） */
function quoteLine(
  code: string,
  q: { price: number; prevClose: number; open: number; volume: number; high: string; low: number; time: string },
): string {
  const f: string[] = new Array(38).fill("0");
  const sym = code.slice(0, 6);
  f[0] = "1";
  f[1] = code;
  f[2] = sym;
  f[3] = String(q.price);
  f[4] = String(q.prevClose);
  f[5] = String(q.open);
  f[6] = String(q.volume);
  f[30] = q.time;
  f[33] = q.high;
  f[34] = String(q.low);
  f[35] = `${q.price}/${q.volume}/${q.price * q.volume * 100}`;
  return `v_sh${sym}="${f.join("~")}";`;
}

const traded = (code: string) => {
  const c = closeOf(code);
  return { price: c, prevClose: c, open: c, volume: 1000, high: String(c), low: c, time: "20261009150003" };
};

/** OMITTED、CALIBER 两只报价里没有，转去逐股补 */
const QUOTES = [
  quoteLine(OK, traded(OK)),
  // 报价时间停在昨天：今天没成交
  quoteLine(STALE_TIME, { ...traded(STALE_TIME), time: "20261008150003" }),
  // 开盘价 0、量 0：今天没成交
  quoteLine(ZERO_OPEN, { ...traded(ZERO_OPEN), open: 0, volume: 0 }),
  // 最高价不是数：报价路径把高低价夹到开收之间，高 < 低出不来，坏掉的价格字段才会触发 R1
  quoteLine(BAD_OHLC, { ...traded(BAD_OHLC), high: "-" }),
  // 交易所发布的除权参考前收 ≠ 库里收盘：除权日，转逐股日 K
  quoteLine(EX_RIGHTS, { ...traded(EX_RIGHTS), prevClose: closeOf(EX_RIGHTS) - 0.5 }),
].join("\n");

function httpOf(): FakeHttp {
  const base: Record<string, number> = { ...A_INDEX_SECIDS };
  for (const c of CODES) base[emSecidOf(c)] = closeOf(c);
  return new FakeHttp([
    { match: /qt\.gtimg\.cn/, reply: QUOTES },
    // 东财逐股日 K 只到昨天：EX_RIGHTS 与 OMITTED 都没有今天这一行
    emDailyRoute(base, (secid, d) => d === TODAY && (secid === emSecidOf(EX_RIGHTS) || secid === emSecidOf(OMITTED))),
  ]);
}

describe("updateBars 给今天的每只股票分类", () => {
  it("没成交 / 拒收 / 除权日缺 / 口径拒收 / 逐股没有今天，各记各的 bar_status", async () => {
    // CALIBER 这只东财给的是总收益序列，换不成不复权 + 等比因子
    const real = eastmoneyAdapter.dailyBars!.bind(eastmoneyAdapter);
    vi.spyOn(eastmoneyAdapter, "dailyBars").mockImplementation(async (ctx, code, from, to) => {
      if (code !== CALIBER) return real(ctx, code, from, to);
      return {
        bars: [{ date: TODAY, open: 16, high: 16, low: 16, close: 16, volume: 1000, amount: 1.6e6 }],
        caliber: "total_return",
        volumeUnit: "infer",
        currency: "CNY",
      };
    });
    const http = httpOf();
    const logs: string[] = [];
    const secs = await loadSecurities(wh, "A");
    const r = await updateBars(
      { wh, http, today: TODAY, log: (m) => logs.push(m), ver: 9 },
      "A",
      secs,
      TODAY,
      "2026-10-08",
    );

    expect(r).toMatchObject({
      viaQuote: 1,
      exRights: 1,
      quoteFallback: 2,
      expected: 7,
      updated: 1,
      noTrade: 3,
      missing: [
        { code: BAD_OHLC, reason: "rejected:ohlc" },
        { code: EX_RIGHTS, reason: "chain_failed" },
        { code: CALIBER, reason: "rejected:caliber" },
      ],
    });
    expect(r.expected).toBe(r.updated + r.noTrade + r.missing.length);

    expect(
      await wh.all(`SELECT code, status, reason, src, ver FROM bar_status WHERE date = DATE '${TODAY}' ORDER BY code`),
    ).toEqual([
      { code: STALE_TIME, status: "no_trade", reason: null, src: "txq", ver: 9 },
      { code: ZERO_OPEN, status: "no_trade", reason: null, src: "txq", ver: 9 },
      { code: BAD_OHLC, status: "missing", reason: "rejected:ohlc", src: "txq", ver: 9 },
      { code: EX_RIGHTS, status: "missing", reason: "chain_failed", src: "em", ver: 9 },
      { code: OMITTED, status: "no_trade", reason: null, src: "em", ver: 9 },
      { code: CALIBER, status: "missing", reason: "rejected:caliber", src: null, ver: 9 },
    ]);

    // 今天写进 bars_daily 的只有报价正常的那只；拒收的、没成交的都不写
    expect(
      await wh.all(`SELECT code, src FROM bars_daily WHERE date = DATE '${TODAY}' ORDER BY code`),
    ).toEqual([{ code: OK, src: "txq" }]);

    // 拒收与口径失败各记一条数据问题
    expect(
      await wh.all(
        `SELECT code, rule, severity, src, ver FROM data_issues
         WHERE dataset = 'bars' AND date = DATE '${TODAY}' ORDER BY code`,
      ),
    ).toEqual([
      { code: BAD_OHLC, rule: "ohlc", severity: "reject", src: "txq", ver: 9 },
      { code: CALIBER, rule: "caliber", severity: "reject", src: null, ver: 9 },
    ]);

    // 报价被体检拒收的不转去逐股补；东财只为除权与漏报价的两只发了请求（口径那只走的是上面的替身）
    const emCalls = http.calls.filter((c) => /push2his/.test(c.url)).map((c) => new URL(c.url).searchParams.get("secid"));
    expect(emCalls).not.toContain(emSecidOf(BAD_OHLC));
    expect(new Set(emCalls)).toEqual(new Set([emSecidOf(EX_RIGHTS), emSecidOf(OMITTED)]));
  });
});

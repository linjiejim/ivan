/**
 * 等风控解封的预算（D108）：同时在等的只记一次账；预算不够就不睡、记成 rate_limited 缺失，交给完整性闸门；
 * 预算内照旧等到解封；日历指数被拦时整晚抛可重跑的错。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockedError } from "../http.ts";
import { FakeHttp } from "../testing/fake-http.ts";
import { A_INDEX_SECIDS, emDailyRoute, emSecidOf } from "../testing/nightly.ts";
import { seedSyntheticMarket } from "../testing/seed.ts";
import { Warehouse } from "../warehouse/db.ts";
import { updateBars } from "./bars.ts";
import { assessCompleteness, RetryableEtlError } from "./completeness.ts";
import { loadSecurities } from "./context.ts";
import { daily } from "./pipeline.ts";
import {
  DEFAULT_RATE_LIMIT_WAIT_MS,
  RateLimitBudgetError,
  RateLimitWaitBudget,
  rateLimitWaitMsFromEnv,
} from "./rate-limit.ts";

const KLINE_HOSTS = ["push2his.eastmoney.com", "web.ifzq.gtimg.cn"];

describe("RateLimitWaitBudget", () => {
  it("同一段时间里几只股票一起等，只扣一次；不重叠的部分才再扣", () => {
    let now = 1_000_000;
    const b = new RateLimitWaitBudget(10 * 60_000, () => now);
    expect(b.reserve(now + 5 * 60_000)).toBe(true);
    // 另外两只同时在等同一个解封时刻：不再扣
    expect(b.reserve(now + 5 * 60_000)).toBe(true);
    expect(b.reserve(now + 4 * 60_000)).toBe(true);
    expect(b.spentMs).toBe(5 * 60_000);
    // 解封后又被封，这次要等 4 分钟：从已记账的时刻之后算
    now += 5 * 60_000;
    expect(b.reserve(now + 4 * 60_000)).toBe(true);
    expect(b.spentMs).toBe(9 * 60_000);
    expect(b.remainingMs).toBe(60_000);
  });

  it("不够等到解封就用完：之后一律不等（剩下的零头不让后面的股票一只只去试）", () => {
    const now = 0;
    const b = new RateLimitWaitBudget(10 * 60_000, () => now);
    expect(b.reserve(20 * 60_000)).toBe(false);
    expect(b.isExhausted).toBe(true);
    expect(b.spentMs).toBe(0);
    expect(b.reserve(1)).toBe(false);
  });

  it("环境变量：默认 30 分钟，0 = 不等，乱写用默认", () => {
    expect(rateLimitWaitMsFromEnv({})).toBe(DEFAULT_RATE_LIMIT_WAIT_MS);
    expect(DEFAULT_RATE_LIMIT_WAIT_MS).toBe(30 * 60_000);
    expect(rateLimitWaitMsFromEnv({ ETL_RATE_LIMIT_WAIT_MS: "0" })).toBe(0);
    expect(rateLimitWaitMsFromEnv({ ETL_RATE_LIMIT_WAIT_MS: "120000" })).toBe(120_000);
    expect(rateLimitWaitMsFromEnv({ ETL_RATE_LIMIT_WAIT_MS: "abc" })).toBe(DEFAULT_RATE_LIMIT_WAIT_MS);
    expect(rateLimitWaitMsFromEnv({ ETL_RATE_LIMIT_WAIT_MS: "-5" })).toBe(DEFAULT_RATE_LIMIT_WAIT_MS);
  });
});

const TODAY = "2026-10-09";
const CODES = Array.from({ length: 5 }, (_, i) => `${600000 + i}.SH`);

let wh: Warehouse;
beforeEach(async () => {
  wh = await Warehouse.open(":memory:");
  // 库里只到 10-07，今晚（10-09）差两天：全部逐股补日 K（不走报价）
  await seedSyntheticMarket(wh, {
    market: "A",
    start: "2026-09-21",
    days: 13,
    stocks: CODES.map((code, k) => ({ code, name: `股${k}`, close: () => 10 + k })),
  });
  await wh.run(
    `INSERT INTO trade_calendar (market, date) VALUES ('A', DATE '2026-10-08'), ('A', DATE '${TODAY}')`,
  );
});
afterEach(() => {
  vi.useRealTimers();
  wh.close();
});

/**
 * 假时钟下跑一段夹着真 I/O（DuckDB）的异步流程：时钟只在有定时器挂着（代码在 sleep）时才往前跳到下一个定时器，
 * 其余时候让真 I/O 走；直到流程结束。返回期间一共跳了多少毫秒。
 */
async function drive<T>(p: Promise<T>, maxJumps = 1000): Promise<{ value: T; jumpedMs: number }> {
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  const t0 = Date.now();
  for (let n = 0; !settled && n < 100_000; n++) {
    await new Promise((r) => setImmediate(r));
    if (vi.getTimerCount() > 0 && maxJumps-- > 0) await vi.advanceTimersToNextTimerAsync();
  }
  return { value: await p, jumpedMs: Date.now() - t0 };
}

function klineHttp(): FakeHttp {
  const base: Record<string, number> = { ...A_INDEX_SECIDS };
  CODES.forEach((c, k) => (base[emSecidOf(c)] = 10 + k));
  return new FakeHttp([emDailyRoute(base)]);
}

describe("updateBars 遇到整条日 K 链被风控", () => {
  it("预算不够等到解封：不睡，全部记成 rate_limited 缺失，只记一行日志", async () => {
    const http = klineHttp();
    for (const h of KLINE_HOSTS) http.setBlocked(h, Date.now() + 60 * 60_000);
    const logs: string[] = [];
    const budget = new RateLimitWaitBudget(10 * 60_000);
    const t0 = Date.now();
    const r = await updateBars(
      { wh, http, today: TODAY, log: (m) => logs.push(m), ver: 3, rateLimitBudget: budget },
      "A",
      await loadSecurities(wh, "A"),
      TODAY,
      "2026-10-08",
    );
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.missing).toEqual(CODES.map((code) => ({ code, reason: "rate_limited" })));
    expect(logs.filter((l) => /预算不够等到解封/.test(l))).toHaveLength(1);
    expect(logs.some((l) => /等待 \d+ 分钟后继续/.test(l))).toBe(false);
    expect(budget.isExhausted).toBe(true);
    expect(
      await wh.all(`SELECT DISTINCT status, reason FROM bar_status WHERE date = DATE '${TODAY}'`),
    ).toEqual([{ status: "missing", reason: "rate_limited" }]);
  });

  it("预算够：照旧等到解封后接着补，今天的日线都写上", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const http = klineHttp();
    for (const h of KLINE_HOSTS) http.setBlocked(h, Date.now() + 60_000);
    const logs: string[] = [];
    const budget = new RateLimitWaitBudget(10 * 60_000);
    const p = updateBars(
      { wh, http, today: TODAY, log: (m) => logs.push(m), ver: 3, rateLimitBudget: budget },
      "A",
      await loadSecurities(wh, "A"),
      TODAY,
      "2026-10-08",
    );
    // 等待 = 解封时刻 + 5 秒：并发的 3 只一起等，预算只扣一次
    const { value: r, jumpedMs } = await drive(p);
    vi.useRealTimers();
    expect(jumpedMs).toBeGreaterThanOrEqual(65_000);
    expect(r.missing).toEqual([]);
    expect(r.updated).toBe(CODES.length);
    expect(budget.spentMs).toBeGreaterThan(60_000);
    expect(budget.spentMs).toBeLessThan(70_000);
    expect(logs.some((l) => /等待 \d+ 分钟后继续/.test(l))).toBe(true);
  });

  it("不给预算（命令行回填，worker 停着）：照旧等到解封", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const http = klineHttp();
    // 封 2 小时：超过任何默认预算，没有预算时也照样等
    for (const h of KLINE_HOSTS) http.setBlocked(h, Date.now() + 2 * 60 * 60_000);
    const p = updateBars(
      { wh, http, today: TODAY, log: () => {}, ver: 3 },
      "A",
      await loadSecurities(wh, "A"),
      TODAY,
      "2026-10-08",
    );
    const { value: r, jumpedMs } = await drive(p);
    vi.useRealTimers();
    expect(jumpedMs).toBeGreaterThanOrEqual(2 * 60 * 60_000);
    expect(r.missing).toEqual([]);
    expect(r.updated).toBe(CODES.length);
  });

  it("预算用完后抛的错仍是一种 BlockedError，消息说明预算", () => {
    const b = new RateLimitWaitBudget(60_000);
    const e = new RateLimitBudgetError(new BlockedError("push2his.eastmoney.com", 0), b);
    expect(e).toBeInstanceOf(BlockedError);
    expect(e.message).toMatch(/1 分钟用完了，不再等/);
  });
});

describe("完整性闸门写明风控", () => {
  it("缺失里有 rate_limited 时原因里带上只数", () => {
    const c = assessCompleteness({
      market: "A",
      expected: 5000,
      updated: 4900,
      noTrade: 50,
      missing: [
        ...Array.from({ length: 40 }, (_, i) => ({ code: `6${String(i).padStart(5, "0")}.SH`, reason: "rate_limited" as const })),
        ...Array.from({ length: 10 }, (_, i) => ({ code: `0${String(i).padStart(5, "0")}.SZ`, reason: "chain_failed" as const })),
      ],
      critical: new Set(),
      accepted: new Set(),
      noTradeHistory: [],
    });
    expect(c.ok).toBe(false);
    expect(c.reasons[0]).toMatch(/有 50 只股票今天的日线没拿到（其中 40 只是数据源风控、没等到解封）/);
    expect(c.missingReasons).toEqual({ rate_limited: 40, chain_failed: 10 });
  });
});

describe("daily() 遇到日历指数被风控", () => {
  it("抛可以自动重跑的错（RetryableEtlError），版本记成 failed", async () => {
    const http = new FakeHttp([]);
    for (const h of KLINE_HOSTS) http.setBlocked(h, Date.now() + 30 * 60_000);
    const e = await daily({ wh, http, today: "2026-10-12", log: () => {} }, "A").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RetryableEtlError);
    expect((e as Error).message).toMatch(/^数据源风控：.*稍后自动重跑/);
    const v = await wh.one<{ status: string; note: string }>(
      `SELECT status, note FROM data_versions WHERE kind = 'daily' ORDER BY id DESC LIMIT 1`,
    );
    expect(v?.status).toBe("failed");
    expect(v?.note).toMatch(/风控|暂停/);
  });
});

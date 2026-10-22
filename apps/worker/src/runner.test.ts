/**
 * 行情仓写库期间不跑回测（D60）：认领规则的真值表，以及 computeBlocked 读 jobs 表的判断；
 * 自动重跑（D73）：没到时间的任务不认领、不挡回测，闸门没过时最多重跑 2 次。
 */
import { IncompleteDataError, RetryableEtlError } from "@ivan/data";
import {
  A_INDEX_SECIDS,
  emDailyRoute,
  emSecidOf,
  FakeHttp,
  seedSyntheticMarket,
} from "@ivan/data/testing";
import { jobs, newId } from "@ivan/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { etlJob } from "./jobs/etl.ts";
import { claim, computeBlocked, shouldWait } from "./runner.ts";
import { fakeJobContext, makeTestEnv } from "./testing/harness.ts";

const idle = { maintenance: false, blocked: false, computeRunning: 0 };

describe("shouldWait", () => {
  it.each([
    // [道, 下一个任务, 状态, 该不该等]
    ["compute", null, idle, false],
    ["compute", null, { ...idle, blocked: true }, true],
    ["etl", "etl", idle, false],
    ["etl", "etl", { ...idle, computeRunning: 2 }, true],
    ["etl", "check", { ...idle, computeRunning: 1 }, true],
    // 结算、简报不写行情仓，不用等回测
    ["etl", "settle", { ...idle, computeRunning: 1 }, false],
    ["etl", "brief", { ...idle, computeRunning: 1 }, false],
    ["etl", null, { ...idle, computeRunning: 1 }, false],
    // 维护状态：两条道都不认领
    ["compute", null, { ...idle, maintenance: true }, true],
    ["etl", "brief", { ...idle, maintenance: true }, true],
  ] as const)("%s 道，下一个 %s，%o → %s", (lane, next, state, want) => {
    expect(shouldWait(lane, next, state)).toBe(want);
  });
});

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe("computeBlocked", () => {
  it("etl / check 排队或在跑时挡住 compute 道（回测、扫描、复核都在这条道上）；简报排队不挡", async () => {
    const t = await makeTestEnv();
    cleanup = t.cleanup;
    const { db, sqlite } = t.env.app;
    const add = (kind: string, status: string, createdAt: number, startedAt?: number) =>
      db
        .insert(jobs)
        .values({ id: newId("j_"), kind, payload: {}, status, createdAt, startedAt })
        .run();
    expect(computeBlocked(sqlite)).toBeNull();
    add("brief", "queued", 1000);
    add("settle", "running", 1100, 1150);
    add("etl", "done", 900);
    add("check", "failed", 950);
    expect(computeBlocked(sqlite)).toBeNull();
    add("etl", "queued", 2000);
    expect(computeBlocked(sqlite)).toEqual({ kind: "etl", since: 2000 });
    add("check", "running", 1500, 1600);
    // 最早的写库任务；在跑的从开始时间算
    expect(computeBlocked(sqlite)).toEqual({ kind: "check", since: 1600 });
  });
});

describe("自动重跑（D73）", () => {
  it("认领跳过 not_before 还没到的任务；到了时间才认领；没到时间的重跑不挡回测", async () => {
    const t = await makeTestEnv();
    cleanup = t.cleanup;
    const { db, sqlite } = t.env.app;
    const now = 1_000_000;
    db.insert(jobs)
      .values({
        id: "j_retry",
        kind: "etl",
        payload: { market: "A" },
        status: "queued",
        createdAt: now - 5000,
        notBefore: now + 45 * 60_000,
        attempt: 1,
      })
      .run();
    db.insert(jobs)
      .values({
        id: "j_settle",
        kind: "settle",
        payload: { market: "HK" },
        status: "queued",
        createdAt: now - 1000,
      })
      .run();
    db.insert(jobs)
      .values({ id: "j_bt", kind: "backtest", payload: {}, status: "queued", createdAt: now - 500 })
      .run();
    expect(computeBlocked(sqlite, now)).toBeNull();
    expect(claim("compute", now)?.id).toBe("j_bt");
    // 更早排队的重跑没到时间：先认领后面的结算
    expect(claim("etl", now)?.id).toBe("j_settle");
    expect(claim("etl", now)).toBeUndefined();
    // 到时间了：挡回测，也能被认领
    const later = now + 45 * 60_000;
    expect(computeBlocked(sqlite, later)).toEqual({ kind: "etl", since: now - 5000 });
    const got = claim("etl", later);
    expect(got).toMatchObject({ id: "j_retry", attempt: 1, notBefore: later });
  });

  it("闸门没过：etlJob 排第 1 次、第 2 次重跑（45 分钟后），第 3 次失败就不再排", async () => {
    const codes = Array.from({ length: 20 }, (_, i) => `${600000 + i}.SH`);
    const base: Record<string, number> = { ...A_INDEX_SECIDS };
    codes.slice(5).forEach((c, k) => (base[emSecidOf(c)] = 10 + k));
    const http = new FakeHttp([{ match: /qt\.gtimg\.cn/, status: 500 }, emDailyRoute(base)]);
    const t = await makeTestEnv({ http, today: "2026-10-09" });
    cleanup = t.cleanup;
    await seedSyntheticMarket(t.env.wh, {
      market: "A",
      start: "2026-09-21",
      days: 14,
      stocks: codes.map((code, k) => ({ code, name: `股${k}`, close: () => 10 + k })),
    });
    const queued = () =>
      t.env.app.db
        .select()
        .from(jobs)
        .where(eq(jobs.kind, "etl"))
        .all()
        .map((j) => ({
          attempt: j.attempt,
          status: j.status,
          notBefore: j.notBefore,
          payload: j.payload,
        }));
    const before = Date.now();
    for (const attempt of [0, 1, 2]) {
      const ctx = fakeJobContext("etl", { market: "A" }, { attempt });
      await expect(etlJob(ctx)).rejects.toBeInstanceOf(IncompleteDataError);
      if (attempt < 2)
        expect(ctx.logs.at(-1)).toMatch(new RegExp(`自动重试（第 ${attempt + 1}/2 次）$`));
    }
    const q = queued();
    expect(q.map((j) => [j.attempt, j.status])).toEqual([
      [1, "queued"],
      [2, "queued"],
    ]);
    for (const j of q) {
      expect(j.notBefore! - before).toBeGreaterThanOrEqual(45 * 60_000);
      expect(j.notBefore! - Date.now()).toBeLessThanOrEqual(45 * 60_000);
      expect(j.payload).toMatchObject({ market: "A" });
    }
  });

  describe("数据源风控（D108）", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const setup = async (http: FakeHttp) => {
      const codes = Array.from({ length: 20 }, (_, i) => `${600000 + i}.SH`);
      const t = await makeTestEnv({ http, today: "2026-10-09" });
      cleanup = t.cleanup;
      await seedSyntheticMarket(t.env.wh, {
        market: "A",
        start: "2026-09-21",
        days: 14,
        stocks: codes.map((code, k) => ({ code, name: `股${k}`, close: () => 10 + k })),
      });
      const retries = () =>
        t.env.app.db
          .select()
          .from(jobs)
          .where(eq(jobs.kind, "etl"))
          .all()
          .map((j) => ({ attempt: j.attempt, status: j.status, notBefore: j.notBefore }));
      return { t, retries };
    };

    it("日 K 被封、等风控的预算不够：不睡，闸门判缺（写明风控），排 45 分钟后重跑，排队期间不挡回测", async () => {
      vi.stubEnv("ETL_RATE_LIMIT_WAIT_MS", "0");
      const until = Date.now() + 60 * 60_000;
      const http = new FakeHttp([
        // 报价出错：全部转逐股日 K；指数照常（先于日线），个股日 K 两家都被封
        { match: /qt\.gtimg\.cn/, status: 500 },
        { match: /push2his\.eastmoney\.com.*secid=1\.6/, block: { untilMs: until } },
        { match: /web\.ifzq\.gtimg\.cn/, block: { untilMs: until } },
        emDailyRoute({ ...A_INDEX_SECIDS }),
      ]);
      const { t, retries } = await setup(http);
      const ctx = fakeJobContext("etl", { market: "A" }, { attempt: 0 });
      const t0 = Date.now();
      const e = await etlJob(ctx).catch((x: unknown) => x);
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(e).toBeInstanceOf(IncompleteDataError);
      expect((e as Error).message).toMatch(/其中 \d+ 只是数据源风控、没等到解封/);
      expect(ctx.logs.some((l) => /预算不够等到解封/.test(l))).toBe(true);
      expect(ctx.logs.at(-1)).toMatch(/自动重试（第 1\/2 次）$/);
      const [r] = retries();
      expect(r).toMatchObject({ attempt: 1, status: "queued" });
      expect(r!.notBefore! - Date.now()).toBeGreaterThan(40 * 60_000);
      // 排着队等重跑：回测照常
      expect(computeBlocked(t.env.app.sqlite, Date.now())).toBeNull();
    });

    it("日历指数被封：整晚抛可重跑的错，同样排 45 分钟后重跑", async () => {
      const http = new FakeHttp([]);
      for (const h of ["push2his.eastmoney.com", "web.ifzq.gtimg.cn"]) {
        http.setBlocked(h, Date.now() + 30 * 60_000);
      }
      const { retries } = await setup(http);
      const ctx = fakeJobContext("etl", { market: "A" }, { attempt: 0 });
      const e = await etlJob(ctx).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RetryableEtlError);
      expect((e as Error).message).toMatch(/^数据源风控：/);
      expect(retries()).toEqual([expect.objectContaining({ attempt: 1, status: "queued" })]);
    });
  });
});

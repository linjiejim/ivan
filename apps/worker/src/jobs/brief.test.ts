/**
 * 简报两处线上修正（D70、D78）：休市不说「今天」，开市日更新失败不说休市；简报永久保留。
 */
import { type BriefFacts, checkGrounding, collectEvidence, factsForModel } from "@ivan/ai";
import { StrategySpecSchema } from "@ivan/core";
import { seedSyntheticMarket } from "@ivan/data/testing";
import {
  briefEditions,
  briefs,
  jobs,
  ledgerEntries,
  newId,
  trackingDays,
  trackings,
  verifyUserChain,
} from "@ivan/db";
import { MockLanguageModelV4 } from "ai/test";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { fakeJobContext, makeTestEnv, seedTracking } from "../testing/harness.ts";
import { briefJob } from "./brief.ts";

const spec = StrategySpecSchema.parse({
  name: "低估值",
  market: "A",
  rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 5 },
});

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

/** 北京时间某天 hh:00 的毫秒时间戳 */
const at = (date: string, h: number) =>
  Date.parse(`${date}T${String(h).padStart(2, "0")}:00:00+08:00`);

async function setup(today: string, lastDays: Array<[string, number, number]>) {
  const t = await makeTestEnv({ today });
  cleanup = t.cleanup;
  const { app, wh } = t.env;
  // 行情仓：数据截至 lastDays 的最后一天
  await seedSyntheticMarket(wh, {
    market: "A",
    start: "2026-09-21",
    days: 30,
    stocks: [{ code: "600001.SH", name: "甲", close: (i) => 10 + i }],
  });
  await wh.run(`DELETE FROM data_versions`);
  await wh.run(
    `INSERT INTO data_versions (id, market, as_of, kind) VALUES (nextval('data_version_seq'), 'A', $d::DATE, 'daily')`,
    { d: lastDays.at(-1)![0] },
  );
  const { trackingId } = seedTracking(app, { spec, startDate: lastDays[0]![0] });
  for (const [date, nav, bench] of lastDays) {
    app.db
      .insert(trackingDays)
      .values({ trackingId, date, nav, bench, cash: 0, positions: 5 })
      .run();
  }
  return { ...t, trackingId };
}

function addEtlJob(
  app: Awaited<ReturnType<typeof makeTestEnv>>["env"]["app"],
  o: { status: string; createdAt: number; result?: Record<string, unknown>; error?: string },
) {
  app.db
    .insert(jobs)
    .values({
      id: newId("j_"),
      kind: "etl",
      payload: { market: "A" },
      status: o.status,
      result: o.result ?? null,
      error: o.error ?? null,
      createdAt: o.createdAt,
    })
    .run();
}

function briefOf(app: Awaited<ReturnType<typeof makeTestEnv>>["env"]["app"], date: string) {
  const b = app.db.select().from(briefs).where(eq(briefs.date, date)).get()!;
  return { content: b.content!, facts: b.facts as unknown as BriefFacts, grounding: b.grounding };
}

const DAYS: Array<[string, number, number]> = [
  ["2026-09-28", 1.0, 1.0],
  ["2026-09-29", 1.01, 1.002],
  ["2026-09-30", 1.03, 1.004],
];

describe("夜间简报", () => {
  it("节假日（etl 明确返回非交易日）：没有当日涨跌，第一句是今天休市", async () => {
    const { env } = await setup("2026-10-05", DAYS);
    addEtlJob(env.app, {
      status: "done",
      createdAt: at("2026-10-05", 17),
      result: { market: "A", tradingDay: false, latest: "2026-09-30" },
    });
    await briefJob(fakeJobContext("brief"));
    const { content, facts } = briefOf(env.app, "2026-10-05");
    expect(facts.marketDay).toEqual({ A: "closed" });
    expect(facts.staleMarkets).toEqual([]);
    expect(facts.trackings[0]).toMatchObject({
      lastDate: "2026-09-30",
      dayReturn: null,
      dayBench: null,
    });
    expect(content.startsWith("今天休市")).toBe(true);
    expect(content).not.toMatch(/今天 [+-]/);
    expect(content).toContain("（最近交易日 2026-09-30）");
  });

  it("开市日更新失败（指数步骤失败、日历里没有今天）：不说休市，说数据没更新", async () => {
    const { env } = await setup("2026-10-09", [
      ["2026-09-29", 1.0, 1.0],
      ["2026-09-30", 1.02, 1.01],
    ]);
    addEtlJob(env.app, {
      status: "failed",
      createdAt: at("2026-10-09", 17),
      error: "A 股今天开市了，但指数日 K 还没有今天的数据，稍后在管理页重跑",
    });
    await briefJob(fakeJobContext("brief"));
    const { content, facts } = briefOf(env.app, "2026-10-09");
    expect(facts.marketDay).toEqual({ A: "stale" });
    expect(facts.staleMarkets).toContain("A");
    expect(content).not.toContain("休市");
    expect(content).toContain("A 股今天的数据没更新成功");
    expect(content).not.toMatch(/今天 [+-]/);
  });

  it("还没跑 etl：不说休市，说还没更新完", async () => {
    const { env } = await setup("2026-10-09", DAYS);
    await briefJob(fakeJobContext("brief"));
    const { content, facts } = briefOf(env.app, "2026-10-09");
    expect(facts.marketDay).toEqual({ A: "pending" });
    expect(facts.staleMarkets).toEqual(["A"]);
    expect(content).not.toContain("休市");
    expect(content).toContain("A 股今天的数据还没更新完");
  });

  it("当天结算过：照常说今天的涨跌", async () => {
    const { env } = await setup("2026-09-30", DAYS);
    addEtlJob(env.app, {
      status: "done",
      createdAt: at("2026-09-30", 17),
      result: { market: "A", tradingDay: true },
    });
    await briefJob(fakeJobContext("brief"));
    const { content, facts } = briefOf(env.app, "2026-09-30");
    expect(facts.marketDay).toEqual({ A: "traded" });
    expect(facts.trackings[0]!.dayReturn).toBeCloseTo(1.03 / 1.01 - 1, 12);
    expect(content).toContain("「低估值」今天 +1.98%");
    expect(content).not.toContain("休市");
  });

  it("没调 LLM 的模板简报不存核对结果；模板里的数字都能在给模型的事实里找到（D69）", async () => {
    const { env } = await setup("2026-09-30", DAYS);
    addEtlJob(env.app, {
      status: "done",
      createdAt: at("2026-09-30", 17),
      result: { market: "A", tradingDay: true },
    });
    await briefJob(fakeJobContext("brief"));
    const { content, facts, grounding } = briefOf(env.app, "2026-09-30");
    expect(grounding).toBeNull();
    const g = checkGrounding(content, collectEvidence("facts", factsForModel(facts)));
    expect(g.checked).toBeGreaterThan(0);
    expect(g.unverified).toEqual([]);
  });

  it("90 天前的简报不再被删除（D70）", async () => {
    const { env } = await setup("2026-10-05", DAYS);
    env.app.db
      .insert(briefs)
      .values({
        id: "b_old",
        userId: "u_test",
        date: "2026-06-01",
        facts: { date: "2026-06-01", dataAsOf: { A: "2026-06-01" }, trackings: [] },
        content: "旧简报",
      })
      .run();
    await briefJob(fakeJobContext("brief"));
    expect(env.app.db.select().from(briefs).where(eq(briefs.id, "b_old")).get()?.content).toBe(
      "旧简报",
    );
  });

  describe("第 2 版（D70）", () => {
    const closedDay = async () => {
      const r = await setup("2026-10-05", DAYS);
      addEtlJob(r.env.app, {
        status: "done",
        createdAt: at("2026-10-05", 17),
        result: { market: "A", tradingDay: false, latest: "2026-09-30" },
      });
      return r;
    };

    it("休市且没有变化：不调 LLM，模型记 template；facts 是第 2 版、没有上一期判词", async () => {
      const { env } = await closedDay();
      const llm = new MockLanguageModelV4({ modelId: "mock-brief", doGenerate: [] });
      env.briefModel = llm;
      const ctx = fakeJobContext("brief");
      await briefJob(ctx);
      expect(llm.doGenerateCalls).toHaveLength(0);
      const b = env.app.db.select().from(briefs).get()!;
      expect(b.model).toBe("template");
      expect(ctx.logs.join("\n")).not.toContain("确定性模板");
      const facts = b.facts as unknown as BriefFacts;
      expect(facts.factsVersion).toBe(2);
      expect(facts.trackings[0]).toMatchObject({
        tradedToday: false,
        verdict: "WARMING_UP",
        prevVerdict: null,
      });
      expect(b.content).not.toContain("状态：");
    });

    it("判词变了：开头先说变化，带上次的判词；可能失效只建议复核", async () => {
      const { env, trackingId } = await closedDay();
      env.app.db
        .insert(briefs)
        .values({
          id: "b_prev",
          userId: "u_test",
          date: "2026-09-30",
          facts: {
            factsVersion: 2,
            date: "2026-09-30",
            dataAsOf: { A: "2026-09-30" },
            trackings: [{ trackingId, verdict: "DRIFTING", warnings: [] }],
          },
          content: "上一期",
        })
        .run();
      env.app.db
        .update(trackings)
        .set({
          summary: {
            lastDate: "2026-09-30",
            health: { state: "decayed", signal: "critical", perMetric: {}, version: 1 },
          },
        })
        .where(eq(trackings.id, trackingId))
        .run();
      await briefJob(fakeJobContext("brief"));
      const { content, facts } = briefOf(env.app, "2026-10-05");
      expect(facts.trackings[0]).toMatchObject({ verdict: "DECAYED", prevVerdict: "DRIFTING" });
      expect(
        content.startsWith("「低估值」状态：可能失效（上次：偏离），建议复核规则是否仍然有效。"),
      ).toBe(true);
      expect(content).not.toMatch(/卖出|停止/);
    });

    it("同一天重跑：两版只追加、当前版是第 2 版、两条 brief 账本；版次改不了", async () => {
      const { env } = await closedDay();
      await briefJob(fakeJobContext("brief"));
      await briefJob(fakeJobContext("brief"));
      const eds = env.app.db.select().from(briefEditions).orderBy(asc(briefEditions.edition)).all();
      expect(eds.map((e) => [e.userId, e.date, e.edition])).toEqual([
        ["u_test", "2026-10-05", 1],
        ["u_test", "2026-10-05", 2],
      ]);
      expect(env.app.db.select().from(briefs).all()).toHaveLength(1);
      expect(env.app.db.select().from(briefs).get()!.createdAt).toBe(eds[1]!.createdAt);
      const ledger = env.app.db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.kind, "brief"))
        .orderBy(asc(ledgerEntries.seq))
        .all();
      expect(ledger.map((l) => l.payloadId)).toEqual(eds.map((e) => e.id));
      expect(verifyUserChain(env.app, "u_test").ok).toBe(true);
      expect(() => env.app.sqlite.prepare(`UPDATE brief_editions SET content = 'x'`).run()).toThrow(
        /append-only/,
      );
    });
  });
});

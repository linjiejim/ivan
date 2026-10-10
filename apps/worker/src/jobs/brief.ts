/**
 * 夜间简报（spec §8）：先算确定性的 briefFacts，LLM 只基于它写 ≤150 字摘要；facts 与正文一起存档，永久保留（D70）。
 * 简报不计入用户的对话额度，token 记在系统账上（usage_daily 的 user_id = "system"）。
 */

/** 系统用量在 usage_daily 里的户头 */
export const SYSTEM_USAGE_ID = "system";
import { type BriefFacts, newWarnings, writeBrief } from "@ivan/ai";
import type { Market } from "@ivan/core";
import { latestDataVersion } from "@ivan/data";
import {
  briefs,
  newId,
  strategies,
  trackingDays,
  trackingOrders,
  trackings,
  usageDaily,
} from "@ivan/db";
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { env, todayOf } from "../env.ts";
import { type MarketDay, marketDayStatus } from "../market-day.ts";
import type { JobContext } from "../runner.ts";

export async function briefJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const { db } = env().app;
  const { cfg, wh } = env();
  const today = todayOf();
  const active = db
    .select({ t: trackings, name: strategies.name })
    .from(trackings)
    .innerJoin(strategies, eq(strategies.id, trackings.strategyId))
    .where(eq(trackings.status, "active"))
    .all();
  const users = [...new Set(active.map((a) => a.t.userId))];
  const dataAsOf: Record<string, string | null> = {
    A: (await latestDataVersion(wh, "A")).asOf,
    HK: (await latestDataVersion(wh, "HK")).asOf,
  };
  // 各市场今天的状态（D78）：没更新（失败或还没跑完）的市场简报要先说明；休市只认 etl 明确返回的非交易日
  const marketDay: Partial<Record<Market, MarketDay>> = {};
  for (const m of new Set(active.map((a) => a.t.market as Market))) {
    marketDay[m] = await marketDayStatus(m, today);
  }
  const staleMarkets = (["A", "HK"] as const).filter(
    (m) => marketDay[m] === "stale" || marketDay[m] === "pending",
  );
  let written = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  for (const userId of users) {
    const mine = active.filter((a) => a.t.userId === userId);
    // 上一期简报时就已存在的提示，这期不再重复
    const prevBrief = db
      .select({ facts: briefs.facts })
      .from(briefs)
      .where(and(eq(briefs.userId, userId), lt(briefs.date, today)))
      .orderBy(desc(briefs.date))
      .get()?.facts as BriefFacts | undefined;
    const myMarkets = new Set(mine.map((a) => a.t.market as Market));
    const facts: BriefFacts = {
      date: today,
      dataAsOf,
      marketDay: Object.fromEntries([...myMarkets].map((m) => [m, marketDay[m]])),
      staleMarkets: staleMarkets.filter((m) => myMarkets.has(m)),
      trackings: [],
    };
    for (const { t, name } of mine) {
      const days = db
        .select()
        .from(trackingDays)
        .where(eq(trackingDays.trackingId, t.id))
        .orderBy(asc(trackingDays.date))
        .all();
      const last = days.at(-1);
      const prev = days.at(-2);
      const orders = db
        .select()
        .from(trackingOrders)
        .where(eq(trackingOrders.trackingId, t.id))
        .all();
      const summary = (t.summary ?? {}) as { checks?: Array<{ level: string; title: string }> };
      const warnings = (summary.checks ?? []).filter((c) => c.level === "warn").map((c) => c.title);
      facts.trackings.push({
        trackingId: t.id,
        name,
        market: t.market,
        days: days.length,
        lastDate: last?.date ?? null,
        // 只有今天结算过才有「今天」的涨跌：休市日不能把上一交易日的涨跌说成今天
        dayReturn: last && prev && last.date === today ? last.nav / prev.nav - 1 : null,
        dayBench: last && prev && last.date === today ? last.bench / prev.bench - 1 : null,
        excessTotal: last ? last.nav / last.bench - 1 : null,
        deviationPct: t.deviationPct,
        buys: orders.filter((o) => o.side === "buy").map((o) => o.name ?? o.code),
        sells: orders.filter((o) => o.side === "sell").map((o) => o.name ?? o.code),
        ...newWarnings(prevBrief, t.id, warnings),
      });
    }
    const { text, model, usage, fallbackReason } = await writeBrief(cfg.llm, facts);
    if (fallbackReason) ctx.log(`简报用了确定性模板：${fallbackReason}`);
    tokensIn += usage.inputTokens;
    tokensOut += usage.outputTokens;
    db.insert(briefs)
      .values({
        id: newId("b_"),
        userId,
        date: today,
        facts: facts as unknown as Record<string, unknown>,
        content: text,
        model,
      })
      .onConflictDoUpdate({
        target: [briefs.userId, briefs.date],
        set: {
          facts: facts as unknown as Record<string, unknown>,
          content: text,
          model,
          createdAt: Date.now(),
        },
      })
      .run();
    written++;
    ctx.progress(written / users.length, `简报 ${written}/${users.length}`);
  }
  if (tokensIn || tokensOut) {
    db.insert(usageDaily)
      .values({ userId: SYSTEM_USAGE_ID, day: today, tokensIn, tokensOut })
      .onConflictDoUpdate({
        target: [usageDaily.userId, usageDaily.day],
        set: {
          tokensIn: sql`${usageDaily.tokensIn} + ${tokensIn}`,
          tokensOut: sql`${usageDaily.tokensOut} + ${tokensOut}`,
        },
      })
      .run();
  }
  // 简报永久保留（D70），不再按天数清理
  return { users: users.length, written, staleMarkets, tokensIn, tokensOut };
}

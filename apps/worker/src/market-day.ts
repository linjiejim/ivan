/**
 * 市场当日状态（D78）：简报、判词、数据横幅、/internal/data-status 共用这一个判断。
 *
 * - traded：最新的已提交（ok）数据版本 as_of = 今天；
 * - closed：今天是周末，或今天这个市场的 etl 任务已完成且结果是 tradingDay: false；
 * - stale：今天这个市场有失败的 etl 任务且之后没有成功；
 * - pending：其余（还没跑、排着队或正在跑）。
 *
 * 「休市」只认 etl 任务明确返回的非交易日（或周末），不从交易日历里有没有今天推断：
 * 开市日指数步骤失败时，日历里同样没有今天，那是「没更新」不是「休市」。
 */
import { type DateStr, type Market, todayCN, weekday } from "@ivan/core";
import { committedAsOf } from "@ivan/data";
import { jobs } from "@ivan/db";
import { and, desc, eq, like } from "drizzle-orm";
import { env, todayOf } from "./env.ts";

export type MarketDay = "traded" | "closed" | "stale" | "pending";

export interface EtlJobToday {
  status: string;
  result: Record<string, unknown> | null;
  createdAt: number;
  /** 自动重跑的次数（S13 起才有） */
  attempt?: number;
}

/** 纯函数：给定今天、最新数据版本日期与今天这个市场的 etl 任务，判断当日状态。 */
export function classifyMarketDay(i: {
  today: DateStr;
  committedAsOf: DateStr | null;
  etlJobsToday: EtlJobToday[];
}): MarketDay {
  if (i.committedAsOf === i.today) return "traded";
  const w = weekday(i.today);
  if (w === 0 || w === 6) return "closed";
  const jobsToday = [...i.etlJobsToday].sort((a, b) => a.createdAt - b.createdAt);
  if (jobsToday.some((j) => j.status === "done" && j.result?.tradingDay === false)) return "closed";
  const lastFailed = jobsToday.findLast((j) => j.status === "failed");
  if (lastFailed) {
    const doneAfter = jobsToday.some(
      (j) => j.status === "done" && j.createdAt > lastFailed.createdAt,
    );
    if (!doneAfter) return "stale";
  }
  return "pending";
}

/** 某个市场今天的状态：读最新数据版本与今天（北京时间）创建的 etl 任务。 */
export async function marketDayStatus(market: Market, today = todayOf()): Promise<MarketDay> {
  const { wh, app } = env();
  // 只看提交过的 ok 版本（D60）：还开着、失败或休市跳过的版本都不算「今天已更新」
  const asOf = await committedAsOf(wh, market);
  const rows = app.db
    .select({ status: jobs.status, result: jobs.result, createdAt: jobs.createdAt })
    .from(jobs)
    .where(and(eq(jobs.kind, "etl"), like(jobs.payload, `%"market":"${market}"%`)))
    .orderBy(desc(jobs.createdAt))
    .limit(50)
    .all();
  return classifyMarketDay({
    today,
    committedAsOf: asOf,
    etlJobsToday: rows.filter((r) => todayCN(new Date(r.createdAt)) === today),
  });
}

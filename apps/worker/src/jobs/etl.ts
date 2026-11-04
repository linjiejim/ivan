/**
 * 夜间 ETL（spec §8）：增量更新行情仓 → 交易日才结算该市场的跟踪。失败则中止后续步骤并记录。
 *
 * 完整性闸门（D73）：运行中跟踪的持仓与明日计划是 critical，缺了只让相关跟踪显示「数据未更新」；
 * 闸门没过、或开市了但指数日 K 还没有今天（可重跑的失败）时 45 分钟后自动再排一次，最多 2 次。
 * 排着队等重跑期间市场当日状态是「没更新」（market-day.ts）。数据源风控（D108）：等解封有预算，用完了被拦的股票记成缺失、
 * 日历指数被拦时整晚抛可重跑的错，两种都走这条自动重跑，排着队时不挡回测。重跑成功而当天的简报已经写过时再排一次简报（加一版）。
 * 补数据（D111）：今天没齐、但截至日能提交到之前齐全的那天时，任务照常完成（结算跟到那天），同样 45 分钟后再排一次接着补；
 * 排着队等的时候市场当日状态是「没更新」，横幅说「补数据中」。
 * A 股夜间更新成功后，如果事件数据的历史已补齐、而事件因子列的补算标记和当前签名或版本对不上（部署了新口径），排上按年补算（S15b）。
 */
import { MARKET_LABEL, type Market, nowHmCN, todayCN } from "@ivan/core";
import { acceptMissingFromEnv, daily } from "@ivan/data";
import { jobs } from "@ivan/db";
import { and, eq } from "drizzle-orm";
import { boundedEtlContext, env, todayOf } from "../env.ts";
import { enqueue, type JobContext } from "../runner.ts";
import { enqueueEventColsIfNeeded } from "./event-cols.ts";
import { criticalCodes, settleMarket } from "./settle.ts";

/** 自动重跑最多几次 */
export const ETL_MAX_RETRIES = 2;
/** 隔多久重跑 */
export const ETL_RETRY_DELAY_MS = 45 * 60_000;

function retryable(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { retryable?: unknown }).retryable === true;
}

/** 今天（北京时间）已经跑完过简报 */
function briefDoneToday(): boolean {
  const today = todayOf();
  return env()
    .app.db.select({ finishedAt: jobs.finishedAt })
    .from(jobs)
    .where(and(eq(jobs.kind, "brief"), eq(jobs.status, "done")))
    .all()
    .some((j) => j.finishedAt !== null && todayCN(new Date(j.finishedAt)) === today);
}

/** 45 分钟后自动重跑（最多 ETL_MAX_RETRIES 次） */
function scheduleRetry(market: Market, ctx: JobContext): void {
  const attempt = ctx.job.attempt ?? 0;
  if (attempt >= ETL_MAX_RETRIES) return;
  const notBefore = Date.now() + ETL_RETRY_DELAY_MS;
  enqueue("etl", { market, retryOf: ctx.job.id }, null, { notBefore, attempt: attempt + 1 });
  ctx.log(
    `${MARKET_LABEL[market]}${nowHmCN(new Date(notBefore))} 自动重试（第 ${attempt + 1}/${ETL_MAX_RETRIES} 次）`,
  );
}

export async function etlJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const market = (ctx.job.payload.market === "HK" ? "HK" : "A") as Market;
  const attempt = ctx.job.attempt ?? 0;
  // 等风控有预算（D108）：用完了被拦的股票记成缺失，交给闸门与下面的自动重跑，不一直占着写库任务的位置挡回测
  const etl = boundedEtlContext(ctx.log, (f, note) => ctx.progress(f * 0.8, note));
  const waited = () => Math.round(etl.rateLimitBudget?.spentMs ?? 0);
  let r: Awaited<ReturnType<typeof daily>>;
  try {
    r = await daily(etl, market, {
      critical: criticalCodes(market),
      acceptMissing: acceptMissingFromEnv(),
    });
  } catch (e) {
    if (retryable(e)) scheduleRetry(market, ctx);
    throw e;
  }
  // 补数据中（D111）：截至日已经往前推了，今晚再排一次接着补
  if (r.catchUp) scheduleRetry(market, ctx);
  if (!r.tradingDay)
    return {
      market,
      tradingDay: false,
      latest: r.latest,
      ...(waited() ? { rateLimitWaitMs: waited() } : {}),
    };
  ctx.progress(0.85, "结算跟踪");
  const s = await settleMarket(market, ctx, { staleCodes: r.completeness?.missingCritical ?? [] });
  // 重跑成功时，当天的简报如果已经写过（还说着「数据没更新」），再排一次，加一版（S10）
  const briefAgain = attempt > 0 && briefDoneToday();
  if (briefAgain) enqueue("brief", {});
  const eventCols = market === "A" ? await enqueueEventColsIfNeeded(ctx.log) : null;
  return {
    market,
    tradingDay: true,
    latest: r.latest,
    dataVersion: r.dataVersion,
    missingCritical: r.completeness?.missingCritical ?? [],
    ...(r.catchUp ? { catchUp: r.catchUp } : {}),
    ...(attempt > 0 ? { attempt } : {}),
    ...(briefAgain ? { briefAgain: true } : {}),
    ...(eventCols ? { eventCols } : {}),
    ...(waited() ? { rateLimitWaitMs: waited() } : {}),
    ...s,
  };
}

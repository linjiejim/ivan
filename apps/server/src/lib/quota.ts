/**
 * 每用户每日额度（D10、D59）：对话消息、回测次数与数据查询（复核等要 worker 组装数据的读请求）。
 * 管理员可逐人覆盖；超额返回 429。
 */
import { todayCN } from "@ivan/core";
import { usageDaily, userQuotas } from "@ivan/db";
import { and, eq, sql } from "drizzle-orm";
import { env } from "../env.ts";
import { AppError } from "./errors.ts";

export type QuotaKind = "chatMessages" | "backtests" | "analyses";

export const QUOTA_KINDS: readonly QuotaKind[] = ["chatMessages", "backtests", "analyses"];

const LABEL: Record<QuotaKind, string> = {
  chatMessages: "对话",
  backtests: "回测",
  analyses: "数据查询",
};

const COLUMN = {
  chatMessages: usageDaily.chatMessages,
  backtests: usageDaily.backtests,
  analyses: usageDaily.analyses,
} as const;

export function quotaOf(userId: string): Record<QuotaKind, number> {
  const { cfg, app } = env();
  const o = app.db.select().from(userQuotas).where(eq(userQuotas.userId, userId)).get();
  return {
    chatMessages: o?.chatMessages ?? cfg.quota.chatMessages,
    backtests: o?.backtests ?? cfg.quota.backtests,
    analyses: o?.analyses ?? cfg.quota.analyses,
  };
}

export function usageToday(userId: string) {
  const { app } = env();
  return (
    app.db
      .select()
      .from(usageDaily)
      .where(and(eq(usageDaily.userId, userId), eq(usageDaily.day, todayCN())))
      .get() ?? { chatMessages: 0, backtests: 0, analyses: 0, tokensIn: 0, tokensOut: 0 }
  );
}

/** 只检查不计数（先挡住超额的请求，等真的拿到结果再 consume）；超额抛 429 */
export function ensureQuota(userId: string, kind: QuotaKind, n = 1): void {
  const limit = quotaOf(userId)[kind];
  const used = usageToday(userId)[kind];
  if (used + n > limit) {
    throw new AppError(
      429,
      `今天的${LABEL[kind]}额度（${limit} 次）已用完，明天再来，或请管理员调高额度。`,
    );
  }
}

/** 检查并计数；超额抛 429。n 为本次消耗。 */
export function consume(userId: string, kind: QuotaKind, n = 1): void {
  ensureQuota(userId, kind, n);
  const { app } = env();
  const col = COLUMN[kind];
  app.db
    .insert(usageDaily)
    .values({ userId, day: todayCN(), [kind]: n })
    .onConflictDoUpdate({
      target: [usageDaily.userId, usageDaily.day],
      set: { [kind]: sql`${col} + ${n}` },
    })
    .run();
}

export function recordTokens(userId: string, tokensIn: number, tokensOut: number): void {
  const { app } = env();
  app.db
    .insert(usageDaily)
    .values({ userId, day: todayCN(), tokensIn, tokensOut })
    .onConflictDoUpdate({
      target: [usageDaily.userId, usageDaily.day],
      set: {
        tokensIn: sql`${usageDaily.tokensIn} + ${tokensIn}`,
        tokensOut: sql`${usageDaily.tokensOut} + ${tokensOut}`,
      },
    })
    .run();
}

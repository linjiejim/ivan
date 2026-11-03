/**
 * 试用申请（D109）：没有邀请码的人在登录页留个邮箱，申请先落库，再发邮件提醒管理员；
 * 管理员在管理页一键发邀请（生成邀请码，配了发信就直接发到申请人邮箱）或忽略。
 * 接口是公开的：每个 IP 每小时最多 3 次、全站 24 小时最多 30 条；同一邮箱已有待处理的申请时不重复记录、不重复提醒。
 */
import { randomInt } from "node:crypto";
import { invites, newId, trialRequests } from "@ivan/db";
import { and, count, desc, eq, gt, sql } from "drizzle-orm";
import { env } from "../env.ts";
import { AppError, notFound } from "../lib/errors.ts";
import { mailConfigured, sendMail } from "../lib/mail.ts";

const PER_IP_PER_HOUR = 3;
const PER_DAY = 30;
export const TRIAL_INVITE_DAYS = 14;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function inviteCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  return s;
}

/** 生成一个一次性邀请码；days 为空 = 不过期 */
export function createInvite(createdBy: string, note: string | null, days: number | null): string {
  const code = inviteCode();
  env()
    .app.db.insert(invites)
    .values({
      id: newId("inv_"),
      code,
      note,
      createdBy,
      expiresAt: days ? Date.now() + days * DAY : null,
    })
    .run();
  return code;
}

// 每个 IP 最近一小时的提交时间；只在内存里，重启清零无妨（全站每日上限在库里）
const hits = new Map<string, number[]>();

function allowIp(ip: string, now: number): boolean {
  const recent = (hits.get(ip) ?? []).filter((t) => t > now - HOUR);
  const ok = recent.length < PER_IP_PER_HOUR;
  if (ok) recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.every((t) => t <= now - HOUR)) hits.delete(k);
  }
  return ok;
}

export function resetTrialLimitsForTest() {
  hits.clear();
}

const clip = (v: unknown, max: number) =>
  typeof v === "string" ? v.trim().slice(0, max) || null : null;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface TrialInput {
  email?: unknown;
  name?: unknown;
  message?: unknown;
  /** 蜜罐：表单里藏着、人看不到的输入框 */
  website?: unknown;
}

export async function submitTrialRequest(input: TrialInput, ip: string): Promise<void> {
  const { cfg, app } = env();
  if (!cfg.trial.enabled) throw new AppError(404, "这个实例没有开放试用申请");
  // 填了蜜罐的多半是脚本：照样回成功，什么都不记
  if (clip(input.website, 200)) return;
  const email = clip(input.email, 200)?.toLowerCase() ?? "";
  if (!EMAIL_RE.test(email)) throw new AppError(400, "邮箱格式不对");
  const name = clip(input.name, 50);
  const message = clip(input.message, 1000);
  const now = Date.now();
  if (!allowIp(ip, now)) throw new AppError(429, "提交得太频繁了，过一个小时再试");

  const pending = app.db
    .select({ id: trialRequests.id })
    .from(trialRequests)
    .where(and(eq(trialRequests.email, email), eq(trialRequests.status, "pending")))
    .get();
  if (pending) return;
  const today = app.db
    .select({ n: count() })
    .from(trialRequests)
    .where(gt(trialRequests.createdAt, now - DAY))
    .get()!.n;
  if (today >= PER_DAY) throw new AppError(429, "今天申请的人太多了，明天再来");

  const id = newId("trq_");
  app.db.insert(trialRequests).values({ id, email, name, message, createdAt: now }).run();

  if (!cfg.trial.notifyTo || !mailConfigured()) return;
  try {
    await sendMail({
      to: cfg.trial.notifyTo,
      replyTo: email,
      subject: `Ivan 试用申请：${email}`,
      text: [
        `${name ?? "（没留称呼）"} <${email}> 申请试用 Ivan。`,
        "",
        "想用 Ivan 看什么：",
        message ?? "（没写）",
        "",
        `去管理页发邀请：${cfg.publicUrl}/admin`,
        "直接回复这封邮件就是回复对方。",
      ].join("\n"),
    });
  } catch (e) {
    console.error("试用申请提醒没发出去", errorText(e));
    app.db
      .update(trialRequests)
      .set({ notifyError: errorText(e).slice(0, 300) })
      .where(eq(trialRequests.id, id))
      .run();
  }
}

export function listTrialRequests() {
  return env()
    .app.db.select()
    .from(trialRequests)
    .orderBy(sql`${trialRequests.status} = 'pending' DESC`, desc(trialRequests.createdAt))
    .limit(200)
    .all();
}

export interface TrialInviteResult {
  code: string;
  link: string;
  /** 邀请邮件发到申请人邮箱了没有；没发出去时 emailError 说明原因，管理员复制链接自己发 */
  emailed: boolean;
  emailError: string | null;
}

/** 认领一条待处理的申请：只有还在 pending 的才改得动，两个人同时点也只会处理一次 */
function claim(id: string, status: "invited" | "dismissed"): void {
  const { app } = env();
  const row = app.db
    .select({ status: trialRequests.status })
    .from(trialRequests)
    .where(eq(trialRequests.id, id))
    .get();
  if (!row) throw notFound("申请");
  const r = app.db
    .update(trialRequests)
    .set({ status, handledAt: Date.now() })
    .where(and(eq(trialRequests.id, id), eq(trialRequests.status, "pending")))
    .run();
  if (r.changes === 0) throw new AppError(409, "这条申请已经处理过了");
}

export async function inviteTrialRequest(id: string, adminId: string): Promise<TrialInviteResult> {
  const { cfg, app } = env();
  claim(id, "invited");
  const row = app.db.select().from(trialRequests).where(eq(trialRequests.id, id)).get()!;
  const code = createInvite(adminId, `试用申请：${row.email}`, TRIAL_INVITE_DAYS);
  app.db.update(trialRequests).set({ inviteCode: code }).where(eq(trialRequests.id, id)).run();
  const link = `${cfg.publicUrl}/register?invite=${code}`;
  if (!mailConfigured()) return { code, link, emailed: false, emailError: "没有配置发信" };
  try {
    await sendMail({
      to: row.email,
      replyTo: cfg.trial.notifyTo || undefined,
      subject: "你的 Ivan 邀请码",
      text: [
        `你好${row.name ? `，${row.name}` : ""}：`,
        "",
        `谢谢你想试试 Ivan。这是你的注册链接，${TRIAL_INVITE_DAYS} 天内有效，注册一次就失效：`,
        link,
        "",
        `链接打不开的话，也可以在注册页手动填邀请码：${code}`,
        "",
        `每个账号每天可以对话 ${cfg.quota.chatMessages} 次、回测 ${cfg.quota.backtests} 次。Ivan 只用于研究，不构成投资建议。`,
        ...(cfg.trial.notifyTo ? ["有问题直接回复这封邮件。"] : []),
      ].join("\n"),
    });
    return { code, link, emailed: true, emailError: null };
  } catch (e) {
    console.error("邀请邮件没发出去", errorText(e));
    return { code, link, emailed: false, emailError: errorText(e) };
  }
}

export function dismissTrialRequest(id: string): void {
  claim(id, "dismissed");
}

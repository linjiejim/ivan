/**
 * 发信（D109）：只发纯文本，经 Resend 的 HTTP 接口，不引入 SMTP 依赖。没配 RESEND_API_KEY 就不发。
 * 发件地址用 Resend 的测试域名（onboarding@resend.dev）时只能发给 Resend 账号自己的邮箱；
 * 要给申请人发邀请，得在 Resend 验证自己的域名，再把 MAIL_FROM 换成那个域名下的地址。
 */
import { env } from "../env.ts";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}

export type Mailer = (mail: Mail) => Promise<void>;

const TIMEOUT_MS = 10_000;

const resend: Mailer = async (mail) => {
  const { resendApiKey, from } = env().cfg.mail;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${resendApiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      from,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
      ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // Resend 的错误体是 { name, message }，只留 message，不把请求内容带进日志
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(`发信失败（${res.status}）：${body?.message ?? res.statusText}`);
  }
};

let override: Mailer | null = null;

export function mailConfigured(): boolean {
  return override !== null || env().cfg.mail.resendApiKey !== "";
}

export function sendMail(mail: Mail): Promise<void> {
  if (override) return override(mail);
  if (!env().cfg.mail.resendApiKey) return Promise.reject(new Error("没有配置发信"));
  return resend(mail);
}

/** 测试用：换成记录发出内容的假发信；传 null 恢复 */
export function setMailerForTest(mailer: Mailer | null) {
  override = mailer;
}

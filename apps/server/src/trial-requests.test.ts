/**
 * 试用申请（D109）：公开提交、限流与去重、提醒邮件、管理员发邀请与忽略。用临时目录的应用库和假发信。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@ivan/core/config";
import { openAppDb } from "@ivan/db";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createAuth, migrateAuth } from "./auth.ts";
import { setEnvForTest } from "./env.ts";
import { type Mail, setMailerForTest } from "./lib/mail.ts";
import { resetTrialLimitsForTest } from "./services/trial-requests.ts";

const dir = mkdtempSync(join(tmpdir(), "ivan-trial-"));
const base = loadConfig();
const cfg = {
  ...base,
  dataDir: dir,
  appDbPath: join(dir, "app.sqlite"),
  publicUrl: "http://localhost:18905",
  workerPort: 1,
  trial: { enabled: true, notifyTo: "owner@example.com" },
  mail: { resendApiKey: "", from: "Ivan <ivan@example.com>" },
};
const handle = openAppDb(cfg.appDbPath);
setEnvForTest(cfg, handle);
let app: ReturnType<typeof createApp>;

let sent: Mail[] = [];
let failMail = false;

async function call(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; ip?: string } = {},
) {
  const res = await app.request(path, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      origin: cfg.publicUrl,
      "x-forwarded-for": init.ip ?? "203.0.113.1",
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

async function signUp(email: string, invite?: string) {
  const r = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: cfg.publicUrl,
      ...(invite ? { "x-invite-code": invite } : {}),
    },
    body: JSON.stringify({ email, password: "password-123", name: email.split("@")[0] }),
  });
  return { status: r.status, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

const rows = () =>
  handle.sqlite.prepare(`SELECT * FROM trial_requests ORDER BY created_at`).all() as Array<{
    id: string;
    email: string;
    name: string | null;
    message: string | null;
    status: string;
    invite_code: string | null;
    notify_error: string | null;
  }>;

let adminCookie = "";

beforeAll(async () => {
  const deps = {
    sqlite: handle.sqlite,
    secret: "test-secret-test-secret-test-secret-00",
    baseURL: cfg.publicUrl,
  };
  await migrateAuth(deps);
  app = createApp(createAuth(deps));
  adminCookie = (await signUp("admin@example.com")).cookie;
  setMailerForTest(async (mail) => {
    if (failMail) throw new Error("发信失败（403）：domain is not verified");
    sent.push(mail);
  });
});

beforeEach(() => {
  handle.sqlite.prepare(`DELETE FROM trial_requests`).run();
  resetTrialLimitsForTest();
  sent = [];
  failMail = false;
  cfg.trial.enabled = true;
});

describe("提交申请", () => {
  it("登录页能知道开放了申请", async () => {
    expect((await call("/api/setup")).json).toMatchObject({ trialRequests: true });
  });

  it("不登录就能提交；先落库，再提醒管理员，回复直达申请人", async () => {
    const r = await call("/api/trial-requests", {
      body: { email: " Alice@Example.com ", name: "Alice", message: "想验证低估值高分红" },
    });
    expect(r.status).toBe(200);
    expect(rows()).toMatchObject([
      {
        email: "alice@example.com",
        name: "Alice",
        message: "想验证低估值高分红",
        status: "pending",
      },
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "owner@example.com", replyTo: "alice@example.com" });
    expect(sent[0]!.text).toContain("想验证低估值高分红");
    expect(sent[0]!.text).toContain("http://localhost:18905/admin");
  });

  it("邮箱不对就拒绝", async () => {
    expect((await call("/api/trial-requests", { body: { email: "not-an-email" } })).status).toBe(
      400,
    );
    expect(rows()).toHaveLength(0);
  });

  it("填了蜜罐的照样回成功，但不记录、不提醒", async () => {
    const r = await call("/api/trial-requests", {
      body: { email: "bot@example.com", website: "http://spam.example" },
    });
    expect(r.status).toBe(200);
    expect(rows()).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("同一邮箱还在排队时不重复记录、不重复提醒", async () => {
    await call("/api/trial-requests", { body: { email: "bob@example.com" } });
    await call("/api/trial-requests", { body: { email: "BOB@example.com" }, ip: "203.0.113.2" });
    expect(rows()).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("同一个 IP 一小时最多 3 次", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await call("/api/trial-requests", { body: { email: `u${i}@example.com` } });
      expect(r.status).toBe(200);
    }
    const blocked = await call("/api/trial-requests", { body: { email: "u4@example.com" } });
    expect(blocked.status).toBe(429);
    const other = await call("/api/trial-requests", {
      body: { email: "u5@example.com" },
      ip: "198.51.100.7",
    });
    expect(other.status).toBe(200);
  });

  it("提醒没发出去也照样收下，原因记在申请上", async () => {
    failMail = true;
    const r = await call("/api/trial-requests", { body: { email: "carol@example.com" } });
    expect(r.status).toBe(200);
    expect(rows()[0]!.notify_error).toContain("domain is not verified");
  });

  it("没开放时 404，登录页也不显示入口", async () => {
    cfg.trial.enabled = false;
    expect((await call("/api/trial-requests", { body: { email: "d@example.com" } })).status).toBe(
      404,
    );
    expect((await call("/api/setup")).json).toMatchObject({ trialRequests: false });
  });
});

describe("管理员处理申请", () => {
  it("发邀请：生成邀请码、发到申请人邮箱，对方用它能注册；不能处理第二次", async () => {
    await call("/api/trial-requests", { body: { email: "dave@example.com", name: "Dave" } });
    const list = await call("/api/admin/trial-requests", { cookie: adminCookie });
    expect(list.json).toMatchObject({ enabled: true, notifies: true });
    const id = rows()[0]!.id;
    sent = [];

    const r = await call(`/api/admin/trial-requests/${id}/invite`, {
      method: "POST",
      cookie: adminCookie,
    });
    expect(r.status).toBe(200);
    const code = String(r.json.code);
    expect(r.json).toMatchObject({
      emailed: true,
      link: `http://localhost:18905/register?invite=${code}`,
    });
    expect(rows()[0]).toMatchObject({ status: "invited", invite_code: code });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "dave@example.com", replyTo: "owner@example.com" });
    expect(sent[0]!.text).toContain(`/register?invite=${code}`);
    expect(sent[0]!.text).toContain("Dave");

    expect((await signUp("dave@example.com", code)).status).toBe(200);
    const again = await call(`/api/admin/trial-requests/${id}/invite`, {
      method: "POST",
      cookie: adminCookie,
    });
    expect(again.status).toBe(409);
  });

  it("邀请邮件没发出去时照样给出链接，让管理员自己发", async () => {
    await call("/api/trial-requests", { body: { email: "erin@example.com" } });
    failMail = true;
    const r = await call(`/api/admin/trial-requests/${rows()[0]!.id}/invite`, {
      method: "POST",
      cookie: adminCookie,
    });
    expect(r.json).toMatchObject({ emailed: false });
    expect(String(r.json.emailError)).toContain("domain is not verified");
    expect(String(r.json.link)).toContain("/register?invite=");
  });

  it("忽略后不再算待处理，同一邮箱可以重新申请", async () => {
    await call("/api/trial-requests", { body: { email: "frank@example.com" } });
    const id = rows()[0]!.id;
    const r = await call(`/api/admin/trial-requests/${id}/dismiss`, {
      method: "POST",
      cookie: adminCookie,
    });
    expect(r.status).toBe(200);
    expect(rows()[0]!.status).toBe("dismissed");
    await call("/api/trial-requests", { body: { email: "frank@example.com" }, ip: "203.0.113.9" });
    expect(rows()).toHaveLength(2);
  });

  it("普通用户看不到、也处理不了申请", async () => {
    await call("/api/trial-requests", { body: { email: "gina@example.com" } });
    const inv = await call("/api/admin/invites", { body: {}, cookie: adminCookie });
    const user = await signUp("user@example.com", String(inv.json.code));
    expect((await call("/api/admin/trial-requests", { cookie: user.cookie })).status).toBe(403);
    const r = await call(`/api/admin/trial-requests/${rows()[0]!.id}/invite`, {
      method: "POST",
      cookie: user.cookie,
    });
    expect(r.status).toBe(403);
    expect(rows()[0]!.status).toBe("pending");
  });
});

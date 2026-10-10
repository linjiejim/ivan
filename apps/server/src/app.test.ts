/**
 * 服务端 API 测试：账号与邀请码（验收 8）、LLM 不能越权（验收 6：不经过 drafts/:id/confirm，
 * 任何工具调用都产生不了策略版本或跟踪）。用临时目录的应用库，不需要 worker 与行情仓。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { todayCN } from "@ivan/core";
import { loadConfig } from "@ivan/core/config";
import { openAppDb } from "@ivan/db";
import { beforeAll, describe, expect, it } from "vitest";
import { buildTools } from "./agent/tools.ts";
import { createApp } from "./app.ts";
import { createAuth, migrateAuth } from "./auth.ts";
import { setEnvForTest } from "./env.ts";
import { registerChat, setChatModelForTest } from "./routes/chat.ts";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";

const dir = mkdtempSync(join(tmpdir(), "ivan-test-"));
const base = loadConfig();
const cfg = {
  ...base,
  dataDir: dir,
  appDbPath: join(dir, "app.sqlite"),
  publicUrl: "http://localhost:18905",
  workerPort: 1,
};
const handle = openAppDb(cfg.appDbPath);
setEnvForTest(cfg, handle);
const deps = {
  sqlite: handle.sqlite,
  secret: "test-secret-test-secret-test-secret-00",
  baseURL: cfg.publicUrl,
};
let app: ReturnType<typeof createApp>;

async function call(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
) {
  const res = await app.request(path, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      origin: cfg.publicUrl,
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...init.headers,
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return {
    status: res.status,
    json: json as Record<string, unknown>,
    cookie: res.headers.get("set-cookie"),
  };
}

async function signUp(email: string, invite?: string) {
  const r = await call("/api/auth/sign-up/email", {
    body: { email, password: "password-123", name: email.split("@")[0] },
    headers: invite ? { "x-invite-code": invite } : {},
  });
  return { ...r, cookie: r.cookie?.split(";")[0] ?? "" };
}

const count = (table: string) =>
  (handle.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

let admin = "";
let adminId = "";

beforeAll(async () => {
  await migrateAuth(deps);
  app = createApp(createAuth(deps), registerChat);
  const r = await signUp("admin@test.local");
  admin = r.cookie;
  adminId = String((r.json.user as { id: string }).id);
});

describe("账号与邀请码（验收 8）", () => {
  it("第一个注册的人是管理员", async () => {
    const me = await call("/api/me", { cookie: admin });
    expect((me.json.user as { role: string }).role).toBe("admin");
  });

  it("没有邀请码不能注册，邀请码只能用一次", async () => {
    expect((await signUp("a@test.local")).status).toBe(400);
    const inv = await call("/api/admin/invites", { body: { note: "t" }, cookie: admin });
    const code = String(inv.json.code);
    const ok = await signUp("b@test.local", code);
    expect(ok.status).toBe(200);
    expect((await signUp("c@test.local", code)).status).toBe(400);
    const me = await call("/api/me", { cookie: ok.cookie });
    expect((me.json.user as { role: string }).role).toBe("user");
    expect((await call("/api/admin/users", { cookie: ok.cookie })).status).toBe(403);
  });

  it("超出每日额度返回 429 和中文提示", async () => {
    await call(`/api/admin/users/${adminId}/quota`, {
      body: { chatMessages: 0, backtests: 0 },
      cookie: admin,
    });
    const versions = count("strategy_versions");
    const s = await call("/api/strategies/from-preset", {
      body: { presetId: "hk-dividend" },
      cookie: admin,
    });
    expect(count("strategy_versions")).toBe(versions + 1);
    const r = await call("/api/runs", { body: { versionId: s.json.versionId }, cookie: admin });
    expect(r.status).toBe(429);
    expect(String(r.json.error)).toMatch(/额度/);
    await call(`/api/admin/users/${adminId}/quota`, {
      body: { chatMessages: null, backtests: null },
      cookie: admin,
    });
  });
});

describe("LLM 不能越权（验收 6）", () => {
  const opts = { toolCallId: "t", messages: [] } as never;

  it("工具只能写草稿；确认之后才有版本", async () => {
    const tools = buildTools({ userId: adminId, threadId: "th_test", page: {} });
    const [strategies0, versions0, drafts0] = [
      count("strategies"),
      count("strategy_versions"),
      count("drafts"),
    ];
    const out = (await tools.propose_strategy!.execute!(
      {
        spec: {
          name: "工具提议",
          market: "A",
          filters: [{ factor: "roe_ttm", op: ">=", value: 15 }],
          rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 10 },
        },
      },
      opts,
    )) as { ok: boolean; draftId: string };
    expect(out.ok).toBe(true);
    expect(count("strategies")).toBe(strategies0);
    expect(count("strategy_versions")).toBe(versions0);
    expect(count("drafts")).toBe(drafts0 + 1);

    const confirmed = await call(`/api/drafts/${out.draftId}/confirm`, {
      method: "POST",
      body: {},
      cookie: admin,
    });
    expect(confirmed.status).toBe(200);
    expect(count("strategy_versions")).toBe(versions0 + 1);

    // 对这个新策略提议上线跟踪：同样只有草稿
    const trackings0 = count("trackings");
    const t = (await buildTools({
      userId: adminId,
      threadId: "th_test",
      page: { strategyId: String(confirmed.json.strategyId) },
    }).propose_tracking!.execute!({}, opts)) as { draftId: string };
    expect(count("trackings")).toBe(trackings0);
    const ok = await call(`/api/drafts/${t.draftId}/confirm`, {
      method: "POST",
      body: {},
      cookie: admin,
    });
    expect(ok.status).toBe(200);
    expect(count("trackings")).toBe(trackings0 + 1);
  });

  it("任何工具都不能直接生成版本或跟踪，也改不了跟踪的状态", async () => {
    const tools = buildTools({ userId: adminId, threadId: "th_test", page: {} });
    const active = () =>
      (
        handle.sqlite
          .prepare(`SELECT count(*) AS n FROM trackings WHERE status = 'active'`)
          .get() as { n: number }
      ).n;
    const before = [count("strategies"), count("strategy_versions"), count("trackings"), active()];
    // 不需要 worker 的工具逐个调一遍（需要行情的工具会因 worker 不在而失败，但同样不许写版本）
    for (const [name, t] of Object.entries(tools)) {
      try {
        const r = t.execute!(name === "list_factors" ? { market: "A" } : {}, opts);
        if (r && typeof (r as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
          for await (const _ of r as AsyncIterable<unknown>) void _;
        } else await r;
      } catch {
        // 缺参数或 worker 不在：忽略，只关心有没有写库
      }
    }
    expect([count("strategies"), count("strategy_versions"), count("trackings"), active()]).toEqual(
      before,
    );
  });

  it("停止跟踪：工具只出确认卡片，用户点了才停", async () => {
    const t = handle.sqlite
      .prepare(`SELECT id FROM trackings WHERE status = 'active' LIMIT 1`)
      .get() as { id: string };
    const tools = buildTools({ userId: adminId, threadId: "th_test", page: {} });
    const card = (await tools.propose_stop_tracking!.execute!({ trackingId: t.id }, opts)) as {
      trackingId: string;
    };
    expect(card.trackingId).toBe(t.id);
    const status = () =>
      (
        handle.sqlite.prepare(`SELECT status FROM trackings WHERE id = ?`).get(t.id) as {
          status: string;
        }
      ).status;
    expect(status()).toBe("active");
    expect((await call(`/api/trackings/${t.id}/stop`, { body: {}, cookie: admin })).status).toBe(
      200,
    );
    expect(status()).toBe("stopped");
    // 已经停了的再提议会报错，不会出卡片
    await expect(
      tools.propose_stop_tracking!.execute!({ trackingId: t.id }, opts) as Promise<unknown>,
    ).rejects.toThrow(/已经停/);
  });

  it("草稿只能本人确认，而且只能确认一次", async () => {
    const other = await signUp(
      "d@test.local",
      String((await call("/api/admin/invites", { body: {}, cookie: admin })).json.code),
    );
    const d = await call("/api/drafts", {
      body: {
        spec: {
          name: "x",
          market: "HK",
          rank: { terms: [{ factor: "pb", weight: 1, better: "low" }], top: 5 },
        },
      },
      cookie: admin,
    });
    expect(d.status).toBe(200);
    expect(
      (
        await call(`/api/drafts/${d.json.draftId}/confirm`, {
          method: "POST",
          body: {},
          cookie: other.cookie,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(`/api/drafts/${d.json.draftId}/confirm`, {
          method: "POST",
          body: {},
          cookie: admin,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(`/api/drafts/${d.json.draftId}/confirm`, {
          method: "POST",
          body: {},
          cookie: admin,
        })
      ).status,
    ).toBe(409);
  });
});

describe("对话链路（模拟模型）", () => {
  const usage = {
    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 20, text: 20, reasoning: 0 },
  };
  const spec = {
    name: "对话建的策略",
    market: "A",
    filters: [{ factor: "roe_ttm", op: ">=", value: 15 }],
    rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 10 },
  };

  it("模型调用 propose_strategy → 卡片数据进流、消息落库、没有生成版本；第二轮能带着工具历史继续", async () => {
    setChatModelForTest(
      new MockLanguageModelV4({
        doStream: [
          {
            stream: convertArrayToReadableStream([
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "propose_strategy",
                input: JSON.stringify({ spec }),
              },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
            ] as never),
          },
          {
            stream: convertArrayToReadableStream([
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "草稿已生成，请在卡片上点确认。" },
              { type: "text-end", id: "t1" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ] as never),
          },
          {
            stream: convertArrayToReadableStream([
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t2" },
              { type: "text-delta", id: "t2", delta: "好的。" },
              { type: "text-end", id: "t2" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ] as never),
          },
        ],
      }) as never,
    );
    const versions0 = count("strategy_versions");
    const drafts0 = count("drafts");
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: cfg.publicUrl, cookie: admin },
      body: JSON.stringify({
        message: {
          id: "m_user_1",
          role: "user",
          parts: [{ type: "text", text: "建一个 ROE 大于 15% 的策略" }],
        },
        context: {},
      }),
    });
    expect(res.status).toBe(200);
    const threadId = res.headers.get("x-thread-id");
    expect(threadId).toBeTruthy();
    const stream = await res.text();
    expect(stream).toContain("propose_strategy");
    expect(stream).toContain("draftId");
    expect(stream).toContain("草稿已生成");
    expect(count("strategy_versions")).toBe(versions0);
    expect(count("drafts")).toBe(drafts0 + 1);
    const t = await call(`/api/threads/${threadId}`, { cookie: admin });
    const msgs = t.json.messages as Array<{
      role: string;
      parts: Array<{ type: string; state?: string }>;
    }>;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(
      msgs[1]!.parts.some(
        (p) => p.type === "tool-propose_strategy" && p.state === "output-available",
      ),
    ).toBe(true);

    // 第二轮：历史里的工具结果要能转回模型消息
    const res2 = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: cfg.publicUrl, cookie: admin },
      body: JSON.stringify({
        threadId,
        message: { id: "m_user_2", role: "user", parts: [{ type: "text", text: "好" }] },
      }),
    });
    expect(res2.status).toBe(200);
    expect(await res2.text()).toContain("好的");
    const t2 = await call(`/api/threads/${threadId}`, { cookie: admin });
    expect((t2.json.messages as unknown[]).length).toBe(4);
    const me = await call("/api/me", { cookie: admin });
    expect((me.json.usage as { chatMessages: number; tokensIn: number }).chatMessages).toBe(2);
    expect((me.json.usage as { tokensIn: number }).tokensIn).toBeGreaterThan(0);
    setChatModelForTest(null);
  });

  it("没配置 LLM 时返回 503 和中文提示", async () => {
    const res = await call("/api/chat", {
      body: { message: { id: "m3", role: "user", parts: [{ type: "text", text: "hi" }] } },
      cookie: admin,
    });
    if (cfg.llm.apiKey) return; // 本机配置了 key 就跳过
    expect(res.status).toBe(503);
    expect(String(res.json.error)).toMatch(/LLM/);
  });
});

describe("LLM 用量（spec §10）", () => {
  it("夜间简报的 token 记在系统账上，不算进对话用量，也不占任何人的额度", async () => {
    const today = todayCN();
    handle.sqlite
      .prepare(
        `INSERT INTO usage_daily (user_id, day, tokens_in, tokens_out) VALUES ('system', ?, 100, 50)`,
      )
      .run(today);
    const r = await call("/api/admin/usage", { cookie: admin });
    const row = (
      r.json as unknown as Array<{ day: string; chatTokens: number; briefTokens: number }>
    ).find((d) => d.day === today)!;
    const users = handle.sqlite
      .prepare(
        `SELECT sum(tokens_in + tokens_out) AS n FROM usage_daily WHERE day = ? AND user_id != 'system'`,
      )
      .get(today) as { n: number };
    expect(row.briefTokens).toBe(150);
    expect(row.chatTokens).toBe(users.n);
    const u = await call("/api/admin/users", { cookie: admin });
    expect((u.json as unknown as Array<{ id: string }>).some((x) => x.id === "system")).toBe(false);
  });
});

describe("运行合约（D55、D57、D59）", () => {
  async function presetVersion(): Promise<{ strategyId: string; versionId: string }> {
    const s = await call("/api/strategies/from-preset", {
      body: { presetId: "hk-dividend" },
      cookie: admin,
    });
    return { strategyId: String(s.json.strategyId), versionId: String(s.json.versionId) };
  }

  /** 直接写一条跑完的回测（server 测试没有 worker） */
  function doneRun(v: { strategyId: string; versionId: string }, params: Record<string, unknown>) {
    const id = `r_test_${Math.random().toString(36).slice(2, 10)}`;
    handle.sqlite
      .prepare(
        `INSERT INTO runs (id, user_id, strategy_id, version_id, kind, params, status, engine_version, finished_at)
         VALUES (?, ?, ?, ?, 'backtest', ?, 'done', '1.2.0', ?)`,
      )
      .run(id, adminId, v.strategyId, v.versionId, JSON.stringify(params), Date.now());
    return id;
  }

  const clearJobs = () =>
    handle.sqlite.prepare(`UPDATE jobs SET status = 'done' WHERE user_id = ?`).run(adminId);

  it("成交假设里有不认识的设置：400 和中文说明；合法的存成完整对象", async () => {
    clearJobs();
    const v = await presetVersion();
    const bad = await call("/api/runs", {
      body: { versionId: v.versionId, start: "2020-01-01", exec: { foo: 1 } },
      cookie: admin,
    });
    expect(bad.status).toBe(400);
    expect(String(bad.json.error)).toBe("成交假设里有不认识的设置：foo");
    const ok = await call("/api/runs", {
      body: { versionId: v.versionId, start: "2020-01-01" },
      cookie: admin,
    });
    expect(ok.status).toBe(200);
    const row = handle.sqlite
      .prepare(`SELECT params FROM runs WHERE id = ?`)
      .get(ok.json.runId) as {
      params: string;
    };
    expect(JSON.parse(row.params).exec).toEqual({ v: 1 });
    clearJobs();
  });

  it("复核数据：排一个 verify 任务、计入数据查询额度；同时第二个 → 409；不占回测队列名额", async () => {
    clearJobs();
    const v = await presetVersion();
    const runId = doneRun(v, {
      start: "2020-01-01",
      end: "2024-12-31",
      capital: 1e6,
      oosMonths: 12,
    });
    const used = async () =>
      ((await call("/api/me", { cookie: admin })).json.usage as { analyses: number }).analyses;
    const before = await used();
    const r = await call(`/api/runs/${runId}/verify`, { method: "POST", body: {}, cookie: admin });
    expect(r.status).toBe(202);
    expect(r.json.status).toBe("queued");
    expect(await used()).toBe(before + 1);
    const job = handle.sqlite
      .prepare(`SELECT kind, payload FROM jobs WHERE id = ?`)
      .get(r.json.jobId) as { kind: string; payload: string };
    expect(job.kind).toBe("verify");
    expect(JSON.parse(job.payload)).toEqual({ runId });
    const run = (await call(`/api/runs/${runId}`, { cookie: admin })).json;
    expect(run.verify).toMatchObject({ status: "queued", kind: "input" });
    expect(run.exec).toEqual({ v: 1 });

    const again = await call(`/api/runs/${runId}/verify`, {
      method: "POST",
      body: {},
      cookie: admin,
    });
    expect(again.status).toBe(409);
    expect(String(again.json.error)).toBe("上一次复核还没结束");
    expect(await used()).toBe(before + 1);
    // 排队中的复核不占 MAX_ACTIVE_JOBS：照样能提交回测
    const bt = await call("/api/runs", {
      body: { versionId: v.versionId, start: "2020-01-01" },
      cookie: admin,
    });
    expect(bt.status).toBe(200);
    clearJobs();
  });

  it("数据查询额度用完 → 429", async () => {
    clearJobs();
    const v = await presetVersion();
    const runId = doneRun(v, {
      start: "2020-01-01",
      end: "2024-12-31",
      capital: 1e6,
      oosMonths: 12,
    });
    await call(`/api/admin/users/${adminId}/quota`, { body: { analyses: 0 }, cookie: admin });
    const r = await call(`/api/runs/${runId}/verify`, { method: "POST", body: {}, cookie: admin });
    expect(r.status).toBe(429);
    expect(String(r.json.error)).toMatch(/数据查询额度/);
    await call(`/api/admin/users/${adminId}/quota`, { body: { analyses: null }, cookie: admin });
  });

  it("完整重跑：计入回测额度，新建 kind = reproduce 的运行，参数照抄；不计入试错次数", async () => {
    clearJobs();
    const v = await presetVersion();
    const params = {
      start: "2020-01-01",
      end: "2024-12-31",
      capital: 1e6,
      oosMonths: 12,
      exec: { v: 1 },
      priorVersions: 2,
    };
    const runId = doneRun(v, params);
    const used = async () =>
      ((await call("/api/me", { cookie: admin })).json.usage as { backtests: number }).backtests;
    const before = await used();
    const r = await call(`/api/runs/${runId}/reproduce`, {
      method: "POST",
      body: {},
      cookie: admin,
    });
    expect(r.status).toBe(200);
    expect(await used()).toBe(before + 1);
    const row = handle.sqlite
      .prepare(`SELECT kind, params, version_id FROM runs WHERE id = ?`)
      .get(r.json.runId) as { kind: string; params: string; version_id: string };
    expect(row.kind).toBe("reproduce");
    expect(row.version_id).toBe(v.versionId);
    expect(JSON.parse(row.params)).toEqual({ ...params, reproOf: runId });
    const job = handle.sqlite.prepare(`SELECT kind FROM jobs WHERE id = ?`).get(r.json.jobId) as {
      kind: string;
    };
    expect(job.kind).toBe("backtest");
    // 重跑不算「同一区间回测过的版本」：另一个版本的回测看到的试错次数里没有它
    const { priorVersionsOnPeriod } = await import("./services/runs.ts");
    expect(priorVersionsOnPeriod(v.strategyId, params as never, "v_other")).toBe(1);
    clearJobs();
  });

  it("完整重跑的终点钉在原运行卡记下的那天；复核与重跑互斥；重跑本身不能复核", async () => {
    clearJobs();
    const v = await presetVersion();
    const runId = doneRun(v, {
      start: "2020-01-01",
      end: "2026-10-05",
      capital: 1e6,
      oosMonths: 0,
    });
    handle.sqlite
      .prepare(`UPDATE runs SET card = ?, card_hash = 'c' WHERE id = ?`)
      .run(JSON.stringify({ schema: 1, params: { end: "2026-09-30" } }), runId);
    const verify = () =>
      call(`/api/runs/${runId}/verify`, { method: "POST", body: {}, cookie: admin });
    const reproduce = () =>
      call(`/api/runs/${runId}/reproduce`, { method: "POST", body: {}, cookie: admin });

    // 复核还在排队：不让重跑
    expect((await verify()).status).toBe(202);
    const blocked = await reproduce();
    expect(blocked.status).toBe(409);
    expect(String(blocked.json.error)).toMatch(/复核还没结束/);
    clearJobs();

    const r = await reproduce();
    expect(r.status).toBe(200);
    const row = handle.sqlite.prepare(`SELECT params FROM runs WHERE id = ?`).get(r.json.runId) as {
      params: string;
    };
    expect(JSON.parse(row.params)).toMatchObject({ end: "2026-09-30", reproOf: runId });
    // 重跑还没跑完：不让复核，也不让再重跑一次
    const v2 = await verify();
    expect(v2.status).toBe(409);
    expect(String(v2.json.error)).toMatch(/完整重跑还没结束/);
    expect((await reproduce()).status).toBe(409);

    // 重跑跑完了：它自己上的 verify 是「和原回测比」的结果，不能被复核盖掉
    handle.sqlite.prepare(`UPDATE runs SET status = 'done' WHERE id = ?`).run(r.json.runId);
    const onRepro = await call(`/api/runs/${r.json.runId}/verify`, {
      method: "POST",
      body: {},
      cookie: admin,
    });
    expect(onRepro.status).toBe(400);
    expect(String(onRepro.json.error)).toBe("重跑的结果请到原回测上复核");
    clearJobs();
  });

  it("基准回测的成交假设读不懂：上线提案给 409 和中文说明，不是 500", async () => {
    const v = await presetVersion();
    doneRun(v, {
      start: "2020-01-01",
      end: "2024-12-31",
      capital: 1e6,
      oosMonths: 12,
      exec: { v: 9 },
    });
    const p = await call("/api/trackings/propose", {
      body: { versionId: v.versionId },
      cookie: admin,
    });
    expect(p.status).toBe(409);
    expect(String(p.json.error)).toBe("基准回测的成交假设读不懂，请先重新回测");
  });

  it("下载运行卡：没有卡的旧回测 404，有卡的作为附件返回", async () => {
    const v = await presetVersion();
    const runId = doneRun(v, {
      start: "2020-01-01",
      end: "2024-12-31",
      capital: 1e6,
      oosMonths: 12,
    });
    expect((await call(`/api/runs/${runId}/card`, { cookie: admin })).status).toBe(404);
    handle.sqlite
      .prepare(`UPDATE runs SET card = ?, card_hash = ? WHERE id = ?`)
      .run(JSON.stringify({ schema: 1, cardHash: "abc" }), "abc", runId);
    const res = await app.request(`/api/runs/${runId}/card`, { headers: { cookie: admin } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="ivan-run-${runId}.json"`,
    );
    expect(await res.json()).toEqual({ schema: 1, cardHash: "abc" });
  });

  it("上线跟踪抄基准回测的成交假设，提案里写明成交假设", async () => {
    const v = await presetVersion();
    doneRun(v, { start: "2020-01-01", end: "2024-12-31", capital: 1e6, oosMonths: 12 });
    const p = await call("/api/trackings/propose", {
      body: { versionId: v.versionId },
      cookie: admin,
    });
    expect(p.status).toBe(200);
    expect(p.json.exec).toEqual({ v: 1 });
    expect(p.json.legacyBaseline).toBe(false);
    const d = handle.sqlite
      .prepare(`SELECT summary FROM drafts WHERE id = ?`)
      .get(p.json.draftId) as {
      summary: string;
    };
    expect(d.summary).toContain("成交假设：开盘价成交，不计滑点（旧口径）");
    const ok = await call(`/api/drafts/${p.json.draftId}/confirm`, {
      method: "POST",
      body: {},
      cookie: admin,
    });
    expect(ok.status).toBe(200);
    const t = handle.sqlite
      .prepare(`SELECT exec_config FROM trackings WHERE id = ?`)
      .get(ok.json.trackingId) as { exec_config: string };
    expect(JSON.parse(t.exec_config)).toEqual({ v: 1 });
    const view = await call(`/api/trackings/${ok.json.trackingId}`, { cookie: admin });
    expect(view.json.execText).toBe("开盘价成交，不计滑点（旧口径）");
  });

  it("管理员改额度只动提交的那几项；/api/me 带数据查询额度", async () => {
    await call(`/api/admin/users/${adminId}/quota`, { body: { backtests: 7 }, cookie: admin });
    await call(`/api/admin/users/${adminId}/quota`, { body: { analyses: 5 }, cookie: admin });
    const me = await call("/api/me", { cookie: admin });
    expect(me.json.quota).toMatchObject({
      backtests: 7,
      analyses: 5,
      chatMessages: cfg.quota.chatMessages,
    });
    expect(me.json.usage).toHaveProperty("analyses");
    const bad = await call(`/api/admin/users/${adminId}/quota`, {
      body: { analyses: -1 },
      cookie: admin,
    });
    expect(bad.status).toBe(400);
    await call(`/api/admin/users/${adminId}/quota`, {
      body: { backtests: null, analyses: null },
      cookie: admin,
    });
    const me2 = await call("/api/me", { cookie: admin });
    expect(me2.json.quota).toMatchObject({
      backtests: cfg.quota.backtests,
      analyses: cfg.quota.analyses,
    });
    const usage = await call("/api/admin/usage", { cookie: admin });
    expect((usage.json as unknown as Array<Record<string, unknown>>)[0]).toHaveProperty("analyses");
  });
});

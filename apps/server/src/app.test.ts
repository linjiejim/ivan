/**
 * 服务端 API 测试：账号与邀请码（验收 8）、LLM 不能越权（验收 6：不经过 drafts/:id/confirm，
 * 任何工具调用都产生不了策略版本或跟踪）。用临时目录的应用库，不需要 worker 与行情仓。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GROUNDING_VERSION } from "@ivan/ai";
import { defaultExec, LEGACY_EXEC, specFactorKeys, todayCN, validateSpec } from "@ivan/core";
import { loadConfig } from "@ivan/core/config";
import { specHashOf } from "@ivan/core/node";
import {
  appendLedger,
  openAppDb,
  packJson,
  planContentHash,
  planItems,
  planSnapshots,
  type TraceBundle,
  unpackJson,
  verifyBundle,
  verifyUserChain,
  writeBriefEdition,
} from "@ivan/db";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildTools, eventsForModel, evidenceForModel } from "./agent/tools.ts";
import { createApp } from "./app.ts";
import { clearDataStatusCache } from "./services/runs.ts";
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

describe("管理接口的请求体", () => {
  it("额度：请求体不是对象 400；用户不存在 404；事件回填：请求体不是对象 400（不转给 worker）", async () => {
    for (const body of [[1], 3, "x"]) {
      const r = await call(`/api/admin/users/${adminId}/quota`, { body, cookie: admin });
      expect(r.status).toBe(400);
      expect(r.json.error).toBe("请求体要是一个对象");
      const e = await call("/api/admin/events/backfill", { body, cookie: admin });
      expect(e.status).toBe(400);
    }
    const nobody = await call(`/api/admin/users/u_nobody/quota`, {
      body: { backtests: 3 },
      cookie: admin,
    });
    expect(nobody.status).toBe(404);
    expect(
      handle.sqlite.prepare(`SELECT 1 FROM user_quotas WHERE user_id = 'u_nobody'`).get(),
    ).toBeUndefined();
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
    // 账本、计划快照、计划项、健康读数、简报版次、跟踪、版本：每个工具调用前后都不变（D68、D70、验收 14）
    const guarded = () => [
      count("strategies"),
      count("strategy_versions"),
      count("trackings"),
      active(),
      count("ledger_entries"),
      count("plan_snapshots"),
      count("plan_items"),
      count("tracking_health"),
      count("brief_editions"),
    ];
    // 不需要 worker 的工具逐个调一遍（需要行情的工具会因 worker 不在而失败，但同样不许写版本）
    for (const [name, t] of Object.entries(tools)) {
      const before = guarded();
      try {
        const r = t.execute!(name === "list_factors" ? { market: "A" } : {}, opts);
        if (r && typeof (r as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
          for await (const _ of r as AsyncIterable<unknown>) void _;
        } else await r;
      } catch {
        // 缺参数或 worker 不在：忽略，只关心有没有写库
      }
      expect(guarded(), name).toEqual(before);
    }
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
    // 每条助手消息都带一份核对结果（这条没有要核对的数）
    expect(msgs[1]!.parts.some((p) => p.type === "data-grounding")).toBe(true);

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

  /** 模拟模型：一步只说一段话 */
  const textStream = (id: string, text: string) =>
    ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id },
        { type: "text-delta", id, delta: text },
        { type: "text-end", id },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
      ] as never),
    }) as never;
  async function chat(text: string) {
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: cfg.publicUrl, cookie: admin },
      body: JSON.stringify({
        message: { id: `m_u_${Math.random()}`, role: "user", parts: [{ type: "text", text }] },
        context: {},
      }),
    });
    const threadId = res.headers.get("x-thread-id");
    const stream = await res.text();
    const row = handle.sqlite
      .prepare(
        `SELECT parts, usage FROM messages WHERE thread_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
      )
      .get(threadId) as { parts: string; usage: string | null };
    const parts = JSON.parse(row.parts) as Array<{ type: string; data?: unknown; text?: string }>;
    const grounding = parts.find((p) => p.type === "data-grounding")?.data as
      | { version: number; checked: number; unverified: Array<{ raw: string; reason: string }> }
      | undefined;
    return {
      status: res.status,
      threadId,
      stream,
      parts,
      grounding,
      usage: row.usage ? (JSON.parse(row.usage) as Record<string, unknown>) : null,
    };
  }

  it("数字核对（D69）：没有工具给过的数字被标注并落库；流和 x-thread-id 不受影响；用量记模型与 token", async () => {
    setChatModelForTest(
      new MockLanguageModelV4({
        modelId: "mock-chat",
        doStream: [textStream("t1", "这个策略超额 +99.9%，很稳。")],
      }) as never,
    );
    const r = await chat("这个策略怎么样？");
    setChatModelForTest(null);
    expect(r.status).toBe(200);
    expect(r.threadId).toBeTruthy();
    expect(r.stream).toContain("超额 +99.9%");
    expect(r.stream).toContain("data-grounding");
    // finish 在核对之后
    expect(r.stream.indexOf("data-grounding")).toBeLessThan(
      r.stream.lastIndexOf('"type":"finish"'),
    );
    expect(r.parts.find((p) => p.type === "text")?.text).toBe("这个策略超额 +99.9%，很稳。");
    expect(r.grounding).toMatchObject({ version: GROUNDING_VERSION, checked: 1 });
    expect(r.grounding!.unverified).toHaveLength(1);
    expect(r.grounding!.unverified[0]).toMatchObject({ raw: "+99.9%", reason: "no_match" });
    expect(r.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      model: "mock-chat",
      grounding: { version: GROUNDING_VERSION, checked: 1, unverified: 1 },
    });
    // 管理页按天统计核对没通过的回复
    const u = await call("/api/admin/usage", { cookie: admin });
    const today = (u.json as unknown as Array<{ day: string; groundingFlagged: number }>).find(
      (d) => d.day === todayCN(),
    );
    expect(today?.groundingFlagged).toBeGreaterThanOrEqual(1);
  });

  it("数字核对：用户自己写的数复述出来、日期与代码都不算编造", async () => {
    setChatModelForTest(
      new MockLanguageModelV4({
        doStream: [textStream("t1", "好的，按 ROE 不低于 15% 来筛，600519 在 2024-06-28 也算。")],
      }) as never,
    );
    const r = await chat("ROE 大于 15% 的有哪些？");
    setChatModelForTest(null);
    expect(r.grounding).toMatchObject({ checked: 1, unverified: [] });
    expect(r.usage).toMatchObject({ grounding: { unverified: 0 } });
  });

  it("数字核对：lookup_security 后照抄股息率（%）、市值（亿）、PE（倍）不误报", async () => {
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.host !== `127.0.0.1:${cfg.workerPort}`) return real(input, init);
      const reply = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (url.pathname === "/internal/securities/search")
        return reply(
          (url.searchParams.get("q") ?? "").includes("00700")
            ? [{ code: "00700.HK", name: "腾讯控股", market: "HK" }]
            : [{ code: "600519.SH", name: "贵州茅台", market: "A" }],
        );
      if (url.pathname === "/internal/securities/600519.SH")
        return reply({
          security: { code: "600519.SH", name: "贵州茅台", market: "A" },
          factors: {
            date: "2024-06-28",
            close: 1460.52,
            dividend_yield_ttm: 3.456,
            mcap: 18345.61,
            pe_ttm: 21.37,
            roe_ttm: 34.19,
          },
          financials: [],
          actions: [],
        });
      return new Response("{}", { status: 404 });
    });
    try {
      setChatModelForTest(
        new MockLanguageModelV4({
          doStream: [
            {
              stream: convertArrayToReadableStream([
                { type: "stream-start", warnings: [] },
                {
                  type: "tool-call",
                  toolCallId: "call_ls",
                  toolName: "lookup_security",
                  input: JSON.stringify({ query: "600519" }),
                },
                {
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: "tool_calls" },
                  usage,
                },
              ] as never),
            },
            textStream(
              "t2",
              "贵州茅台股息率 3.5%，ROE 34.2%，市值约 18,346 亿，PE 21.4 倍，收盘价 1460.52 元（2024-06-28）。",
            ),
          ],
        }) as never,
      );
      const r = await chat("茅台股息率多少");
      expect(r.stream).toContain("lookup_security");
      expect(r.grounding!.checked).toBe(5);
      expect(r.grounding!.unverified).toEqual([]);
      expect(r.usage).toMatchObject({ inputTokens: 200, outputTokens: 40 });
    } finally {
      setChatModelForTest(null);
      vi.unstubAllGlobals();
    }
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
    // 新回测默认规则表与指标第 2 版（D62、D63）、按流动性成交（D64）
    expect(JSON.parse(row.params).exec).toEqual(defaultExec("HK"));
    clearJobs();
  });

  it("成交假设越界：400 和中文说明；合法的覆盖项合并到默认值", async () => {
    clearJobs();
    const v = await presetVersion();
    const bad = await call("/api/runs", {
      body: { versionId: v.versionId, start: "2020-01-01", exec: { slippageBps: 500 } },
      cookie: admin,
    });
    expect(bad.status).toBe(400);
    expect(String(bad.json.error)).toBe("单边滑点要在 0–200 bp 之间");
    const cap = await call("/api/runs", {
      body: { versionId: v.versionId, start: "2020-01-01", exec: { participation: 1.5 } },
      cookie: admin,
    });
    expect(cap.status).toBe(400);
    expect(String(cap.json.error)).toBe("单笔上限要在日均成交额的 1%–100% 之间");
    const ok = await call("/api/runs", {
      body: {
        versionId: v.versionId,
        start: "2020-01-01",
        exec: { slippageBps: 20, participation: null },
      },
      cookie: admin,
    });
    expect(ok.status).toBe(200);
    const row = handle.sqlite
      .prepare(`SELECT params FROM runs WHERE id = ?`)
      .get(ok.json.runId) as {
      params: string;
    };
    expect(JSON.parse(row.params).exec).toEqual({
      ...defaultExec("HK"),
      slippageBps: 20,
      participation: null,
    });
    clearJobs();
  });

  it("对话 run_backtest 带成交假设覆盖项：冲击开关映射成平方根 / 不计", async () => {
    clearJobs();
    const v = await presetVersion();
    const tools = buildTools({ userId: adminId, threadId: "th_test", page: {} });
    const gen = tools.run_backtest!.execute!(
      {
        versionId: v.versionId,
        start: "2020-01-01",
        exec: { slippageBps: 0, impact: false, participation: 0.05 },
      },
      { toolCallId: "t", messages: [] } as never,
    ) as AsyncGenerator<{ runId: string }>;
    const first = await gen.next();
    const runId = first.value.runId;
    await gen.return(undefined as never);
    const row = handle.sqlite.prepare(`SELECT params FROM runs WHERE id = ?`).get(runId) as {
      params: string;
    };
    expect(JSON.parse(row.params).exec).toEqual({
      ...defaultExec("HK"),
      slippageBps: 0,
      impact: "none",
      impactEta: 0,
      participation: 0.05,
    });
    clearJobs();
  });

  it("对比旧口径与新口径的回测：comparable 为 false，模型摘要带每次的成交假设与指标口径", async () => {
    const v = await presetVersion();
    const params = { start: "2020-01-01", end: "2024-12-31", capital: 1e6, oosMonths: 0 };
    const legacy = doneRun(v, params);
    const fresh = doneRun(v, { ...params, exec: defaultExec("HK") });
    const same = doneRun(v, { ...params, exec: defaultExec("HK") });
    const metrics = (version: 1 | 2) =>
      JSON.stringify({
        cagr: 0.1,
        excessCagr: 0.02,
        maxDrawdown: -0.2,
        totalReturn: 0.5,
        sharpe: 1,
        winRate: 0.5,
        buys: 40,
        ...(version === 2 ? { metricsVersion: 2 } : {}),
      });
    const setM = handle.sqlite.prepare(`UPDATE runs SET metrics = ? WHERE id = ?`);
    setM.run(metrics(1), legacy);
    setM.run(metrics(2), fresh);
    setM.run(metrics(2), same);

    const api = await call("/api/runs/compare", { body: { ids: [legacy, fresh] }, cookie: admin });
    expect(api.status).toBe(200);
    expect(api.json.comparable).toBe(false);
    const rows = api.json.runs as Array<{ execText: string; metricsVersion: number }>;
    expect(rows.map((r) => r.metricsVersion)).toEqual([1, 2]);
    expect(rows[0]!.execText).toBe("开盘价成交，不计滑点（旧口径）");
    expect(rows[1]!.execText).toContain("单边滑点 10bp");

    const tools = buildTools({ userId: adminId, threadId: "th_test", page: {} });
    const tool = tools.compare_runs!;
    const out = await tool.execute!({ runIds: [legacy, fresh] }, {
      toolCallId: "t",
      messages: [],
    } as never);
    const model = (await tool.toModelOutput!({
      toolCallId: "t",
      input: {},
      output: out,
    } as never)) as unknown as {
      value: {
        comparable: boolean;
        note?: string;
        runs: Array<{ execText: string; metricsVersion: number }>;
      };
    };
    expect(model.value.comparable).toBe(false);
    expect(model.value.note).toContain("不直接比");
    expect(model.value.runs.map((r) => r.execText)).toEqual(rows.map((r) => r.execText));
    expect(model.value.runs.map((r) => r.metricsVersion)).toEqual([1, 2]);

    const ok = await call("/api/runs/compare", { body: { ids: [fresh, same] }, cookie: admin });
    expect(ok.json.comparable).toBe(true);
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
    // 存下的参数没有 exec：按旧口径补齐
    expect(run.exec).toEqual(LEGACY_EXEC);

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
    // 重跑不算试错：另一种设置看到的试错次数里只有原回测那一种
    const { countTrials } = await import("./services/runs.ts");
    expect(countTrials(v.strategyId, params, "other-spec-hash")).toBe(1);
    clearJobs();
  });

  it("可信度（D65）：回测详情带区间与扇形；给模型的摘要带年化超额区间与跑赢基准的把握；提示词不许说成概率", async () => {
    const v = await presetVersion();
    const runId = doneRun(v, {
      start: "2020-01-01",
      end: "2024-12-31",
      capital: 1e6,
      oosMonths: 0,
    });
    const iv = (est: number, lo: number, hi: number) => ({ est, lo, hi });
    const confidence = {
      method: "stationary_bootstrap",
      version: 1,
      B: 1000,
      blockMean: 21,
      seed: 123,
      n: 1200,
      cagr: iv(0.1, 0.01, 0.2),
      excessCagr: iv(0.042, -0.018, 0.099),
      sharpe: iv(0.8, 0.1, 1.5),
      ir: iv(0.5, -0.1, 1.1),
      maxDrawdown: iv(-0.2, -0.45, -0.12),
      mddMedian: -0.25,
      probExcessPositive: 0.91,
      psrActive: 0.8765,
      actualMddPercentile: 70,
    };
    const fan = {
      horizon: 243,
      days: [243],
      p5: [0.8],
      p25: [0.95],
      p50: [1.05],
      p75: [1.15],
      p95: [1.3],
      mdd: { p5: -0.3, p50: -0.12, p95: -0.05 },
      probLoss: 0.3,
    };
    const metrics = {
      start: "2020-01-02",
      end: "2024-12-31",
      yearly: [],
      monthly: [],
      metricsVersion: 2,
    };
    handle.sqlite
      .prepare(`UPDATE runs SET validation = ?, validation_z = ?, metrics = ? WHERE id = ?`)
      .run(JSON.stringify(confidence), packJson(fan), JSON.stringify(metrics), runId);
    const detail = (await call(`/api/runs/${runId}`, { cookie: admin })).json;
    expect(detail.validation).toEqual(confidence);
    expect(detail.fan).toEqual(fan);
    const { getRun } = await import("./services/runs.ts");
    const { runForModel } = await import("./agent/tools.ts");
    const m = runForModel(getRun(adminId, runId)) as Record<string, unknown>;
    expect(m.excessCagrCi).toEqual([-0.018, 0.099]);
    expect(m.psrActive).toBe(0.88);
    const { systemPrompt } = await import("./agent/prompt.ts");
    expect(systemPrompt(null)).toMatch(/只能说成按历史重抽样的结果，不说概率、不说预测/);
  });

  describe("试错计数（D66）", () => {
    /** 同一策略再加一个版本（策略内容不同，spec_hash 不同） */
    function addVersion(v: { strategyId: string }, n: number, spec: Record<string, unknown>) {
      const id = `v_test_${Math.random().toString(36).slice(2, 10)}`;
      handle.sqlite
        .prepare(
          `INSERT INTO strategy_versions (id, strategy_id, n, spec, spec_hash, source, created_at)
           VALUES (?, ?, ?, ?, ?, 'form', ?)`,
        )
        .run(id, v.strategyId, n, JSON.stringify(spec), specHashOf(spec), Date.now());
      return id;
    }
    function insertRun(
      v: { strategyId: string },
      versionId: string,
      kind: string,
      params: Record<string, unknown>,
      status = "done",
    ) {
      handle.sqlite
        .prepare(
          `INSERT INTO runs (id, user_id, strategy_id, version_id, kind, params, status, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `r_test_${Math.random().toString(36).slice(2, 10)}`,
          adminId,
          v.strategyId,
          versionId,
          kind,
          JSON.stringify(params),
          status,
          Date.now(),
        );
    }
    const specHashOfVersion = (versionId: string) =>
      (
        handle.sqlite
          .prepare(`SELECT spec_hash AS h FROM strategy_versions WHERE id = ?`)
          .get(versionId) as { h: string }
      ).h;
    const period = (start: string, end = "2024-12-31") => ({
      start,
      end,
      capital: 1e6,
      oosMonths: 12,
    });

    it("起点挪一天不清零；扫描子回测计入；和已有版本相同的扫描取值只算一次；重跑与没跑完的不算", async () => {
      const { countTrials } = await import("./services/runs.ts");
      const v = await presetVersion();
      const base = (
        handle.sqlite
          .prepare(`SELECT spec FROM strategy_versions WHERE id = ?`)
          .get(v.versionId) as {
          spec: string;
        }
      ).spec;
      const specA = JSON.parse(base) as Record<string, unknown>;
      const specB = { ...specA, name: `${String(specA.name)} B` };
      const specC = { ...specA, name: `${String(specA.name)} C` };
      const vB = addVersion(v, 2, specB);
      const hashA = specHashOfVersion(v.versionId);
      const hashC = specHashOf(specC);

      insertRun(v, v.versionId, "backtest", period("2018-01-02"));
      insertRun(v, vB, "backtest", period("2018-01-03"));
      // 从第三种设置看：两个版本都算，起点差一天不影响
      expect(countTrials(v.strategyId, period("2018-01-03"), hashC)).toBe(2);
      // 本次自己的策略内容不算
      expect(countTrials(v.strategyId, period("2018-01-03"), hashA)).toBe(1);

      // 扫描子回测按自己的策略内容计入；和版本 A 相同的取值只算一次
      insertRun(v, v.versionId, "sweep_child", { ...period("2018-01-02"), specOverride: specC });
      insertRun(v, v.versionId, "sweep_child", { ...period("2018-01-02"), specOverride: specA });
      expect(countTrials(v.strategyId, period("2018-01-03"), "other")).toBe(3);

      // 重跑、没跑完的、区间重叠不到一半的都不算
      const specD = { ...specA, name: `${String(specA.name)} D` };
      insertRun(v, v.versionId, "reproduce", { ...period("2018-01-02"), specOverride: specD });
      insertRun(
        v,
        v.versionId,
        "sweep_child",
        { ...period("2018-01-02"), specOverride: specD },
        "failed",
      );
      insertRun(v, v.versionId, "sweep_child", {
        ...period("2023-06-01"),
        specOverride: specD,
      });
      expect(countTrials(v.strategyId, period("2018-01-03"), "other")).toBe(3);
      // 区间重叠过半（约 53%）就算
      expect(countTrials(v.strategyId, period("2022-01-01", "2024-12-31"), "other")).toBe(4);
    });

    it("提交回测时存下 priorVersions；扫描的每个取值带自己的试错次数", async () => {
      clearJobs();
      const v = await presetVersion();
      insertRun(v, v.versionId, "backtest", period("2020-01-01"));
      const r = await call("/api/runs", {
        body: { versionId: v.versionId, start: "2020-01-02", end: "2024-12-31" },
        cookie: admin,
      });
      expect(r.status).toBe(200);
      const row = handle.sqlite
        .prepare(`SELECT params FROM runs WHERE id = ?`)
        .get(r.json.runId) as {
        params: string;
      };
      // 同一个版本（同样的策略内容）不算自己
      expect(JSON.parse(row.params).priorVersions).toBe(0);
      clearJobs();
      // 扫描：取值 15 就是当前版本的内容（不算自己），取值 20 看到版本的那次回测
      const sw = await call("/api/runs/sweep", {
        body: { versionId: v.versionId, path: "/rank/top", values: [15, 20], start: "2020-01-02" },
        cookie: admin,
      });
      expect(sw.status).toBe(200);
      const job = handle.sqlite
        .prepare(`SELECT payload FROM jobs WHERE id = ?`)
        .get(sw.json.jobId) as {
        payload: string;
      };
      const variants = JSON.parse(job.payload).variants as Array<{ priorVersions: number }>;
      expect(variants.map((x) => x.priorVersions)).toEqual([0, 1]);
      clearJobs();
    });
  });

  it("补丁路径不能碰原型链：扫描与草稿给 /__proto__/x、/constructor/prototype/x 都 400，Object.prototype 不变", async () => {
    clearJobs();
    const v = await presetVersion();
    for (const path of [
      "/__proto__/polluted",
      "/constructor/prototype/polluted",
      "/rank/__proto__/polluted",
    ]) {
      const sw = await call("/api/runs/sweep", {
        body: { versionId: v.versionId, path, values: [1, 2], start: "2020-01-02" },
        cookie: admin,
      });
      expect(sw.status).toBe(400);
      const d = await call("/api/drafts", {
        body: { strategyId: v.strategyId, patch: [{ op: "add", path, value: "yes" }] },
        cookie: admin,
      });
      expect(d.status).toBe(400);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
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
    expect(p.json.exec).toEqual(LEGACY_EXEC);
    // S04 起新回测已经是新口径：旧口径的基准回测要提示
    expect(p.json.legacyBaseline).toBe(true);
    const d = handle.sqlite
      .prepare(`SELECT summary FROM drafts WHERE id = ?`)
      .get(p.json.draftId) as {
      summary: string;
    };
    expect(d.summary).toContain("成交假设：开盘价成交，不计滑点（旧口径）");
    expect(d.summary).toContain("建议先按新口径重新回测");
    const ok = await call(`/api/drafts/${p.json.draftId}/confirm`, {
      method: "POST",
      body: {},
      cookie: admin,
    });
    expect(ok.status).toBe(200);
    const t = handle.sqlite
      .prepare(`SELECT exec_config FROM trackings WHERE id = ?`)
      .get(ok.json.trackingId) as { exec_config: string };
    expect(JSON.parse(t.exec_config)).toEqual(LEGACY_EXEC);
    const view = await call(`/api/trackings/${ok.json.trackingId}`, { cookie: admin });
    expect(view.json.execText).toBe("开盘价成交，不计滑点（旧口径）");
  });

  it("基准回测是新口径：上线跟踪抄它的成交假设，不提示旧口径", async () => {
    const v = await presetVersion();
    const runId = doneRun(v, {
      start: "2020-01-01",
      end: "2024-12-31",
      capital: 1e6,
      oosMonths: 12,
      exec: { v: 1, rules: 2, metrics: 2 },
    });
    // 确保它是最新跑完的那次（同一毫秒里插入的旧口径回测不能抢先）
    handle.sqlite
      .prepare(`UPDATE runs SET finished_at = ? WHERE id = ?`)
      .run(Date.now() + 60_000, runId);
    const p = await call("/api/trackings/propose", {
      body: { versionId: v.versionId },
      cookie: admin,
    });
    expect(p.status).toBe(200);
    expect(p.json.exec).toEqual({ ...LEGACY_EXEC, rules: 2, metrics: 2 });
    expect(p.json.legacyBaseline).toBe(false);
    expect(p.json.execText).toBe("开盘价成交，不计滑点；规则表第 2 版，指标第 2 版");
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

describe("个股证据（D67、D59）", () => {
  /** 假 worker：只拦 127.0.0.1:{workerPort} 的内部调用，记下请求 */
  type Call = { path: string; body: unknown };
  let calls: Call[] = [];
  const DATA_VERSION = { id: 9, asOf: "2024-06-28" };

  function dossierFor(code: string, asOf: string, factors: string[]) {
    const items = [
      {
        group: "price",
        key: "close",
        label: "收盘价（不复权）",
        value: 10.123,
        unit: "元",
        asOf,
        availDate: asOf,
        ref: { table: "bars_daily", key: { code, date: asOf }, src: "em", ver: 8 },
      },
      ...factors.map((k) => ({
        group: "valuation",
        key: k,
        label: k,
        value: 1.23456,
        asOf,
        availDate: asOf,
        ref: { table: "factors_daily", key: { code, date: asOf }, src: "em", ver: 8 },
      })),
      {
        group: "financial",
        key: "fin_np",
        label: "归母净利润",
        value: 10,
        unit: "亿",
        asOf: "2024-03-31",
        availDate: "2024-01-31",
        ref: {
          table: "financials_seen",
          key: { code, report_date: "2024-03-31" },
          src: "em",
          ver: 2,
        },
        note: "（之后被更正过）",
      },
    ];
    return {
      evidenceVersion: 1,
      code,
      name: "甲",
      market: "A",
      asOf,
      dataDate: asOf,
      dataVersion: DATA_VERSION,
      items,
      caveats: [],
      hash: "f".repeat(64),
    };
  }

  function fakeWorker() {
    calls = [];
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.host !== `127.0.0.1:${cfg.workerPort}`) return real(input, init);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path: url.pathname + url.search, body });
      const reply = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (url.pathname === "/internal/calendar/prev") {
        // 周一的前一个交易日是上周五
        return reply({ prev: url.searchParams.get("date") === "2024-03-04" ? "2024-03-01" : null });
      }
      if (url.pathname === "/internal/securities/search") {
        const q = url.searchParams.get("q");
        return reply(
          q === "银行"
            ? [
                { code: "600001.SH", name: "甲银行", market: "A" },
                { code: "600002.SH", name: "乙银行", market: "A" },
              ]
            : [{ code: "600001.SH", name: "甲", market: "A" }],
        );
      }
      const m = /^\/internal\/securities\/([^/]+)\/dossier$/.exec(url.pathname);
      if (m && m[1] === "600009.SH") {
        // worker 内部出错：原文带 SQL 与文件路径
        return new Response(
          JSON.stringify({
            error: "Binder Error: column x not found in /root/ivan/data/market.duckdb",
          }),
          { status: 500 },
        );
      }
      if (m && m[1] === "600008.SH")
        return new Response(JSON.stringify({ error: "这只股票那天还没有数据" }), { status: 404 });
      if (m) {
        const asOf = url.searchParams.get("asOf") ?? DATA_VERSION.asOf;
        const factors = (url.searchParams.get("factors") ?? "pe_ttm").split(",").filter(Boolean);
        return reply(dossierFor(decodeURIComponent(m[1]!), asOf, factors));
      }
      if (url.pathname === "/internal/explain") {
        const b = body as { date: string; codes: string[] };
        return reply({
          version: 1,
          date: b.date,
          regime: null,
          limit: 40,
          candidates: [],
          codes: [
            {
              code: b.codes[0],
              name: "甲",
              hasData: true,
              passed: true,
              failed: [],
              rank: 12,
              cappedOut: false,
              score: 0.8312,
              termPct: { pe_ttm: 0.83 },
              factors: {},
            },
          ],
        });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });
  }
  afterEach(() => vi.unstubAllGlobals());

  async function aVersion() {
    const s = await call("/api/strategies/from-preset", {
      body: { presetId: "a-quality-value" },
      cookie: admin,
    });
    return { strategyId: String(s.json.strategyId), versionId: String(s.json.versionId) };
  }
  function insertRun(
    v: { strategyId: string; versionId: string },
    kind: string,
    params: Record<string, unknown>,
    card: unknown = null,
  ) {
    const id = `r_ev_${Math.random().toString(36).slice(2, 10)}`;
    handle.sqlite
      .prepare(
        `INSERT INTO runs (id, user_id, strategy_id, version_id, kind, label, params, status, card, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'done', ?, ?)`,
      )
      .run(
        id,
        adminId,
        v.strategyId,
        v.versionId,
        kind,
        kind === "sweep_child" ? "前 5 只" : null,
        JSON.stringify(params),
        card ? JSON.stringify(card) : null,
        Date.now(),
      );
    return id;
  }
  const period = { start: "2020-01-01", end: "2024-06-28", capital: 1e6, oosMonths: 12 };
  const used = async () =>
    ((await call("/api/me", { cookie: admin })).json.usage as { analyses: number }).analyses;

  it("给成交日：按交易日历的前一个交易日取数，没有一项晚于决策日；计入数据查询额度", async () => {
    fakeWorker();
    const before = await used();
    const r = await call("/api/securities/600001/evidence?tradeDate=2024-03-04", { cookie: admin });
    expect(r.status).toBe(200);
    expect(await used()).toBe(before + 1);
    const e = r.json as unknown as {
      decision: { decisionDate: string; tradeDate: string };
      dossier: { asOf: string; items: Array<{ availDate: string }> };
      strategy: unknown;
    };
    expect(e.decision).toEqual({ decisionDate: "2024-03-01", tradeDate: "2024-03-04" });
    expect(calls.map((c) => c.path)).toContain("/internal/calendar/prev?market=A&date=2024-03-04");
    for (const it of e.dossier.items) expect(it.availDate <= "2024-03-01").toBe(true);
    expect(e.strategy).toBeNull();
    // 成交日之前没有交易日
    const none = await call("/api/securities/600001/evidence?tradeDate=2024-01-02", {
      cookie: admin,
    });
    expect(none.status).toBe(400);
    // 没拿到证据不扣额度
    expect(await used()).toBe(before + 1);
    const missing = await call("/api/securities/600008/evidence", { cookie: admin });
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe("这只股票那天还没有数据");
    expect(await used()).toBe(before + 1);
  });

  it("worker 内部出错：只给通用的中文原因，不把 SQL 与文件路径传给用户；不扣额度", async () => {
    fakeWorker();
    const before = await used();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await call("/api/securities/600009/evidence", { cookie: admin });
    errSpy.mockRestore();
    expect(r.status).toBe(500);
    expect(r.json.error).toBe("行情服务出错，请稍后再试");
    expect(JSON.stringify(r.json)).not.toMatch(/Binder|duckdb/);
    expect(await used()).toBe(before);
  });

  it("给了别人的跟踪（同时给了自己的版本）：先 404，不扣额度", async () => {
    fakeWorker();
    const v = await aVersion();
    const before = await used();
    const r = await call(
      `/api/securities/600001/evidence?versionId=${v.versionId}&trackingId=t_nobody&decisionDate=2024-03-01`,
      { cookie: admin },
    );
    expect(r.status).toBe(404);
    expect(await used()).toBe(before);
  });

  it("扫描子回测按它自己的 specOverride 解释；运行卡记的数据版本和现在不同时提示数据修订过", async () => {
    fakeWorker();
    const v = await aVersion();
    const base = (
      handle.sqlite.prepare(`SELECT spec FROM strategy_versions WHERE id = ?`).get(v.versionId) as {
        spec: string;
      }
    ).spec;
    const override = validateSpec({
      ...JSON.parse(base),
      rank: { ...JSON.parse(base).rank, top: 5 },
      filters: [{ factor: "dividend_yield_ttm", op: ">=", value: 3 }],
    }).spec!;
    const child = insertRun(
      v,
      "sweep_child",
      { ...period, specOverride: override },
      {
        data: { versionId: 5 },
      },
    );
    const r = await call(`/api/securities/600001.SH/evidence?tradeDate=2024-03-04&runId=${child}`, {
      cookie: admin,
    });
    expect(r.status).toBe(200);
    const explain = calls.find((c) => c.path === "/internal/explain")!;
    expect(explain.body).toMatchObject({ date: "2024-03-01", codes: ["600001.SH"] });
    expect((explain.body as { spec: unknown }).spec).toEqual(override);
    const dossierCall = calls.find((c) => c.path.includes("/dossier"))!;
    expect(new URL(`http://x${dossierCall.path}`).searchParams.get("factors")).toBe(
      specFactorKeys(override).join(","),
    );
    const e = r.json as unknown as {
      strategy: { source: string; rank: number; band: string; name: string; top: number };
      caveats: Array<{ id: string; title: string }>;
    };
    expect(e.strategy).toMatchObject({ source: "run", rank: 12, band: "out", top: 5 });
    expect(e.strategy.name).toMatch(/（前 5 只）$/);
    expect(e.caveats).toContainEqual({
      id: "run_data_revised",
      level: "warn",
      title: "这次回测之后数据修订过，名次可能和当时不同",
    });

    // 运行卡记的就是现在的数据版本：不提示；没有运行卡：提示早于记录
    const same = insertRun(v, "backtest", period, { data: { versionId: DATA_VERSION.id } });
    const r2 = await call(`/api/securities/600001/evidence?runId=${same}`, { cookie: admin });
    expect((r2.json.caveats as Array<{ id: string }>).map((c) => c.id)).not.toContain(
      "run_data_revised",
    );
    // 普通回测：用版本的策略
    expect(r2.json.strategy).toMatchObject({ source: "run", rank: 12 });
    const old = insertRun(v, "backtest", period);
    const r3 = await call(`/api/securities/600001/evidence?runId=${old}`, { cookie: admin });
    expect(r3.json.caveats).toContainEqual({
      id: "run_data_revised",
      level: "warn",
      title: "这次回测早于数据版本记录，名次可能和当时不同",
    });
    // 别人的回测：404
    expect(
      (await call(`/api/securities/600001/evidence?runId=r_nobody`, { cookie: admin })).status,
    ).toBe(404);
  });

  it("worker 不在：503 和中文说明", async () => {
    const r = await call("/api/securities/600001/evidence", { cookie: admin });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe("行情服务（worker）没有运行");
  });

  it("get_security_evidence：只读、计入额度；名字对应多只时把候选写进错误；给模型的摘要按组留位置", async () => {
    fakeWorker();
    const tools = buildTools({ userId: adminId, threadId: "th_test", page: {} });
    const opts = { toolCallId: "t", messages: [] } as never;
    const tables = ["strategies", "strategy_versions", "trackings", "drafts", "runs", "jobs"];
    const before = tables.map(count);
    const usedBefore = await used();
    const out = (await tools.get_security_evidence!.execute!(
      { query: "600001", tradeDate: "2024-03-04" },
      opts,
    )) as Parameters<typeof evidenceForModel>[0];
    expect(out.decision.decisionDate).toBe("2024-03-01");
    expect(tables.map(count)).toEqual(before);
    expect(await used()).toBe(usedBefore + 1);
    await expect(
      tools.get_security_evidence!.execute!({ query: "银行" }, opts) as Promise<unknown>,
    ).rejects.toThrow("「银行」对应多只股票：甲银行（600001.SH）、乙银行（600002.SH）");

    // 一份 20 个因子的证据：因子只给 7 项，收盘价、财报、两融与筹码不被挤掉；数值四舍五入到 2 位
    const many = dossierFor(
      "600001.SH",
      "2024-03-01",
      Array.from({ length: 20 }, (_, i) => `f${i}`),
    );
    const ev = (key: string, value: number) => ({
      group: "events",
      key,
      label: key,
      value,
      asOf: "2024-03-01",
      availDate: "2024-03-01",
      ref: { table: "factors_daily", key: {}, src: null, ver: null },
    });
    many.items.push(
      ev("margin_ratio", 1.1) as never,
      ev("unlock_days", 181) as never,
      ev("holder_num_qoq", -3) as never,
      ev("block_premium_20d", -2) as never,
    );
    const m = evidenceForModel({
      planRecord: null,
      dossier: many as never,
      decision: { decisionDate: "2024-03-01", tradeDate: "2024-03-04" },
      strategy: null,
      caveats: [
        { id: "restated_possible", level: "info", title: "财报数值为最新版本，可能含事后更正" },
      ],
    });
    expect(m.items.map((i) => i.label)).toEqual([
      ...["f0", "f1", "f2", "f3", "f4", "f5", "f6"],
      "收盘价（不复权）",
      "归母净利润",
      "margin_ratio",
      "unlock_days",
      "holder_num_qoq",
    ]);
    expect(m.items[0]).toEqual({ label: "f0", value: 1.23, unit: null, availDate: "2024-03-01" });
    expect(m).toMatchObject({
      code: "600001.SH",
      decisionDate: "2024-03-01",
      tradeDate: "2024-03-04",
      dataVersion: 9,
      strategy: null,
      caveats: ["财报数值为最新版本，可能含事后更正"],
    });
  });

  it("get_security_evidence 带跟踪与日期：先给那晚第 1 版计划里的记录（第 2 版已存在也一样），不再按现在的数据重新解释", async () => {
    fakeWorker();
    const v = await aVersion();
    const trackingId = insertTracking(v, "2024-01-02");
    insertSnapshot(trackingId, {
      decisionDate: "2024-03-01",
      planDate: "2024-03-04",
      edition: 1,
      rank: 3,
    });
    insertSnapshot(trackingId, {
      decisionDate: "2024-03-01",
      planDate: "2024-03-04",
      edition: 2,
      cause: "data_revision",
      rank: 5,
    });
    const tools = buildTools({ userId: adminId, threadId: "th_test", page: {} });
    const opts = { toolCallId: "t", messages: [] } as never;
    const out = (await tools.get_security_evidence!.execute!(
      { query: "600001", tradeDate: "2024-03-04", trackingId },
      opts,
    )) as Parameters<typeof evidenceForModel>[0];
    expect(out.planRecord).toMatchObject({
      edition: 1,
      inPlan: true,
      side: "sell",
      reasonDetail: "ranked_out",
      reasonText: "掉出前 15 名（排第 3）",
      rank: 3,
      decisionDate: "2024-03-01",
      dataAsOf: "2024-03-01",
    });
    expect(out.strategy).toBeNull();
    expect(calls.some((c) => c.path.startsWith("/internal/explain"))).toBe(false);
    const m = evidenceForModel(out);
    expect(Object.keys(m)[0]).toBe("planRecord");
    expect(m.planRecord).toMatchObject({ rank: 3, reasonText: "掉出前 15 名（排第 3）" });
    // 没有快照的日子：照常按策略解释
    const other = (await tools.get_security_evidence!.execute!(
      { query: "600001", decisionDate: "2024-02-01", trackingId },
      opts,
    )) as Parameters<typeof evidenceForModel>[0];
    expect(other.planRecord).toBeNull();
    expect(other.strategy).toMatchObject({ source: "tracking", rank: 12 });
  });
});

describe("决策账本与计划快照（D68）", () => {
  const opts = { toolCallId: "t", messages: [] } as never;
  async function adminTracking() {
    const st = await call("/api/strategies/from-preset", {
      body: { presetId: "a-quality-value" },
      cookie: admin,
    });
    return insertTracking(
      { strategyId: String(st.json.strategyId), versionId: String(st.json.versionId) },
      "2024-01-02",
    );
  }
  const ledgerKinds = (userId: string) =>
    (
      handle.sqlite
        .prepare(`SELECT kind FROM ledger_entries WHERE user_id = ? ORDER BY seq`)
        .all(userId) as Array<{ kind: string }>
    ).map((r) => r.kind);

  it("确认上线记 tracking_start；对话提议停止只写草稿，确认后才停并记 tracking_stop（带原因）；链校验通过", async () => {
    const st = await call("/api/strategies/from-preset", {
      body: { presetId: "a-quality-value" },
      cookie: admin,
    });
    const tools = buildTools({
      userId: adminId,
      threadId: "th_test",
      page: { strategyId: String(st.json.strategyId) },
    });
    const ledger0 = count("ledger_entries");
    const proposed = (await tools.propose_tracking!.execute!({}, opts)) as { draftId: string };
    expect(count("ledger_entries")).toBe(ledger0);
    const ok = await call(`/api/drafts/${proposed.draftId}/confirm`, { body: {}, cookie: admin });
    const trackingId = String(ok.json.trackingId);
    expect(ledgerKinds(adminId).at(-1)).toBe("tracking_start");

    const [drafts0, ledger1] = [count("drafts"), count("ledger_entries")];
    const card = (await tools.propose_stop_tracking!.execute!(
      { trackingId, reason: "换成新版本" },
      opts,
    )) as { draftId: string; trackingId: string; reason: string };
    expect(card).toMatchObject({ trackingId, reason: "换成新版本" });
    expect(count("drafts")).toBe(drafts0 + 1);
    expect(count("ledger_entries")).toBe(ledger1);
    const status = () =>
      (
        handle.sqlite.prepare(`SELECT status FROM trackings WHERE id = ?`).get(trackingId) as {
          status: string;
        }
      ).status;
    expect(status()).toBe("active");
    const confirmed = await call(`/api/drafts/${card.draftId}/confirm`, {
      body: {},
      cookie: admin,
    });
    expect(confirmed.json).toEqual({ kind: "tracking_stop", trackingId });
    expect(status()).toBe("stopped");
    const last = handle.sqlite
      .prepare(
        `SELECT kind, subject_id AS s, payload_z AS z FROM ledger_entries WHERE user_id = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(adminId) as { kind: string; s: string; z: Buffer };
    expect(last.kind).toBe("tracking_stop");
    expect(last.s).toBe(trackingId);
    expect(unpackJson<Record<string, unknown>>(last.z)).toMatchObject({
      reason: "换成新版本",
      days: 0,
      at: expect.any(Number),
    });
    expect(verifyUserChain(handle, adminId)).toMatchObject({ ok: true });
    // 停了的跟踪：再提议 409、页面再停 409，不会重复记账
    await expect(
      tools.propose_stop_tracking!.execute!({ trackingId }, opts) as Promise<unknown>,
    ).rejects.toThrow(/已经停/);
    expect(
      (await call(`/api/trackings/${trackingId}/stop`, { body: {}, cookie: admin })).status,
    ).toBe(409);
  });

  it("页面上停止：带选填原因，同样记 tracking_stop", async () => {
    const trackingId = await adminTracking();
    const r = await call(`/api/trackings/${trackingId}/stop`, {
      body: { reason: "回撤超出预期" },
      cookie: admin,
    });
    expect(r.status).toBe(200);
    const z = handle.sqlite
      .prepare(
        `SELECT payload_z AS z FROM ledger_entries WHERE subject_id = ? AND kind = 'tracking_stop'`,
      )
      .get(trackingId) as { z: Buffer };
    expect(unpackJson<{ reason: string }>(z.z)!.reason).toBe("回撤超出预期");
  });

  it("get_plan：给模型的摘要带原因文字、名次与数据版本；别人的跟踪 404；接口按归属读快照", async () => {
    const trackingId = await adminTracking();
    const id1 = insertSnapshot(trackingId, {
      decisionDate: "2024-03-01",
      planDate: "2024-03-04",
      edition: 1,
      rank: 3,
    });
    const tools = buildTools({ userId: adminId, threadId: "th_test", page: { trackingId } });
    const out = (await tools.get_plan!.execute!({}, opts)) as never;
    const m = (await tools.get_plan!.toModelOutput!({
      toolCallId: "t",
      input: {},
      output: out,
    })) as unknown as {
      value: Record<string, unknown> & { items: Array<Record<string, unknown>> };
    };
    expect(m.value).toMatchObject({
      snapshotId: id1,
      decisionDate: "2024-03-01",
      planDate: "2024-03-04",
      planDateBasis: "holiday_table",
      edition: 1,
      cause: "initial",
      dataAsOf: "2024-03-01",
      dataVersion: 9,
    });
    expect(m.value.items[0]).toMatchObject({
      side: "sell",
      name: "甲",
      reasonText: "掉出前 15 名（排第 3）",
      rank: 3,
      score: 0.41,
      estWeight: 0.07,
      failedConditions: [],
    });
    expect(m.value.items[0]!.keyFactors).toEqual([
      { factor: "市盈率 TTM", value: 12.35, unit: "x", percentile: 41 },
    ]);
    // 带日期：决策日或成交日都能找到；没有那晚的快照取之前最近的一晚
    const byPlanDate = (await tools.get_plan!.execute!({ date: "2024-03-04" }, opts)) as {
      plan: { id: string };
    };
    expect(byPlanDate.plan.id).toBe(id1);

    const other = await signUp(
      "plan-other@test.local",
      String((await call("/api/admin/invites", { body: {}, cookie: admin })).json.code),
    );
    const otherId = String((other.json.user as { id: string }).id);
    const otherTools = buildTools({ userId: otherId, threadId: "th_x", page: {} });
    await expect(
      otherTools.get_plan!.execute!({ trackingId }, opts) as Promise<unknown>,
    ).rejects.toThrow(/跟踪不存在/);
    expect((await call(`/api/plans/${id1}`, { cookie: other.cookie })).status).toBe(404);
    expect(
      (await call(`/api/trackings/${trackingId}/plans`, { cookie: other.cookie })).status,
    ).toBe(404);
    const mine = await call(`/api/plans/${id1}`, { cookie: admin });
    expect(mine.status).toBe(200);
    expect((mine.json.items as Array<{ reasonText: string }>)[0]!.reasonText).toBe(
      "掉出前 15 名（排第 3）",
    );
    const list = await call(`/api/trackings/${trackingId}/plans?from=2024-01-01`, {
      cookie: admin,
    });
    expect(list.json).toEqual([expect.objectContaining({ id: id1, itemCount: 1 })]);
    // 跟踪详情带最近一版计划（跟踪页「明日计划」的依据）
    const detail = await call(`/api/trackings/${trackingId}`, { cookie: admin });
    expect((detail.json.plan as { id: string }).id).toBe(id1);
  });
});

describe("决策回溯（D71）", () => {
  const opts = { toolCallId: "t", messages: [] } as never;
  let calls: string[] = [];
  /** 假 worker 报的已提交数据版本（测缓存时改它） */
  let dataVersion = 9;
  /** 假 worker：A 股数据截至 2024-04-30；计划结果回看按条目回一个固定值 */
  function fakeWorker() {
    calls = [];
    dataVersion = 9;
    clearDataStatusCache();
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.host !== `127.0.0.1:${cfg.workerPort}`) return real(input, init);
      calls.push(url.pathname);
      const reply = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (url.pathname === "/internal/data-status") {
        return reply({
          markets: [{ market: "A", asOf: "2024-04-30", dataVersion, lastEtl: null, day: "traded" }],
          maintenance: null,
          computePaused: null,
        });
      }
      if (url.pathname === "/internal/plan-outcomes") {
        const b = JSON.parse(String(init!.body)) as {
          items: Array<{ code: string; side: string }>;
        };
        return reply({
          asOf: "2024-04-30",
          outcomes: b.items.map((i) => ({
            code: i.code,
            side: i.side,
            fillDate: "2024-03-04",
            fillOpen: 10,
            estPrice: 10.1,
            slipVsEst: -0.0099,
            ret5: 0.021,
            ret20: 0.031,
            excess5: 0.004,
            excess20: 0.012,
          })),
        });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    // 回溯页的数据状态走 60 秒缓存：别让这里的假数据带到后面的用例
    clearDataStatusCache();
  });

  /** 经确认卡上线一个跟踪，再按 worker 的写法补上两版计划、一条拒单、状态变化与重放差异；另有别的跟踪与一版简报 */
  async function seeded() {
    const st = await call("/api/strategies/from-preset", {
      body: { presetId: "a-quality-value" },
      cookie: admin,
    });
    const tools = buildTools({
      userId: adminId,
      threadId: "th_test",
      page: { strategyId: String(st.json.strategyId) },
    });
    const proposed = (await tools.propose_tracking!.execute!({}, opts)) as { draftId: string };
    const ok = await call(`/api/drafts/${proposed.draftId}/confirm`, { body: {}, cookie: admin });
    const trackingId = String(ok.json.trackingId);
    handle.sqlite
      .prepare(`UPDATE trackings SET last_date = '2024-03-29' WHERE id = ?`)
      .run(trackingId);
    const other = insertTracking(
      { strategyId: String(st.json.strategyId), versionId: String(st.json.versionId) },
      "2024-01-02",
    );
    appendLedger(handle, {
      userId: adminId,
      kind: "tracking_start",
      subjectType: "tracking",
      subjectId: other,
      asOf: "2024-01-02",
      payloadTable: "inline",
      payload: { trackingId: other, note: "别的跟踪的上线内容" },
    });
    const id1 = insertSnapshot(trackingId, {
      decisionDate: "2024-03-01",
      planDate: "2024-03-04",
      edition: 1,
      rank: 3,
    });
    writeBriefEdition(handle, adminId, {
      date: "2024-03-01",
      facts: { trackings: [{ id: other }] },
      content: "简报正文：两个跟踪都正常",
      model: null,
      grounding: null,
    });
    appendLedger(handle, {
      userId: adminId,
      kind: "health_transition",
      subjectType: "tracking",
      subjectId: trackingId,
      asOf: "2024-03-01",
      payloadTable: "inline",
      payload: {
        from: "warming_up",
        to: "monitoring",
        reason: "第一个够样本的读数不正常",
        inputs: {},
      },
    });
    const id2 = insertSnapshot(trackingId, {
      decisionDate: "2024-03-01",
      planDate: "2024-03-04",
      edition: 2,
      cause: "data_revision",
      rank: 5,
    });
    handle.sqlite
      .prepare(
        `INSERT INTO tracking_trades (tracking_id, date, seq, code, name, side, kind, amount, reject_reason)
         VALUES (?, '2024-03-04', 1, '600001.SH', '甲', 'sell', 'reject', 70000, 'limit_down')`,
      )
      .run(trackingId);
    return { trackingId, other, id1, id2 };
  }
  const drift = (trackingId: string, firstDrift: string, asOf = "2024-03-29") =>
    appendLedger(handle, {
      userId: adminId,
      kind: "replay_drift",
      subjectType: "tracking",
      subjectId: trackingId,
      asOf,
      payloadTable: "inline",
      payload: {
        firstDrift,
        navDrift: 2,
        benchDrift: 0,
        maxNavDiff: 0.001,
        cause: "data",
        dataVersion: 9,
      },
    });

  it("时间线：计划、修订、状态变化、简报、重放差异、上线，按日期倒序，带哈希前 8 位", async () => {
    const { trackingId, id2 } = await seeded();
    drift(trackingId, "2024-03-12");
    const r = await call(`/api/trackings/${trackingId}/ledger`, { cookie: admin });
    expect(r.status).toBe(200);
    const entries = r.json.entries as Array<{
      kind: string;
      asOf: string;
      summary: string;
      hash8: string;
      refId: string | null;
      edition: number | null;
    }>;
    expect(r.json.hasMore).toBe(false);
    const summaries = entries.map((e) => e.summary);
    expect(summaries).toEqual(
      expect.arrayContaining([
        "计划 第 1 版（当晚的计划）",
        "计划 第 2 版（数据修订）",
        "状态 观察期 → 偏离（第一个够样本的读数不正常）",
        "简报 第 1 版",
        "重放差异：数据修订，最早影响 2024-03-12",
        "上线",
      ]),
    );
    // 别的跟踪的条目不在时间线里
    expect(entries.some((e) => e.summary.includes("别的跟踪"))).toBe(false);
    expect(entries.find((e) => e.edition === 2)).toMatchObject({ kind: "plan", refId: id2 });
    expect(entries.every((e) => /^[0-9a-f]{8}$/.test(e.hash8))).toBe(true);
    const dates = entries.map((e) => e.asOf);
    expect([...dates].sort().reverse()).toEqual(dates);
    // 按日期范围取：只到 2024-03-01；limit 1 时 hasMore
    const range = await call(
      `/api/trackings/${trackingId}/ledger?from=2024-03-01&to=2024-03-01&limit=1`,
      {
        cookie: admin,
      },
    );
    expect((range.json.entries as unknown[]).length).toBe(1);
    expect(range.json.hasMore).toBe(true);
  });

  it("那天看到的计划：第 1 版对最新版、版次原因、按现在的数据重放没买到（跌停开盘）、5 / 20 天后怎么样", async () => {
    fakeWorker();
    const { trackingId, id1, id2 } = await seeded();
    const r = await call(`/api/trackings/${trackingId}/plan-on?date=2024-03-04`, { cookie: admin });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      decisionDate: "2024-03-01",
      planDate: "2024-03-04",
      edition1: { id: id1, edition: 1 },
      latest: { id: id2, edition: 2 },
      cause: "data_revision",
      causeText: "数据修订",
      diff: {
        added: [],
        removed: [],
        changed: [{ code: "600001.SH", field: "rank", before: 3, after: 5 }],
      },
      replay: [
        {
          code: "600001.SH",
          side: "sell",
          outcome: "rejected",
          rejectReason: "limit_down",
          price: null,
        },
      ],
      revisedAfter: false,
      outcomes: [{ code: "600001.SH", ret5: 0.021, ret20: 0.031, excess20: 0.012 }],
    });
    expect(calls).toContain("/internal/plan-outcomes");
    // 同一晚的结算先写当晚计划、再记重放差异（asOf = 决策日）：第 1 版本来就是按修订后的数据算的，不算
    drift(trackingId, "2024-02-28", "2024-03-01");
    expect(
      (await call(`/api/trackings/${trackingId}/plan-on?date=2024-03-01`, { cookie: admin })).json
        .revisedAfter,
    ).toBe(false);
    // 之后的重放差异：首个漂移日晚于计划日不算；≤ 计划日才算「这晚之后数据修订过」
    drift(trackingId, "2024-03-12");
    expect(
      (await call(`/api/trackings/${trackingId}/plan-on?date=2024-03-01`, { cookie: admin })).json
        .revisedAfter,
    ).toBe(false);
    drift(trackingId, "2024-02-28");
    expect(
      (await call(`/api/trackings/${trackingId}/plan-on?date=2024-03-01`, { cookie: admin })).json
        .revisedAfter,
    ).toBe(true);
    // 计划日还没结算：不给重放结果；决策日之后不满 5 个交易日：不去算结果
    handle.sqlite
      .prepare(`UPDATE trackings SET last_date = '2024-03-01' WHERE id = ?`)
      .run(trackingId);
    insertSnapshot(trackingId, {
      decisionDate: "2024-04-26",
      planDate: "2024-04-29",
      edition: 1,
      rank: 1,
    });
    calls = [];
    const fresh = await call(`/api/trackings/${trackingId}/plan-on`, { cookie: admin });
    expect(fresh.json).toMatchObject({ decisionDate: "2024-04-26", replay: null, outcomes: null });
    expect(calls).not.toContain("/internal/plan-outcomes");
    // 没有那么早的计划
    expect(
      (await call(`/api/trackings/${trackingId}/plan-on?date=2023-01-01`, { cookie: admin })).json,
    ).toBeNull();
  });

  it("计划结果回看按（快照、已提交的数据版本）缓存：反复打开回溯页与结果接口只算一次，数据版本变了才重算", async () => {
    fakeWorker();
    const { trackingId, id1 } = await seeded();
    calls = [];
    clearDataStatusCache();
    const outcomesCalls = () => calls.filter((p) => p === "/internal/plan-outcomes").length;
    const planOn = () =>
      call(`/api/trackings/${trackingId}/plan-on?date=2024-03-04`, { cookie: admin });
    expect((await planOn()).json.outcomes).toEqual([expect.objectContaining({ ret5: 0.021 })]);
    expect(outcomesCalls()).toBe(1);
    expect((await planOn()).json.outcomes).toEqual([expect.objectContaining({ ret5: 0.021 })]);
    // 结果接口与回溯页同一份缓存（第 1 版就是 plan-on 算过的那份）
    const direct = await call(`/api/plans/${id1}/outcomes`, { cookie: admin });
    expect(direct.status).toBe(200);
    expect(direct.json.outcomes).toEqual([expect.objectContaining({ code: "600001.SH" })]);
    expect(outcomesCalls()).toBe(1);
    // 数据状态也走缓存：三次请求只问了 worker 一次
    expect(calls.filter((p) => p === "/internal/data-status")).toHaveLength(1);
    // 提交了新的数据版本：重算一次
    dataVersion = 10;
    clearDataStatusCache();
    await planOn();
    expect(outcomesCalls()).toBe(2);
    await call(`/api/plans/${id1}/outcomes`, { cookie: admin });
    expect(outcomesCalls()).toBe(2);
  });

  it("导出：离线校验通过；别的跟踪与简报只有哈希；校验接口；别人 404", async () => {
    const { trackingId, other } = await seeded();
    const r = await app.request(`/api/trackings/${trackingId}/export`, {
      headers: { cookie: admin, origin: cfg.publicUrl },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toMatch(
      new RegExp(`attachment; filename="ivan-trace-${trackingId}-\\d{4}-\\d{2}-\\d{2}\\.json"`),
    );
    const text = await r.text();
    const bundle = JSON.parse(text) as TraceBundle;
    expect(verifyBundle(bundle)).toMatchObject({ ok: true, checked: bundle.entries.length });
    expect(bundle.chain.ok).toBe(true);
    expect(bundle.tracking).toMatchObject({ id: trackingId, startDate: expect.any(String) });
    expect(bundle.manifest).toMatchObject({
      engineVersion: expect.any(String),
      hashVersion: 2,
      factorCoreVersion: 2,
      eventFactorVersion: 1,
      evidenceVersion: 2,
    });
    expect(bundle.verification.canonicalJson).toMatch(/canonicalJson/);
    expect(text).not.toContain(other);
    expect(text).not.toContain("别的跟踪的上线内容");
    expect(text).not.toContain("简报正文");
    const brief = bundle.entries.filter((e) => "foreign" in e);
    expect(brief.length).toBeGreaterThan(0);
    // 篡改一个值：报出那一条
    const plan = bundle.entries.find((e) => "kind" in e && e.kind === "plan")!;
    (bundle.payloads[String(plan.seq)] as { cash: number }).cash = 1;
    expect(verifyBundle(bundle).firstBreak).toEqual({
      seq: plan.seq,
      reason: "payload_hash_mismatch",
    });

    const v = await call("/api/ledger/verify", { body: {}, cookie: admin });
    expect(v.json).toMatchObject({ ok: true, firstBreak: null });
    expect(v.json.checked).toBe(bundle.entries.length);

    const stranger = await signUp(
      "trace-other@test.local",
      String((await call("/api/admin/invites", { body: {}, cookie: admin })).json.code),
    );
    for (const path of ["export", "ledger", "plan-on"]) {
      expect(
        (await call(`/api/trackings/${trackingId}/${path}`, { cookie: stranger.cookie })).status,
      ).toBe(404);
    }
    // 陌生人自己的链是空的，也是通过的
    expect((await call("/api/ledger/verify", { body: {}, cookie: stranger.cookie })).json).toEqual({
      ok: true,
      checked: 0,
      firstBreak: null,
    });
    // 改了库里的一条（绕过只追加的触发器）：校验指出第一处断点
    const strangerId = String((stranger.json.user as { id: string }).id);
    for (let i = 0; i < 3; i++) {
      appendLedger(handle, {
        userId: strangerId,
        kind: "tracking_start",
        subjectType: "user",
        subjectId: strangerId,
        asOf: "2024-01-02",
        payloadTable: "inline",
        payload: { i },
      });
    }
    const trigger = handle.sqlite
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'ledger_entries_no_update'`,
      )
      .get() as { sql: string };
    handle.sqlite.exec(`DROP TRIGGER ledger_entries_no_update`);
    try {
      handle.sqlite
        .prepare(`UPDATE ledger_entries SET payload_z = ? WHERE user_id = ? AND seq = 2`)
        .run(packJson({ i: 99 }), strangerId);
    } finally {
      handle.sqlite.exec(trigger.sql);
    }
    expect((await call("/api/ledger/verify", { body: {}, cookie: stranger.cookie })).json).toEqual({
      ok: false,
      checked: 1,
      firstBreak: { seq: 2, reason: "payload_hash_mismatch" },
    });
  });
});

/** 直接写一个运行中的跟踪（绕过确认卡，测试用） */
describe("跟踪判词（D70）", () => {
  const opts = { toolCallId: "t", messages: [] } as never;
  /** 假 worker：只回 /internal/data-status，A 股今天的状态与最新数据日可调 */
  function fakeDataStatus(a: { day: string; asOf: string }) {
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.host !== `127.0.0.1:${cfg.workerPort}`) return real(input, init);
      if (url.pathname === "/internal/data-status") {
        return new Response(
          JSON.stringify({
            markets: [{ market: "A", asOf: a.asOf, dataVersion: 3, lastEtl: null, day: a.day }],
            maintenance: null,
            computePaused: null,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });
  }
  afterEach(() => vi.unstubAllGlobals());

  async function trackingWith(summary: Record<string, unknown>) {
    const st = await call("/api/strategies/from-preset", {
      body: { presetId: "a-quality-value" },
      cookie: admin,
    });
    const id = insertTracking(
      { strategyId: String(st.json.strategyId), versionId: String(st.json.versionId) },
      "2026-08-03",
    );
    handle.sqlite
      .prepare(
        `UPDATE trackings SET summary = ?, last_date = '2026-09-30', last_nav = 1.01, last_bench = 1.03, deviation_pct = 2 WHERE id = ?`,
      )
      .run(JSON.stringify(summary), id);
    return id;
  }
  const health = {
    state: "monitoring",
    signal: "warning",
    perMetric: {
      beatBacktestPct: { value: 2.4, signal: "warning" },
      ddRatio: { value: 1.1234, signal: "healthy" },
    },
    version: 1,
  };

  it("看板与跟踪页：偏离、结算失败（横幅列出）、数据未更新（市场 stale）", async () => {
    fakeDataStatus({ day: "traded", asOf: "2026-09-30" });
    const drifting = await trackingWith({ lastDate: "2026-09-30", health });
    const failed = await trackingWith({
      lastDate: "2026-09-29",
      health,
      lastError: { date: "2026-09-30", message: "跟踪的策略版本不合法" },
    });
    const d = await call("/api/dashboard", { cookie: admin });
    const rows = d.json.trackings as Array<{ id: string; verdict: string; health: unknown }>;
    expect(rows.find((r) => r.id === drifting)).toMatchObject({ verdict: "DRIFTING", health });
    expect(rows.find((r) => r.id === failed)!.verdict).toBe("SETTLE_FAILED");
    expect((d.json.data as { settleFailures: unknown[] }).settleFailures).toContainEqual({
      trackingId: failed,
      name: expect.any(String),
      date: "2026-09-30",
      message: "跟踪的策略版本不合法",
    });
    const page = await call(`/api/trackings/${drifting}`, { cookie: admin });
    expect(page.json).toMatchObject({ verdict: "DRIFTING", lastError: null });

    vi.unstubAllGlobals();
    fakeDataStatus({ day: "stale", asOf: "2026-09-30" });
    const stale = await call(`/api/trackings/${drifting}`, { cookie: admin });
    expect(stale.json.verdict).toBe("STALE_DATA");
  });

  it("看板的数据状态只给横幅用得到的字段；失败原因与维护说明只给管理员", async () => {
    const { dashboardDataStatus } = await import("./services/dashboard.ts");
    const full = {
      markets: [
        {
          market: "A",
          asOf: "2026-09-30",
          dataVersion: 3,
          lastEtl: {
            status: "failed",
            finishedAt: 1,
            error: "IO Error: /root/ivan/data/market.duckdb",
          },
          day: "stale" as const,
          sources: {
            versionId: 3,
            status: "ok",
            date: null,
            served: { em: 1 },
            fallbacks: 0,
            failed: 0,
            empty: 0,
            index: {},
          },
          soft: [{ step: "fx", lastOkDate: null, failingNights: 3, firstFailDate: null }],
          capture: { attrs: [], financialsSeen: { rows: 1, new7d: 0 } },
        },
      ],
      maintenance: "行情仓要升级到第 5 版：先停 worker 跑 scripts/migrate.sh",
      computePaused: { reason: "etl", since: 1 },
      events: {
        datasets: {},
        backfill: { status: "idle", notBefore: null, progress: {}, lastBatch: null },
      },
      workerUp: true,
    };
    const user = dashboardDataStatus(full, false);
    expect(user).toEqual({
      markets: [
        {
          market: "A",
          asOf: "2026-09-30",
          dataVersion: 3,
          lastEtl: { status: "failed", finishedAt: 1, error: null },
          day: "stale",
        },
      ],
      maintenance: "行情仓维护中",
      computePaused: { reason: "etl", since: 1 },
      workerUp: true,
    });
    const adminView = dashboardDataStatus(full, true);
    expect(adminView.markets[0]!.lastEtl!.error).toMatch(/IO Error/);
    expect(adminView.maintenance).toMatch(/migrate/);
    expect(adminView).not.toHaveProperty("events");
  });

  it("get_tracking：带判词与健康度，字段叫 beatBacktestPct；给模型的判词是中文", async () => {
    fakeDataStatus({ day: "closed", asOf: "2026-09-30" });
    const trackingId = await trackingWith({ lastDate: "2026-09-30", health });
    const tools = buildTools({ userId: adminId, threadId: "th_test", page: { trackingId } });
    const out = (await tools.get_tracking!.execute!({}, opts)) as Record<string, unknown>;
    expect(out).toMatchObject({ trackingId, beatBacktestPct: 2, verdict: "DRIFTING" });
    expect(out).not.toHaveProperty("deviationPct");
    const m = (await tools.get_tracking!.toModelOutput!({
      toolCallId: "t",
      input: {},
      output: out as never,
    })) as unknown as { value: Record<string, unknown> };
    expect(m.value).toMatchObject({
      verdict: "偏离",
      beatBacktestPct: 2,
      health: {
        state: "偏离",
        verdict: "偏离",
        perMetric: {
          beatBacktestPct: { value: 2, signal: "warning" },
          ddRatio: { value: 1.12, signal: "healthy" },
        },
      },
    });
  });

  it("get_tracking：停了的跟踪没有判词（不说「数据未更新」）；早于判词存下的结果原样给模型", async () => {
    fakeDataStatus({ day: "traded", asOf: "2026-09-30" });
    const trackingId = await trackingWith({ lastDate: "2026-09-01", health });
    handle.sqlite.prepare(`UPDATE trackings SET status = 'stopped' WHERE id = ?`).run(trackingId);
    const tools = buildTools({ userId: adminId, threadId: "th_test", page: { trackingId } });
    const out = (await tools.get_tracking!.execute!({}, opts)) as Record<string, unknown>;
    expect(out).toMatchObject({ stopped: true, verdict: null, health: null });
    const toModel = async (output: unknown) =>
      (
        (await tools.get_tracking!.toModelOutput!({
          toolCallId: "t",
          input: {},
          output: output as never,
        })) as unknown as {
          value: Record<string, unknown>;
        }
      ).value;
    expect(await toModel(out)).toMatchObject({ verdict: "已停止", health: null });
    // S10 之前存下的输出：没有 verdict / health，不替它编「观察期」
    const old = { trackingId, strategyName: "x", days: 3, excess: 0.01, deviationPct: 40 };
    expect(await toModel(old)).toEqual(old);
  });
});

function insertTracking(v: { strategyId: string; versionId: string }, startDate: string): string {
  const id = `t_${Math.random().toString(36).slice(2, 10)}`;
  handle.sqlite
    .prepare(
      `INSERT INTO trackings (id, user_id, strategy_id, version_id, market, start_date, capital)
       VALUES (?, ?, ?, ?, 'A', ?, 1000000)`,
    )
    .run(id, adminId, v.strategyId, v.versionId, startDate);
  return id;
}

/** 按 worker 结算的写法写一版快照（一条卖出计划项 600001.SH）并记账本 */
function insertSnapshot(
  trackingId: string,
  o: { decisionDate: string; planDate: string; edition: number; cause?: string; rank: number },
): string {
  const id = `ps_${Math.random().toString(36).slice(2, 10)}`;
  const item = {
    seq: 1,
    code: "600001.SH",
    name: "甲",
    side: "sell",
    reason: "rebalance",
    reasonDetail: "ranked_out",
    rank: o.rank,
    score: 0.4123,
    estPrice: 10.1,
    estShares: 7000,
    estWeight: 0.0707,
    refClose: 10.1,
    curWeight: 0.0707,
    failedConditions: [] as string[],
    factors: { pe_ttm: 12.345 },
    termPct: { pe_ttm: 0.41 },
  };
  const versionId = (
    handle.sqlite.prepare(`SELECT version_id AS v FROM trackings WHERE id = ?`).get(trackingId) as {
      v: string;
    }
  ).v;
  const content = {
    trackingId,
    decisionDate: o.decisionDate,
    planDate: o.planDate,
    versionId,
    specHash: "spec",
    regime: null,
    exposureCurrent: null,
    exposureNext: null,
    equity: 1e6,
    cash: 1000,
    positions: [],
    candidates: [],
  };
  const contentHash = planContentHash(content, [item]);
  handle.db
    .insert(planSnapshots)
    .values({
      id,
      trackingId,
      userId: adminId,
      decisionDate: o.decisionDate,
      planDate: o.planDate,
      planDateBasis: "holiday_table",
      edition: o.edition,
      cause: o.cause ?? "initial",
      versionId,
      specHash: "spec",
      dataVersion: 9,
      dataAsOf: o.decisionDate,
      engineVersion: "1.2.0",
      execHash: "e".repeat(64),
      inputHash: "i".repeat(64),
      hashVersion: 2,
      explainHash: "x".repeat(64),
      equity: 1e6,
      cash: 1000,
      band: 15,
      benchSym: "csi300_tr",
      benchClose: 3500,
      positionsZ: packJson([]),
      candidatesZ: packJson([]),
      contentHash,
    })
    .run();
  handle.db
    .insert(planItems)
    .values({ ...item, snapshotId: id })
    .run();
  appendLedger(handle, {
    userId: adminId,
    kind: "plan",
    subjectType: "tracking",
    subjectId: trackingId,
    asOf: o.decisionDate,
    payloadTable: "plan_snapshots",
    payloadId: id,
    payloadHash: contentHash,
  });
  return id;
}

describe("数据质量（D74）", () => {
  it("管理页数据接口带数据质量；标为已核对只有管理员能做，转给 worker", async () => {
    const calls: string[] = [];
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.host !== `127.0.0.1:${cfg.workerPort}`) return real(input, init);
      calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
      const reply = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
      if (url.pathname === "/internal/data-status")
        return reply({ markets: [], maintenance: null });
      if (url.pathname === "/internal/data-quality")
        return reply({
          days: 7,
          byRule: [{ rule: "ohlc", severity: "reject", n: 1, open: 1 }],
          topCodes: [],
          open: [],
          lastVersions: [],
        });
      if (url.pathname === "/internal/data-issues/3/resolve")
        return reply({ id: 3, resolvedVer: 9, resolvedBy: "admin" });
      return reply({ error: "没有" }, 404);
    });
    try {
      const d = await call("/api/admin/data", { cookie: admin });
      expect(d.status).toBe(200);
      expect(d.json.quality).toMatchObject({ byRule: [{ rule: "ohlc", n: 1 }] });
      const inv = await call("/api/admin/invites", { body: { note: "dq" }, cookie: admin });
      const user = await signUp("dq@test.local", String(inv.json.code));
      expect(
        (await call("/api/admin/data-issues/3/resolve", { method: "POST", cookie: user.cookie }))
          .status,
      ).toBe(403);
      const ok = await call("/api/admin/data-issues/3/resolve", { method: "POST", cookie: admin });
      expect(ok.json).toEqual({ id: 3, resolvedVer: 9, resolvedBy: "admin" });
      expect(
        (await call("/api/admin/data-issues/x/resolve", { method: "POST", cookie: admin })).status,
      ).toBe(400);
      expect(calls).toContain("GET /internal/data-quality?days=7");
      expect(calls).toContain("POST /internal/data-issues/3/resolve");
      expect(calls.filter((c) => c.includes("resolve"))).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("点时事件数据回填（S15）", () => {
  it("估算与排回填只有管理员能用，转给 worker；已经有一个在排队时 409 原样转回", async () => {
    const calls: string[] = [];
    let queued = false;
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.host !== `127.0.0.1:${cfg.workerPort}`) return real(input, init);
      calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
      const reply = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
      if (url.pathname === "/internal/events/estimate")
        return reply({
          since: url.searchParams.get("since") ?? "2013-01-01",
          requests: 4,
          lines: ["两融明细：约 600 万行，12,000-15,330 次请求，按 0.6 秒 / 次约 2.0-2.6 小时"],
          datasets: [],
        });
      if (url.pathname === "/internal/events/backfill") {
        if (queued) return reply({ error: "已经有一个事件数据回填在排队或运行" }, 409);
        queued = true;
        return reply({ jobId: "j_events" });
      }
      if (url.pathname === "/internal/jobs/kick") return reply({ ok: true });
      return reply({ error: "没有" }, 404);
    });
    try {
      const inv = await call("/api/admin/invites", { body: { note: "ev" }, cookie: admin });
      const user = await signUp("ev@test.local", String(inv.json.code));
      expect((await call("/api/admin/events/estimate", { cookie: user.cookie })).status).toBe(403);
      expect(
        (await call("/api/admin/events/backfill", { body: {}, cookie: user.cookie })).status,
      ).toBe(403);
      expect(calls).toEqual([]);

      const est = await call("/api/admin/events/estimate?since=2015-01-01", { cookie: admin });
      expect(est.status).toBe(200);
      expect(est.json).toMatchObject({ since: "2015-01-01", requests: 4 });
      expect(
        (await call("/api/admin/events/estimate?since=2015-1-1", { cookie: admin })).status,
      ).toBe(400);

      const first = await call("/api/admin/events/backfill", { body: {}, cookie: admin });
      expect(first.json).toEqual({ jobId: "j_events" });
      const second = await call("/api/admin/events/backfill", { body: {}, cookie: admin });
      expect(second.status).toBe(409);
      expect(second.json.error).toBe("已经有一个事件数据回填在排队或运行");
      expect(calls).toContain("GET /internal/events/estimate?since=2015-01-01");
      expect(calls.filter((c) => c === "POST /internal/events/backfill")).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("提交前校验基准与港股通名单（D75、D77）", () => {
  /** 假 worker：data-status 给 A 股各基准首个数据日、港股通名单（null = 没有记录）；记下请求 */
  function fakeWorker(o: { hkConnect: { attrs: string[]; firstDate: string } | null }) {
    const calls: string[] = [];
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.host !== `127.0.0.1:${cfg.workerPort}`) return real(input, init);
      calls.push(url.pathname);
      const reply = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
      if (url.pathname === "/internal/data-status")
        return reply({
          markets: [
            {
              market: "A",
              asOf: "2026-09-30",
              dataVersion: 5,
              lastEtl: null,
              benchFirstDates: {
                csi300_tr: "2013-01-04",
                sse: "2013-01-04",
                csi500_tr: "2013-01-04",
                csi1000_tr: "2014-10-17",
                csi_div_tr: null,
              },
            },
            {
              market: "HK",
              asOf: "2026-09-30",
              dataVersion: 5,
              lastEtl: null,
              benchFirstDates: { hsi_tr: "2013-01-02", hscei_tr: "2013-01-02" },
              hkConnect: o.hkConnect,
            },
          ],
          maintenance: null,
          computePaused: null,
        });
      return reply({ ok: true });
    });
    return calls;
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    clearDataStatusCache();
  });

  const backtestsToday = () =>
    (
      handle.sqlite
        .prepare(
          `SELECT coalesce(sum(backtests), 0) AS n FROM usage_daily WHERE user_id = ? AND day = ?`,
        )
        .get(adminId, todayCN()) as { n: number }
    ).n;
  const clearJobs = () =>
    handle.sqlite.prepare(`UPDATE jobs SET status = 'done' WHERE user_id = ?`).run(adminId);

  async function versionOf(spec: Record<string, unknown>): Promise<string> {
    const d = await call("/api/drafts", { body: { spec }, cookie: admin });
    expect(d.status).toBe(200);
    const c = await call(`/api/drafts/${d.json.draftId}/confirm`, {
      method: "POST",
      body: {},
      cookie: admin,
    });
    expect(c.status).toBe(200);
    return String(c.json.versionId);
  }
  const rank = { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 5 };

  it("中证1000 起点早于首个数据日：400、不排任务、不扣额度；之后的起点照常排队", async () => {
    clearJobs();
    fakeWorker({ hkConnect: null });
    const versionId = await versionOf({ name: "小盘", market: "A", rank, benchmark: "csi1000" });
    const used = backtestsToday();
    const runs0 = count("runs");
    const jobs0 = count("jobs");
    const bad = await call("/api/runs", {
      body: { versionId, start: "2014-06-03" },
      cookie: admin,
    });
    expect(bad.status).toBe(400);
    expect(String(bad.json.error)).toBe(
      "基准「中证1000全收益」从 2014-10-17 才有数据，请把起点设在这之后，或换个基准",
    );
    // 起点就是首个数据日：前一个交易日还没有基准，同样拒绝
    const same = await call("/api/runs", {
      body: { versionId, start: "2014-10-17" },
      cookie: admin,
    });
    expect(same.status).toBe(400);
    // 参数扫描同样在扣额度之前拦下
    const sweep = await call("/api/runs/sweep", {
      body: { versionId, path: "/rank/top", values: [3, 5], start: "2014-06-03" },
      cookie: admin,
    });
    expect(sweep.status).toBe(400);
    expect(backtestsToday()).toBe(used);
    expect(count("runs")).toBe(runs0);
    expect(count("jobs")).toBe(jobs0);

    const ok = await call("/api/runs", { body: { versionId, start: "2015-01-05" }, cookie: admin });
    expect(ok.status).toBe(200);
    expect(backtestsToday()).toBe(used + 1);
    clearJobs();
  });

  it("基准一行都没有：「还没有数据」", async () => {
    clearJobs();
    fakeWorker({ hkConnect: null });
    const versionId = await versionOf({ name: "红利", market: "A", rank, benchmark: "csi_div" });
    const used = backtestsToday();
    const r = await call("/api/runs", { body: { versionId, start: "2020-01-02" }, cookie: admin });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toBe("基准「中证红利全收益」还没有数据，等今晚行情更新后再试");
    expect(backtestsToday()).toBe(used);
  });

  it("港股通股票池没有名单：400、不扣额度；有名单时照常排队", async () => {
    clearJobs();
    const spec = { name: "港股通", market: "HK", universe: { hkConnect: true }, rank };
    fakeWorker({ hkConnect: null });
    const versionId = await versionOf(spec);
    const used = backtestsToday();
    const r = await call("/api/runs", { body: { versionId, start: "2020-01-02" }, cookie: admin });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toBe("港股通名单还没有记录，等今晚证券表刷新后再试");
    expect(backtestsToday()).toBe(used);

    vi.unstubAllGlobals();
    clearDataStatusCache();
    fakeWorker({ hkConnect: { attrs: ["hk_connect_sz"], firstDate: "2026-06-01" } });
    const ok = await call("/api/runs", { body: { versionId, start: "2020-01-02" }, cookie: admin });
    expect(ok.status).toBe(200);
    expect(backtestsToday()).toBe(used + 1);
    clearJobs();
  });

  it("data-status 缓存 60 秒；worker 不在时不拦（交给 worker 建输入时再查）", async () => {
    clearJobs();
    const calls = fakeWorker({ hkConnect: null });
    const versionId = await versionOf({ name: "沪深300", market: "A", rank });
    expect(
      (await call("/api/runs", { body: { versionId, start: "2020-01-02" }, cookie: admin })).status,
    ).toBe(200);
    expect(
      (await call("/api/runs", { body: { versionId, start: "2020-01-02" }, cookie: admin })).status,
    ).toBe(200);
    expect(calls.filter((p) => p === "/internal/data-status")).toHaveLength(1);
    clearJobs();
    vi.unstubAllGlobals();
    clearDataStatusCache();
    const v2 = await versionOf({ name: "红利2", market: "A", rank, benchmark: "csi_div" });
    expect(
      (await call("/api/runs", { body: { versionId: v2, start: "2020-01-02" }, cookie: admin }))
        .status,
    ).toBe(200);
    clearJobs();
  });
});

describe("两融与筹码（S15b）", () => {
  type Coverage = Record<string, { from: string | null; ready: boolean }>;
  /** 假 worker：data-status 带事件因子的覆盖；证券搜索与两融与筹码明细；记下请求 */
  function fakeWorker(o: { ready: boolean; done?: number; total?: number }) {
    const calls: string[] = [];
    const real = globalThis.fetch;
    const factorCoverage: Coverage = {
      margin_ratio: { from: "2013-01-11", ready: o.ready },
      margin_chg_20d: { from: "2013-02-13", ready: o.ready },
      margin_eligible: { from: "2013-01-11", ready: o.ready },
      holder_num_qoq: { from: "2013-07-20", ready: o.ready },
      unlock_days: { from: "2013-01-01", ready: o.ready },
      unlock_ratio_30d: { from: "2013-01-01", ready: o.ready },
      block_premium_20d: { from: "2013-02-10", ready: o.ready },
    };
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.host !== `127.0.0.1:${cfg.workerPort}`) return real(input, init);
      calls.push(`${url.pathname}${url.search}`);
      const reply = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
      if (url.pathname === "/internal/data-status")
        return reply({
          markets: [{ market: "A", asOf: "2026-09-30", dataVersion: 5, lastEtl: null }],
          maintenance: null,
          computePaused: null,
          factorCoverage,
          eventFactors: {
            v: 1,
            sig: "abcd1234",
            complete: o.ready,
            doneYears: o.done ?? 7,
            totalYears: o.total ?? 14,
          },
        });
      if (url.pathname === "/internal/securities/search")
        return reply(
          (url.searchParams.get("q") ?? "").includes("00700")
            ? [{ code: "00700.HK", name: "腾讯控股", market: "HK" }]
            : [{ code: "600519.SH", name: "贵州茅台", market: "A" }],
        );
      if (url.pathname === "/internal/securities/600519.SH/events")
        return reply({
          code: "600519.SH",
          name: "贵州茅台",
          asOf: url.searchParams.get("asOf") ?? "2026-09-30",
          dataVersion: { id: 5, asOf: "2026-09-30" },
          margin: Array.from({ length: 21 }, (_, i) => ({
            date: `2026-09-${String(i + 1).padStart(2, "0")}`,
            availDate: `2026-09-${String(i + 2).padStart(2, "0")}`,
            financingAmount: 1e10 + i * 1e8,
            shortAmount: 1e8,
            marginRatio: 1.0953,
          })),
          holders: [
            { endDate: "2026-06-30", noticeDate: "2026-08-01", holderNum: 48212, qoqPct: -9.75 },
          ],
          lockups: [],
          blocks: [
            {
              tradeDate: "2026-09-29",
              availDate: "2026-09-30",
              dealPrice: 11.84,
              closePrice: 13.13,
              premiumPct: -9.825,
              dealAmount: 1.2e7,
              buyerInst: true,
              sellerInst: false,
            },
          ],
          coverage: {},
          caveats: [],
          hash: "h".repeat(64),
        });
      return reply({ ok: true });
    });
    return calls;
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    clearDataStatusCache();
  });

  const backtestsToday = () =>
    (
      handle.sqlite
        .prepare(
          `SELECT coalesce(sum(backtests), 0) AS n FROM usage_daily WHERE user_id = ? AND day = ?`,
        )
        .get(adminId, todayCN()) as { n: number }
    ).n;
  const analyses = async () =>
    ((await call("/api/me", { cookie: admin })).json.usage as { analyses: number }).analyses;
  const clearJobs = () =>
    handle.sqlite.prepare(`UPDATE jobs SET status = 'done' WHERE user_id = ?`).run(adminId);
  async function versionOf(spec: Record<string, unknown>): Promise<string> {
    const d = await call("/api/drafts", { body: { spec }, cookie: admin });
    const c = await call(`/api/drafts/${d.json.draftId}/confirm`, {
      method: "POST",
      body: {},
      cookie: admin,
    });
    return String(c.json.versionId);
  }
  const eventSpec = {
    name: "避开解禁",
    market: "A",
    filters: [{ factor: "margin_chg_20d", op: ">", value: 0 }],
    rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 5 },
  };

  it("历史还没补算完：用到事件因子的回测与扫描 400、不扣额度；不用的照常", async () => {
    clearJobs();
    fakeWorker({ ready: false, done: 7, total: 14 });
    const versionId = await versionOf(eventSpec);
    const used = backtestsToday();
    const runs0 = count("runs");
    const bad = await call("/api/runs", {
      body: { versionId, start: "2020-01-02" },
      cookie: admin,
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe(
      "两融与筹码类因子的历史还在补算（7/14 年），补完后才能回测；今天的选股可以先用",
    );
    const sweep = await call("/api/runs/sweep", {
      body: { versionId, path: "/rank/top", values: [3, 5], start: "2020-01-02" },
      cookie: admin,
    });
    expect(sweep.status).toBe(400);
    expect(backtestsToday()).toBe(used);
    expect(count("runs")).toBe(runs0);
    const plain = await versionOf({ ...eventSpec, name: "不用事件因子", filters: [] });
    expect(
      (await call("/api/runs", { body: { versionId: plain, start: "2020-01-02" }, cookie: admin }))
        .status,
    ).toBe(200);
    clearJobs();
  });

  it("完整重跑也先查：历史还没补算完时 400、不扣额度、不建运行", async () => {
    clearJobs();
    fakeWorker({ ready: false, done: 7, total: 14 });
    const versionId = await versionOf({ ...eventSpec, name: "避开解禁-重跑" });
    const { strategy_id: strategyId } = handle.sqlite
      .prepare(`SELECT strategy_id FROM strategy_versions WHERE id = ?`)
      .get(versionId) as { strategy_id: string };
    const runId = `r_test_${Math.random().toString(36).slice(2, 10)}`;
    handle.sqlite
      .prepare(
        `INSERT INTO runs (id, user_id, strategy_id, version_id, kind, params, status, engine_version, finished_at)
         VALUES (?, ?, ?, ?, 'backtest', ?, 'done', '1.2.0', ?)`,
      )
      .run(
        runId,
        adminId,
        strategyId,
        versionId,
        JSON.stringify({ start: "2020-01-02", end: "2024-12-31", capital: 1e6, oosMonths: 12 }),
        Date.now(),
      );
    const used = backtestsToday();
    const runs0 = count("runs");
    const r = await call(`/api/runs/${runId}/reproduce`, {
      method: "POST",
      body: {},
      cookie: admin,
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe(
      "两融与筹码类因子的历史还在补算（7/14 年），补完后才能回测；今天的选股可以先用",
    );
    expect(backtestsToday()).toBe(used);
    expect(count("runs")).toBe(runs0);
    clearJobs();
  });

  it("起点早于数据起点：「因子『…』从 … 起才有数据」，不扣额度", async () => {
    clearJobs();
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.host !== `127.0.0.1:${cfg.workerPort}`) return real(input, init);
      if (url.pathname === "/internal/data-status")
        return new Response(
          JSON.stringify({
            markets: [],
            maintenance: null,
            computePaused: null,
            factorCoverage: { margin_chg_20d: { from: "2019-03-15", ready: true } },
            eventFactors: { v: 1, sig: "x", complete: true, doneYears: 14, totalYears: 14 },
          }),
        );
      return new Response(JSON.stringify({ ok: true }));
    });
    const versionId = await versionOf({ ...eventSpec, name: "两融变化2" });
    const used = backtestsToday();
    const bad = await call("/api/runs", {
      body: { versionId, start: "2019-01-02" },
      cookie: admin,
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe(
      "因子「融资余额 20 日变化」从 2019-03-15 起才有数据，请把起点设在这之后",
    );
    expect(backtestsToday()).toBe(used);
    expect(
      (await call("/api/runs", { body: { versionId, start: "2019-03-15" }, cookie: admin })).status,
    ).toBe(200);
    clearJobs();
  });

  it("/api/securities/:code/events：计入数据查询额度；港股直接回「只有 A 股」、不扣额度；参数不对 400", async () => {
    const calls = fakeWorker({ ready: true });
    const before = await analyses();
    const r = await call("/api/securities/600519/events?asOf=2026-09-30&datasets=margin,blocks", {
      cookie: admin,
    });
    expect(r.status).toBe(200);
    expect(r.json.code).toBe("600519.SH");
    expect(calls).toContain(
      "/internal/securities/600519.SH/events?asOf=2026-09-30&datasets=margin%2Cblocks",
    );
    expect(await analyses()).toBe(before + 1);
    const hk = await call("/api/securities/00700/events", { cookie: admin });
    expect(hk.status).toBe(404);
    expect(hk.json.error).toBe("两融、股东户数、解禁、大宗交易目前只有 A 股");
    expect(
      (await call("/api/securities/600519/events?datasets=nope", { cookie: admin })).status,
    ).toBe(400);
    expect(
      (await call("/api/securities/600519/events?asOf=2026-9-1", { cookie: admin })).status,
    ).toBe(400);
    expect(await analyses()).toBe(before + 1);
  });

  it("get_security_events：只读、计入额度；港股报错；给模型的摘要百分数都叫 *Pct，户数照抄", async () => {
    fakeWorker({ ready: true });
    const tools = buildTools({ userId: adminId, threadId: "th_test", page: {} });
    const opts = { toolCallId: "t", messages: [] } as never;
    const tables = ["strategies", "strategy_versions", "trackings", "drafts", "runs", "jobs"];
    const before = tables.map(count);
    const usedBefore = await analyses();
    const out = await tools.get_security_events!.execute!({ query: "贵州茅台" }, opts);
    expect(tables.map(count)).toEqual(before);
    expect(await analyses()).toBe(usedBefore + 1);
    const m = eventsForModel(out as Parameters<typeof eventsForModel>[0]);
    expect(m).toMatchObject({
      code: "600519.SH",
      dataVersion: 5,
      margin: {
        date: "2026-09-21",
        marginRatioPct: 1.1,
        comparedWith: "2026-09-01",
        marginChg20dPct: 20,
      },
      holders: [{ holderNum: 48212, qoqPct: -9.75 }],
      blocks: { count: 1, dealAmount: 1.2e7, premium20dPct: -9.82 },
    });
    await expect(
      tools.get_security_events!.execute!({ query: "00700" }, opts) as Promise<unknown>,
    ).rejects.toThrow("两融、股东户数、解禁、大宗交易目前只有 A 股");
    expect(await analyses()).toBe(usedBefore + 1);
    // list_factors 带上事件因子的数据集、数据起点与是否补算完成
    const lf = (await tools.list_factors!.execute!({ market: "A" }, opts)) as {
      factors: Array<{
        key: string;
        dataset?: string;
        from?: string | null;
        ready?: boolean | null;
      }>;
    };
    expect(lf.factors.find((f) => f.key === "unlock_days")).toMatchObject({
      dataset: "lockups",
      from: "2013-01-01",
      ready: true,
    });
    expect(lf.factors.find((f) => f.key === "pe_ttm")!.dataset).toBeUndefined();
    const api = await call("/api/factors?market=A", { cookie: admin });
    expect(
      (api.json.factors as Array<{ key: string; from?: string }>).find(
        (f) => f.key === "margin_chg_20d",
      )!.from,
    ).toBe("2013-02-13");
  });
});

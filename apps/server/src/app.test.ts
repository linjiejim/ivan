/**
 * 服务端 API 测试：账号与邀请码（验收 8）、LLM 不能越权（验收 6：不经过 drafts/:id/confirm，
 * 任何工具调用都产生不了策略版本或跟踪）。用临时目录的应用库，不需要 worker 与行情仓。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  unpackJson,
  verifyUserChain,
} from "@ivan/db";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildTools, evidenceForModel } from "./agent/tools.ts";
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
    // 账本、计划快照、计划项、跟踪、版本：每个工具调用前后都不变（D68、验收 14）
    const guarded = () => [
      count("strategies"),
      count("strategy_versions"),
      count("trackings"),
      active(),
      count("ledger_entries"),
      count("plan_snapshots"),
      count("plan_items"),
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

  it("get_security_evidence：只读、计入额度；名字对应多只时把候选写进错误；给模型的摘要最多 12 项", async () => {
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

    // 一份 20 个因子的证据：模型只拿到 12 项，数值四舍五入到 2 位
    const many = dossierFor(
      "600001.SH",
      "2024-03-01",
      Array.from({ length: 20 }, (_, i) => `f${i}`),
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
    expect(m.items).toHaveLength(12);
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

/** 直接写一个运行中的跟踪（绕过确认卡，测试用） */
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

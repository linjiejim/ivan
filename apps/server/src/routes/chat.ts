/**
 * 对话（spec §9）：POST /api/chat 流式返回（AI SDK UI 消息流），会话与消息落库；前端只发最新一条消息，
 * 历史从库里取。线程列表 / 读取 / 删除。
 */
import { languageModel, llmConfigured } from "@ivan/ai";
import type { Metrics } from "@ivan/core";
import { messages, newId, threads } from "@ivan/db";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type FinishReason,
  type LanguageModel,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, user } from "../app.ts";
import { groundTurn } from "../agent/grounding.ts";
import { buildTools, type PageRef } from "../agent/tools.ts";
import { systemPrompt } from "../agent/prompt.ts";
import { env } from "../env.ts";
import { AppError, notFound } from "../lib/errors.ts";
import { consume, recordTokens } from "../lib/quota.ts";
import { getRun } from "../services/runs.ts";
import { getStrategy } from "../services/strategies.ts";
import { getTracking } from "../services/trackings.ts";

/** 测试注入：用模拟模型替换真实 LLM */
let modelOverride: LanguageModel | null = null;
export function setChatModelForTest(m: LanguageModel | null): void {
  modelOverride = m;
}

function modelIdOf(m: LanguageModel): string {
  return typeof m === "string" ? m : m.modelId;
}

/** 把页面上下文写成几行给模型看（spec §9：system prompt 带上当前上下文摘要） */
function contextSummary(userId: string, page: PageRef): string | null {
  const lines: string[] = [];
  try {
    if (page.strategyId) {
      const s = getStrategy(userId, page.strategyId);
      lines.push(
        `策略「${s.name}」（strategyId=${s.id}，市场 ${s.market}，当前 v${s.current?.n}，versionId=${s.current?.id}）`,
      );
      if (s.current) lines.push(...s.current.describe.map((l) => `  ${l}`));
    }
    if (page.runId) {
      const r = getRun(userId, page.runId);
      const m = r.metrics as Metrics | null;
      lines.push(
        `回测 runId=${r.id}（${r.params.start} ~ ${r.params.end}，状态 ${r.status}${m ? `，年化超额 ${(m.excessCagr * 100).toFixed(1)}%，最大回撤 ${(m.maxDrawdown * 100).toFixed(1)}%` : ""}）`,
      );
    }
    if (page.trackingId) {
      const t = getTracking(userId, page.trackingId);
      lines.push(
        `向前跟踪 trackingId=${t.id}（「${t.strategyName}」，${t.startDate} 起，已结算 ${t.days.length} 天）`,
      );
    }
    if (page.range)
      lines.push(
        `用户在图上框选了 ${page.range.from} ~ ${page.range.to} 这段（query_run 的 period 可以直接用）`,
      );
  } catch {
    // 上下文里的对象不存在或不属于用户：忽略
  }
  return lines.length ? lines.join("\n") : null;
}

function loadMessages(threadId: string): UIMessage[] {
  const { db } = env().app;
  return db
    .select()
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.createdAt))
    .all()
    .map((m) => ({
      id: m.id,
      role: m.role as UIMessage["role"],
      parts: m.parts as UIMessage["parts"],
    }));
}

function ownThread(userId: string, threadId: string) {
  const { db } = env().app;
  const t = db
    .select()
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.userId, userId)))
    .get();
  if (!t) throw notFound("会话");
  return t;
}

function textOf(m: UIMessage): string {
  return m.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim();
}

export function registerChat(app: Hono<AppEnv>): void {
  app.get("/api/threads", (c) => {
    const { db } = env().app;
    return c.json(
      db
        .select({ id: threads.id, title: threads.title, updatedAt: threads.updatedAt })
        .from(threads)
        .where(eq(threads.userId, user(c).id))
        .orderBy(desc(threads.updatedAt))
        .limit(50)
        .all(),
    );
  });
  app.get("/api/threads/:id", (c) => {
    const t = ownThread(user(c).id, c.req.param("id"));
    return c.json({ id: t.id, title: t.title, context: t.context, messages: loadMessages(t.id) });
  });
  app.delete("/api/threads/:id", (c) => {
    const t = ownThread(user(c).id, c.req.param("id"));
    const { db } = env().app;
    db.delete(messages).where(eq(messages.threadId, t.id)).run();
    db.delete(threads).where(eq(threads.id, t.id)).run();
    return c.json({ ok: true });
  });

  app.post("/api/chat", async (c) => {
    const u = user(c);
    const { cfg } = env();
    if (!modelOverride && !llmConfigured(cfg.llm))
      throw new AppError(503, "管理员还没有配置 LLM（.env 里的 LLM_API_KEY / LLM_MODEL）");
    const body = (await c.req.json()) as {
      threadId?: string | null;
      message: UIMessage;
      context?: PageRef;
    };
    if (!body.message || body.message.role !== "user") throw new AppError(400, "缺少用户消息");
    consume(u.id, "chatMessages");

    const { db } = env().app;
    let threadId = body.threadId ?? null;
    if (threadId) ownThread(u.id, threadId);
    else {
      threadId = newId("th_");
      db.insert(threads)
        .values({
          id: threadId,
          userId: u.id,
          title: textOf(body.message).slice(0, 40) || "新对话",
          context: (body.context ?? {}) as Record<string, unknown>,
        })
        .run();
    }
    const history = loadMessages(threadId);
    const incoming: UIMessage = { ...body.message, id: body.message.id || newId("m_") };
    db.insert(messages)
      .values({ id: incoming.id, threadId, role: "user", parts: incoming.parts as unknown[] })
      .onConflictDoNothing()
      .run();
    const all = [...history.filter((m) => m.id !== incoming.id), incoming];
    const page = body.context ?? {};
    const tools = buildTools({ userId: u.id, threadId, page });
    const summary = contextSummary(u.id, page);
    const model = modelOverride ?? languageModel(cfg.llm, "chat");

    const result = streamText({
      model,
      system: systemPrompt(summary),
      messages: await convertToModelMessages(all, { tools, ignoreIncompleteToolCalls: true }),
      tools,
      // 分析类问题会连着调好几个工具（走势、估值、财报、计算），步数给到 12（spec 20261020 D106）
      stopWhen: stepCountIs(12),
      onFinish: ({ totalUsage }) => {
        recordTokens(u.id, totalUsage.inputTokens ?? 0, totalUsage.outputTokens ?? 0);
      },
    });

    const tid = threadId;
    const onError = (e: unknown) => (e instanceof Error ? `出错了：${e.message}` : "出错了");
    // 每条助手消息的用量与数字核对摘要（D69）；模型出错时为空
    let usage: Record<string, unknown> | null = null;
    const stream = createUIMessageStream({
      originalMessages: all,
      generateId: () => newId("m_"),
      onError,
      execute: async ({ writer }) => {
        // 先原样转发模型流（不发 finish），等所有步骤结束后核对数字、写 data-grounding，再结束
        for await (const chunk of result.toUIMessageStream({ sendFinish: false, onError })) {
          writer.write(chunk);
        }
        let finishReason: FinishReason | undefined;
        try {
          const steps = await result.steps;
          const total = await result.totalUsage;
          finishReason = await result.finishReason;
          const g = await groundTurn({
            tools,
            steps,
            history,
            userMessage: incoming,
            contextSummary: summary,
          });
          writer.write({ type: "data-grounding", data: g });
          usage = {
            inputTokens: total.inputTokens ?? 0,
            outputTokens: total.outputTokens ?? 0,
            model: modelIdOf(model),
            grounding: { version: g.version, checked: g.checked, unverified: g.unverified.length },
          };
        } catch {
          // 模型出错：错误已经在流里，不核对
        }
        writer.write({ type: "finish", ...(finishReason ? { finishReason } : {}) });
      },
      onEnd: ({ messages: finalMessages }) => {
        const known = new Set(all.map((m) => m.id));
        for (const m of finalMessages) {
          if (known.has(m.id)) continue;
          const extra = m.role === "assistant" && usage ? { usage } : {};
          db.insert(messages)
            .values({
              id: m.id,
              threadId: tid,
              role: m.role,
              parts: m.parts as unknown[],
              ...extra,
            })
            .onConflictDoUpdate({
              target: messages.id,
              set: { parts: m.parts as unknown[], ...extra },
            })
            .run();
        }
        db.update(threads).set({ updatedAt: Date.now() }).where(eq(threads.id, tid)).run();
      },
    });
    return createUIMessageStreamResponse({ stream, headers: { "x-thread-id": tid } });
  });
}

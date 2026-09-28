/**
 * 对话面板（spec §9）：只发最新一条消息，历史在服务端；工具调用渲染成卡片；页面上下文随消息一起发。
 */
import { useChat } from "@ai-sdk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DefaultChatTransport, type UIMessage } from "ai";
import { History, Loader2, Plus, SendHorizontal, Square, X } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { cx, Info } from "../components/ui.tsx";
import {
  CompareCard,
  OverviewCard,
  QueryCard,
  RunCard,
  ScreenCard,
  SecurityCard,
  StopTrackingCard,
  StrategyDraftCard,
  SweepCard,
  ToolChip,
  TrackingDraftCard,
} from "./cards.tsx";
import { activityOf } from "./activity.ts";
import { type PageContext, useChatUi } from "./chat-context.tsx";

/** 极简 markdown：段落、列表、**粗体**、`代码`；不用 innerHTML */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? (
          <strong key={i}>{p.slice(2, -2)}</strong>
        ) : p.startsWith("`") && p.endsWith("`") ? (
          <code key={i} className="rounded bg-surface-2 px-1 text-[12px]">
            {p.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function Markdown({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
          return (
            <ul key={i} className="list-disc space-y-0.5 pl-5">
              {lines.map((l, j) => (
                <li key={j}>
                  <Inline text={l.replace(/^\s*([-*]|\d+\.)\s+/, "")} />
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap">
            <Inline text={b.replace(/^#+\s*/gm, "")} />
          </p>
        );
      })}
    </div>
  );
}

type ToolPart = {
  type: string;
  state: "input-streaming" | "input-available" | "output-available" | "output-error";
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

function renderTool(part: ToolPart, send: (t: string) => void): ReactNode {
  const name = part.type.replace(/^tool-/, "");
  const out = part.output as Record<string, unknown> | undefined;
  if (part.state === "output-error")
    return <ToolChip name={name} state={part.state} error={part.errorText} />;
  switch (name) {
    case "propose_strategy":
      return out ? (
        <StrategyDraftCard output={out as never} send={send} />
      ) : (
        <ToolChip name="生成策略草稿" state={part.state} />
      );
    case "propose_tracking":
      return out ? (
        <TrackingDraftCard output={out as never} send={send} />
      ) : (
        <ToolChip name="准备上线跟踪" state={part.state} />
      );
    case "run_backtest":
    case "get_run":
      return out?.runId ? (
        <RunCard runId={String(out.runId)} />
      ) : (
        <ToolChip name="提交回测" state={part.state} />
      );
    case "run_sensitivity":
      return out?.runId ? (
        <SweepCard runId={String(out.runId)} />
      ) : (
        <ToolChip name="提交参数扫描" state={part.state} />
      );
    case "compare_runs":
      return out?.runIds ? (
        <CompareCard runIds={out.runIds as string[]} />
      ) : (
        <ToolChip name="对比回测" state={part.state} />
      );
    case "query_run":
      return out ? (
        <QueryCard output={out as never} />
      ) : (
        <ToolChip name="下钻回测" state={part.state} />
      );
    case "screen_today":
      return out ? (
        <ScreenCard output={out as never} />
      ) : (
        <ToolChip name="按规则选股" state={part.state} />
      );
    case "screen_rules":
      return out ? (
        <ScreenCard output={out as never} title="按条件选股" />
      ) : (
        <ToolChip name="按条件选股" state={part.state} />
      );
    case "get_overview":
      return out ? (
        <OverviewCard output={out as never} />
      ) : (
        <ToolChip name="查看看板" state={part.state} />
      );
    case "propose_stop_tracking":
      return out ? (
        <StopTrackingCard output={out as never} send={send} />
      ) : (
        <ToolChip name="准备停止跟踪" state={part.state} />
      );
    case "lookup_security":
      return out ? (
        <SecurityCard output={out as never} />
      ) : (
        <ToolChip name="查个股" state={part.state} />
      );
    default:
      return <ToolChip name={name} state={part.state} />;
  }
}

/** 回复过程中一直挂在对话底部：在做什么 + 已经等了多久 */
function ActivityLine({ label }: { label: string | null }) {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const sec = Math.floor((now - start) / 1000);
  return (
    <div className="flex items-center gap-2 text-xs text-muted" role="status" aria-live="polite">
      <Loader2 className="size-3.5 animate-spin text-accent" />
      <span className="text-ink-2">{label ?? "回复中"}…</span>
      {sec >= 2 && <span className="tabular">{sec} 秒</span>}
      {sec >= 25 && label?.includes("回测") && <span>回测和扫描要多等一会儿</span>}
    </div>
  );
}

function Message({ m, send }: { m: UIMessage; send: (t: string) => void }) {
  if (m.role === "user") {
    const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-3 py-2 text-sm text-white">
          {text}
        </div>
      </div>
    );
  }
  return (
    <div className="text-sm leading-6 text-ink">
      {m.parts.map((p, i) => {
        if (p.type === "text") return p.text ? <Markdown key={i} text={p.text} /> : null;
        if (p.type.startsWith("tool-"))
          return <div key={i}>{renderTool(p as unknown as ToolPart, send)}</div>;
        return null;
      })}
    </div>
  );
}

/** 空对话时的示例提问：跟着当前页面走 */
function suggestionsFor(page: PageContext): string[] {
  if (page.runId)
    return [
      "帮我解读这次回测，最值得注意的是什么？",
      "最大的一次回撤是什么时候、为什么？",
      "止损从 5% 到 20% 各跑一遍，看看结果稳不稳",
    ];
  if (page.trackingId)
    return ["这个跟踪最近表现怎么样？和回测比偏离大吗？", "明天要买卖哪些股票，为什么？"];
  if (page.strategyId)
    return [
      "按这个策略今天会选出哪些股票？",
      "止损改成 10% 再跑一次，和上个版本对比",
      "这个策略有什么可以改进的？",
    ];
  return [
    "我的跟踪今天表现怎么样？",
    "建一个 A 股 PE 小于 20、ROE 大于 15%、月度调仓的策略并回测",
    "帮我找找股息率超过 5% 的港股",
    "查一下贵州茅台现在的估值",
  ];
}

function ChatBody({
  sessionKey,
  threadId,
  initial,
  onThread,
}: {
  /** 会话实例的稳定 key：只在用户切换会话时变，服务端回传会话 id 时不变（避免流式回答中途重挂载） */
  sessionKey: string;
  threadId: string | null;
  initial: UIMessage[];
  onThread: (id: string) => void;
}) {
  const ui = useChatUi();
  const qc = useQueryClient();
  const threadRef = useRef(threadId);
  if (threadId) threadRef.current = threadId;
  const ctxRef = useRef<PageContext>(ui.page);
  ctxRef.current = ui.page;
  const nextCtx = useRef<PageContext | null>(null);
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages }) => {
          const context = nextCtx.current ?? ctxRef.current;
          nextCtx.current = null;
          const { label: _label, ...rest } = context;
          return { body: { threadId: threadRef.current, message: messages.at(-1), context: rest } };
        },
        fetch: async (input, init) => {
          const res = await fetch(input, init);
          const tid = res.headers.get("x-thread-id");
          if (tid && tid !== threadRef.current) {
            threadRef.current = tid;
            onThread(tid);
          }
          if (!res.ok) {
            const body = (await res
              .clone()
              .json()
              .catch(() => ({}))) as { error?: string };
            throw new Error(body.error ?? `请求失败（${res.status}）`);
          }
          return res;
        },
      }),
    [onThread],
  );
  const { messages, sendMessage, status, stop, error, clearError } = useChat({
    id: sessionKey,
    messages: initial,
    transport,
    onFinish: () => {
      void qc.invalidateQueries({ queryKey: ["me"] });
      void qc.invalidateQueries({ queryKey: ["threads"] });
    },
  });
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 输入框随内容长高，最多 8 行左右
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [text]);
  const busy = status === "submitted" || status === "streaming";
  const send = (t: string, ctx?: PageContext) => {
    if (!t.trim() || busy) return;
    if (ctx) nextCtx.current = ctx;
    clearError();
    void sendMessage({ text: t.trim() });
  };
  // 图表「问 AI」等外部提问：同一个提问只发一次（StrictMode 下 effect 会跑两遍）
  const handled = useRef<unknown>(null);
  useEffect(() => {
    if (!ui.pending || ui.pending === handled.current) return;
    handled.current = ui.pending;
    const p = ui.takePending();
    if (p) send(p.text, p.context);
  }, [ui.pending]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  return (
    <>
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {!messages.length && (
          <div className="space-y-2 text-sm text-ink-2">
            <p>可以这样问我：</p>
            {suggestionsFor(ui.page).map((s) => (
              <button
                key={s}
                className="block w-full rounded-lg border border-line px-3 py-2 text-left hover:border-accent"
                onClick={() => send(s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m) => (
          <Message key={m.id} m={m} send={(t) => send(t)} />
        ))}
        {busy && <ActivityLine label={activityOf(messages, status)} />}
        {error && (
          <div className="rounded-lg bg-warn-bg px-3 py-2 text-xs text-warn">{error.message}</div>
        )}
        <div ref={endRef} />
      </div>
      <div className="border-t border-line p-3">
        {ui.page.label && (
          <div className="mb-2 inline-flex max-w-full items-center gap-1 rounded-md bg-surface-2 px-2 py-0.5 text-[11px] text-ink-2">
            <span className="truncate">上下文：{ui.page.label}</span>
            <button onClick={() => ui.setPage({})} aria-label="清除上下文">
              <X className="size-3" />
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(text);
                setText("");
              }
            }}
            rows={1}
            placeholder="问点什么…"
            title="Enter 发送，Shift+Enter 换行"
            className="max-h-42 min-h-10 flex-1 resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
          />
          {busy ? (
            <button
              onClick={() => void stop()}
              className="rounded-lg bg-surface-2 p-2.5 text-ink-2"
              aria-label="停止"
            >
              <Square className="size-4" />
            </button>
          ) : (
            <button
              onClick={() => {
                send(text);
                setText("");
              }}
              className="rounded-lg bg-accent p-2.5 text-white disabled:opacity-40"
              disabled={!text.trim()}
              aria-label="发送"
            >
              <SendHorizontal className="size-4" />
            </button>
          )}
        </div>
      </div>
    </>
  );
}

export function ChatPanel({
  full,
  docked,
  initialThread,
}: {
  /** 全屏对话页 */
  full?: boolean;
  /** 首页常驻：不给收起按钮 */
  docked?: boolean;
  /** /chat/:threadId 直接打开某个会话 */
  initialThread?: string;
}) {
  const ui = useChatUi();
  const [showHistory, setShowHistory] = useState(false);
  // 会话实例 key：打开已有会话时用它的 id，新对话用随机 key；服务端回传新会话 id 时不换 key
  const [session, setSession] = useState<{ key: string; load: string | null }>(() => {
    const id = initialThread ?? ui.threadId;
    return { key: id ?? `new-${Date.now()}`, load: id };
  });
  useEffect(() => {
    if (initialThread && initialThread !== ui.threadId) ui.setThreadId(initialThread);
  }, [initialThread]); // eslint-disable-line react-hooks/exhaustive-deps
  const openThread = (id: string | null) => {
    ui.setThreadId(id);
    setSession({ key: id ?? `new-${Date.now()}`, load: id });
  };
  const threadsQ = useQuery({
    queryKey: ["threads"],
    queryFn: () =>
      api.get<Array<{ id: string; title: string | null; updatedAt: number }>>("/api/threads"),
    enabled: showHistory,
  });
  const initial = useQuery({
    queryKey: ["thread", session.load],
    queryFn: () => api.get<{ messages: UIMessage[] }>(`/api/threads/${session.load}`),
    enabled: !!session.load,
    retry: false,
    staleTime: Infinity,
  });
  useEffect(() => {
    if (initial.isError) openThread(null);
  }, [initial.isError]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = !session.load || initial.data;
  return (
    <div className={cx("flex h-full flex-col", full && "rounded-xl border border-line bg-surface")}>
      <div className="relative flex items-center gap-1.5 border-b border-line px-3 py-2">
        <span className="text-sm font-semibold">问 AI</span>
        <Info label="AI 能做什么">
          AI
          负责把你的想法翻译成策略、跑回测、解读结果；回复里的数字都来自卡片（引擎算的），以卡片为准。
          新建或修改策略、上线或停止跟踪，都要你在卡片上点确认才生效。
        </Info>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            className="rounded p-1.5 text-ink-2 hover:bg-surface-2"
            title="新对话"
            onClick={() => openThread(null)}
          >
            <Plus className="size-4" />
          </button>
          <button
            className="rounded p-1.5 text-ink-2 hover:bg-surface-2"
            title="历史对话"
            onClick={() => setShowHistory(!showHistory)}
          >
            <History className="size-4" />
          </button>
          {!full && !docked && (
            <button
              className="rounded p-1.5 text-ink-2 hover:bg-surface-2"
              title="收起"
              onClick={() => ui.setOpen(false)}
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        {showHistory && (
          <div className="absolute right-2 top-10 z-20 max-h-80 w-72 overflow-auto rounded-lg border border-line bg-surface p-1 shadow-lg">
            {threadsQ.data?.length ? (
              threadsQ.data.map((t) => (
                <button
                  key={t.id}
                  className={cx(
                    "block w-full truncate rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2",
                    t.id === ui.threadId && "bg-surface-2",
                  )}
                  onClick={() => {
                    openThread(t.id);
                    setShowHistory(false);
                  }}
                >
                  {t.title ?? "对话"}
                </button>
              ))
            ) : (
              <p className="px-2 py-2 text-xs text-muted">还没有历史对话</p>
            )}
          </div>
        )}
      </div>
      {ready ? (
        <ChatBody
          key={session.key}
          sessionKey={session.key}
          threadId={ui.threadId}
          initial={initial.data?.messages ?? []}
          onThread={ui.setThreadId}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">
          <Loader2 className="size-4 animate-spin" />
        </div>
      )}
    </div>
  );
}

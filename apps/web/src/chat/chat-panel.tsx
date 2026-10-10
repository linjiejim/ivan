/**
 * 对话面板（spec §9）：只发最新一条消息，历史在服务端；工具调用渲染成卡片；页面上下文随消息一起发。
 */
import { useChat } from "@ai-sdk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DefaultChatTransport, type UIMessage } from "ai";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AiAvatar } from "../components/brand.tsx";
import {
  type Icon,
  IconBacktest,
  IconClose,
  IconCompose,
  IconContext,
  IconHistory,
  IconScreen,
  IconSend,
  IconSpinner,
  IconStopGenerating,
  IconStrategy,
  IconSweep,
  IconTracking,
  IconAI,
} from "../components/icons.tsx";
import { Callout, cx, IconButton, Info, Popover } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { dateTime } from "../lib/format.ts";
import {
  CompareCard,
  EvidenceCard,
  GroundingNote,
  OverviewCard,
  PlanCard,
  QueryCard,
  RunCard,
  ScreenCard,
  SecurityCard,
  StopTrackingCard,
  StrategyDraftCard,
  SweepCard,
  ToolChip,
  TrackingCard,
  TrackingDraftCard,
} from "./cards.tsx";
import type { GroundingResult } from "../lib/types.ts";
import { activityOf } from "./activity.ts";
import { type PageContext, useChatUi } from "./chat-context.tsx";

/** 极简 markdown：段落、列表、**粗体**、`代码`；不用 innerHTML */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? (
          <strong key={i} className="font-semibold text-ink">
            {p.slice(2, -2)}
          </strong>
        ) : p.startsWith("`") && p.endsWith("`") ? (
          <code key={i} className="rounded-[5px] bg-surface-2 px-1 py-px text-[12px] text-ink">
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
            <ul key={i} className="space-y-1 pl-4 marker:text-faint [&>li]:list-disc">
              {lines.map((l, j) => (
                <li key={j} className="pl-0.5">
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
        <ToolChip name="propose_strategy" state={part.state} />
      );
    case "propose_tracking":
      return out ? (
        <TrackingDraftCard output={out as never} send={send} />
      ) : (
        <ToolChip name="propose_tracking" state={part.state} />
      );
    case "run_backtest":
    case "get_run":
      return out?.runId ? (
        <RunCard runId={String(out.runId)} />
      ) : (
        <ToolChip name={name} state={part.state} />
      );
    case "run_sensitivity":
      return out?.runId ? (
        <SweepCard runId={String(out.runId)} />
      ) : (
        <ToolChip name="run_sensitivity" state={part.state} />
      );
    case "compare_runs":
      return out?.runIds ? (
        <CompareCard runIds={out.runIds as string[]} />
      ) : (
        <ToolChip name="compare_runs" state={part.state} />
      );
    case "query_run":
      return out ? (
        <QueryCard output={out as never} />
      ) : (
        <ToolChip name="query_run" state={part.state} />
      );
    case "screen_today":
      return out ? (
        <ScreenCard output={out as never} />
      ) : (
        <ToolChip name="screen_today" state={part.state} />
      );
    case "screen_rules":
      return out ? (
        <ScreenCard output={out as never} title="按条件选股" />
      ) : (
        <ToolChip name="screen_rules" state={part.state} />
      );
    case "get_overview":
      return out ? (
        <OverviewCard output={out as never} />
      ) : (
        <ToolChip name="get_overview" state={part.state} />
      );
    case "propose_stop_tracking":
      return out ? (
        <StopTrackingCard output={out as never} send={send} />
      ) : (
        <ToolChip name="propose_stop_tracking" state={part.state} />
      );
    case "lookup_security":
      return out ? (
        <SecurityCard output={out as never} />
      ) : (
        <ToolChip name="lookup_security" state={part.state} />
      );
    case "get_security_evidence":
      return out ? (
        <EvidenceCard output={out as never} />
      ) : (
        <ToolChip name="get_security_evidence" state={part.state} />
      );
    case "get_plan":
      return out ? (
        <PlanCard output={out as never} />
      ) : (
        <ToolChip name="get_plan" state={part.state} />
      );
    case "get_tracking":
      return out ? (
        <TrackingCard output={out as never} />
      ) : (
        <ToolChip name="get_tracking" state={part.state} />
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
    <div className="flex items-center gap-2.5 text-xs" role="status" aria-live="polite">
      <AiAvatar />
      <IconSpinner size={13} className="animate-spin text-accent" />
      <span className="ai-shimmer font-medium">{label ?? "回复中"}…</span>
      {sec >= 2 && <span className="tabular text-muted">{sec} 秒</span>}
      {sec >= 25 && label?.includes("回测") && (
        <span className="text-muted">回测和扫描要多等一会儿</span>
      )}
    </div>
  );
}

/** 回复结束时服务端写的数字核对片段（D69）；流式输出中还没有 */
function groundingOf(m: UIMessage): GroundingResult | undefined {
  const p = m.parts.find((x) => x.type === "data-grounding") as { data?: unknown } | undefined;
  return p?.data as GroundingResult | undefined;
}

function Message({ m, send }: { m: UIMessage; send: (t: string) => void }) {
  if (m.role === "user") {
    const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return (
      <div className="flex justify-end pl-8">
        <div className="rounded-2xl rounded-br-md bg-surface-2 px-3.5 py-2 text-sm leading-6 whitespace-pre-wrap text-ink ring-1 ring-line ring-inset">
          {text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-2.5">
      <AiAvatar className="mt-0.5" />
      <div className="min-w-0 flex-1 text-sm leading-6 text-ink">
        {m.parts.map((p, i) => {
          if (p.type === "text") return p.text ? <Markdown key={i} text={p.text} /> : null;
          if (p.type.startsWith("tool-"))
            return <div key={i}>{renderTool(p as unknown as ToolPart, send)}</div>;
          return null;
        })}
        <GroundingNote g={groundingOf(m)} />
      </div>
    </div>
  );
}

/** 空对话时的示例提问：跟着当前页面走 */
function suggestionsFor(page: PageContext): Array<[Icon, string]> {
  if (page.runId)
    return [
      [IconBacktest, "帮我解读这次回测，最值得注意的是什么？"],
      [IconBacktest, "最大的一次回撤是什么时候、为什么？"],
      [IconSweep, "止损从 5% 到 20% 各跑一遍，看看结果稳不稳"],
    ];
  if (page.trackingId)
    return [
      [IconTracking, "这个跟踪最近表现怎么样？和回测比偏离大吗？"],
      [IconTracking, "明天要买卖哪些股票，为什么？"],
    ];
  if (page.strategyId)
    return [
      [IconScreen, "按这个策略今天会选出哪些股票？"],
      [IconBacktest, "止损改成 10% 再跑一次，和上个版本对比"],
      [IconStrategy, "这个策略有什么可以改进的？"],
    ];
  return [
    [IconTracking, "我的跟踪今天表现怎么样？"],
    [IconStrategy, "建一个 A 股 PE 小于 20、ROE 大于 15%、月度调仓的策略并回测"],
    [IconScreen, "帮我找找股息率超过 5% 的港股"],
    [IconScreen, "查一下贵州茅台现在的估值"],
  ];
}

function Welcome({ page, send }: { page: PageContext; send: (t: string) => void }) {
  return (
    <div className="animate-enter">
      <div className="mb-4 flex items-center gap-2.5">
        <AiAvatar size="md" />
        <div>
          <p className="text-sm font-semibold text-ink">有什么想法，直接说</p>
          <p className="text-xs text-muted">写策略、跑回测、解读结果；改动都要你点确认才生效</p>
        </div>
      </div>
      <div className="space-y-1.5">
        {suggestionsFor(page).map(([Ico, s], i) => (
          <button
            key={s}
            className="group/sug flex w-full animate-enter items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-2.5 text-left text-sm text-ink-2 transition-[border-color,background-color,color] duration-150 hover:border-accent-line hover:bg-accent-wash hover:text-ink"
            style={{ animationDelay: `${80 + i * 50}ms` }}
            onClick={() => send(s)}
          >
            <Ico
              size={16}
              className="shrink-0 text-faint transition-colors group-hover/sug:text-accent"
            />
            <span className="min-w-0 flex-1">{s}</span>
          </button>
        ))}
      </div>
    </div>
  );
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
  const submit = () => {
    send(text);
    setText("");
  };

  return (
    <>
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-5">
        {!messages.length && <Welcome page={ui.page} send={(s) => send(s)} />}
        {messages.map((m) => (
          <Message key={m.id} m={m} send={(t) => send(t)} />
        ))}
        {busy && <ActivityLine label={activityOf(messages, status)} />}
        {error && <Callout tone="warn">{error.message}</Callout>}
        <div ref={endRef} />
      </div>
      <div className="border-t border-line bg-surface px-3 pt-2.5 pb-3">
        {ui.page.label && (
          <div className="mb-2 inline-flex h-6 max-w-full items-center gap-1.5 rounded-md bg-surface-2 pr-1 pl-2 text-2xs text-ink-2">
            <IconContext size={12} className="shrink-0 text-muted" />
            <span className="truncate">{ui.page.label}</span>
            <button
              onClick={() => ui.setPage({})}
              aria-label="清除上下文"
              title="清除上下文"
              className="flex size-4 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-surface-3 hover:text-ink"
            >
              <IconClose size={10} weight="bold" />
            </button>
          </div>
        )}
        <div className="flex items-end gap-2 rounded-xl border border-line-strong bg-surface py-1.5 pr-1.5 pl-3 transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-wash)]">
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            aria-label="给 AI 的消息"
            placeholder="问点什么…"
            title="Enter 发送，Shift+Enter 换行"
            className="max-h-42 min-h-8 flex-1 resize-none bg-transparent py-1 text-sm leading-6 text-ink outline-none placeholder:text-muted"
          />
          {busy ? (
            <button
              onClick={() => void stop()}
              className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink ring-1 ring-line-strong transition-colors ring-inset hover:bg-surface-3"
              aria-label="停止生成"
              title="停止生成"
            >
              <IconStopGenerating size={14} weight="fill" />
            </button>
          ) : (
            <button
              onClick={submit}
              className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-ink shadow-raise transition-[background-color,opacity,transform] duration-150 hover:bg-primary-hover active:translate-y-px disabled:bg-surface-3 disabled:text-faint disabled:shadow-none"
              disabled={!text.trim()}
              aria-label="发送"
              title="发送（Enter）"
            >
              <IconSend size={16} weight="bold" />
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const threadsQ = useQuery({
    queryKey: ["threads"],
    queryFn: () =>
      api.get<Array<{ id: string; title: string | null; updatedAt: number }>>("/api/threads"),
    enabled: historyOpen,
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
    <div
      className={cx(
        "flex h-full flex-col",
        full && "overflow-hidden rounded-2xl border border-line bg-surface shadow-[var(--edge)]",
      )}
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3">
        <IconAI size={16} weight="fill" className="text-accent" />
        <span className="text-sm font-semibold text-ink">问 AI</span>
        <Info label="AI 能做什么">
          AI
          负责把你的想法翻译成策略、跑回测、解读结果；回复里的数字都来自卡片（引擎算的），以卡片为准。
          新建或修改策略、上线或停止跟踪，都要你在卡片上点确认才生效。
        </Info>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton
            icon={IconCompose}
            label="新对话"
            size="sm"
            onClick={() => openThread(null)}
          />
          <Popover
            width={288}
            align="end"
            label="历史对话"
            trigger={({ ref, open, toggle }) => (
              <IconButton
                ref={ref}
                icon={IconHistory}
                label="历史对话"
                size="sm"
                active={open}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => {
                  toggle();
                  setHistoryOpen(true);
                }}
              />
            )}
          >
            {(close) => (
              <div className="max-h-80 overflow-y-auto">
                <div className="px-2 pt-1 pb-1.5 text-2xs text-muted">历史对话</div>
                {threadsQ.isLoading ? (
                  <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted">
                    <IconSpinner size={13} className="animate-spin" />
                    加载中…
                  </div>
                ) : threadsQ.data?.length ? (
                  threadsQ.data.map((t) => (
                    <button
                      key={t.id}
                      role="menuitem"
                      className={cx(
                        "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-surface-2",
                        t.id === ui.threadId ? "bg-surface-2 text-ink" : "text-ink-2",
                      )}
                      onClick={() => {
                        openThread(t.id);
                        close();
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate">{t.title ?? "对话"}</span>
                      <span className="shrink-0 font-mono text-[10.5px] text-muted">
                        {dateTime(t.updatedAt)}
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="px-2 py-2 text-xs text-muted">还没有历史对话</p>
                )}
              </div>
            )}
          </Popover>
          {!full && !docked && (
            <IconButton icon={IconClose} label="收起" size="sm" onClick={() => ui.setOpen(false)} />
          )}
        </div>
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
          <IconSpinner size={16} className="animate-spin" />
        </div>
      )}
    </div>
  );
}

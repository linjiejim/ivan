/**
 * 工具卡片（D16）：卡片直接渲染工具输出或按 id 读库，数字以卡片为准；LLM 的文字只做解读。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check as CheckIcon, ChevronRight, Loader2, Wrench, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { NavChart } from "../components/charts/nav-chart.tsx";
import { MonthlyTable, PnlBars } from "../components/charts/small.tsx";
import { CompareView } from "../components/compare-view.tsx";
import { DiffView } from "../components/diff-view.tsx";
import { ScreenTable } from "../components/screen-table.tsx";
import { Badge, Button, Checks, cx, ErrorNote, Info, InfoRows } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { deviationText, fmtFactor, MARKET_TEXT, money, pct, tone } from "../lib/format.ts";
import type { RunDetail, ScreenResult, SpecChange } from "../lib/types.ts";

function Frame({
  title,
  children,
  right,
  info,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
  right?: React.ReactNode;
  /** 标题旁的 ⓘ：次要说明按需看 */
  info?: React.ReactNode;
}) {
  return (
    <div className="my-2 rounded-lg border border-line bg-page">
      <div className="flex items-center gap-1.5 border-b border-line px-3 py-1.5 text-xs font-medium text-ink-2">
        {title}
        {info && <Info>{info}</Info>}
        <span className="ml-auto">{right}</span>
      </div>
      <div className="px-3 py-2.5">{children}</div>
    </div>
  );
}

// ── 草稿（策略 / 跟踪）：确认是唯一的生效入口 ──

interface DraftStatus {
  status: "pending" | "confirmed" | "discarded";
  resultId: string | null;
}

function useDraft(draftId: string) {
  return useQuery({
    queryKey: ["draft", draftId],
    queryFn: () => api.get<DraftStatus>(`/api/drafts/${draftId}`),
  });
}

function DraftActions({
  draftId,
  onConfirmed,
  confirmLabel,
}: {
  draftId: string;
  onConfirmed: (r: Record<string, string>) => void;
  confirmLabel: string;
}) {
  const d = useDraft(draftId);
  const qc = useQueryClient();
  const confirm = useMutation({
    mutationFn: () => api.post<Record<string, string>>(`/api/drafts/${draftId}/confirm`),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["draft", draftId] });
      await qc.invalidateQueries({ queryKey: ["strategies"] });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
      onConfirmed(r);
    },
  });
  const discard = useMutation({
    mutationFn: () => api.post(`/api/drafts/${draftId}/discard`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["draft", draftId] }),
  });
  if (d.data?.status === "confirmed")
    return (
      <span className="inline-flex items-center gap-1 text-xs text-accent">
        <CheckIcon className="size-3.5" />
        已确认
      </span>
    );
  if (d.data?.status === "discarded") return <span className="text-xs text-muted">已放弃</span>;
  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="primary"
        loading={confirm.isPending}
        onClick={() => confirm.mutate()}
      >
        {confirmLabel}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        loading={discard.isPending}
        onClick={() => discard.mutate()}
      >
        放弃
      </Button>
      <ErrorNote error={confirm.error ?? discard.error} />
    </div>
  );
}

export function StrategyDraftCard({
  output,
  send,
}: {
  output: {
    ok: boolean;
    draftId?: string;
    strategyId?: string | null;
    changes?: SpecChange[];
    describe?: string[];
    strategyName?: string | null;
    errors?: string[];
  };
  send: (text: string) => void;
}) {
  if (!output.ok) {
    return (
      <Frame title="策略草稿没有通过校验">
        <ul className="list-disc pl-4 text-xs text-ink-2">
          {output.errors?.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </Frame>
    );
  }
  const isNew = !output.strategyId;
  return (
    <Frame
      title={isNew ? `新策略草稿「${output.strategyName}」` : `修改「${output.strategyName}」`}
      right={<Badge tone="warn">待确认</Badge>}
    >
      <DiffView changes={output.changes ?? []} describe={isNew ? output.describe : undefined} />
      <div className="mt-3">
        <DraftActions
          draftId={output.draftId!}
          confirmLabel={isNew ? "确认创建" : "确认修改"}
          onConfirmed={(r) =>
            send(`我确认了（新版本 versionId=${r.versionId}，strategyId=${r.strategyId}）。`)
          }
        />
      </div>
    </Frame>
  );
}

export function TrackingDraftCard({
  output,
  send,
}: {
  output: {
    draftId: string;
    strategyName: string;
    versionN: number;
    startDate: string;
    capital: number;
    hasBaseline: boolean;
  };
  send: (text: string) => void;
}) {
  return (
    <Frame title="上线跟踪" right={<Badge tone="warn">待确认</Badge>}>
      <p className="text-sm">
        「{output.strategyName}」v{output.versionN}，{output.startDate} 起，模拟资金{" "}
        {output.capital.toLocaleString()}。
      </p>
      {!output.hasBaseline && (
        <p className="mt-1 text-xs text-warn">这个版本还没有跑完的回测，上线后没法和回测比。</p>
      )}
      <div className="mt-3">
        <DraftActions
          draftId={output.draftId}
          confirmLabel="确认上线"
          onConfirmed={(r) => send(`我确认上线了（trackingId=${r.trackingId}）。`)}
        />
      </div>
    </Frame>
  );
}

// ── 回测（进度 → 结果） ──

export function useRunPoll(runId: string | undefined) {
  return useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.get<RunDetail>(`/api/runs/${runId}`),
    enabled: !!runId,
    refetchInterval: (q) =>
      q.state.data && (q.state.data.status === "done" || q.state.data.status === "failed")
        ? false
        : 1500,
  });
}

export function RunCard({ runId }: { runId: string }) {
  const q = useRunPoll(runId);
  const r = q.data;
  if (!r)
    return (
      <Frame title="回测">
        {q.error ? (
          <ErrorNote error={q.error} />
        ) : (
          <Loader2 className="size-4 animate-spin text-muted" />
        )}
      </Frame>
    );
  if (r.status !== "done") {
    return (
      <Frame title="回测">
        {r.status === "failed" ? (
          <ErrorNote error={new Error(r.error ?? "失败")} />
        ) : (
          <div className="flex items-center gap-2 text-xs text-ink-2">
            <Loader2 className="size-3.5 animate-spin" />
            {r.status === "queued" ? "排队中…" : (r.job?.note ?? "回测中…")}{" "}
            {Math.round((r.job?.progress ?? 0) * 100)}%
          </div>
        )}
      </Frame>
    );
  }
  if (r.kind === "sweep") return <SweepCard runId={runId} />;
  const m = r.metrics!;
  return (
    <Frame
      title={`回测 ${r.params.start} ~ ${r.params.end}`}
      info={
        <InfoRows
          rows={[
            ["总收益", pct(m.totalReturn)],
            ["基准年化", pct(m.benchCagr)],
            ["胜率", m.winRate === null ? "—" : pct(m.winRate, 0, false)],
            ["买入笔数", String(m.buys)],
            ...(r.segments?.outOfSample
              ? ([
                  ["样本内年化超额", pct(r.segments.inSample.excessCagr)],
                  ["样本外年化超额", pct(r.segments.outOfSample.excessCagr)],
                ] as Array<[string, string]>)
              : []),
          ]}
        />
      }
      right={
        <Link to={`/runs/${r.id}`} className="inline-flex items-center text-accent">
          完整报告 <ChevronRight className="size-3.5" />
        </Link>
      }
    >
      <div className="grid grid-cols-4 gap-2 text-center">
        {[
          ["年化", pct(m.cagr), tone(m.cagr)],
          ["年化超额", pct(m.excessCagr), tone(m.excessCagr)],
          ["最大回撤", pct(m.maxDrawdown, 1, false), ""],
          ["夏普", m.sharpe.toFixed(2), ""],
        ].map(([l, v, c]) => (
          <div key={l}>
            <div className="text-[11px] text-muted">{l}</div>
            <div className={`text-sm font-semibold ${c}`}>{v}</div>
          </div>
        ))}
      </div>
      <div className="mt-2">
        <NavChart points={r.series} height={160} />
      </div>
      {r.checks.length > 0 && (
        <div className="mt-2">
          <Checks checks={r.checks} compact />
        </div>
      )}
    </Frame>
  );
}

export function SweepCard({ runId }: { runId: string }) {
  const q = useRunPoll(runId);
  const r = q.data;
  if (!r || r.status !== "done")
    return (
      <Frame title="参数扫描">
        <div className="flex items-center gap-2 text-xs text-ink-2">
          <Loader2 className="size-3.5 animate-spin" />
          {r?.job?.note ?? "扫描中…"} {Math.round((r?.job?.progress ?? 0) * 100)}%
        </div>
      </Frame>
    );
  const max = Math.max(...r.children.map((c) => Math.abs(c.headline?.excessCagr ?? 0)), 0.01);
  return (
    <Frame
      title={`参数扫描：${r.label}`}
      info="条的长度 = 年化超额（红为正、蓝为负）。相邻取值之间跳得厉害，说明策略对这个参数敏感。"
      right={
        <Link to={`/runs/${r.id}`} className="text-accent">
          详情
        </Link>
      }
    >
      <ul className="space-y-1">
        {r.children.map((c) => {
          const v = c.headline?.excessCagr ?? 0;
          return (
            <li
              key={c.id}
              className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-2 text-xs"
            >
              <span className="truncate text-ink-2">{c.label?.split(" = ").pop()}</span>
              <span className="h-2.5">
                <span
                  className="block h-2.5 rounded-r-[4px]"
                  style={{
                    width: `${(Math.abs(v) / max) * 100}%`,
                    background: v >= 0 ? "var(--up)" : "var(--series-1)",
                    opacity: 0.85,
                  }}
                />
              </span>
              <span className={`tabular ${tone(v)}`}>{pct(v)}</span>
            </li>
          );
        })}
      </ul>
      {r.checks.length > 0 && (
        <div className="mt-2">
          <Checks checks={r.checks} compact />
        </div>
      )}
    </Frame>
  );
}

// ── 下钻 ──

export function QueryCard({
  output,
}: {
  output: { runId: string; result: Record<string, unknown> & { what: string } };
}) {
  const res = output.result;
  const title: Record<string, string> = {
    drawdowns: "最大几次回撤",
    period: "区间表现",
    holdings_on: "当天持仓",
    trades: "交易明细",
    contributors: "盈亏贡献",
    industry: "行业",
    monthly: "月度收益",
  };
  let body: React.ReactNode = null;
  if (res.what === "drawdowns") {
    const dd = res.drawdowns as Array<{
      peak: string;
      trough: string;
      recovery: string | null;
      depth: number;
    }>;
    body = (
      <table className="tabular w-full text-xs">
        <tbody>
          {dd.map((d) => (
            <tr key={d.peak} className="border-b border-line last:border-0">
              <td className="py-1 text-down">{pct(d.depth, 1, false)}</td>
              <td className="py-1 text-ink-2">
                {d.peak} → {d.trough}
              </td>
              <td className="py-1 text-right text-muted">
                {d.recovery ? `${d.recovery} 修复` : "未修复"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  } else if (res.what === "period") {
    const m = res.metrics as {
      start: string;
      end: string;
      totalReturn: number;
      benchReturn: number;
      excessTotal: number;
      maxDrawdown: number;
    };
    const best = res.bestClosed as Array<{ code: string; pnl: number }>;
    const worst = res.worstClosed as Array<{ code: string; pnl: number }>;
    body = (
      <div className="space-y-2 text-xs">
        <div className="grid grid-cols-4 gap-2 text-center">
          {[
            ["策略", pct(m.totalReturn), tone(m.totalReturn)],
            ["基准", pct(m.benchReturn), tone(m.benchReturn)],
            ["超额", pct(m.excessTotal), tone(m.excessTotal)],
            ["回撤", pct(m.maxDrawdown, 1, false), ""],
          ].map(([l, v, c]) => (
            <div key={l}>
              <div className="text-muted">{l}</div>
              <div className={`font-semibold ${c}`}>{v}</div>
            </div>
          ))}
        </div>
        {worst.length > 0 && (
          <PnlBars rows={worst.map((w) => ({ label: w.code, value: w.pnl }))} format={money} />
        )}
        {best.length > 0 && (
          <PnlBars rows={best.map((w) => ({ label: w.code, value: w.pnl }))} format={money} />
        )}
      </div>
    );
  } else if (res.what === "holdings_on") {
    const snap = res.snapshot as {
      date: string;
      items: Array<{ code: string; weight: number }>;
    } | null;
    body = snap ? (
      <div className="flex flex-wrap gap-1.5">
        <span className="text-xs text-muted">{snap.date}</span>
        {snap.items.map((i) => (
          <Badge key={i.code}>
            {i.code} {pct(i.weight, 0, false)}
          </Badge>
        ))}
      </div>
    ) : (
      <p className="text-xs text-muted">那天之前还没有持仓。</p>
    );
  } else if (res.what === "trades") {
    const trades = res.trades as Array<{
      seq: number;
      date: string;
      code: string;
      name: string | null;
      side: string;
      price: number;
      pnl: number | null;
      reason: string;
    }>;
    body = (
      <table className="tabular w-full text-xs">
        <tbody>
          {trades.slice(0, 30).map((t) => (
            <tr key={t.seq} className="border-b border-line last:border-0">
              <td className="py-1 text-ink-2">{t.date}</td>
              <td className="py-1">{t.name ?? t.code}</td>
              <td className={t.side === "buy" ? "text-up" : "text-down"}>
                {t.side === "buy" ? "买" : "卖"}
              </td>
              <td className="py-1 text-right">{t.price.toFixed(2)}</td>
              <td className={`py-1 text-right ${tone(t.pnl)}`}>
                {t.pnl === null ? "" : money(t.pnl)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  } else if (res.what === "contributors") {
    const best = res.best as Array<{ code: string; name: string; pnl: number }>;
    const worst = res.worst as Array<{ code: string; name: string; pnl: number }>;
    body = (
      <div className="space-y-3">
        <PnlBars
          rows={best.map((b) => ({ label: b.name, sub: b.code, value: b.pnl }))}
          format={money}
        />
        <PnlBars
          rows={worst
            .filter((w) => w.pnl < 0)
            .map((b) => ({ label: b.name, sub: b.code, value: b.pnl }))}
          format={money}
        />
      </div>
    );
  } else if (res.what === "industry") {
    const rows = res.byIndustry as Array<{ industry: string; pnl: number; avgWeight: number }>;
    body = (
      <PnlBars
        rows={rows
          .slice(0, 10)
          .map((x) => ({ label: x.industry, sub: pct(x.avgWeight, 0, false), value: x.pnl }))}
        format={money}
      />
    );
  } else if (res.what === "monthly") {
    body = <MonthlyTable monthly={res.monthly as never} yearly={res.yearly as never} />;
  }
  return <Frame title={title[res.what] ?? res.what}>{body}</Frame>;
}

export function SecurityCard({
  output,
}: {
  output: { found: boolean; query: string; card?: Record<string, unknown> };
}) {
  if (!output.found || !output.card) return <Frame title="个股">没找到「{output.query}」。</Frame>;
  const sec = output.card.security as {
    code: string;
    name: string;
    industry: string | null;
    list_date: string | null;
    delist_date: string | null;
  };
  const f = (output.card.factors ?? {}) as Record<string, number | string | boolean | null>;
  const items: Array<[string, string, string?]> = [
    ["收盘", fmtFactor(f.close)],
    ["市值", fmtFactor(f.mcap, "亿")],
    ["PE TTM", fmtFactor(f.pe_ttm)],
    ["PE 5 年分位", fmtFactor(f.pe_pct_5y, "%")],
    ["PB", fmtFactor(f.pb)],
    ["ROE TTM", fmtFactor(f.roe_ttm, "%")],
    ["股息率", fmtFactor(f.dividend_yield_ttm, "%")],
    ["营收同比", fmtFactor(f.rev_yoy, "%")],
    ["净利同比", fmtFactor(f.np_yoy, "%")],
    ["250 日涨跌", fmtFactor(f.chg_250d, "%")],
  ];
  return (
    <Frame
      title={`${sec.name} ${sec.code}`}
      right={<span className="text-muted">{String(f.date ?? "")}</span>}
    >
      <div className="mb-2 text-xs text-muted">
        {sec.industry ?? "—"} · 上市 {sec.list_date ?? "—"}
        {sec.delist_date ? ` · 已退市 ${sec.delist_date}` : ""}
      </div>
      <div className="grid grid-cols-5 gap-2 text-center text-xs">
        {items.map(([l, v]) => (
          <div key={l}>
            <div className="text-muted">{l}</div>
            <div className="tabular font-medium">{v}</div>
          </div>
        ))}
      </div>
    </Frame>
  );
}

export function ToolChip({ name, state, error }: { name: string; state: string; error?: string }) {
  const [open, setOpen] = useState(false);
  const label: Record<string, string> = {
    list_factors: "查看因子",
    list_strategies: "查看策略列表",
    get_strategy: "读取策略",
    list_runs: "查看回测记录",
    get_tracking: "读取跟踪",
    get_run: "读取回测",
  };
  return (
    <div className="my-1 text-xs text-muted">
      <button className="inline-flex items-center gap-1" onClick={() => setOpen(!open)}>
        {state === "output-error" ? (
          <X className="size-3 text-warn" />
        ) : state === "output-available" ? (
          <Wrench className="size-3" />
        ) : (
          <Loader2 className="size-3 animate-spin" />
        )}
        {label[name] ?? name}
        {state === "output-error" && "失败"}
      </button>
      {open && error && <div className="mt-1 whitespace-pre-wrap text-warn">{error}</div>}
    </div>
  );
}

export function ScreenCard({
  output,
  title = "按规则选股",
}: {
  output: ScreenResult & { describe?: string[] };
  title?: string;
}) {
  return (
    <Frame
      title={`${title} · ${output.date}`}
      info={
        <>
          {output.describe?.length ? (
            <ul className="mb-1.5 space-y-0.5 text-ink">
              {output.describe.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          ) : null}
          按规则在这一天的数据上算出的结果，不是投资建议。
        </>
      }
      right={<span className="text-muted">共 {output.rows.length} 只</span>}
    >
      <div className="max-h-72 overflow-auto">
        <ScreenTable result={output} />
      </div>
    </Frame>
  );
}

// ── 看板概览（get_overview）：对话里也能一眼看到各跟踪的现状 ──

interface OverviewOutput {
  dataAsOf: Record<string, string | null>;
  failedMarkets: string[];
  trackings: Array<{
    id: string;
    strategyName: string;
    market: string;
    startDate: string;
    days: number;
    excess: number | null;
    deviationPct: number | null;
  }>;
  plans: Array<{
    trackingId: string;
    strategyName: string;
    planDate: string;
    buys: string[];
    sells: string[];
  }>;
}

export function OverviewCard({ output }: { output: OverviewOutput }) {
  const asOf = Object.entries(output.dataAsOf)
    .filter(([, d]) => d)
    .map(([m, d]) => `${MARKET_TEXT[m]} ${d}`)
    .join(" · ");
  return (
    <Frame title="我的跟踪" right={<span className="text-muted">数据截至 {asOf || "—"}</span>}>
      {output.failedMarkets.length > 0 && (
        <p className="mb-2 text-xs text-warn">
          {output.failedMarkets.map((m) => MARKET_TEXT[m]).join("、")}
          最近一次更新失败，数字还是旧的。
        </p>
      )}
      {output.trackings.length ? (
        <ul className="divide-y divide-line">
          {output.trackings.map((t) => (
            <li key={t.id} className="flex items-center gap-2 py-1.5 text-xs">
              <Link to={`/trackings/${t.id}`} className="min-w-0 flex-1 hover:text-accent">
                <div className="truncate font-medium text-ink">{t.strategyName}</div>
                <div className="truncate text-muted">
                  {t.days ? `跟踪 ${t.days} 天` : `${t.startDate} 开始`} ·{" "}
                  {deviationText(t.deviationPct, t.days)}
                </div>
              </Link>
              <span className={cx("tabular text-sm font-semibold", tone(t.excess))}>
                {t.days ? pct(t.excess) : "—"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">还没有上线跟踪的策略。</p>
      )}
      {output.plans.length > 0 && (
        <div className="mt-2 space-y-1.5 border-t border-line pt-2">
          {output.plans.map((p) => (
            <div key={p.trackingId} className="flex flex-wrap items-center gap-1 text-xs">
              <span className="text-muted">
                {p.strategyName} · {p.planDate}：
              </span>
              {p.buys.map((n) => (
                <Badge key={`b-${n}`} tone="up">
                  买 {n}
                </Badge>
              ))}
              {p.sells.map((n) => (
                <Badge key={`s-${n}`} tone="down">
                  卖 {n}
                </Badge>
              ))}
            </div>
          ))}
        </div>
      )}
    </Frame>
  );
}

// ── 停止跟踪：模型只能提议，停不停由用户在卡片上点 ──

export function StopTrackingCard({
  output,
  send,
}: {
  output: {
    trackingId: string;
    strategyName: string;
    startDate: string;
    days: number;
    excess: number | null;
  };
  send: (text: string) => void;
}) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["tracking", output.trackingId],
    queryFn: () => api.get<{ status: string }>(`/api/trackings/${output.trackingId}`),
  });
  const stop = useMutation({
    mutationFn: () => api.post(`/api/trackings/${output.trackingId}/stop`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["tracking", output.trackingId] });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
      send(`我停掉了（trackingId=${output.trackingId}）。`);
    },
  });
  const stopped = status.data?.status === "stopped";
  return (
    <Frame
      title="停止跟踪"
      right={stopped ? <Badge>已停止</Badge> : <Badge tone="warn">待确认</Badge>}
    >
      <p className="text-sm">
        「{output.strategyName}」{output.startDate} 起
        {output.days ? `，已跟踪 ${output.days} 天，跟踪超额 ${pct(output.excess)}` : ""}。
      </p>
      <p className="mt-1 text-xs text-muted">停止后不再每日结算，历史记录都保留。</p>
      {!stopped && (
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" variant="danger" loading={stop.isPending} onClick={() => stop.mutate()}>
            确认停止
          </Button>
          <ErrorNote error={stop.error} />
        </div>
      )}
    </Frame>
  );
}

export function CompareCard({ runIds }: { runIds: string[] }) {
  return (
    <Frame title="回测对比">
      <CompareView ids={runIds} />
    </Frame>
  );
}

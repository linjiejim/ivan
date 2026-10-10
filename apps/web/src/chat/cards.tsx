/**
 * 工具卡片（D16）：卡片直接渲染工具输出或按 id 读库，数字以卡片为准；LLM 的文字只做解读。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { NavChart } from "../components/charts/nav-chart.tsx";
import { MonthlyTable, PnlBars } from "../components/charts/small.tsx";
import { CompareView } from "../components/compare-view.tsx";
import { DiffView } from "../components/diff-view.tsx";
import {
  type Icon,
  IconBacktest,
  IconBoard,
  IconCheck,
  IconCompare,
  IconError,
  IconGoLive,
  IconHistory,
  IconRules,
  IconScreen,
  IconSpinner,
  IconStop,
  IconStrategy,
  IconSweep,
  IconTracking,
  IconData,
  IconChevronDown,
  IconEvidence,
  IconPlan,
  IconWarn,
} from "../components/icons.tsx";
import { EvidenceBody } from "../components/evidence-modal.tsx";
import { PlanItems, PlanMeta } from "../components/plan-list.tsx";
import { ScreenTable, ScreenTrace } from "../components/screen-table.tsx";
import { TrackingVerdict, VerdictBadge } from "../components/verdict.tsx";
import {
  Badge,
  Button,
  Checks,
  cx,
  ErrorNote,
  Figure,
  Info,
  InfoRows,
  Tag,
  TextLink,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import {
  beatPct,
  deviationText,
  fmtFactor,
  MARKET_TEXT,
  money,
  NA,
  pct,
  tone,
} from "../lib/format.ts";
import type {
  GroundingResult,
  PlanSnapshot,
  TrackingHealth,
  Verdict,
  RunDetail,
  ScreenResult,
  SecurityEvidence,
  SpecChange,
} from "../lib/types.ts";
import { computePausedNote } from "../lib/verify.ts";
import { TOOL_ACTIVITY } from "./activity.ts";

function Frame({
  title,
  icon: Ico,
  children,
  right,
  info,
}: {
  title: React.ReactNode;
  icon?: Icon;
  children: React.ReactNode;
  right?: React.ReactNode;
  /** 标题旁的 ⓘ：次要说明按需看 */
  info?: React.ReactNode;
}) {
  return (
    <div className="my-2.5 animate-enter overflow-hidden rounded-xl border border-line bg-page/70">
      <div className="flex h-9 items-center gap-1.5 border-b border-line px-3 text-xs font-medium text-ink-2">
        {Ico && <Ico size={14} className="shrink-0 text-muted" />}
        <span className="min-w-0 truncate">{title}</span>
        {info && <Info>{info}</Info>}
        <span className="ml-auto flex shrink-0 items-center">{right}</span>
      </div>
      <div className="px-3 py-3">{children}</div>
    </div>
  );
}

/** 卡片里的小指标：标签在上、数字在下 */
function MiniStats({ items }: { items: Array<[string, string, string?]> }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {items.map(([l, v, c]) => (
        <div key={l}>
          <div className="text-2xs text-muted">{l}</div>
          <div className={cx("mt-0.5 text-sm font-semibold tracking-[-0.01em] text-ink", c)}>
            <Figure text={v} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 进度：一行说明 + 一道细进度条 */
function Progress({ note, progress }: { note: string; progress: number }) {
  const p = Math.round(progress * 100);
  return (
    <div>
      <div className="flex items-center gap-2 text-xs">
        <IconSpinner size={13} className="animate-spin text-accent" />
        <span className="ai-shimmer font-medium">{note}</span>
        <span className="tabular ml-auto text-muted">{p}%</span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-700 ease-out"
          style={{ width: `${Math.max(p, 3)}%` }}
        />
      </div>
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

/** 草稿卡片右上角的状态：和下面的按钮读同一份缓存，不会一个说「待确认」一个说「已确认」 */
function DraftBadge({ draftId }: { draftId: string }) {
  const d = useDraft(draftId);
  if (d.data?.status === "confirmed") return <Badge icon={IconCheck}>已确认</Badge>;
  if (d.data?.status === "discarded") return <Badge>已放弃</Badge>;
  return <Badge tone="warn">待你确认</Badge>;
}

function DraftActions({
  draftId,
  onConfirmed,
  confirmLabel,
  confirmIcon,
}: {
  draftId: string;
  onConfirmed: (r: Record<string, string>) => void;
  confirmLabel: string;
  confirmIcon?: Icon;
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
      <span className="inline-flex items-center gap-1 text-xs font-medium text-down">
        <IconCheck size={14} weight="bold" />
        已确认
      </span>
    );
  if (d.data?.status === "discarded") return <span className="text-xs text-muted">已放弃</span>;
  return (
    <div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          icon={confirmIcon ?? IconCheck}
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
      </div>
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
      <Frame title="策略草稿没有通过校验" icon={IconError}>
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-ink-2 marker:text-faint">
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
      icon={isNew ? IconStrategy : IconRules}
      right={<DraftBadge draftId={output.draftId!} />}
    >
      <DiffView changes={output.changes ?? []} describe={isNew ? output.describe : undefined} />
      <div className="mt-3.5 border-t border-line pt-3">
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
    /** 锁定的成交假设（旧草稿没有） */
    execText?: string;
    legacyBaseline?: boolean;
  };
  send: (text: string) => void;
}) {
  return (
    <Frame title="上线跟踪" icon={IconGoLive} right={<DraftBadge draftId={output.draftId} />}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted">策略</dt>
        <dd className="text-ink">
          「{output.strategyName}」<span className="font-mono">v{output.versionN}</span>
        </dd>
        <dt className="text-muted">上线日</dt>
        <dd className="font-mono text-ink">{output.startDate}</dd>
        <dt className="text-muted">模拟资金</dt>
        <dd className="tabular text-ink">{output.capital.toLocaleString()} 元</dd>
        {output.execText && (
          <>
            <dt className="text-muted">成交假设</dt>
            <dd className="text-ink">{output.execText}</dd>
          </>
        )}
      </dl>
      {output.legacyBaseline && (
        <p className="mt-2 text-xs text-warn">
          基准回测用的是旧口径，上线后也会沿用；建议先按新口径重新回测。
        </p>
      )}
      {!output.hasBaseline && (
        <p className="mt-2 text-xs text-warn">这个版本还没有跑完的回测，上线后没法和回测比。</p>
      )}
      <div className="mt-3.5 border-t border-line pt-3">
        <DraftActions
          draftId={output.draftId}
          confirmLabel="确认上线"
          confirmIcon={IconGoLive}
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
      <Frame title="回测" icon={IconBacktest}>
        {q.error ? <ErrorNote error={q.error} /> : <Progress note="读取中" progress={0} />}
      </Frame>
    );
  if (r.status !== "done") {
    return (
      <Frame title="回测" icon={IconBacktest}>
        {r.status === "failed" ? (
          <ErrorNote error={new Error(r.error ?? "失败")} className="mt-0" />
        ) : (
          <Progress
            note={
              r.status === "queued"
                ? (computePausedNote(r) ?? "排队中…")
                : (r.job?.note ?? "回测中…")
            }
            progress={r.job?.progress ?? 0}
          />
        )}
      </Frame>
    );
  }
  if (r.kind === "sweep") return <SweepCard runId={runId} />;
  const m = r.metrics!;
  return (
    <Frame
      title={
        <span className="font-mono text-[11px]">
          {r.params.start} ~ {r.params.end}
        </span>
      }
      icon={IconBacktest}
      info={
        <InfoRows
          rows={[
            ["总收益", pct(m.totalReturn)],
            ["基准年化", pct(m.benchCagr)],
            ["胜率", m.winRate === null ? NA : pct(m.winRate, 0, false)],
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
      right={<TextLink to={`/runs/${r.id}`}>完整报告</TextLink>}
    >
      <MiniStats
        items={[
          ["年化", pct(m.cagr), tone(m.cagr)],
          ["年化超额", pct(m.excessCagr), tone(m.excessCagr)],
          ["最大回撤", pct(m.maxDrawdown, 1, false)],
          ["夏普", m.sharpe.toFixed(2)],
        ]}
      />
      <div className="mt-3">
        <NavChart points={r.series} height={168} />
      </div>
      {r.checks.length > 0 && (
        <div className="mt-2.5">
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
      <Frame title="参数扫描" icon={IconSweep}>
        <Progress note={r?.job?.note ?? "扫描中…"} progress={r?.job?.progress ?? 0} />
      </Frame>
    );
  const max = Math.max(...r.children.map((c) => Math.abs(c.headline?.excessCagr ?? 0)), 0.01);
  return (
    <Frame
      title={`参数扫描：${r.label}`}
      icon={IconSweep}
      info="条的长度 = 年化超额（红为正、蓝为负）。相邻取值之间跳得厉害，说明策略对这个参数敏感。"
      right={<TextLink to={`/runs/${r.id}`}>详情</TextLink>}
    >
      <ul className="space-y-1.5">
        {r.children.map((c) => {
          const v = c.headline?.excessCagr ?? 0;
          return (
            <li
              key={c.id}
              className="grid grid-cols-[minmax(0,6rem)_1fr_auto] items-center gap-2.5 text-xs"
            >
              <span className="truncate font-mono text-[11px] text-ink-2">
                {c.label?.split(" = ").pop()}
              </span>
              <span className="h-2">
                <span
                  className="block h-2 rounded-r-[3px] rounded-l-[1px]"
                  style={{
                    width: `${Math.max((Math.abs(v) / max) * 100, 1.5)}%`,
                    background: v >= 0 ? "var(--up)" : "var(--neg)",
                    opacity: 0.8,
                  }}
                />
              </span>
              <span className={cx("tabular w-14 text-right font-medium", tone(v))}>{pct(v)}</span>
            </li>
          );
        })}
      </ul>
      {r.checks.length > 0 && (
        <div className="mt-2.5">
          <Checks checks={r.checks} compact />
        </div>
      )}
    </Frame>
  );
}

// ── 下钻 ──

const QUERY_TITLE: Record<string, string> = {
  drawdowns: "最大几次回撤",
  period: "区间表现",
  holdings_on: "当天持仓",
  trades: "交易明细",
  contributors: "盈亏贡献",
  industry: "行业",
  monthly: "月度收益",
  execution: "成交与容量",
};

export function QueryCard({
  output,
}: {
  output: { runId: string; result: Record<string, unknown> & { what: string } };
}) {
  const res = output.result;
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
              <td className="py-1.5 font-medium text-down">{pct(d.depth, 1, false)}</td>
              <td className="py-1.5 font-mono text-[11px] text-ink-2">
                {d.peak} → {d.trough}
              </td>
              <td className="py-1.5 text-right text-muted">
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
      <div className="space-y-3 text-xs">
        <MiniStats
          items={[
            ["策略", pct(m.totalReturn), tone(m.totalReturn)],
            ["基准", pct(m.benchReturn), tone(m.benchReturn)],
            ["超额", pct(m.excessTotal), tone(m.excessTotal)],
            ["回撤", pct(m.maxDrawdown, 1, false)],
          ]}
        />
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
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 font-mono text-[11px] text-muted">{snap.date}</span>
        {snap.items.map((i) => (
          <Tag key={i.code} mono>
            {i.code} {pct(i.weight, 0, false)}
          </Tag>
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
      <div className="max-h-72 overflow-y-auto">
        <table className="tabular w-full text-xs">
          <tbody>
            {trades.slice(0, 30).map((t) => (
              <tr key={t.seq} className="border-b border-line last:border-0">
                <td className="py-1.5 font-mono text-[11px] text-muted">{t.date}</td>
                <td className="py-1.5 text-ink">{t.name ?? t.code}</td>
                <td className={cx("py-1.5", t.side === "buy" ? "text-up" : "text-down")}>
                  {t.side === "buy" ? "买" : "卖"}
                </td>
                <td className="py-1.5 text-right">{t.price.toFixed(2)}</td>
                <td className={cx("py-1.5 text-right font-medium", tone(t.pnl))}>
                  {t.pnl === null ? "" : money(t.pnl)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
  } else if (res.what === "execution") {
    const ex = res as unknown as {
      exec: string | null;
      note: string | null;
      legacyFill: boolean;
      rejections: Array<{ side: string; reason: string; count: number; value: number }>;
      participation: { p50: number; p90: number; max: number } | null;
      capacityEstimate: number | null;
      slippageCost: number | null;
      fees: number | null;
    };
    body = (
      <div className="space-y-3 text-xs">
        {ex.exec && <p className="text-muted">成交假设：{ex.exec}</p>}
        {ex.note && <p className={ex.legacyFill ? "text-warn" : "text-muted"}>{ex.note}</p>}
        {!ex.legacyFill && (
          <MiniStats
            items={[
              ["容量估计", money(ex.capacityEstimate)],
              ["参与率 90%", pct(ex.participation?.p90, 2, false)],
              ["滑点与冲击", money(ex.slippageCost)],
              ["费用", money(ex.fees)],
            ]}
          />
        )}
        {ex.rejections.length > 0 && (
          <table className="tabular w-full">
            <tbody>
              {ex.rejections.map((x) => (
                <tr key={`${x.side}${x.reason}`} className="border-b border-line last:border-0">
                  <td className={cx("py-1.5", x.side === "买" ? "text-up" : "text-down")}>
                    {x.side}
                  </td>
                  <td className="py-1.5 text-ink">{x.reason}</td>
                  <td className="py-1.5 text-right text-ink-2">{x.count} 次</td>
                  <td className="py-1.5 text-right text-muted">{money(x.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }
  return (
    <Frame title={QUERY_TITLE[res.what] ?? res.what} icon={IconBacktest}>
      {body}
    </Frame>
  );
}

export function SecurityCard({
  output,
}: {
  output: { found: boolean; query: string; card?: Record<string, unknown> };
}) {
  if (!output.found || !output.card)
    return (
      <Frame title="个股" icon={IconScreen}>
        <p className="text-xs text-muted">没找到「{output.query}」。</p>
      </Frame>
    );
  const sec = output.card.security as {
    code: string;
    name: string;
    industry: string | null;
    list_date: string | null;
    delist_date: string | null;
  };
  const f = (output.card.factors ?? {}) as Record<string, number | string | boolean | null>;
  const items: Array<[string, string]> = [
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
      title={
        <>
          {sec.name}
          <span className="ml-1.5 font-mono text-[11px] font-normal text-muted">{sec.code}</span>
        </>
      }
      icon={IconScreen}
      right={
        <span className="font-mono text-[11px] font-normal text-muted">{String(f.date ?? "")}</span>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <Tag>{sec.industry ?? NA}</Tag>
        <span>上市 {sec.list_date ?? NA}</span>
        {sec.delist_date && <Badge tone="warn">已退市 {sec.delist_date}</Badge>}
      </div>
      <dl className="grid grid-cols-5 gap-x-2 gap-y-3 text-xs">
        {items.map(([l, v]) => (
          <div key={l} className="min-w-0">
            <dt className="truncate text-2xs text-muted">{l}</dt>
            <dd className="tabular mt-0.5 font-medium text-ink">{v}</dd>
          </div>
        ))}
      </dl>
    </Frame>
  );
}

/** 个股证据（D67）：决策日当时可得的数据，带出处、数据版本与校验值 */
export function EvidenceCard({ output }: { output: SecurityEvidence }) {
  return (
    <Frame
      title="个股证据"
      icon={IconEvidence}
      info="只用决策日（成交日的前一个交易日）收盘后当时可得的数据；财报优先用当时首次见到的数值。每行标出来源和数据日，校验值可以复核。"
    >
      <EvidenceBody e={output} />
    </Frame>
  );
}

/** 工具名 → 人话 + 图标（没有卡片的工具在对话里显示成一行小字） */
const TOOL_META: Record<string, [string, Icon]> = {
  list_factors: ["查看可用因子", IconRules],
  list_strategies: ["查看你的策略", IconStrategy],
  get_strategy: ["读取策略", IconStrategy],
  propose_strategy: ["写策略草稿", IconStrategy],
  run_backtest: ["提交回测", IconBacktest],
  get_run: ["读取回测", IconBacktest],
  list_runs: ["查看回测记录", IconHistory],
  query_run: ["下钻回测", IconBacktest],
  compare_runs: ["对比回测", IconCompare],
  run_sensitivity: ["提交参数扫描", IconSweep],
  screen_today: ["按策略选股", IconScreen],
  screen_rules: ["按条件选股", IconScreen],
  lookup_security: ["查个股", IconScreen],
  get_security_evidence: ["查看个股证据", IconEvidence],
  propose_tracking: ["准备上线跟踪", IconGoLive],
  get_tracking: ["读取跟踪", IconTracking],
  get_overview: ["查看看板", IconBoard],
  propose_stop_tracking: ["准备停止跟踪", IconStop],
  get_plan: ["查看计划依据", IconPlan],
};

export function ToolChip({ name, state, error }: { name: string; state: string; error?: string }) {
  const [open, setOpen] = useState(false);
  const [label, Ico] = TOOL_META[name] ?? [TOOL_ACTIVITY[name] ?? name, IconData];
  const failed = state === "output-error";
  const done = state === "output-available";
  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => failed && setOpen(!open)}
        aria-expanded={failed ? open : undefined}
        className={cx(
          "inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-2xs ring-1 ring-inset",
          failed ? "bg-warn-bg text-warn ring-warn-line" : "bg-surface-2/60 text-muted ring-line",
          !failed && "cursor-default",
        )}
      >
        {failed ? (
          <IconError size={12} weight="bold" />
        ) : done ? (
          <Ico size={12} />
        ) : (
          <IconSpinner size={12} className="animate-spin" />
        )}
        {label}
        {failed && (
          <>
            失败
            <IconChevronDown
              size={10}
              className={cx("transition-transform", open && "rotate-180")}
            />
          </>
        )}
      </button>
      {open && error && (
        <div className="mt-1.5 rounded-lg bg-warn-bg px-2.5 py-2 text-2xs whitespace-pre-wrap text-warn">
          {error}
        </div>
      )}
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
      title={
        <>
          {title}
          <span className="ml-1.5 font-mono text-[11px] font-normal text-muted">{output.date}</span>
        </>
      }
      icon={IconScreen}
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
      right={
        <span className="font-normal text-muted">
          共 <span className="tabular">{output.rows.length}</span> 只
        </span>
      }
    >
      <div className="max-h-72 overflow-auto">
        <ScreenTable result={output} />
      </div>
      <ScreenTrace result={output} />
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
    /** 判词（D70）；早于 S10 的消息没有 */
    verdict?: Verdict;
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
    .join("，");
  return (
    <Frame
      title="我的跟踪"
      icon={IconTracking}
      right={<span className="font-normal text-muted">数据截至 {asOf || NA}</span>}
    >
      {output.failedMarkets.length > 0 && (
        <p className="mb-2 text-xs text-warn">
          {output.failedMarkets.map((m) => MARKET_TEXT[m]).join("、")}
          最近一次更新失败，数字还是旧的。
        </p>
      )}
      {output.trackings.length ? (
        <ul>
          {output.trackings.map((t) => (
            <li key={t.id} className="border-b border-line last:border-0">
              <Link
                to={`/trackings/${t.id}`}
                className="group/ov flex items-center gap-2 py-2 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium text-ink transition-colors group-hover/ov:text-accent">
                      {t.strategyName}
                    </span>
                    {t.verdict && <VerdictBadge verdict={t.verdict} />}
                  </div>
                  <div className="truncate text-muted">
                    {t.days ? `跟踪 ${t.days} 天` : `${t.startDate} 开始`}，
                    {deviationText(t.deviationPct, t.days)}
                  </div>
                </div>
                <span
                  className={cx(
                    "text-sm font-semibold tracking-[-0.01em]",
                    t.days ? tone(t.excess) : "text-muted",
                  )}
                >
                  <Figure text={t.days ? pct(t.excess) : NA} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">还没有上线跟踪的策略。</p>
      )}
      {output.plans.length > 0 && (
        <div className="mt-2 space-y-2 border-t border-line pt-2.5">
          {output.plans.map((p) => (
            <div key={p.trackingId} className="flex flex-wrap items-center gap-1 text-xs">
              <span className="mr-0.5 text-muted">
                {p.strategyName} <span className="font-mono text-[11px]">{p.planDate}</span>
              </span>
              {p.buys.map((n) => (
                <Badge key={`b-${n}`} tone="up">
                  <span className="opacity-70">买</span>
                  {n}
                </Badge>
              ))}
              {p.sells.map((n) => (
                <Badge key={`s-${n}`} tone="down">
                  <span className="opacity-70">卖</span>
                  {n}
                </Badge>
              ))}
            </div>
          ))}
        </div>
      )}
    </Frame>
  );
}

// ── 一个跟踪的现状（get_tracking，D70）：判词 + 三个数 + 去详情 ──

export interface TrackingOutput {
  trackingId: string;
  strategyName: string;
  market?: string;
  startDate: string;
  days: number;
  lastDate: string | null;
  excess: number | null;
  /** 跑赢回测同期（百分位 0–100）；早于 S10 的消息叫 deviationPct */
  beatBacktestPct?: number | null;
  deviationPct?: number | null;
  verdict?: Verdict;
  health?: Pick<TrackingHealth, "state" | "signal" | "perMetric"> | null;
  lastError?: { date: string; message: string } | null;
}

export function TrackingCard({ output }: { output: TrackingOutput }) {
  const beat = output.beatBacktestPct ?? output.deviationPct ?? null;
  return (
    <Frame
      title={<>「{output.strategyName}」</>}
      icon={IconTracking}
      right={
        output.verdict && (
          <TrackingVerdict
            verdict={output.verdict}
            health={output.health}
            lastError={output.lastError}
            lastDate={output.lastDate}
          />
        )
      }
    >
      <MiniStats
        items={[
          ["跟踪超额", output.days ? pct(output.excess) : NA, tone(output.excess)],
          ["跑赢回测同期", beatPct(beat)],
          ["跟踪天数", output.days ? `${output.days} 天` : NA],
          ["最后结算", output.lastDate ?? NA],
        ]}
      />
      <div className="mt-2.5 flex items-center justify-between border-t border-line pt-2 text-2xs text-muted">
        <span>
          {output.days ? `${output.startDate} 上线` : `${output.startDate} 开始`}
          {output.market ? `，${MARKET_TEXT[output.market]}` : ""}
        </span>
        <TextLink to={`/trackings/${output.trackingId}`}>打开跟踪</TextLink>
      </div>
    </Frame>
  );
}

// ── 停止跟踪：模型只能写草稿（D68），停不停由用户在卡片上确认 ──

export function StopTrackingCard({
  output,
  send,
}: {
  output: {
    /** 旧消息（S08 之前）没有草稿：只显示，不能再确认 */
    draftId?: string;
    trackingId: string;
    strategyName: string;
    startDate: string;
    days: number;
    excess: number | null;
    reason?: string | null;
  };
  send: (text: string) => void;
}) {
  const qc = useQueryClient();
  return (
    <Frame
      title="停止跟踪"
      icon={IconStop}
      right={output.draftId ? <DraftBadge draftId={output.draftId} /> : undefined}
    >
      <p className="text-sm text-ink">
        「{output.strategyName}」<span className="font-mono text-xs">{output.startDate}</span> 起
        {output.days ? `，已跟踪 ${output.days} 天，跟踪超额 ${pct(output.excess)}` : ""}。
      </p>
      {output.reason && <p className="mt-1 text-xs text-ink-2">停止原因：{output.reason}</p>}
      <p className="mt-1 text-xs text-muted">
        停止后不再每日结算，历史记录都保留；会记进决策账本。
      </p>
      {output.draftId && (
        <div className="mt-3.5 border-t border-line pt-3">
          <DraftActions
            draftId={output.draftId}
            confirmLabel="确认停止"
            confirmIcon={IconStop}
            onConfirmed={async () => {
              await qc.invalidateQueries({ queryKey: ["tracking", output.trackingId] });
              send(`我停掉了（trackingId=${output.trackingId}）。`);
            }}
          />
        </div>
      )}
    </Frame>
  );
}

// ── 明日计划与依据（get_plan，D68） ──

export function PlanCard({
  output,
}: {
  output: { trackingId: string; strategyName: string; market: string; plan: PlanSnapshot };
}) {
  const p = output.plan;
  return (
    <Frame
      title={
        <>
          「{output.strategyName}」的计划
          <span className="ml-1.5 font-mono text-[11px] font-normal text-muted">
            决策日 {p.decisionDate}
          </span>
        </>
      }
      icon={IconPlan}
      info="按规则在决策日收盘后算出的模拟计划；每项的 ⓘ 是当时的名次、得分、因子分位与估算，存的是当时的值，以后数据修订也不会改写。"
      right={
        <span className="font-normal text-muted">
          第 <span className="tabular">{p.edition}</span> 版
        </span>
      }
    >
      <p className="mb-1.5 text-xs text-muted">
        <PlanMeta plan={p} />
      </p>
      {p.items.length ? (
        <PlanItems plan={p} trackingId={output.trackingId} market={output.market} />
      ) : (
        <p className="text-xs text-muted">没有计划中的买卖，持仓照旧。</p>
      )}
      <p className="mt-2 border-t border-line pt-2 text-right text-2xs text-muted">
        仅供研究，不构成投资建议
      </p>
    </Frame>
  );
}

export function CompareCard({ runIds }: { runIds: string[] }) {
  return (
    <Frame title="回测对比" icon={IconCompare}>
      <CompareView ids={runIds} />
    </Frame>
  );
}

/** 工具数的出处：「get_run.excessCagr」→「get_run · excessCagr」 */
function evidencePath(path: string): string {
  const i = path.indexOf(".");
  return i < 0 ? path : `${path.slice(0, i)} · ${path.slice(i + 1)}`;
}

/**
 * 数字核对标注（D69）：助手回复里有工具结果找不到的数字时，挂在气泡下面；全对上时不显示。
 * 对话是流式的撤不回来，所以只标注、不改写；ⓘ 列出每个数最接近的工具数。
 */
export function GroundingNote({ g }: { g: GroundingResult | null | undefined }) {
  if (!g?.unverified.length) return null;
  const raws = [...new Set(g.unverified.map((u) => u.raw.trim()))];
  return (
    <div className="mt-1.5 flex items-start gap-1.5 text-2xs leading-5 text-warn">
      <IconWarn size={12} weight="fill" className="mt-[3px] shrink-0" />
      <span>
        有 {raws.length} 个数字没在工具结果里找到：{raws.join("、")}，请以卡片为准
        <Info label="数字核对：说明" width={300}>
          <p className="mb-1.5">
            回复里的数字逐个和本轮及最近几次工具结果核对，允许四舍五入，不认推算出来的数。日期、代码、均线天数不核对。
          </p>
          <InfoRows
            rows={g.unverified.map((u) => [
              u.raw.trim(),
              u.nearest
                ? `${u.reason === "sign_mismatch" ? "符号不符，工具数" : "最接近"} ${u.nearest.value}（${evidencePath(u.nearest.path)}）`
                : "工具结果里没有同类的数",
            ])}
          />
        </Info>
      </span>
    </div>
  );
}

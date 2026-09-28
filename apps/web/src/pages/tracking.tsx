/**
 * 跟踪详情（spec §7）：回测段 + 跟踪段曲线、与回测的偏离、持仓、明日计划、停止。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, useParams } from "react-router";
import type { OpenPosition } from "@ivan/core";
import { useChatUi } from "../chat/chat-context.tsx";
import { NavChart } from "../components/charts/nav-chart.tsx";
import { Badge, Button, Card, Checks, ErrorNote, Spinner, Stat } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { DEVIATION_INFO, deviationText, MARKET_TEXT, money, pct, tone } from "../lib/format.ts";
import type { Check, TrackingChart, TrackingView } from "../lib/types.ts";

type TrackingDetail = TrackingView & {
  days: Array<{ date: string; nav: number; bench: number; cash: number; positions: number }>;
  orders: Array<{
    planDate: string;
    code: string;
    name: string | null;
    side: string;
    reason: string;
  }>;
};

export function TrackingPage() {
  const { id = "" } = useParams();
  const q = useQuery({
    queryKey: ["tracking", id],
    queryFn: () => api.get<TrackingDetail>(`/api/trackings/${id}`),
  });
  const chart = useQuery({
    queryKey: ["tracking-chart", id],
    queryFn: () => api.get<TrackingChart>(`/api/trackings/${id}/chart`),
  });
  const chat = useChatUi();
  const qc = useQueryClient();
  const stop = useMutation({
    mutationFn: () => api.post(`/api/trackings/${id}/stop`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tracking", id] }),
  });
  const t = q.data;
  useEffect(() => {
    if (t)
      chat.setPage({
        trackingId: t.id,
        strategyId: t.strategyId,
        versionId: t.versionId,
        label: `跟踪「${t.strategyName}」`,
      });
  }, [t?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (q.isLoading) return <Spinner />;
  if (!t) return <ErrorNote error={q.error} />;
  const summary = (t.summary ?? {}) as {
    positions?: OpenPosition[];
    cash?: number;
    equity?: number;
    checks?: Check[];
    waitingForStart?: boolean;
    dataAsOf?: string;
    replay?: { navDrift: number; benchDrift: number; firstDrift: string | null; at: string };
  };
  const drift =
    summary.replay && summary.replay.navDrift + summary.replay.benchDrift > 0
      ? summary.replay
      : null;
  const points = chart.data ? [...chart.data.backtest, ...chart.data.tracking] : [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">跟踪：{t.strategyName}</h1>
        <Badge>{MARKET_TEXT[t.market]}</Badge>
        <Badge tone={t.status === "active" ? "accent" : "neutral"}>
          {t.status === "active" ? "运行中" : "已停止"}
        </Badge>
        <Link to={`/strategies/${t.strategyId}`} className="text-sm text-accent">
          策略
        </Link>
        <div className="ml-auto flex gap-2">
          <Button
            onClick={() =>
              chat.ask("这个跟踪最近表现怎么样？和回测相比偏离大吗？", { trackingId: t.id })
            }
          >
            问 AI
          </Button>
          {t.status === "active" && (
            <Button
              variant="danger"
              loading={stop.isPending}
              onClick={() => confirm("停止后不再每日结算，确定？") && stop.mutate()}
            >
              停止跟踪
            </Button>
          )}
        </div>
      </div>
      {summary.waitingForStart ? (
        <Card>
          <p className="text-sm text-ink-2">
            {t.startDate} 开盘建仓，当天收盘后第一次结算。下面是按最新数据算出的首日计划。
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-2 @2xl:grid-cols-4">
          <Stat
            label="跟踪收益"
            value={pct(t.nav !== null ? t.nav - 1 : null)}
            valueClass={tone(t.nav !== null ? t.nav - 1 : null)}
            note={`${t.startDate} 起 · ${t.days.length} 天`}
          />
          <Stat
            label="跟踪超额"
            value={pct(t.excess)}
            valueClass={tone(t.excess)}
            note={`基准 ${pct(t.bench !== null ? t.bench - 1 : null)}`}
          />
          <Stat
            label="跑赢回测同期"
            value={t.deviationPct === null ? "—" : `${t.deviationPct.toFixed(0)}%`}
            note={t.deviationPct === null ? deviationText(null, t.days.length) : "低于 10% 要留意"}
            info={DEVIATION_INFO}
          />
          <Stat label="总资产" value={money(summary.equity)} note={`现金 ${money(summary.cash)}`} />
        </div>
      )}
      <Card
        title="回测段 + 跟踪段"
        info={
          <>
            上线日之前是回测，之后是每天收盘重放的模拟盘。在图上拖动框选一段，可以问 AI 为什么。
            {summary.dataAsOf && <div className="mt-1 text-muted">数据截至 {summary.dataAsOf}</div>}
          </>
        }
      >
        {chart.data ? (
          <NavChart
            points={points}
            splitDate={chart.data.tracking.length ? t.startDate : undefined}
            strategyLabel={t.strategyName}
            onAsk={(range) =>
              chat.ask(`${range.from} 到 ${range.to} 这段为什么是这样？`, {
                trackingId: t.id,
                range,
              })
            }
          />
        ) : (
          <Spinner />
        )}
        {drift && (
          <p className="mt-2 text-xs text-muted">
            {drift.at} 结算时发现数据被修订过（最早影响 {drift.firstDrift}：净值 {drift.navDrift}{" "}
            天、基准 {drift.benchDrift} 天），曲线已按最新数据重算。
          </p>
        )}
      </Card>
      <div className="grid gap-4 @4xl:grid-cols-2">
        <Card title="明日计划" subtitle={t.orders[0] ? `${t.orders[0].planDate} 开盘` : undefined}>
          {t.orders.length ? (
            <div className="flex flex-wrap gap-1.5">
              {t.orders.map((o) => (
                <Badge key={`${o.side}-${o.code}`} tone={o.side === "buy" ? "up" : "down"}>
                  {o.side === "buy" ? "买" : "卖"} {o.name ?? o.code}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">没有计划中的买卖。</p>
          )}
        </Card>
        <Card title="当前持仓">
          {summary.positions?.length ? (
            <table className="tabular w-full text-sm">
              <tbody>
                {summary.positions.map((p) => (
                  <tr key={p.code} className="border-b border-line last:border-0">
                    <td className="py-1.5">
                      {p.name} <span className="text-xs text-muted">{p.code}</span>
                    </td>
                    <td className="py-1.5 text-right text-ink-2">{pct(p.weight, 1, false)}</td>
                    <td className={`py-1.5 text-right ${tone(p.ret)}`}>{pct(p.ret)}</td>
                    <td className="py-1.5 text-right text-xs text-muted">{p.entryDate} 买入</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted">空仓</p>
          )}
        </Card>
      </div>
      {summary.checks && summary.checks.length > 0 && (
        <Card title="检查">
          <Checks checks={summary.checks} />
        </Card>
      )}
    </div>
  );
}

/**
 * 跟踪详情（spec §7）：回测段 + 跟踪段曲线、与回测的偏离、持仓、明日计划、停止。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import type { OpenPosition } from "@ivan/core";
import { useChatUi } from "../chat/chat-context.tsx";
import { NavChart } from "../components/charts/nav-chart.tsx";
import {
  IconAI,
  IconChart,
  IconChecks,
  IconPlan,
  IconPositions,
  IconStop,
} from "../components/icons.tsx";
import {
  Badge,
  Button,
  Callout,
  Card,
  Checks,
  cx,
  DataTable,
  ErrorNote,
  LiveDot,
  Modal,
  PageHeader,
  PageSkeleton,
  Skeleton,
  Stat,
  Tag,
  Td,
  TextLink,
  Th,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import {
  beatPct,
  DEVIATION_INFO,
  deviationText,
  MARKET_TEXT,
  money,
  pct,
  tone,
} from "../lib/format.ts";
import { usePageTitle } from "../lib/title.ts";
import type { Check, TrackingChart, TrackingSummary, TrackingView } from "../lib/types.ts";

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
  const [stopping, setStopping] = useState(false);
  const stop = useMutation({
    mutationFn: () => api.post(`/api/trackings/${id}/stop`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["tracking", id] });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
      setStopping(false);
    },
  });
  const t = q.data;
  usePageTitle(t ? `跟踪「${t.strategyName}」` : "跟踪");
  useEffect(() => {
    if (t)
      chat.setPage({
        trackingId: t.id,
        strategyId: t.strategyId,
        versionId: t.versionId,
        label: `跟踪「${t.strategyName}」`,
      });
  }, [t?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (q.isLoading) return <PageSkeleton />;
  if (!t) return <ErrorNote error={q.error} />;
  const summary = (t.summary ?? {}) as {
    positions?: OpenPosition[];
    cash?: number;
    equity?: number;
    checks?: Check[];
    waitingForStart?: boolean;
    dataAsOf?: string;
    replay?: NonNullable<TrackingSummary["replay"]>;
    /** 仓位控制（D52）：当前仓位系数与下一个交易日要调到的系数 */
    exposure?: { current: number; next: number } | null;
  };
  const drift =
    summary.replay && summary.replay.navDrift + summary.replay.benchDrift > 0
      ? summary.replay
      : null;
  const points = chart.data ? [...chart.data.backtest, ...chart.data.tracking] : [];
  const active = t.status === "active";
  return (
    <div className="space-y-6">
      <PageHeader
        back={{ to: "/", label: "看板" }}
        title={t.strategyName}
        badges={
          <>
            <Tag>{MARKET_TEXT[t.market]}</Tag>
            {active ? (
              <Badge tone="accent">
                <LiveDot />
                运行中
              </Badge>
            ) : (
              <Badge>已停止</Badge>
            )}
          </>
        }
        meta={
          <>
            <span>
              <span className="font-mono">{t.startDate}</span> 上线，已跟踪{" "}
              <span className="tabular font-medium text-ink-2">{t.days.length}</span> 天
            </span>
            {t.execText && <Tag>成交假设：{t.execText}</Tag>}
            <TextLink to={`/strategies/${t.strategyId}`}>策略详情</TextLink>
          </>
        }
        actions={
          <>
            <Button
              variant="ai"
              icon={IconAI}
              onClick={() =>
                chat.ask("这个跟踪最近表现怎么样？和回测相比偏离大吗？", { trackingId: t.id })
              }
            >
              问 AI
            </Button>
            {active && (
              <Button variant="danger" icon={IconStop} onClick={() => setStopping(true)}>
                停止跟踪
              </Button>
            )}
          </>
        }
      />
      {summary.waitingForStart ? (
        <Callout tone="info" title="等待开盘建仓">
          <span className="font-mono">{t.startDate}</span>{" "}
          开盘建仓，当天收盘后第一次结算。下面是按最新数据算出的首日计划。
        </Callout>
      ) : (
        <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4">
          <Stat
            label="跟踪收益"
            value={pct(t.nav !== null ? t.nav - 1 : null)}
            valueClass={tone(t.nav !== null ? t.nav - 1 : null)}
            note={`${t.startDate} 起`}
          />
          <Stat
            label="跟踪超额"
            value={pct(t.excess)}
            valueClass={tone(t.excess)}
            note={`基准 ${pct(t.bench !== null ? t.bench - 1 : null)}`}
          />
          <Stat
            label="跑赢回测同期"
            value={beatPct(t.deviationPct)}
            note={t.deviationPct === null ? deviationText(null, t.days.length) : "低于 10% 要留意"}
            info={DEVIATION_INFO}
          />
          <Stat
            label="总资产"
            value={money(summary.equity)}
            note={
              summary.exposure
                ? `现金 ${money(summary.cash)}；仓位系数 ${Math.round(summary.exposure.current * 100)}%${
                    summary.exposure.next !== summary.exposure.current
                      ? `，下个交易日调到 ${Math.round(summary.exposure.next * 100)}%`
                      : ""
                  }`
                : `现金 ${money(summary.cash)}`
            }
          />
        </div>
      )}
      <Card
        title="回测段 + 跟踪段"
        icon={IconChart}
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
            height={300}
            onAsk={(range) =>
              chat.ask(`${range.from} 到 ${range.to} 这段为什么是这样？`, {
                trackingId: t.id,
                range,
              })
            }
          />
        ) : (
          <div className="space-y-3">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-[300px] w-full rounded-lg" />
          </div>
        )}
        {drift && (
          <p className="mt-3 text-xs text-muted">
            {drift.causeText ? (
              <>
                {drift.at} 结算时重放与上次不一致：{drift.causeText}；净值 {drift.navDrift} 天、基准{" "}
                {drift.benchDrift} 天不一致，曲线已按最新数据重算。
              </>
            ) : (
              <>
                {drift.at} 结算时发现数据被修订过（最早影响 {drift.firstDrift}：净值{" "}
                {drift.navDrift} 天、基准 {drift.benchDrift} 天），曲线已按最新数据重算。
              </>
            )}
          </p>
        )}
      </Card>
      <div className="grid gap-5 @4xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card
          title="明日计划"
          icon={IconPlan}
          subtitle={t.orders[0] ? `${t.orders[0].planDate} 开盘` : undefined}
        >
          {t.orders.length ? (
            <div className="flex flex-wrap gap-1.5">
              {t.orders.map((o) => (
                <Badge key={`${o.side}-${o.code}`} tone={o.side === "buy" ? "up" : "down"}>
                  <span className="opacity-70">{o.side === "buy" ? "买" : "卖"}</span>
                  {o.name ?? o.code}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">没有计划中的买卖，持仓照旧。</p>
          )}
        </Card>
        <Card
          title="当前持仓"
          icon={IconPositions}
          action={
            summary.positions?.length ? (
              <span className="text-xs text-muted">
                <span className="tabular font-medium text-ink-2">{summary.positions.length}</span>{" "}
                只
              </span>
            ) : null
          }
        >
          {summary.positions?.length ? (
            <DataTable>
              <thead>
                <tr>
                  <Th>股票</Th>
                  <Th align="right">仓位</Th>
                  <Th align="right">浮动盈亏</Th>
                  <Th align="right">买入日</Th>
                </tr>
              </thead>
              <tbody>
                {summary.positions.map((p) => (
                  <tr key={p.code} className="transition-colors hover:bg-surface-2/60">
                    <Td>
                      <span className="text-ink">{p.name}</span>
                      <span className="ml-1.5 font-mono text-[11px] text-muted">{p.code}</span>
                    </Td>
                    <Td align="right" className="text-ink-2">
                      {pct(p.weight, 1, false)}
                    </Td>
                    <Td align="right" className={cx("font-medium", tone(p.ret))}>
                      {pct(p.ret)}
                    </Td>
                    <Td align="right" className="font-mono text-[12px] text-muted">
                      {p.entryDate}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          ) : (
            <p className="text-sm text-muted">空仓。</p>
          )}
        </Card>
      </div>
      {summary.checks && summary.checks.length > 0 && (
        <Card title="检查" icon={IconChecks}>
          <Checks checks={summary.checks} />
        </Card>
      )}
      <Modal
        open={stopping}
        onClose={() => setStopping(false)}
        title="停止跟踪？"
        icon={IconStop}
        footer={
          <>
            <Button onClick={() => setStopping(false)}>先不停</Button>
            <Button
              variant="danger"
              icon={IconStop}
              loading={stop.isPending}
              onClick={() => stop.mutate()}
            >
              确认停止
            </Button>
          </>
        }
      >
        <p className="text-sm leading-6 text-ink-2">
          「{t.strategyName}
          」停止后不再每日结算，已有的历史记录、曲线和持仓都会保留。想继续跟踪需要重新上线。
        </p>
        <ErrorNote error={stop.error} />
      </Modal>
    </div>
  );
}

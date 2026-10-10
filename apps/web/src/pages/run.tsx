/**
 * 回测报告（spec §11、D40）：先回答「好不好、要注意什么」——4 个核心指标、诚实检查、净值图；
 * 月度收益、个股与行业归因、期末持仓、交易明细、样本内外收进下方分页，次要指标与复现信息收进 ⓘ。
 * 参数扫描显示各取值的结果与「参数脆弱」检查。
 * 复现（D57）：「复核数据」只比输入指纹（排队任务，轮询到完成）；「完整重跑」新建一次重跑，比结果指纹。
 */
import { defaultExec, describeExec, isLegacyExec } from "@ivan/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useChatUi } from "../chat/chat-context.tsx";
import {
  axisStyle,
  EChart,
  readTokens,
  tipHead,
  tooltipStyle,
  useThemeVersion,
} from "../components/charts/echart.tsx";
import { NavChart } from "../components/charts/nav-chart.tsx";
import { MonthlyTable, PnlBars } from "../components/charts/small.tsx";
import {
  IconAI,
  IconChart,
  IconChecks,
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconReproduce,
  IconRun,
  IconSweep,
  IconVerify,
} from "../components/icons.tsx";
import {
  Badge,
  Callout,
  Card,
  Checks,
  CopyButton,
  cx,
  DataTable,
  Empty,
  ErrorNote,
  IconButton,
  Info,
  InfoRows,
  PageHeader,
  PageSkeleton,
  Skeleton,
  Stat,
  Tabs,
  Tag,
  Td,
  TextLink,
  Th,
  Button,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { money, NA, num, pct, tone } from "../lib/format.ts";
import { usePageTitle } from "../lib/title.ts";
import {
  computePausedNote,
  reproReason,
  reproVerdict,
  runPollInterval,
  verifyBadgeState,
  verifyInFlight,
} from "../lib/verify.ts";
import type { RunDetail, RunVerify, Trade } from "../lib/types.ts";

function useRun(id: string) {
  return useQuery({
    queryKey: ["run", id],
    queryFn: () => api.get<RunDetail>(`/api/runs/${id}`),
    refetchInterval: (q) => runPollInterval(q.state.data),
  });
}

const short = (h: string | null | undefined) => (h ? h.slice(0, 8) : NA);

/** 复现信息（ⓘ）：区间、资金、策略指纹、数据版本、引擎、成交假设、输入指纹、运行卡指纹 */
function ReproRows({ r }: { r: RunDetail }) {
  return (
    <InfoRows
      rows={[
        ["区间", `${r.params.start} ~ ${r.params.end}`],
        ["初始资金", money(r.params.capital)],
        ["样本外", r.params.oosMonths ? `最后 ${r.params.oosMonths} 个月` : "不分"],
        [
          "策略",
          r.versionN ? `v${r.versionN}${r.card ? `（${short(r.card.spec.specHash)}）` : ""}` : NA,
        ],
        [
          "数据截至",
          r.dataAsOf ? `${r.dataAsOf}${r.dataVersion ? `（#${r.dataVersion}）` : ""}` : NA,
        ],
        ["引擎", r.engineVersion ?? NA],
        ["成交假设", r.exec ? describeExec(r.exec) : NA],
        [
          "输入指纹",
          r.inputHash ? (
            <span className="inline-flex items-center gap-1">
              <span className="font-mono">{short(r.inputHash)}</span>
              <CopyButton text={r.inputHash} className="-my-1" />
            </span>
          ) : (
            NA
          ),
        ],
        ["运行卡", <span className="font-mono">{short(r.cardHash)}</span>],
      ]}
    />
  );
}

/** 原运行上的复核结果徽标 */
function VerifyBadge({ v, paused }: { v: RunVerify | null; paused: string | null }) {
  const st = verifyBadgeState(v);
  if (!st) return null;
  switch (st.kind) {
    case "queued":
      return paused ? (
        <span className="inline-flex items-center gap-1">
          <Badge>排队中</Badge>
          <Info label="排队中">{paused}</Info>
        </span>
      ) : (
        <Badge>排队中</Badge>
      );
    case "running":
      return <Badge tone="accent">复核中</Badge>;
    case "failed":
      return (
        <span className="inline-flex items-center gap-1">
          <Badge tone="warn">复核失败</Badge>
          {st.error && <Info label="复核失败">{st.error}</Info>}
        </span>
      );
    case "full":
      return (
        <span className="inline-flex items-center gap-1.5">
          {st.same ? <Badge>逐笔一致</Badge> : <Badge tone="warn">结果不同：{st.reason}</Badge>}
          {st.reproRunId && <TextLink to={`/runs/${st.reproRunId}`}>查看重跑</TextLink>}
        </span>
      );
    case "unrecorded":
      return (
        <span className="inline-flex items-center gap-1">
          <Badge>早于指纹记录</Badge>
          <Info label="早于指纹记录">这次回测早于指纹记录，没法只比输入，可以完整重跑。</Info>
        </span>
      );
    case "hashVersion":
      return <Badge>指纹口径升级过</Badge>;
    case "input":
      return st.same ? <Badge>输入一致</Badge> : <Badge tone="warn">数据已修订</Badge>;
  }
}

/** 重跑页：和原回测比的结论 */
function ReproCallout({ r }: { r: RunDetail }) {
  const v = reproVerdict(r);
  const orig = r.params.reproOf ? (
    <TextLink to={`/runs/${r.params.reproOf}`}>原回测</TextLink>
  ) : undefined;
  if (!v)
    return (
      <Callout tone="neutral" action={orig}>
        {runPollInterval(r) === false
          ? "没拿到比对结果，可以回原回测再完整重跑一次"
          : "正在和原回测比对"}
      </Callout>
    );
  if (v.status === "failed")
    return (
      <Callout tone="warn" title="没比对成" action={orig}>
        {v.error ?? "比对出错了"}
      </Callout>
    );
  return (
    <div className="space-y-2">
      {v.sameResult ? (
        <Callout tone="info" title="逐笔一致" action={orig}>
          和原回测相比，成交、净值与指标完全相同。
        </Callout>
      ) : (
        <Callout tone="warn" title="结果不同" action={orig}>
          {reproReason(v)}
        </Callout>
      )}
      {v.reportSame === false && (
        <Callout tone="neutral">提示项有变化（例如数据提示或试错次数）</Callout>
      )}
    </div>
  );
}

const REASON: Record<string, string> = {
  entry: "建仓",
  rebalance: "调出",
  filtered: "不再满足条件",
  take_profit: "止盈",
  stop_loss: "止损",
  max_hold: "到期",
  signal: "信号",
  delisted: "退市",
  exposure: "仓位控制",
};

function Trades({ runId }: { runId: string }) {
  const [page, setPage] = useState(0);
  const size = 50;
  const q = useQuery({
    queryKey: ["trades", runId, page],
    queryFn: () =>
      api.get<{ total: number; trades: Array<Trade & { seq: number; name: string | null }> }>(
        `/api/runs/${runId}/trades?limit=${size}&offset=${page * size}`,
      ),
    placeholderData: (prev) => prev,
  });
  if (!q.data)
    return (
      <div className="space-y-3 py-2">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </div>
    );
  const pages = Math.ceil(q.data.total / size);
  return (
    <div className={cx("transition-opacity", q.isFetching && "opacity-60")}>
      <DataTable minWidth={680}>
        <thead>
          <tr>
            <Th>日期</Th>
            <Th>股票</Th>
            <Th>方向</Th>
            <Th align="right">价格</Th>
            <Th align="right">金额</Th>
            <Th align="right">费用</Th>
            <Th align="right">盈亏</Th>
            <Th>原因</Th>
          </tr>
        </thead>
        <tbody>
          {q.data.trades.map((t) => (
            <tr key={t.seq} className="transition-colors hover:bg-surface-2/60">
              <Td className="font-mono text-[12px] text-ink-2">{t.date}</Td>
              <Td>
                <span className="text-ink">{t.name ?? t.code}</span>
                {t.name && (
                  <span className="ml-1.5 font-mono text-[11px] text-muted">{t.code}</span>
                )}
              </Td>
              <Td>
                <Badge tone={t.side === "buy" ? "up" : "down"}>
                  {t.side === "buy" ? "买" : "卖"}
                </Badge>
              </Td>
              <Td align="right">{num(t.price, 3)}</Td>
              <Td align="right">{money(t.amount)}</Td>
              <Td align="right" className="text-muted">
                {num(t.fee, 2)}
              </Td>
              <Td align="right" className={cx("font-medium", tone(t.pnl))}>
                {t.pnl === null || t.pnl === undefined ? "" : money(t.pnl)}
              </Td>
              <Td className="text-ink-2">
                {REASON[t.reason] ?? t.reason}
                {t.holdDays ? <span className="text-muted">，持有 {t.holdDays} 天</span> : ""}
              </Td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      {pages > 1 && (
        <div className="mt-3 flex items-center justify-end gap-2 text-xs text-muted">
          <span className="tabular mr-1">
            第 {page + 1} / {pages} 页，共 {q.data.total} 笔
          </span>
          <IconButton
            size="sm"
            icon={IconChevronLeft}
            label="上一页"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          />
          <IconButton
            size="sm"
            icon={IconChevronRight}
            label="下一页"
            disabled={page >= pages - 1}
            onClick={() => setPage(page + 1)}
          />
        </div>
      )}
    </div>
  );
}

function SweepChart({
  variants,
}: {
  variants: Array<{ label: string; excessCagr: number | null }>;
}) {
  const themeV = useThemeVersion();
  const option = useMemo(() => {
    void themeV;
    const t = readTokens();
    const ax = axisStyle(t);
    return {
      animation: false,
      grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
      tooltip: {
        trigger: "item",
        ...tooltipStyle(t),
        formatter: (p: { name: string; value: number }) =>
          tipHead(t, p.name) + `<b style="font-weight:600">${pct(p.value)}</b>`,
      },
      xAxis: {
        type: "category",
        data: variants.map((v) => v.label.split(" = ").pop()),
        ...ax,
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        ...ax,
        axisLine: { show: false },
        axisLabel: { ...ax.axisLabel, formatter: (v: number) => pct(v, 0, false) },
      },
      series: [
        {
          type: "bar",
          barMaxWidth: 28,
          data: variants.map((v) => ({
            value: v.excessCagr,
            name: v.label,
            itemStyle: {
              color: (v.excessCagr ?? 0) >= 0 ? t.up : t.neg,
              borderRadius: (v.excessCagr ?? 0) >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4],
            },
          })),
          label: {
            show: true,
            position: "top",
            color: t.ink2,
            fontSize: 11,
            fontWeight: 500,
            formatter: (p: { value: number }) => pct(p.value),
          },
        },
      ],
    };
  }, [variants, themeV]);
  return <EChart option={option} height={240} />;
}

function RunningCard({ r }: { r: RunDetail }) {
  const progress = Math.round((r.job?.progress ?? 0) * 100);
  return (
    <div className="space-y-5">
      <Card>
        <div className="py-2">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="ai-shimmer font-medium">
              {r.status === "queued"
                ? (computePausedNote(r) ?? "排队中…")
                : (r.job?.note ?? "回测中…")}
            </span>
            <span className="tabular text-xs text-muted">{progress}%</span>
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            className="mt-3 h-1 overflow-hidden rounded-full bg-surface-2"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-700 ease-out"
              style={{ width: `${Math.max(progress, 2)}%` }}
            />
          </div>
          <p className="mt-3 text-xs text-muted">
            在点时正确的历史数据上逐日重放；全市场、长区间的回测大约要半分钟。
          </p>
        </div>
      </Card>
      <div aria-hidden className="grid grid-cols-2 gap-3 opacity-60 @3xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-3 rounded-xl border border-line bg-surface p-4">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-7 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function RunPage() {
  const { id = "" } = useParams();
  const q = useRun(id);
  const chat = useChatUi();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const verify = useMutation({
    mutationFn: () => api.post<{ status: string }>(`/api/runs/${id}/verify`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["run", id] });
      void qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
  const reproduce = useMutation({
    mutationFn: () => api.post<{ runId: string }>(`/api/runs/${id}/reproduce`),
    onSuccess: (x) => {
      void qc.invalidateQueries({ queryKey: ["me"] });
      navigate(`/runs/${x.runId}`);
    },
  });
  const r = q.data;
  usePageTitle(r ? `${r.strategyName ?? "回测"} 回测报告` : "回测报告");
  useEffect(() => {
    if (r)
      chat.setPage({
        runId: r.id,
        strategyId: r.strategyId,
        versionId: r.versionId,
        label: `回测 ${r.params.start} ~ ${r.params.end}`,
      });
  }, [r?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (q.isLoading) return <PageSkeleton />;
  if (!r) return <ErrorNote error={q.error} />;
  const m = r.metrics;
  const verifiable = r.status === "done" && (r.kind === "backtest" || r.kind === "sweep_child");
  // 复核与完整重跑都写原运行的 verify，一个没结束时不让点另一个
  const verifying = verifyInFlight(r.verify);
  // 旧口径的回测，而这个市场已经有更新的口径（R2 起）：给一个按新口径重跑的入口
  const legacyExec =
    r.kind === "backtest" &&
    !!r.market &&
    !!r.exec &&
    isLegacyExec(r.exec) &&
    !isLegacyExec(defaultExec(r.market));

  const header = (
    <PageHeader
      back={{ to: `/strategies/${r.strategyId}`, label: r.strategyName ?? "策略" }}
      title={r.kind === "sweep" ? "参数扫描" : "回测报告"}
      badges={
        <>
          {r.versionN ? <Tag mono>v{r.versionN}</Tag> : null}
          {r.kind === "sweep" && <Tag>{r.label}</Tag>}
          {r.kind === "reproduce" && <Tag>复现</Tag>}
        </>
      }
      meta={
        <>
          <span className="font-mono text-[12px]">
            {r.params.start} ~ {r.params.end}
          </span>
          <span className="inline-flex items-center gap-1">
            复现信息
            <Info label="复现信息" width={320}>
              <ReproRows r={r} />
              <p className="mt-2">
                收盘后决策、次日开盘成交；涨停买不进、跌停卖不出、停牌顺延；持仓含分红再投入；费用按日期生效的费率表。
              </p>
            </Info>
          </span>
          {r.kind !== "reproduce" && <VerifyBadge v={r.verify} paused={computePausedNote(r)} />}
          {r.cardHash && (
            <TextLink
              href={`/api/runs/${r.id}/card`}
              download={`ivan-run-${r.id}.json`}
              icon={IconDownload}
            >
              下载运行卡
            </TextLink>
          )}
        </>
      }
      actions={
        r.status === "done" &&
        r.kind !== "sweep" && (
          <>
            {verifiable && (
              <>
                <Button
                  variant="ghost"
                  icon={IconVerify}
                  loading={verify.isPending}
                  disabled={verifying}
                  onClick={() => verify.mutate()}
                >
                  {r.verify?.status === "queued"
                    ? "排队中"
                    : r.verify?.status === "running"
                      ? "复核中"
                      : "复核数据"}
                </Button>
                <Button
                  variant="ghost"
                  icon={IconReproduce}
                  loading={reproduce.isPending}
                  disabled={verifying}
                  onClick={() => reproduce.mutate()}
                >
                  完整重跑
                </Button>
              </>
            )}
            {legacyExec && (
              <Button
                variant="ghost"
                icon={IconRun}
                onClick={() =>
                  navigate(`/strategies/${r.strategyId}?backtest=${r.id}&exec=default`)
                }
              >
                按新口径重新回测
              </Button>
            )}
            <Button
              variant="ai"
              icon={IconAI}
              onClick={() =>
                chat.ask("帮我解读一下这次回测：表现怎么样，最值得注意的是什么？", { runId: r.id })
              }
            >
              让 AI 解读
            </Button>
          </>
        )
      }
    />
  );
  const actionError = (verify.error ?? reproduce.error) && (
    <ErrorNote error={verify.error ?? reproduce.error} />
  );

  if (r.status === "queued" || r.status === "running") {
    return (
      <div className="space-y-6">
        {header}
        <RunningCard r={r} />
      </div>
    );
  }
  if (r.status === "failed") {
    return (
      <div className="space-y-6">
        {header}
        <Callout
          tone="warn"
          title="回测失败"
          action={
            <Link to={`/strategies/${r.strategyId}`} className="text-xs font-medium text-accent">
              回到策略
            </Link>
          }
        >
          <span className="whitespace-pre-wrap">{r.error}</span>
        </Callout>
      </div>
    );
  }

  if (r.kind === "sweep") {
    const variants = r.final?.variants ?? [];
    return (
      <div className="space-y-6">
        {header}
        <Checks checks={r.checks} compact />
        <Card
          title="各取值的年化超额"
          icon={IconSweep}
          info="同一个策略只改这一个参数，各回测一次。相邻取值之间结果跳得厉害，说明策略对参数敏感（参数脆弱），历史上的好成绩可能是凑出来的。"
        >
          <SweepChart variants={variants} />
          <DataTable className="mt-4">
            <thead>
              <tr>
                <Th>取值</Th>
                <Th align="right">年化超额</Th>
                <Th align="right">最大回撤</Th>
                <Th align="right">夏普</Th>
              </tr>
            </thead>
            <tbody>
              {r.children.map((c) => (
                <tr key={c.id} className="transition-colors hover:bg-surface-2/60">
                  <Td>
                    <Link
                      to={`/runs/${c.id}`}
                      className="text-ink transition-colors hover:text-accent"
                    >
                      {c.label}
                    </Link>
                  </Td>
                  <Td align="right" className={cx("font-medium", tone(c.headline?.excessCagr))}>
                    {pct(c.headline?.excessCagr)}
                  </Td>
                  <Td align="right" className="text-ink-2">
                    {pct(c.headline?.maxDrawdown, 1, false)}
                  </Td>
                  <Td align="right" className="text-ink-2">
                    {c.headline?.sharpe.toFixed(2) ?? NA}
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </Card>
      </div>
    );
  }
  if (!m) return <ErrorNote error={new Error("结果缺失")} />;
  return (
    <div className="space-y-6">
      {header}
      {actionError}
      {r.kind === "reproduce" && <ReproCallout r={r} />}
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <Stat
          label="年化收益"
          value={pct(m.cagr)}
          valueClass={tone(m.cagr)}
          note={`基准 ${pct(m.benchCagr)}`}
          info="含分红再投入、扣除交易费用后的年化收益；基准也是含分红口径（选了价格指数时会单独提示）。"
        />
        <Stat
          label="年化超额"
          value={pct(m.excessCagr)}
          valueClass={tone(m.excessCagr)}
          note={`累计 ${pct(m.excessTotal)}`}
          info="策略相对基准每年多赚（或少赚）多少。这是判断策略有没有用的主要数字。"
        />
        <Stat
          label="最大回撤"
          value={pct(m.maxDrawdown, 1, false)}
          note={m.drawdownPeak ? `${m.drawdownPeak.slice(0, 7)} 起` : undefined}
          info={
            m.drawdownPeak
              ? `从 ${m.drawdownPeak} 的高点跌到 ${m.drawdownTrough} 的低点${m.drawdownRecovery ? `，${m.drawdownRecovery} 才回到前高` : "，到区间结束还没回到前高"}。想想这段时间你拿不拿得住。`
              : "区间内最大的一次从高点到低点的跌幅。"
          }
        />
        <Stat
          label="夏普"
          value={m.sharpe.toFixed(2)}
          note={m.sharpe >= 1 ? "1 以上算不错" : "低于 1，波动换来的收益偏少"}
          info="年化收益 ÷ 年化波动（无风险利率按 0 算），衡量每承担一份波动换来多少收益；一般 1 以上算不错。"
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {r.checks.length ? (
          <Checks checks={r.checks} compact />
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs text-ink-2">
            <IconChecks size={15} className="text-down" />
            诚实检查没有发现需要注意的问题
            <Info>
              引擎按固定阈值检查：样本外是否明显变差、收益是否集中在少数股票或行业、交易是否太少、是否调参调太多次、费用是否吃掉太多收益。
            </Info>
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted">
          更多指标
          <Info label="更多指标" width={300}>
            <InfoRows
              rows={[
                ["总收益", pct(m.totalReturn)],
                ["胜率（卖出盈利的比例）", m.winRate === null ? NA : pct(m.winRate, 0, false)],
                ["平均持有", m.avgHoldDays ? `${m.avgHoldDays.toFixed(0)} 天` : NA],
                ["买入笔数", String(m.buys)],
                ["年化换手", `${m.turnover.toFixed(1)} 倍`],
                ["费用拖累", `${pct(m.costDrag, 2, false)}/年`],
                ["年化波动", pct(m.volatility, 1, false)],
                ...(m.avgExposure !== undefined
                  ? ([["平均股票仓位", pct(m.avgExposure, 0, false)]] as Array<[string, string]>)
                  : []),
                ...(r.segments?.outOfSample
                  ? ([
                      ["样本内年化超额", pct(r.segments.inSample.excessCagr)],
                      ["样本外年化超额", pct(r.segments.outOfSample.excessCagr)],
                    ] as Array<[string, string]>)
                  : []),
              ]}
            />
          </Info>
        </span>
      </div>
      <Card
        title="净值走势"
        icon={IconChart}
        info="蓝线是策略（含分红再投入），灰线是基准。可以切到「超额」「回撤」视图；在图上拖动框选一段，可以问 AI 这段为什么是这样。"
      >
        <NavChart
          points={r.series}
          height={320}
          onAsk={(range) =>
            chat.ask(`为什么 ${range.from} 到 ${range.to} 这段是这样的表现？`, {
              runId: r.id,
              range,
              label: `回测 · ${range.from} ~ ${range.to}`,
            })
          }
        />
      </Card>
      <Details run={r} />
    </div>
  );
}

type DetailTab = "monthly" | "stocks" | "industry" | "positions" | "trades" | "segments";

/** 细节分页：一次只看一块，不用往下翻一长页 */
function Details({ run: r }: { run: RunDetail }) {
  const [tab, setTab] = useState<DetailTab>("monthly");
  const m = r.metrics!;
  const best = r.attribution?.byStock.slice(0, 8) ?? [];
  const worst = (r.attribution?.byStock ?? [])
    .filter((s) => s.pnl < 0)
    .slice(-8)
    .reverse();
  const items: Array<{ value: DetailTab; label: string }> = [
    { value: "monthly", label: "月度收益" },
    { value: "stocks", label: "个股盈亏" },
    { value: "industry", label: "行业" },
    { value: "positions", label: "期末持仓" },
    { value: "trades", label: "交易明细" },
  ];
  if (r.segments?.outOfSample) items.push({ value: "segments", label: "样本内外" });
  return (
    <section className="rounded-xl border border-line bg-surface shadow-[var(--edge)]">
      <Tabs value={tab} onChange={setTab} items={items} className="px-2" />
      <div key={tab} className="animate-enter px-4 pt-4 pb-5">
        {tab === "monthly" && <MonthlyTable monthly={m.monthly} yearly={m.yearly} />}
        {tab === "stocks" && (
          <div className="grid gap-6 @3xl:grid-cols-2">
            <div>
              <h3 className="mb-3 text-xs font-medium text-ink-2">赚得最多</h3>
              <PnlBars
                rows={best.map((s) => ({ label: s.name, sub: s.code, value: s.pnl }))}
                format={money}
              />
            </div>
            <div>
              <h3 className="mb-3 text-xs font-medium text-ink-2">亏得最多</h3>
              {worst.length > 0 ? (
                <PnlBars
                  rows={worst.map((s) => ({ label: s.name, sub: s.code, value: s.pnl }))}
                  format={money}
                />
              ) : (
                <p className="text-xs text-muted">没有亏钱的股票。</p>
              )}
            </div>
            <p className="text-2xs text-muted @3xl:col-span-2">
              按股票汇总的盈亏（已平仓 + 期末浮动）。
            </p>
          </div>
        )}
        {tab === "industry" && (
          <PnlBars
            rows={(r.attribution?.byIndustry ?? []).slice(0, 12).map((x) => ({
              label: x.industry,
              sub: `仓位 ${pct(x.avgWeight, 0, false)}`,
              value: x.pnl,
            }))}
            format={money}
          />
        )}
        {tab === "positions" &&
          (r.final ? (
            <div>
              <p className="mb-3 text-xs text-muted">
                <span className="font-mono">{r.final.date}</span> 收盘，总资产{" "}
                <span className="tabular font-medium text-ink-2">{money(r.final.equity)}</span>
                ，现金 <span className="tabular font-medium text-ink-2">{money(r.final.cash)}</span>
              </p>
              {r.final.positions.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {r.final.positions.map((p) => (
                    <span
                      key={p.code}
                      className="inline-flex h-7 items-center gap-2 rounded-lg px-2.5 text-xs ring-1 ring-line ring-inset"
                    >
                      <span className="text-ink">{p.name}</span>
                      <span className="tabular text-muted">{pct(p.weight, 0, false)}</span>
                      <span className={cx("tabular font-medium", tone(p.ret))}>
                        {pct(p.ret, 0)}
                      </span>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted">期末空仓。</p>
              )}
            </div>
          ) : (
            <Empty title="没有期末持仓数据" className="border-0" />
          ))}
        {tab === "trades" && <Trades runId={r.id} />}
        {tab === "segments" && r.segments && (
          <div>
            <p className="mb-2 text-xs text-muted">
              样本外 = 区间最后几个月单独算，用来看策略是不是只拟合了历史。
            </p>
            <DataTable>
              <thead>
                <tr>
                  <Th>区间</Th>
                  <Th align="right">年化</Th>
                  <Th align="right">年化超额</Th>
                  <Th align="right">最大回撤</Th>
                  <Th align="right">夏普</Th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["样本内", r.segments.inSample],
                    ["样本外", r.segments.outOfSample],
                  ] as const
                ).map(([label, seg]) =>
                  seg ? (
                    <tr key={label}>
                      <Td>
                        <span className="text-ink">{label}</span>
                        <span className="ml-2 font-mono text-[11px] text-muted">
                          {seg.start} ~ {seg.end}
                        </span>
                      </Td>
                      <Td align="right" className={tone(seg.cagr)}>
                        {pct(seg.cagr)}
                      </Td>
                      <Td align="right" className={cx("font-medium", tone(seg.excessCagr))}>
                        {pct(seg.excessCagr)}
                      </Td>
                      <Td align="right" className="text-ink-2">
                        {pct(seg.maxDrawdown, 1, false)}
                      </Td>
                      <Td align="right" className="text-ink-2">
                        {seg.sharpe.toFixed(2)}
                      </Td>
                    </tr>
                  ) : null,
                )}
              </tbody>
            </DataTable>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * 回测报告（spec §11、D40）：先回答「好不好、要注意什么」——4 个核心指标、诚实检查、净值图；
 * 月度收益、个股与行业归因、期末持仓、交易明细、样本内外收进下方分页，次要指标与回测设置收进 ⓘ。
 * 参数扫描显示各取值的结果与「参数脆弱」检查。
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { useChatUi } from "../chat/chat-context.tsx";
import {
  EChart,
  esc,
  readTokens,
  tooltipStyle,
  useThemeVersion,
  axisStyle,
} from "../components/charts/echart.tsx";
import { NavChart } from "../components/charts/nav-chart.tsx";
import { MonthlyTable, PnlBars } from "../components/charts/small.tsx";
import {
  Badge,
  Button,
  Card,
  Checks,
  ErrorNote,
  Info,
  InfoRows,
  Spinner,
  Stat,
  Tabs,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { money, num, pct, tone } from "../lib/format.ts";
import type { RunDetail, Trade } from "../lib/types.ts";

function useRun(id: string) {
  return useQuery({
    queryKey: ["run", id],
    queryFn: () => api.get<RunDetail>(`/api/runs/${id}`),
    refetchInterval: (q) =>
      q.state.data && (q.state.data.status === "done" || q.state.data.status === "failed")
        ? false
        : 1500,
  });
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
  });
  if (!q.data) return <Spinner />;
  const pages = Math.ceil(q.data.total / size);
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="tabular w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="py-2 font-normal">日期</th>
              <th className="py-2 font-normal">股票</th>
              <th className="py-2 font-normal">方向</th>
              <th className="py-2 text-right font-normal">价格</th>
              <th className="py-2 text-right font-normal">金额</th>
              <th className="py-2 text-right font-normal">费用</th>
              <th className="py-2 text-right font-normal">盈亏</th>
              <th className="py-2 pl-3 font-normal">原因</th>
            </tr>
          </thead>
          <tbody>
            {q.data.trades.map((t) => (
              <tr key={t.seq} className="border-b border-line last:border-0">
                <td className="py-1.5 text-ink-2">{t.date}</td>
                <td className="py-1.5">
                  {t.name ?? t.code}
                  {t.name && <span className="ml-1 text-xs text-muted">{t.code}</span>}
                </td>
                <td className={`py-1.5 ${t.side === "buy" ? "text-up" : "text-down"}`}>
                  {t.side === "buy" ? "买" : "卖"}
                </td>
                <td className="py-1.5 text-right">{num(t.price, 3)}</td>
                <td className="py-1.5 text-right">{money(t.amount)}</td>
                <td className="py-1.5 text-right text-ink-2">{num(t.fee, 2)}</td>
                <td className={`py-1.5 text-right ${tone(t.pnl)}`}>
                  {t.pnl === null || t.pnl === undefined ? "" : money(t.pnl)}
                </td>
                <td className="py-1.5 pl-3 text-ink-2">
                  {REASON[t.reason] ?? t.reason}
                  {t.holdDays ? ` · 持有 ${t.holdDays} 天` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted">
          <Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
            上一页
          </Button>
          第 {page + 1}/{pages} 页，共 {q.data.total} 笔
          <Button size="sm" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
            下一页
          </Button>
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
      grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
      tooltip: {
        trigger: "item",
        ...tooltipStyle(t),
        formatter: (p: { name: string; value: number }) =>
          `<b>${esc(pct(p.value))}</b> <span style="color:${t.ink2}">${esc(p.name)}</span>`,
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
          barMaxWidth: 24,
          data: variants.map((v) => ({
            value: v.excessCagr,
            name: v.label,
            itemStyle: {
              color: (v.excessCagr ?? 0) >= 0 ? t.up : t.s1,
              borderRadius: (v.excessCagr ?? 0) >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4],
            },
          })),
          label: {
            show: true,
            position: "top",
            color: t.ink2,
            fontSize: 11,
            formatter: (p: { value: number }) => pct(p.value),
          },
        },
      ],
    };
  }, [variants, themeV]);
  return <EChart option={option} height={240} />;
}

export function RunPage() {
  const { id = "" } = useParams();
  const q = useRun(id);
  const chat = useChatUi();
  const r = q.data;
  useEffect(() => {
    if (r)
      chat.setPage({
        runId: r.id,
        strategyId: r.strategyId,
        versionId: r.versionId,
        label: `回测 ${r.params.start} ~ ${r.params.end}`,
      });
  }, [r?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (q.isLoading) return <Spinner />;
  if (!r) return <ErrorNote error={q.error} />;
  const m = r.metrics;

  const header = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <h1 className="text-lg font-semibold">
        <Link to={`/strategies/${r.strategyId}`} className="hover:text-accent">
          {r.strategyName ?? "回测报告"}
        </Link>
      </h1>
      {r.versionN ? <Badge tone="accent">v{r.versionN}</Badge> : null}
      <span className="text-sm text-ink-2">
        {r.kind === "sweep" ? `参数扫描：${r.label}` : `${r.params.start} ~ ${r.params.end}`}
      </span>
      <Info label="回测设置">
        <InfoRows
          rows={[
            ["区间", `${r.params.start} ~ ${r.params.end}`],
            ["初始资金", money(r.params.capital)],
            ["样本外", r.params.oosMonths ? `最后 ${r.params.oosMonths} 个月` : "不分"],
            ["数据截至", r.dataAsOf ?? "—"],
            ["引擎版本", r.engineVersion ?? "—"],
          ]}
        />
        <p className="mt-1.5">
          收盘后决策、次日开盘成交；涨停买不进、跌停卖不出、停牌顺延；持仓含分红再投入；费用按日期生效的费率表。
        </p>
      </Info>
      {r.status === "done" && r.kind !== "sweep" && (
        <Button
          size="sm"
          className="ml-auto"
          onClick={() =>
            chat.ask("帮我解读一下这次回测：表现怎么样，最值得注意的是什么？", { runId: r.id })
          }
        >
          让 AI 解读
        </Button>
      )}
    </div>
  );

  if (r.status === "queued" || r.status === "running") {
    return (
      <div className="space-y-4">
        {header}
        <Card>
          <div className="py-6 text-center">
            <div className="mx-auto h-1.5 w-64 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${Math.round((r.job?.progress ?? 0) * 100)}%` }}
              />
            </div>
            <p className="mt-3 text-sm text-ink-2">
              {r.status === "queued" ? "排队中…" : (r.job?.note ?? "回测中…")}
            </p>
          </div>
        </Card>
      </div>
    );
  }
  if (r.status === "failed") {
    return (
      <div className="space-y-4">
        {header}
        <ErrorNote error={new Error(`回测失败：${r.error}`)} />
      </div>
    );
  }

  if (r.kind === "sweep") {
    const variants = r.final?.variants ?? [];
    return (
      <div className="space-y-4">
        {header}
        <Checks checks={r.checks} compact />
        <Card
          title="各取值的年化超额"
          info="同一个策略只改这一个参数，各回测一次。相邻取值之间结果跳得厉害，说明策略对参数敏感（参数脆弱），历史上的好成绩可能是凑出来的。"
        >
          <SweepChart variants={variants} />
          <table className="tabular mt-3 w-full text-sm">
            <tbody>
              {r.children.map((c) => (
                <tr key={c.id} className="border-b border-line last:border-0">
                  <td className="py-1.5">
                    <Link to={`/runs/${c.id}`} className="hover:text-accent">
                      {c.label}
                    </Link>
                  </td>
                  <td className={`py-1.5 text-right ${tone(c.headline?.excessCagr)}`}>
                    超额 {pct(c.headline?.excessCagr)}
                  </td>
                  <td className="py-1.5 text-right text-ink-2">
                    回撤 {pct(c.headline?.maxDrawdown, 1, false)}
                  </td>
                  <td className="py-1.5 text-right text-ink-2">
                    夏普 {c.headline?.sharpe.toFixed(2) ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    );
  }
  if (!m) return <ErrorNote error={new Error("结果缺失")} />;
  return (
    <div className="space-y-4">
      {header}
      <div className="grid grid-cols-2 gap-2 @3xl:grid-cols-4">
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
          info="年化收益 ÷ 年化波动（无风险利率按 0 算），衡量每承担一份波动换来多少收益；一般 1 以上算不错。"
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {r.checks.length ? (
          <Checks checks={r.checks} compact />
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-ink-2">
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
                ["胜率（卖出盈利的比例）", m.winRate === null ? "—" : pct(m.winRate, 0, false)],
                ["平均持有", m.avgHoldDays ? `${m.avgHoldDays.toFixed(0)} 天` : "—"],
                ["买入笔数", String(m.buys)],
                ["年化换手", `${m.turnover.toFixed(1)} 倍`],
                ["费用拖累", `${pct(m.costDrag, 2, false)}/年`],
                ["年化波动", pct(m.volatility, 1, false)],
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
        info="蓝线是策略（含分红再投入），灰线是基准。可以切到「超额」「回撤」视图；在图上拖动框选一段，可以问 AI 这段为什么是这样。"
      >
        <NavChart
          points={r.series}
          height={300}
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
    <Card>
      <div className="-mx-4 -mt-2 mb-3 overflow-x-auto px-2">
        <Tabs value={tab} onChange={setTab} items={items} />
      </div>
      {tab === "monthly" && <MonthlyTable monthly={m.monthly} yearly={m.yearly} />}
      {tab === "stocks" && (
        <div className="space-y-4">
          <p className="text-xs text-muted">按股票汇总的盈亏（已平仓 + 期末浮动）。</p>
          <PnlBars
            rows={best.map((s) => ({ label: s.name, sub: s.code, value: s.pnl }))}
            format={money}
          />
          {worst.length > 0 && (
            <PnlBars
              rows={worst.map((s) => ({ label: s.name, sub: s.code, value: s.pnl }))}
              format={money}
            />
          )}
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
            <p className="mb-2 text-xs text-muted">
              {r.final.date} 收盘 · 总资产 {money(r.final.equity)} · 现金 {money(r.final.cash)}
            </p>
            {r.final.positions.length ? (
              <div className="flex flex-wrap gap-1.5">
                {r.final.positions.map((p) => (
                  <Badge key={p.code} tone={p.ret >= 0 ? "up" : "down"}>
                    {p.name} {pct(p.weight, 0, false)} · {pct(p.ret, 0)}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted">空仓</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted">没有期末持仓数据。</p>
        ))}
      {tab === "trades" && <Trades runId={r.id} />}
      {tab === "segments" && r.segments && (
        <div>
          <p className="mb-2 text-xs text-muted">
            样本外 = 区间最后几个月单独算，用来看策略是不是只拟合了历史。
          </p>
          <table className="tabular w-full text-sm">
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th className="py-2 text-left font-normal">区间</th>
                <th className="py-2 text-right font-normal">年化</th>
                <th className="py-2 text-right font-normal">年化超额</th>
                <th className="py-2 text-right font-normal">最大回撤</th>
                <th className="py-2 text-right font-normal">夏普</th>
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
                  <tr key={label} className="border-b border-line last:border-0">
                    <td className="py-1.5">
                      {label}
                      <span className="ml-2 text-xs text-muted">
                        {seg.start} ~ {seg.end}
                      </span>
                    </td>
                    <td className={`py-1.5 text-right ${tone(seg.cagr)}`}>{pct(seg.cagr)}</td>
                    <td className={`py-1.5 text-right ${tone(seg.excessCagr)}`}>
                      {pct(seg.excessCagr)}
                    </td>
                    <td className="py-1.5 text-right text-ink-2">
                      {pct(seg.maxDrawdown, 1, false)}
                    </td>
                    <td className="py-1.5 text-right text-ink-2">{seg.sharpe.toFixed(2)}</td>
                  </tr>
                ) : null,
              )}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

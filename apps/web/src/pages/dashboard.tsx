/**
 * 首页看板（spec §11、D40、D44）：和右侧常驻对话一起组成首页。只回答「现在怎么样、明天做什么」：
 * 简报 · 我的跟踪（一个数 + 走势 + 一句人话）· 多策略对照图（可选一个或几个看细节）· 明日计划 · 最近回测。
 * 口径说明、回测成绩这类次要信息收进 ⓘ。全部从库里确定性渲染，只有简报那段是 LLM 写的。
 */
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, ChevronRight, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useChatUi } from "../chat/chat-context.tsx";
import { MAX_LINES, MultiNavChart, SLOT_VARS } from "../components/charts/multi-nav-chart.tsx";
import { Sparkline } from "../components/charts/small.tsx";
import { useMe } from "../components/layout.tsx";
import {
  Badge,
  Button,
  Card,
  CheckBadges,
  cx,
  Empty,
  ErrorNote,
  Info,
  InfoRows,
  Spinner,
  useMediaQuery,
  WIDE_QUERY,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { DEVIATION_INFO, deviationText, MARKET_TEXT, pct, tone } from "../lib/format.ts";
import type { StrategyLine } from "../lib/multi-series.ts";
import type { Dashboard, DataStatus, PresetView, RunSummary, TrackingChart } from "../lib/types.ts";

/** 只在出问题时出现：worker 没跑、某个市场最近一次更新失败 */
export function DataBanner({ data }: { data: DataStatus }) {
  const isAdmin = useMe().data?.user.role === "admin";
  if (!data.workerUp) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn">
        <AlertTriangle className="size-4" />
        行情服务（worker）没有运行：回测、选股、跟踪结算都会暂停。
      </div>
    );
  }
  const failed = data.markets.filter((m) => m.lastEtl?.status === "failed");
  if (!failed.length) return null;
  return (
    <div className="space-y-2">
      {failed.map((m) => (
        <div
          key={m.market}
          className="flex items-start gap-2 rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <b className="font-medium">
              {MARKET_TEXT[m.market]}数据停在 {m.asOf ?? "—"}
            </b>
            ：最近一次更新失败，这个市场的跟踪没有结算，简报里的数字也还是旧的。
            {isAdmin && (
              <Link to="/admin" className="ml-1 underline underline-offset-2">
                去管理页重跑
              </Link>
            )}
          </div>
          <Info label="失败原因">{m.lastEtl?.error ?? "未知"}</Info>
        </div>
      ))}
    </div>
  );
}

/** 「数据截至」：两个市场同一天就只写一次 */
function asOfText(data: DataStatus): string {
  const ds = data.markets.filter((m) => m.asOf);
  if (!ds.length) return "";
  const same = ds.every((m) => m.asOf === ds[0]!.asOf);
  return same
    ? `数据截至 ${ds[0]!.asOf}`
    : `数据截至 ${ds.map((m) => `${MARKET_TEXT[m.market]} ${m.asOf}`).join(" · ")}`;
}

export function PresetGallery({ presets }: { presets: PresetView[] }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: (presetId: string) =>
      api.post<{ strategyId: string; versionId: string }>("/api/strategies/from-preset", {
        presetId,
      }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["strategies"] });
      const run = await api.post<{ runId: string }>("/api/runs", { versionId: r.versionId });
      navigate(`/runs/${run.runId}`);
    },
  });
  return (
    <div>
      <div className="grid gap-3 @lg:grid-cols-2 @5xl:grid-cols-4">
        {presets.map((p) => (
          <div key={p.id} className="flex flex-col rounded-xl border border-line bg-surface p-3.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">{p.title}</span>
              <Badge>{MARKET_TEXT[p.market]}</Badge>
              <Info label="具体规则">
                <ul className="space-y-0.5">
                  {p.describe.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </Info>
            </div>
            <p className="mt-1 flex-1 text-xs text-ink-2">{p.blurb}</p>
            <Button
              className="mt-3"
              size="sm"
              loading={create.isPending && create.variables === p.id}
              onClick={() => create.mutate(p.id)}
            >
              用它建策略并回测
            </Button>
          </div>
        ))}
      </div>
      <ErrorNote error={create.error} />
    </div>
  );
}

type TrackingRow = Dashboard["trackings"][number];

/** 选择：null = 全部；点一个 = 只看它；再点别的 = 加进来；点掉最后一个 = 回到全部 */
type Selection = string[] | null;

function toggle(sel: Selection, id: string): Selection {
  if (sel === null) return [id];
  if (sel.includes(id)) {
    const next = sel.filter((x) => x !== id);
    return next.length ? next : null;
  }
  return [...sel, id];
}

/** 策略的颜色圆点：列表、选择按钮、图里的线是同一个颜色 */
function Dot({ slot }: { slot: number | undefined }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2.5 shrink-0 rounded-full"
      style={{ background: slot === undefined ? "var(--muted)" : SLOT_VARS[slot] }}
    />
  );
}

function TrackingsCard({
  trackings,
  slots,
  selection,
  onToggle,
}: {
  trackings: TrackingRow[];
  slots: Map<string, number>;
  selection: Selection;
  onToggle: (id: string) => void;
}) {
  return (
    <Card
      title="我的跟踪"
      info={
        <>
          上线后每个交易日收盘后，按规则从上线日起重放一遍模拟盘。
          <br />
          跟踪超额 = 模拟盘收益减去基准（含分红）收益。
          <br />
          {DEVIATION_INFO}
          <br />
          点一行只看它（再点别的可以一起对照）；点名字打开详情。
        </>
      }
    >
      {trackings.length ? (
        <ul className="-mx-2">
          {trackings.map((t) => {
            const slot = slots.get(t.id);
            const on = selection?.includes(t.id) ?? false;
            const dim = selection !== null && !on;
            return (
              <li key={t.id}>
                <div
                  role="button"
                  tabIndex={0}
                  aria-pressed={on}
                  onClick={() => slot !== undefined && onToggle(t.id)}
                  onKeyDown={(e) => e.key === "Enter" && slot !== undefined && onToggle(t.id)}
                  className={cx(
                    "flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-surface-2",
                    on && "bg-surface-2",
                    dim && "opacity-55",
                  )}
                >
                  <Dot slot={slot} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Link
                        to={`/trackings/${t.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="truncate text-sm font-medium hover:text-accent"
                      >
                        {t.strategyName}
                      </Link>
                      <Badge>{MARKET_TEXT[t.market]}</Badge>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                      <span className="truncate">
                        {t.days ? `跟踪 ${t.days} 天` : `${t.startDate} 开始`} ·{" "}
                        {deviationText(t.deviationPct, t.days)}
                      </span>
                      <Info label="回测成绩">
                        <div className="mb-1 font-medium text-ink">上线前的回测成绩</div>
                        {t.baseline ? (
                          <InfoRows
                            rows={[
                              ["年化超额", pct(t.baseline.excessCagr)],
                              ["最大回撤", pct(t.baseline.maxDrawdown, 1, false)],
                              ["夏普", t.baseline.sharpe.toFixed(2)],
                            ]}
                          />
                        ) : (
                          <p>这个版本上线前没有回测。</p>
                        )}
                        <div className="mt-1.5 text-muted">上线日 {t.startDate}</div>
                      </Info>
                    </div>
                  </div>
                  <span className="hidden sm:block">
                    <Sparkline
                      values={t.spark}
                      color={slot === undefined ? "var(--muted)" : SLOT_VARS[slot]}
                    />
                  </span>
                  <div className="w-20 shrink-0 text-right">
                    <div className={cx("tabular text-lg font-semibold", tone(t.excess))}>
                      {t.days ? pct(t.excess) : "—"}
                    </div>
                    <div className="text-[11px] text-muted">跟踪超额</div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty title="还没有上线跟踪的策略">
          回测满意后让 AI「上线跟踪」，或者在策略页点「上线跟踪」。
        </Empty>
      )}
      {trackings.length > MAX_LINES && (
        <p className="mt-2 text-xs text-muted">
          对照图最多同时画 {MAX_LINES} 个策略，灰点的请点名字打开详情看。
        </p>
      )}
    </Card>
  );
}

/** 只选一个策略时：图下面给出它的几个关键数 */
function DetailStrip({ t }: { t: TrackingRow }) {
  const items: Array<[string, string, string]> = [
    [
      "跟踪收益",
      t.days && t.nav !== null ? pct(t.nav - 1) : "—",
      tone(t.nav !== null ? t.nav - 1 : null),
    ],
    ["跟踪超额", t.days ? pct(t.excess) : "—", tone(t.excess)],
    ["跑赢回测同期", t.deviationPct === null ? "—" : `${t.deviationPct.toFixed(0)}%`, ""],
    ["回测年化超额", pct(t.baseline?.excessCagr), tone(t.baseline?.excessCagr)],
  ];
  return (
    <div className="mt-3 flex flex-wrap items-end gap-x-6 gap-y-2 border-t border-line pt-3">
      {items.map(([label, value, cls]) => (
        <div key={label}>
          <div className="text-[11px] text-muted">{label}</div>
          <div className={cx("tabular text-sm font-semibold", cls)}>{value}</div>
        </div>
      ))}
      <Link
        to={`/trackings/${t.id}`}
        className="ml-auto inline-flex items-center text-xs text-accent"
      >
        打开跟踪详情 <ChevronRight className="size-3.5" />
      </Link>
    </div>
  );
}

/** 选了几个策略时：图下面并排比关键数 */
function CompareTable({ rows, slots }: { rows: TrackingRow[]; slots: Map<string, number> }) {
  return (
    <div className="mt-3 overflow-x-auto border-t border-line pt-2">
      <table className="tabular w-full min-w-[560px] text-sm">
        <thead>
          <tr className="text-left text-xs text-muted">
            <th className="py-1.5 font-normal">策略</th>
            <th className="py-1.5 text-right font-normal">跟踪天数</th>
            <th className="py-1.5 text-right font-normal">跟踪超额</th>
            <th className="py-1.5 text-right font-normal">跑赢回测同期</th>
            <th className="py-1.5 text-right font-normal">回测年化超额</th>
            <th className="py-1.5 text-right font-normal">回测最大回撤</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className="border-t border-line">
              <td className="py-1.5">
                <Link
                  to={`/trackings/${t.id}`}
                  className="inline-flex items-center gap-2 hover:text-accent"
                >
                  <Dot slot={slots.get(t.id)} />
                  {t.strategyName}
                </Link>
              </td>
              <td className="py-1.5 text-right text-ink-2">{t.days || "—"}</td>
              <td className={`py-1.5 text-right ${tone(t.excess)}`}>
                {t.days ? pct(t.excess) : "—"}
              </td>
              <td className="py-1.5 text-right text-ink-2">
                {t.deviationPct === null ? "—" : `${t.deviationPct.toFixed(0)}%`}
              </td>
              <td className={`py-1.5 text-right ${tone(t.baseline?.excessCagr)}`}>
                {pct(t.baseline?.excessCagr)}
              </td>
              <td className="py-1.5 text-right text-ink-2">
                {pct(t.baseline?.maxDrawdown, 1, false)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CompareCard({
  trackings,
  slots,
  selection,
  setSelection,
}: {
  trackings: TrackingRow[];
  slots: Map<string, number>;
  selection: Selection;
  setSelection: (s: Selection) => void;
}) {
  const chat = useChatUi();
  const charted = trackings.filter((t) => slots.has(t.id));
  // 能画的都先取回来，切换选择时不用再等
  const charts = useQueries({
    queries: charted.map((t) => ({
      queryKey: ["tracking-chart", t.id],
      queryFn: () => api.get<TrackingChart>(`/api/trackings/${t.id}/chart`),
    })),
  });
  const shown = charted.filter((t) => selection === null || selection.includes(t.id));
  const lines = useMemo<StrategyLine[]>(
    () =>
      shown.flatMap((t) => {
        const c = charts[charted.indexOf(t)]?.data;
        return c
          ? [
              {
                id: t.id,
                name: t.strategyName,
                slot: slots.get(t.id)!,
                benchLabel: c.benchLabel,
                startDate: c.startDate,
                backtest: c.backtest,
                tracking: c.tracking,
              },
            ]
          : [];
      }),
    // charts 每次渲染都是新数组，用各条的更新时间做依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shown.map((t) => t.id).join(), charts.map((c) => c.dataUpdatedAt).join(), slots],
  );
  const loading = charts.some((c) => c.isLoading);
  const single = shown.length === 1 ? shown[0]! : null;
  const chip = (active: boolean) =>
    cx(
      "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs",
      active ? "border-ink/30 bg-surface-2 text-ink" : "border-line text-ink-2 hover:text-ink",
    );
  return (
    <Card
      title="净值对照"
      info="每个策略一种颜色：淡色是上线前的回测，实色是上线后的模拟盘；灰线是基准（含分红），不同市场各一条。切到「超额」看每个策略相对自己基准的表现；「只看跟踪」从各自上线那天起算。在图上拖动可以框选一段，然后问 AI。"
      action={
        single ? (
          <Link
            to={`/trackings/${single.id}`}
            className="inline-flex items-center text-xs text-accent"
          >
            详情 <ChevronRight className="size-3.5" />
          </Link>
        ) : null
      }
    >
      {charted.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          <button className={chip(selection === null)} onClick={() => setSelection(null)}>
            全部
          </button>
          {charted.map((t) => (
            <button
              key={t.id}
              className={chip(selection?.includes(t.id) ?? false)}
              aria-pressed={selection?.includes(t.id) ?? false}
              onClick={() => setSelection(toggle(selection, t.id))}
            >
              <Dot slot={slots.get(t.id)} />
              {t.strategyName}
            </button>
          ))}
        </div>
      )}
      {loading && !lines.length ? (
        <Spinner />
      ) : (
        <MultiNavChart
          lines={lines}
          height={260}
          onAsk={(range) => {
            if (single) {
              chat.ask(
                `帮我看看「${single.strategyName}」${range.from} 到 ${range.to} 这段表现，为什么是这样？`,
                {
                  trackingId: single.id,
                  range,
                  label: `${single.strategyName} · ${range.from} ~ ${range.to}`,
                },
              );
            } else {
              const names = shown.map((t) => `「${t.strategyName}」`).join("");
              chat.ask(
                `对比一下${names}在 ${range.from} 到 ${range.to} 这段的表现，差别主要来自哪里？`,
                {
                  range,
                  label: `${shown.length} 个策略 · ${range.from} ~ ${range.to}`,
                },
              );
            }
          }}
        />
      )}
      {single && <DetailStrip t={single} />}
      {selection !== null && shown.length > 1 && <CompareTable rows={shown} slots={slots} />}
    </Card>
  );
}

function PlanCard({ signals }: { signals: Dashboard["signals"] }) {
  return (
    <Card title="明日计划" info="各跟踪下一个交易日开盘时的模拟买卖，按规则算出，不是投资建议。">
      {signals.length ? (
        <div className="space-y-3">
          {signals.map((s) => (
            <div key={s.trackingId}>
              <div className="mb-1 text-xs text-ink-2">
                {s.strategyName} · {s.orders[0]?.planDate}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {s.orders.map((o) => (
                  <Badge key={`${o.side}-${o.code}`} tone={o.side === "buy" ? "up" : "down"}>
                    {o.side === "buy" ? "买" : "卖"} {o.name ?? o.code}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">明天没有计划中的买卖。</p>
      )}
    </Card>
  );
}

function RunStatus({ r }: { r: RunSummary }) {
  if (r.status === "failed") return <Badge tone="warn">失败</Badge>;
  if (r.status !== "done") return <Badge tone="accent">进行中</Badge>;
  if (r.kind === "sweep") return <span className="text-xs text-muted">扫描完成</span>;
  if (!r.headline) return null;
  return (
    <>
      <span className={`tabular text-sm ${tone(r.headline.excessCagr)}`}>
        {pct(r.headline.excessCagr)}
      </span>
      <CheckBadges checks={r.checks} />
    </>
  );
}

function RecentRunsCard({ runs }: { runs: RunSummary[] }) {
  return (
    <Card
      title="最近回测"
      info="右边的数字是年化超额（相对基准）。"
      action={
        <Link to="/strategies" className="inline-flex items-center text-xs text-accent">
          全部策略 <ChevronRight className="size-3.5" />
        </Link>
      }
    >
      {runs.length ? (
        <ul className="divide-y divide-line">
          {runs.slice(0, 4).map((r) => (
            <li key={r.id} className="flex items-center gap-3 py-2">
              <Link to={`/runs/${r.id}`} className="min-w-0 flex-1 hover:text-accent">
                <div className="truncate text-sm">{r.strategyName ?? "回测"}</div>
                <div className="truncate text-xs text-muted">
                  {r.kind === "sweep"
                    ? `参数扫描：${r.label ?? ""}`
                    : `${r.params.start} ~ ${r.params.end}`}
                </div>
              </Link>
              <RunStatus r={r} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">还没有回测。</p>
      )}
    </Card>
  );
}

function Welcome({ presets }: { presets: PresetView[] }) {
  const chat = useChatUi();
  const wide = useMediaQuery(WIDE_QUERY);
  return (
    <Card
      title="从一个模板开始"
      info="模板是几种常见的选股思路，点一下会建好策略并马上回测；之后可以直接让 AI 帮你改。"
    >
      <p className="mb-3 text-sm text-ink-2">
        {wide
          ? "也可以直接在右边告诉 AI 你的想法，比如「A 股里找低估值、高分红的龙头，每月调一次仓」。"
          : "也可以直接告诉 AI 你的想法，它会帮你写成策略并回测。"}
      </p>
      <PresetGallery presets={presets} />
      {!wide && (
        <Button
          className="mt-4"
          variant="primary"
          onClick={() => chat.ask("我想建一个选股策略，帮我一起想想：", {})}
        >
          用对话描述我的策略
          <ArrowRight className="size-4" />
        </Button>
      )}
    </Card>
  );
}

export function DashboardPage() {
  const q = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.get<Dashboard>("/api/dashboard"),
    refetchInterval: 60_000,
  });
  const chat = useChatUi();
  const [selection, setSelection] = useState<Selection>(null);
  useEffect(() => {
    chat.setPage({});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 按上线先后排：颜色槽位跟着策略走（先上线的先拿色），列表顺序 = 颜色顺序
  const trackings = useMemo(
    () => [...(q.data?.trackings ?? [])].sort((a, b) => a.createdAt - b.createdAt),
    [q.data?.trackings],
  );
  const slots = useMemo(
    () => new Map(trackings.slice(0, MAX_LINES).map((t, i) => [t.id, i])),
    [trackings],
  );
  // 选中的跟踪被停掉后，从选择里去掉
  const valid: Selection = selection?.filter((id) => slots.has(id)) ?? null;
  const sel: Selection = valid && valid.length ? valid : null;
  if (q.isLoading) return <Spinner />;
  if (!q.data) return <ErrorNote error={q.error} />;
  const d = q.data;
  const empty = !d.trackings.length && !d.recentRuns.length;

  return (
    <div className="space-y-4">
      <DataBanner data={d.data} />
      {empty ? (
        <Welcome presets={d.presets} />
      ) : (
        <>
          <Card
            title={
              <>
                <Sparkles className="size-4 text-accent" />
                今日简报
              </>
            }
            info={
              <>
                每个交易日收盘后生成：引擎先算出各跟踪的事实，AI 只负责写成人话，数字以卡片为准。
                {d.brief && <div className="mt-1 text-muted">这一期：{d.brief.date}</div>}
              </>
            }
            action={<span className="text-xs text-muted">{asOfText(d.data)}</span>}
          >
            {d.brief?.content ? (
              <p className="whitespace-pre-wrap text-sm leading-6 text-ink">{d.brief.content}</p>
            ) : (
              <p className="text-sm text-muted">有跟踪中的策略后，每天收盘后会在这里写一段简报。</p>
            )}
          </Card>
          <TrackingsCard
            trackings={trackings}
            slots={slots}
            selection={sel}
            onToggle={(id) => setSelection(toggle(sel, id))}
          />
          {slots.size > 0 && (
            <CompareCard
              trackings={trackings}
              slots={slots}
              selection={sel}
              setSelection={setSelection}
            />
          )}
          <div className="grid gap-4 @3xl:grid-cols-2">
            <PlanCard signals={d.signals} />
            <RecentRunsCard runs={d.recentRuns} />
          </div>
        </>
      )}
    </div>
  );
}

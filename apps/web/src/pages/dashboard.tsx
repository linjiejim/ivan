/**
 * 首页看板（spec §11、D40、D44）：和右侧常驻对话一起组成首页。只回答「现在怎么样、明天做什么」：
 * 简报 · 我的跟踪（一个数 + 走势 + 一句人话）· 多策略对照图（可选一个或几个看细节）· 明日计划 · 最近回测。
 * 口径说明、回测成绩这类次要信息收进 ⓘ。全部从库里确定性渲染，只有简报那段是 LLM 写的。
 */
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useChatUi } from "../chat/chat-context.tsx";
import { AiAvatar } from "../components/brand.tsx";
import { MAX_LINES, MultiNavChart, SLOT_VARS } from "../components/charts/multi-nav-chart.tsx";
import { Sparkline } from "../components/charts/small.tsx";
import {
  IconAI,
  IconBacktest,
  IconBrief,
  IconChart,
  IconClock,
  IconOffline,
  IconPlan,
  IconTemplate,
  IconTracking,
  IconWarn,
} from "../components/icons.tsx";
import { useMe } from "../components/layout.tsx";
import { TrackingVerdict } from "../components/verdict.tsx";
import {
  ArtCard,
  Badge,
  Button,
  Callout,
  Card,
  CheckBadges,
  cx,
  Empty,
  ErrorNote,
  Figure,
  Info,
  InfoRows,
  ListSkeleton,
  SeriesDot,
  Skeleton,
  Tag,
  TextLink,
  useMediaQuery,
  WIDE_QUERY,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { marketBanner } from "../lib/data-status.ts";
import {
  beatPct,
  DEVIATION_INFO,
  deviationText,
  MARKET_TEXT,
  NA,
  pct,
  REASON_TEXT,
  tone,
  VERDICT_TEXT,
} from "../lib/format.ts";
import type { StrategyLine } from "../lib/multi-series.ts";
import { usePageTitle } from "../lib/title.ts";
import type {
  BriefFactsView,
  Dashboard,
  DataStatus,
  PresetView,
  RunSummary,
  TrackingChart,
} from "../lib/types.ts";

/**
 * 只在出问题时出现：worker 没跑、行情仓维护中、某个市场补数据中 / 等自动重跑 / 最近一次更新失败（D73、D111）、某个跟踪结算失败
 */
export function DataBanner({ data }: { data: DataStatus }) {
  const isAdmin = useMe().data?.user.role === "admin";
  if (!data.workerUp) {
    return (
      <Callout tone="warn" icon={IconOffline} title="行情服务（worker）没有运行">
        回测、选股、跟踪结算都会暂停。
      </Callout>
    );
  }
  // 行情仓还没升级到新版（D76）：worker 活着但不排任务、不认领
  if (data.maintenance) {
    return (
      <Callout tone="warn" icon={IconWarn} title="行情仓维护中">
        {isAdmin ? `${data.maintenance}。` : "管理员正在升级行情仓。"}
        升级完成前回测、选股、跟踪结算都会暂停。
      </Callout>
    );
  }
  // 各市场一条（D111）：补数据中 / 等自动重试 / 真的没更新成功；原因与影响收进 ⓘ，只有真失败才给管理员操作
  const banners = data.markets.flatMap((m) => {
    const b = marketBanner(m, isAdmin);
    return b ? [{ m, b }] : [];
  });
  const settle = data.settleFailures ?? [];
  if (!banners.length && !settle.length) return null;
  return (
    <div className="space-y-2">
      {/* 结算失败不只进日志（D70）：这个跟踪的数字还是上一次成功结算的 */}
      {settle.map((f) => (
        <Callout
          key={f.trackingId}
          tone="warn"
          icon={IconWarn}
          title={`「${f.name}」最近一次结算失败`}
          action={<Info label="失败原因">{f.message}</Info>}
        >
          <span className="font-mono">{f.date}</span>{" "}
          的数据没能结算，这个跟踪的数字还是上一次成功结算的，判词显示「结算失败」。
          {isAdmin && (
            <Link
              to="/admin"
              className="ml-1 font-medium text-warn underline decoration-warn/40 underline-offset-2 hover:decoration-warn"
            >
              去管理页重跑
            </Link>
          )}
        </Callout>
      ))}
      {banners.map(({ m, b }) => (
        <Callout
          key={m.market}
          tone={b.kind === "failed" ? "warn" : "neutral"}
          icon={b.kind === "failed" ? IconWarn : IconClock}
          title={b.title}
          action={<Info label="说明">{b.info}</Info>}
        >
          {b.body}
          {b.action && (
            <Link
              to="/admin"
              className="ml-1 font-medium text-warn underline decoration-warn/40 underline-offset-2 hover:decoration-warn"
            >
              去管理页重跑
            </Link>
          )}
        </Callout>
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
    : `数据截至 ${ds.map((m) => `${MARKET_TEXT[m.market]} ${m.asOf}`).join("，")}`;
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
          <div
            key={p.id}
            className="group/preset flex flex-col rounded-xl border border-line bg-surface p-4 transition-[border-color,box-shadow] duration-200 hover:border-line-strong hover:shadow-raise"
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 truncate text-sm font-semibold text-ink">{p.title}</span>
              <Tag>{MARKET_TEXT[p.market]}</Tag>
              <Info label="具体规则">
                <ul className="space-y-1">
                  {p.describe.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </Info>
            </div>
            <p className="mt-1.5 flex-1 text-xs leading-5 text-ink-2">{p.blurb}</p>
            <Button
              className="mt-4 w-full"
              size="sm"
              icon={IconBacktest}
              loading={create.isPending && create.variables === p.id}
              disabled={create.isPending && create.variables !== p.id}
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

function slotColor(slot: number | undefined): string | undefined {
  return slot === undefined ? undefined : SLOT_VARS[slot];
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
      icon={IconTracking}
      flush
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
      action={
        trackings.length > 0 && (
          <span className="text-xs text-muted">
            <span className="tabular font-medium text-ink-2">{trackings.length}</span> 个运行中
          </span>
        )
      }
    >
      {trackings.length ? (
        <ul className="px-2">
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
                    "grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2.5 py-3 transition-[background-color,opacity] duration-150 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto] sm:gap-4",
                    on ? "bg-surface-2" : "hover:bg-surface-2/70",
                    dim && "opacity-50 hover:opacity-80",
                  )}
                >
                  <SeriesDot color={slotColor(slot)} className="size-2.5" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Link
                        to={`/trackings/${t.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="truncate text-sm font-medium text-ink transition-colors hover:text-accent"
                      >
                        {t.strategyName}
                      </Link>
                      {/* 窄的时候名字优先：市场在详情页里有，这里收起 */}
                      <Tag className="@max-md:hidden">{MARKET_TEXT[t.market]}</Tag>
                      <TrackingVerdict
                        verdict={t.verdict}
                        health={t.health}
                        lastError={t.lastError}
                        lastDate={t.lastDate}
                      />
                    </div>
                    <div className="mt-1 flex items-center gap-1 text-xs text-muted">
                      <span className="truncate">
                        {t.days ? `跟踪 ${t.days} 天` : `${t.startDate} 开始`}，
                        {deviationText(t.deviationPct, t.days)}
                      </span>
                      <Info label="回测成绩">
                        <div className="mb-1.5 font-medium text-ink">上线前的回测成绩</div>
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
                    <Sparkline values={t.spark} color={slotColor(slot) ?? "var(--faint)"} />
                  </span>
                  <div className="w-20 text-right @md:w-24">
                    <div
                      className={cx(
                        "text-lg leading-6 font-semibold tracking-[-0.01em]",
                        t.days ? tone(t.excess) : "text-muted",
                      )}
                    >
                      <Figure text={t.days ? pct(t.excess) : NA} />
                    </div>
                    <div className="text-2xs text-muted">跟踪超额</div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty art="bamboo" title="还没有上线跟踪的策略">
          回测满意后，让
          AI「上线跟踪」，或者在策略页点「上线跟踪」。之后每个交易日收盘，这里会长出一条新的走势。
        </Empty>
      )}
      {trackings.length > MAX_LINES && (
        <p className="px-4 pt-1 pb-2 text-xs text-muted">
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
      t.days && t.nav !== null ? pct(t.nav - 1) : NA,
      tone(t.nav !== null ? t.nav - 1 : null),
    ],
    ["跟踪超额", t.days ? pct(t.excess) : NA, tone(t.excess)],
    ["跑赢回测同期", beatPct(t.deviationPct), "text-ink"],
    ["回测年化超额", pct(t.baseline?.excessCagr), tone(t.baseline?.excessCagr)],
  ];
  return (
    <div className="mt-4 flex flex-wrap items-end gap-x-8 gap-y-3 border-t border-line pt-4">
      {items.map(([label, value, cls]) => (
        <div key={label}>
          <div className="text-2xs text-muted">{label}</div>
          <div className={cx("mt-0.5 text-base font-semibold tracking-[-0.01em]", cls)}>
            <Figure text={value} />
          </div>
        </div>
      ))}
      <TextLink to={`/trackings/${t.id}`} className="ml-auto self-center">
        打开跟踪详情
      </TextLink>
    </div>
  );
}

/** 选了几个策略时：图下面并排比关键数 */
function CompareTable({ rows, slots }: { rows: TrackingRow[]; slots: Map<string, number> }) {
  return (
    <div className="mt-4 overflow-x-auto border-t border-line pt-2">
      <table className="tabular w-full min-w-[560px] text-sm">
        <thead>
          <tr className="text-left text-xs text-muted">
            <th className="h-9 font-normal">策略</th>
            <th className="h-9 text-right font-normal">跟踪天数</th>
            <th className="h-9 text-right font-normal">跟踪超额</th>
            <th className="h-9 text-right font-normal">跑赢回测同期</th>
            <th className="h-9 text-right font-normal">回测年化超额</th>
            <th className="h-9 text-right font-normal">回测最大回撤</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className="border-t border-line">
              <td className="h-10">
                <Link
                  to={`/trackings/${t.id}`}
                  className="inline-flex items-center gap-2 text-ink transition-colors hover:text-accent"
                >
                  <SeriesDot color={slotColor(slots.get(t.id))} />
                  {t.strategyName}
                </Link>
              </td>
              <td className="h-10 text-right text-ink-2">{t.days || NA}</td>
              <td className={`h-10 text-right font-medium ${tone(t.excess)}`}>
                {t.days ? pct(t.excess) : NA}
              </td>
              <td className="h-10 text-right text-ink-2">{beatPct(t.deviationPct)}</td>
              <td className={`h-10 text-right ${tone(t.baseline?.excessCagr)}`}>
                {pct(t.baseline?.excessCagr)}
              </td>
              <td className="h-10 text-right text-ink-2">
                {pct(t.baseline?.maxDrawdown, 1, false)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 选策略的小按钮：色点 + 名字，和列表、图里的线同一个颜色 */
function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "relative inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs whitespace-nowrap ring-1 transition-[background-color,color,box-shadow] duration-150 ring-inset pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-2",
        active
          ? "bg-surface-2 font-medium text-ink ring-line-strong"
          : "text-ink-2 ring-line hover:text-ink hover:ring-line-strong",
      )}
    >
      {children}
    </button>
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
  return (
    <Card
      title="净值对照"
      icon={IconChart}
      info="每个策略一种颜色：淡色是上线前的回测，实色是上线后的模拟盘；灰线是基准（含分红），不同市场各一条。切到「超额」看每个策略相对自己基准的表现；「只看跟踪」从各自上线那天起算。在图上拖动可以框选一段，然后问 AI。"
      action={single ? <TextLink to={`/trackings/${single.id}`}>详情</TextLink> : null}
    >
      {charted.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          <Chip active={selection === null} onClick={() => setSelection(null)}>
            全部
          </Chip>
          {charted.map((t) => (
            <Chip
              key={t.id}
              active={selection?.includes(t.id) ?? false}
              onClick={() => setSelection(toggle(selection, t.id))}
            >
              <SeriesDot color={slotColor(slots.get(t.id))} />
              {t.strategyName}
            </Chip>
          ))}
        </div>
      )}
      {loading && !lines.length ? (
        <div className="space-y-3">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-[260px] w-full rounded-lg" />
        </div>
      ) : (
        <MultiNavChart
          lines={lines}
          height={272}
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

function PlanCard({
  signals,
  slots,
}: {
  signals: Dashboard["signals"];
  slots: Map<string, number>;
}) {
  return (
    <Card
      title="明日计划"
      icon={IconPlan}
      info="各跟踪下一个交易日开盘时的模拟买卖，按规则算出，不是投资建议。"
    >
      {signals.length ? (
        <div className="space-y-4">
          {signals.map((s) => (
            <div key={s.trackingId}>
              <div className="mb-2 flex items-center gap-2 text-xs">
                <SeriesDot color={slotColor(slots.get(s.trackingId))} />
                <span className="truncate font-medium text-ink">{s.strategyName}</span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-muted">
                  {s.orders[0]?.planDate} 开盘
                </span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1.5 pl-4">
                {s.orders.map((o) => (
                  <span key={`${o.side}-${o.code}`} className="inline-flex items-center gap-1.5">
                    <Badge tone={o.side === "buy" ? "up" : "down"}>
                      <span className="opacity-70">{o.side === "buy" ? "买" : "卖"}</span>
                      {o.name ?? o.code}
                    </Badge>
                    {/* 计划原因（D68）：掉出前 N 名、不再满足哪条、止盈止损… */}
                    <span className="text-2xs text-muted">
                      {o.reasonText ?? REASON_TEXT[o.reason] ?? o.reason}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-3 py-2 text-sm text-muted">
          <span className="flex size-8 items-center justify-center rounded-lg bg-surface-2">
            <IconPlan size={16} />
          </span>
          明天没有计划中的买卖，持仓照旧。
        </div>
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
    <span className="flex items-center gap-2">
      <CheckBadges checks={r.checks} />
      <span
        className={cx("tabular w-14 text-right text-sm font-medium", tone(r.headline.excessCagr))}
      >
        {pct(r.headline.excessCagr)}
      </span>
    </span>
  );
}

function RecentRunsCard({ runs }: { runs: RunSummary[] }) {
  return (
    <Card
      title="最近回测"
      icon={IconBacktest}
      info="右边的数字是年化超额（相对基准）。"
      action={<TextLink to="/strategies">全部策略</TextLink>}
      flush
    >
      {runs.length ? (
        <ul className="px-2">
          {runs.slice(0, 4).map((r) => (
            <li key={r.id}>
              <Link
                to={`/runs/${r.id}`}
                className="group/run flex items-center gap-3 rounded-lg px-2.5 py-2.5 transition-colors hover:bg-surface-2/70"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-ink transition-colors group-hover/run:text-accent">
                    {r.strategyName ?? "回测"}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-muted">
                    {r.kind === "sweep"
                      ? `参数扫描：${r.label ?? ""}`
                      : `${r.params.start} ~ ${r.params.end}`}
                  </div>
                </div>
                <RunStatus r={r} />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 pb-3 text-sm text-muted">还没有回测。</p>
      )}
    </Card>
  );
}

function Welcome({ presets }: { presets: PresetView[] }) {
  const chat = useChatUi();
  const wide = useMediaQuery(WIDE_QUERY);
  return (
    <div className="space-y-5">
      <ArtCard
        art="start"
        title="从一个选股想法开始"
        body={
          wide
            ? "直接在右边告诉 AI 你的想法，比如「A 股里找低估值、高分红的龙头，每月调一次仓」。它会写成规则、在历史数据上回测，你确认后才生效。"
            : "告诉 AI 你的想法，它会写成规则并回测；也可以先用下面的模板跑一遍看看。"
        }
        action={
          !wide && (
            <Button
              variant="primary"
              icon={IconAI}
              onClick={() => chat.ask("我想建一个选股策略，帮我一起想想：", {})}
            >
              用对话描述我的策略
            </Button>
          )
        }
      />
      <Card
        title="或者，从模板开始"
        icon={IconTemplate}
        info="模板是几种常见的选股思路，点一下会建好策略并马上回测；之后可以直接让 AI 帮你改。"
      >
        <PresetGallery presets={presets} />
      </Card>
    </div>
  );
}

/** 简报的依据（D70）：引擎算好的事实逐条列出，AI 只是把它写成人话 */
function BriefBasis({ facts }: { facts: BriefFactsView }) {
  return (
    <div className="space-y-2">
      <p>这一期简报基于下面这些事实（{facts.date}），数字以这里为准。</p>
      {facts.trackings.map((t, i) => (
        <div key={t.trackingId ?? i} className="border-t border-line pt-1.5">
          <div className="mb-1 font-medium text-ink">{t.name}</div>
          <InfoRows
            rows={[
              [
                "判词",
                t.verdict
                  ? t.prevVerdict && t.prevVerdict !== t.verdict
                    ? `${VERDICT_TEXT[t.verdict]}（上次：${VERDICT_TEXT[t.prevVerdict]}）`
                    : VERDICT_TEXT[t.verdict]
                  : NA,
              ],
              ["最后结算日", t.lastDate ?? NA],
              ["今天", pct(t.dayReturn, 2)],
              ["跟踪天数", t.days ? String(t.days) : NA],
              ["累计超额", pct(t.excessTotal)],
              ["跑赢回测同期", beatPct(t.deviationPct)],
              [
                "明日计划",
                t.buys.length || t.sells.length
                  ? `买 ${t.buys.length} 只、卖 ${t.sells.length} 只`
                  : NA,
              ],
              ["新提示", t.warnings.length ? t.warnings.join("、") : NA],
            ]}
          />
        </div>
      ))}
    </div>
  );
}

function BriefCard({ d }: { d: Dashboard }) {
  const asOf = asOfText(d.data);
  return (
    <Card
      title="今日简报"
      icon={IconBrief}
      info={
        <>
          每个交易日收盘后生成：引擎先算出各跟踪的事实，AI 只负责写成人话，数字以卡片为准。
          {d.brief && <div className="mt-1 text-muted">这一期：{d.brief.date}</div>}
        </>
      }
      action={
        <span className="inline-flex items-center gap-2 text-xs text-muted">
          {d.brief?.facts && d.brief.facts.trackings.length > 0 && (
            <span className="inline-flex items-center">
              依据
              <Info label="简报的依据" width={320}>
                <BriefBasis facts={d.brief.facts} />
              </Info>
            </span>
          )}
          {asOf && (
            <span className="inline-flex items-center gap-1">
              <IconClock size={13} />
              {asOf}
            </span>
          )}
        </span>
      }
    >
      {d.brief?.content ? (
        <div className="flex gap-3">
          <AiAvatar className="mt-0.5" />
          <p className="max-w-[72ch] text-[14.5px] leading-7 whitespace-pre-wrap text-ink">
            {d.brief.content}
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted">有跟踪中的策略后，每天收盘后会在这里写一段简报。</p>
      )}
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div role="status" aria-label="加载中" className="space-y-5">
      <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-4/5" />
      </div>
      <div className="rounded-xl border border-line bg-surface p-4">
        <Skeleton className="mb-4 h-4 w-20" />
        <ListSkeleton rows={3} />
      </div>
      <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    </div>
  );
}

export function DashboardPage() {
  usePageTitle(null);
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
  if (q.isLoading) return <DashboardSkeleton />;
  if (!q.data) return <ErrorNote error={q.error} />;
  const d = q.data;
  const empty = !d.trackings.length && !d.recentRuns.length;

  return (
    <div className="space-y-5">
      <DataBanner data={d.data} />
      {empty ? (
        <Welcome presets={d.presets} />
      ) : (
        <>
          <BriefCard d={d} />
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
          <div className="grid items-start gap-5 @3xl:grid-cols-2">
            <PlanCard signals={d.signals} slots={slots} />
            <RecentRunsCard runs={d.recentRuns} />
          </div>
        </>
      )}
    </div>
  );
}

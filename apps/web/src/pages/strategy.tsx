/**
 * 策略详情：概览（描述 + 最近回测）· 编辑（表单 → 草稿 → 确认）· 版本 · 回测记录（可勾选对比）· 今日选股 · 跟踪。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useChatUi } from "../chat/chat-context.tsx";
import { CompareView } from "../components/compare-view.tsx";
import { DiffView } from "../components/diff-view.tsx";
import {
  IconAI,
  IconBacktest,
  IconChevronRight,
  IconCompare,
  IconEdit,
  IconGoLive,
  IconHistory,
  IconOverview,
  IconRules,
  IconRun,
  IconScreen,
  IconTracking,
} from "../components/icons.tsx";
import { ScreenTable } from "../components/screen-table.tsx";
import { SpecEditor } from "../components/spec-editor.tsx";
import {
  Badge,
  Button,
  Callout,
  Card,
  CheckBadges,
  cx,
  DataTable,
  Empty,
  ErrorNote,
  Field,
  Figure,
  Input,
  LiveDot,
  Modal,
  PageHeader,
  PageSkeleton,
  Skeleton,
  Tabs,
  Tag,
  Td,
  TextLink,
  Th,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { dateTime, MARKET_TEXT, money, NA, pct, tone } from "../lib/format.ts";
import { usePageTitle } from "../lib/title.ts";
import type { RunSummary, ScreenResult, StrategyDetail } from "../lib/types.ts";

type Tab = "overview" | "edit" | "versions" | "runs" | "screen" | "trackings";

const SOURCE_TEXT: Record<string, string> = { chat: "对话", preset: "模板", form: "表单" };

export function BacktestDialog({
  versionId,
  open,
  onClose,
}: {
  versionId: string;
  open: boolean;
  onClose: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [start, setStart] = useState("2018-01-01");
  const [end, setEnd] = useState(today);
  const [capital, setCapital] = useState(1_000_000);
  const [oos, setOos] = useState(12);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: () =>
      api.post<{ runId: string }>("/api/runs", { versionId, start, end, capital, oosMonths: oos }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["me"] });
      onClose();
      navigate(`/runs/${r.runId}`);
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="回测"
      icon={IconRun}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            icon={IconRun}
            loading={run.isPending}
            onClick={() => run.mutate()}
          >
            开始回测
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-x-3 gap-y-4">
        <Field label="起点">
          <Input
            type="date"
            value={start}
            min="2014-01-01"
            onChange={(e) => setStart(e.target.value)}
          />
        </Field>
        <Field label="终点" hint="默认到最新数据日">
          <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
        <Field label="初始资金" hint={capital > 0 ? `${money(capital)}元` : undefined}>
          <Input
            type="number"
            value={capital}
            min={10000}
            step={100000}
            onChange={(e) => setCapital(Number(e.target.value))}
          />
        </Field>
        <Field label="样本外月数" hint="最后 N 个月单独算指标，0 = 不分">
          <Input
            type="number"
            value={oos}
            min={0}
            max={60}
            onChange={(e) => setOos(Number(e.target.value))}
          />
        </Field>
      </div>
      <Callout tone="neutral" className="mt-5 text-xs leading-5">
        收盘后决策、次日开盘成交；涨停买不进、跌停卖不出、停牌顺延；持仓含分红再投入；费用按日期生效的费率表。
      </Callout>
      <ErrorNote error={run.error} />
    </Modal>
  );
}

export function TrackDialog({
  versionId,
  open,
  onClose,
}: {
  versionId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [capital, setCapital] = useState(1_000_000);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const propose = useMutation({
    mutationFn: () =>
      api.post<{
        draftId: string;
        strategyName: string;
        versionN: number;
        startDate: string;
        capital: number;
        hasBaseline: boolean;
      }>("/api/trackings/propose", { versionId, capital }),
  });
  const confirm = useMutation({
    mutationFn: (draftId: string) =>
      api.post<{ trackingId: string }>(`/api/drafts/${draftId}/confirm`),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
      onClose();
      navigate(`/trackings/${r.trackingId}`);
    },
  });
  const p = propose.data;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="上线跟踪"
      icon={IconGoLive}
      footer={
        p ? (
          <>
            <Button onClick={() => propose.reset()}>返回</Button>
            <Button
              variant="primary"
              icon={IconGoLive}
              loading={confirm.isPending}
              onClick={() => confirm.mutate(p.draftId)}
            >
              确认上线
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>取消</Button>
            <Button variant="primary" loading={propose.isPending} onClick={() => propose.mutate()}>
              下一步
            </Button>
          </>
        )
      }
    >
      {!p ? (
        <div className="space-y-4">
          <p className="text-sm leading-6 text-ink-2">
            上线后每个交易日收盘后，按这个版本的规则从上线日起重放一遍模拟盘，和回测对照。版本固定：以后改策略要重新上线。
          </p>
          <Field label="模拟资金" hint={capital > 0 ? `${money(capital)}元` : undefined}>
            <Input
              type="number"
              value={capital}
              step={100000}
              onChange={(e) => setCapital(Number(e.target.value))}
            />
          </Field>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-lg bg-surface-2 px-4 py-3">
            <dt className="text-muted">策略</dt>
            <dd className="font-medium text-ink">
              「{p.strategyName}」<span className="font-mono text-ink-2">v{p.versionN}</span>
            </dd>
            <dt className="text-muted">上线日</dt>
            <dd className="font-mono text-ink">{p.startDate}</dd>
            <dt className="text-muted">模拟资金</dt>
            <dd className="tabular text-ink">{p.capital.toLocaleString()} 元</dd>
          </dl>
          {!p.hasBaseline && (
            <Callout tone="warn">
              这个版本还没有跑完的回测，上线后没法和回测比（看板上「跑赢回测同期」会是空的）。建议先回测一次。
            </Callout>
          )}
        </div>
      )}
      <ErrorNote error={propose.error ?? confirm.error} />
    </Modal>
  );
}

function RunsTab({ runs }: { runs: RunSummary[] }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  if (!runs.length) return <Empty icon={IconBacktest} title="还没有回测" className="border-0" />;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs text-muted">勾选 2 到 4 个完成的回测，可以放在一起对比</span>
        <Button
          size="sm"
          icon={IconCompare}
          disabled={picked.length < 2}
          onClick={() => setComparing(true)}
        >
          对比{picked.length ? ` ${picked.length} 个` : ""}
        </Button>
      </div>
      <DataTable minWidth={620}>
        <thead>
          <tr>
            <Th className="w-8" />
            <Th>回测</Th>
            <Th align="right">年化</Th>
            <Th align="right">年化超额</Th>
            <Th align="right">最大回撤</Th>
            <Th align="right">夏普</Th>
            <Th>提示</Th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const on = picked.includes(r.id);
            return (
              <tr key={r.id} className={cx("transition-colors", on && "bg-accent-wash")}>
                <Td>
                  {r.kind === "backtest" && r.status === "done" && (
                    <input
                      type="checkbox"
                      aria-label="选中对比"
                      className="size-[15px] cursor-pointer accent-ink"
                      checked={on}
                      onChange={(e) =>
                        setPicked((p) =>
                          e.target.checked ? [...p, r.id].slice(-4) : p.filter((x) => x !== r.id),
                        )
                      }
                    />
                  )}
                </Td>
                <Td>
                  <Link
                    to={`/runs/${r.id}`}
                    className={cx(
                      "text-ink transition-colors hover:text-accent",
                      r.kind !== "sweep" && "font-mono text-[13px]",
                    )}
                  >
                    {r.kind === "sweep"
                      ? `参数扫描：${r.label}`
                      : `${r.params.start} ~ ${r.params.end}`}
                  </Link>
                  <div className="text-2xs text-muted">{dateTime(r.createdAt)}</div>
                </Td>
                {r.headline ? (
                  <>
                    <Td align="right" className={tone(r.headline.cagr)}>
                      {pct(r.headline.cagr)}
                    </Td>
                    <Td align="right" className={cx("font-medium", tone(r.headline.excessCagr))}>
                      {pct(r.headline.excessCagr)}
                    </Td>
                    <Td align="right" className="text-ink-2">
                      {pct(r.headline.maxDrawdown, 1, false)}
                    </Td>
                    <Td align="right" className="text-ink-2">
                      {r.headline.sharpe.toFixed(2)}
                    </Td>
                  </>
                ) : (
                  <Td colSpan={4} align="right">
                    <Badge tone={r.status === "failed" ? "warn" : "accent"}>
                      {r.status === "failed"
                        ? "失败"
                        : r.status === "done"
                          ? r.kind === "sweep"
                            ? "扫描完成"
                            : "完成"
                          : "进行中"}
                    </Badge>
                  </Td>
                )}
                <Td>
                  <CheckBadges checks={r.checks} />
                </Td>
              </tr>
            );
          })}
        </tbody>
      </DataTable>
      <Modal
        open={comparing}
        onClose={() => setComparing(false)}
        title="回测对比"
        icon={IconCompare}
        wide
      >
        {comparing && <CompareView ids={picked} />}
      </Modal>
    </div>
  );
}

/** 版本历史：一条时间线，最新的在上面 */
function VersionsTab({ s, currentId }: { s: StrategyDetail; currentId: string }) {
  return (
    <ol className="relative">
      {s.versions.map((v, i) => {
        const current = v.id === currentId;
        const last = i === s.versions.length - 1;
        return (
          <li key={v.id} className="relative grid grid-cols-[20px_minmax(0,1fr)] gap-x-3 pb-6">
            {!last && (
              <span
                aria-hidden
                className="absolute top-5 bottom-0 left-[9.5px] w-px bg-line-strong"
              />
            )}
            <span
              aria-hidden
              className={cx(
                "relative z-[1] mt-1 flex size-5 items-center justify-center rounded-full ring-4 ring-surface",
                current ? "bg-ink" : "bg-surface-3",
              )}
            >
              <span className={cx("size-1.5 rounded-full", current ? "bg-surface" : "bg-muted")} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-semibold text-ink">v{v.n}</span>
                {current && <Badge tone="accent">当前</Badge>}
                <Tag>{SOURCE_TEXT[v.source] ?? v.source}</Tag>
                <span className="font-mono text-[11px] text-muted">{dateTime(v.createdAt)}</span>
              </div>
              {v.note && <p className="mt-1 text-sm text-ink-2">{v.note}</p>}
              <div className="mt-2.5 rounded-lg border border-line bg-page/60 px-3.5 py-3">
                <DiffView changes={[]} describe={v.describe} />
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function LastRun({ run, onRun }: { run: RunSummary | undefined; onRun: () => void }) {
  if (!run?.headline)
    return (
      <Empty
        icon={IconBacktest}
        title="还没有跑完的回测"
        className="border-0 py-6"
        action={
          <Button size="sm" variant="primary" icon={IconRun} onClick={onRun}>
            现在回测
          </Button>
        }
      >
        回测会在点时正确的历史数据上，按规则一天天重放。
      </Empty>
    );
  const h = run.headline;
  const stats: Array<[string, string, string]> = [
    ["年化", pct(h.cagr), tone(h.cagr)],
    ["年化超额", pct(h.excessCagr), tone(h.excessCagr)],
    ["最大回撤", pct(h.maxDrawdown, 1, false), "text-ink"],
  ];
  return (
    <div>
      <div className="font-mono text-[11px] text-muted">
        {run.params.start} ~ {run.params.end}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-4">
        {stats.map(([label, value, cls]) => (
          <div key={label}>
            <div className="text-xs text-muted">{label}</div>
            <div className={cx("mt-1 text-[22px] leading-7 font-semibold tracking-[-0.02em]", cls)}>
              <Figure text={value} />
            </div>
          </div>
        ))}
      </div>
      {run.checks.some((c) => c.level === "warn") && (
        <div className="mt-4">
          <CheckBadges checks={run.checks} />
        </div>
      )}
    </div>
  );
}

export function StrategyPage() {
  const { id = "" } = useParams();
  const q = useQuery({
    queryKey: ["strategy", id],
    queryFn: () => api.get<StrategyDetail>(`/api/strategies/${id}`),
  });
  const [tab, setTab] = useState<Tab>("overview");
  const [backtest, setBacktest] = useState(false);
  const [track, setTrack] = useState(false);
  const chat = useChatUi();
  const s = q.data;
  const version = s?.current;
  usePageTitle(s?.name ?? "策略");
  useEffect(() => {
    if (s)
      chat.setPage({
        strategyId: s.id,
        versionId: s.current?.id,
        label: `策略「${s.name}」v${s.current?.n ?? ""}`,
      });
  }, [s?.id, s?.current?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const screen = useQuery({
    queryKey: ["screen", version?.id],
    queryFn: () => api.get<ScreenResult>(`/api/screen?versionId=${version!.id}&limit=30`),
    enabled: tab === "screen" && !!version,
  });
  if (q.isLoading) return <PageSkeleton stats={0} />;
  if (!s || !version) return <ErrorNote error={q.error ?? new Error("策略不存在")} />;
  const lastDone = s.runs.find((r) => r.kind === "backtest" && r.status === "done");
  const activeTrackings = s.trackings.filter((t) => t.status === "active").length;

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ to: "/strategies", label: "策略" }}
        title={s.name}
        badges={
          <>
            <Tag>{MARKET_TEXT[s.market]}</Tag>
            <Tag mono>v{version.n}</Tag>
            {activeTrackings > 0 && (
              <Badge tone="accent">
                <LiveDot />
                跟踪中
              </Badge>
            )}
          </>
        }
        meta={
          <>
            <span>更新于 {dateTime(version.createdAt)}</span>
            {version.note && <span className="text-ink-2">{version.note}</span>}
          </>
        }
        actions={
          <>
            <Button
              variant="ai"
              icon={IconAI}
              onClick={() =>
                chat.ask(`帮我看看这个策略，有什么可以改进的？`, {
                  strategyId: s.id,
                  versionId: version.id,
                })
              }
            >
              问 AI
            </Button>
            <Button icon={IconGoLive} onClick={() => setTrack(true)}>
              上线跟踪
            </Button>
            <Button variant="primary" icon={IconRun} onClick={() => setBacktest(true)}>
              回测
            </Button>
          </>
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: "overview", label: "概览", icon: IconOverview },
          { value: "edit", label: "编辑", icon: IconEdit },
          { value: "versions", label: "版本", icon: IconHistory, count: s.versions.length },
          { value: "runs", label: "回测", icon: IconBacktest, count: s.runs.length },
          { value: "screen", label: "今日选股", icon: IconScreen },
          { value: "trackings", label: "跟踪", icon: IconTracking, count: s.trackings.length },
        ]}
      />
      <div key={tab} className="animate-enter">
        {tab === "overview" && (
          <div className="grid gap-5 @4xl:grid-cols-2">
            <Card title="规则" icon={IconRules}>
              <DiffView changes={[]} describe={version.describe} />
            </Card>
            <Card
              title="最近一次回测"
              icon={IconBacktest}
              action={lastDone && <TextLink to={`/runs/${lastDone.id}`}>完整报告</TextLink>}
            >
              <LastRun run={lastDone} onRun={() => setBacktest(true)} />
            </Card>
          </div>
        )}
        {tab === "edit" && (
          <Card>
            <SpecEditor key={version.id} strategyId={s.id} initial={version.spec} />
          </Card>
        )}
        {tab === "versions" && (
          <Card>
            <VersionsTab s={s} currentId={version.id} />
          </Card>
        )}
        {tab === "runs" && (
          <Card>
            <RunsTab runs={s.runs} />
          </Card>
        )}
        {tab === "screen" && (
          <Card
            title="按当前版本在最新数据日选股"
            icon={IconScreen}
            subtitle={
              screen.data
                ? `数据日 ${screen.data.date}${
                    screen.data.regime
                      ? screen.data.regime === "weak"
                        ? "，大盘在均线下方，用弱势排序"
                        : "，大盘在均线上方，用强势排序"
                      : ""
                  }`
                : undefined
            }
          >
            {screen.isLoading ? (
              <div className="space-y-3 py-2">
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} className="h-4 w-full" />
                ))}
              </div>
            ) : screen.data ? (
              <ScreenTable result={screen.data} spec={version.spec} />
            ) : (
              <ErrorNote error={screen.error} />
            )}
          </Card>
        )}
        {tab === "trackings" && (
          <Card flush>
            {s.trackings.length ? (
              <ul className="px-2 pt-2">
                {s.trackings.map((t) => (
                  <li key={t.id}>
                    <Link
                      to={`/trackings/${t.id}`}
                      className="group/t flex items-center gap-3 rounded-lg px-2.5 py-3 text-sm transition-colors hover:bg-surface-2/70"
                    >
                      <span className="font-mono text-ink transition-colors group-hover/t:text-accent">
                        {t.startDate} 起
                      </span>
                      {t.status === "active" ? (
                        <Badge tone="accent">
                          <LiveDot />
                          运行中
                        </Badge>
                      ) : (
                        <Badge>已停止</Badge>
                      )}
                      <span className="ml-auto text-xs text-muted">跟踪超额</span>
                      <span className={cx("tabular w-16 text-right font-medium", tone(t.excess))}>
                        {t.excess === null ? NA : pct(t.excess)}
                      </span>
                      <IconChevronRight size={14} className="text-faint" />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty
                art="bamboo"
                title="还没有上线跟踪"
                action={
                  <Button icon={IconGoLive} onClick={() => setTrack(true)}>
                    上线跟踪
                  </Button>
                }
              >
                上线后每个交易日收盘自动结算一次模拟盘，和回测画在同一条线上。
              </Empty>
            )}
          </Card>
        )}
      </div>
      <BacktestDialog versionId={version.id} open={backtest} onClose={() => setBacktest(false)} />
      <TrackDialog versionId={version.id} open={track} onClose={() => setTrack(false)} />
    </div>
  );
}

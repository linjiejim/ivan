/**
 * 策略详情：概览（描述 + 最近回测）· 编辑（表单 → 草稿 → 确认）· 版本 · 回测记录（可勾选对比）· 今日选股 · 跟踪。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Radio } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useChatUi } from "../chat/chat-context.tsx";
import { CompareView } from "../components/compare-view.tsx";
import { DiffView } from "../components/diff-view.tsx";
import { ScreenTable } from "../components/screen-table.tsx";
import { SpecEditor } from "../components/spec-editor.tsx";
import {
  Badge,
  Button,
  Card,
  CheckBadges,
  Empty,
  ErrorNote,
  Field,
  Input,
  Modal,
  Spinner,
  Tabs,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { dateTime, MARKET_TEXT, pct, tone } from "../lib/format.ts";
import type { RunSummary, ScreenResult, StrategyDetail } from "../lib/types.ts";

type Tab = "overview" | "edit" | "versions" | "runs" | "screen" | "trackings";

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
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={run.isPending} onClick={() => run.mutate()}>
            开始回测
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
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
        <Field label="初始资金">
          <Input
            type="number"
            value={capital}
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
      <p className="mt-3 text-xs text-muted">
        规则：收盘后决策、次日开盘成交；涨停买不进、跌停卖不出、停牌顺延；持仓含分红再投入；费用按日期生效的费率表。
      </p>
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
      footer={
        p ? (
          <>
            <Button onClick={() => propose.reset()}>返回</Button>
            <Button
              variant="primary"
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
        <div className="space-y-3">
          <p className="text-sm text-ink-2">
            上线后每个交易日收盘后，按这个版本的规则从上线日起重放一遍模拟盘，和回测对照。版本固定：以后改策略要重新上线。
          </p>
          <Field label="模拟资金">
            <Input
              type="number"
              value={capital}
              onChange={(e) => setCapital(Number(e.target.value))}
            />
          </Field>
        </div>
      ) : (
        <div className="space-y-2 text-sm">
          <p>
            「{p.strategyName}」v{p.versionN}，{p.startDate} 起，模拟资金{" "}
            {p.capital.toLocaleString()}。
          </p>
          {!p.hasBaseline && (
            <p className="text-warn">
              这个版本还没有跑完的回测，上线后没法和回测比（看板上「跑赢回测同期」会是空的）。建议先回测一次。
            </p>
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
  if (!runs.length) return <Empty title="还没有回测" />;
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs text-muted">
        勾选 2–4 个回测可以对比
        <Button size="sm" disabled={picked.length < 2} onClick={() => setComparing(true)}>
          对比 {picked.length || ""}
        </Button>
      </div>
      <table className="tabular w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            <th className="w-8 py-2" />
            <th className="py-2 font-normal">回测</th>
            <th className="py-2 text-right font-normal">年化</th>
            <th className="py-2 text-right font-normal">年化超额</th>
            <th className="py-2 text-right font-normal">最大回撤</th>
            <th className="py-2 text-right font-normal">夏普</th>
            <th className="py-2 pl-3 font-normal">提示</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-b border-line last:border-0">
              <td className="py-2">
                {r.kind === "backtest" && r.status === "done" && (
                  <input
                    type="checkbox"
                    checked={picked.includes(r.id)}
                    onChange={(e) =>
                      setPicked((p) =>
                        e.target.checked ? [...p, r.id].slice(-4) : p.filter((x) => x !== r.id),
                      )
                    }
                  />
                )}
              </td>
              <td className="py-2">
                <Link to={`/runs/${r.id}`} className="hover:text-accent">
                  {r.kind === "sweep"
                    ? `参数扫描：${r.label}`
                    : `${r.params.start} ~ ${r.params.end}`}
                </Link>
                <div className="text-xs text-muted">{dateTime(r.createdAt)}</div>
              </td>
              {r.headline ? (
                <>
                  <td className={`py-2 text-right ${tone(r.headline.cagr)}`}>
                    {pct(r.headline.cagr)}
                  </td>
                  <td className={`py-2 text-right ${tone(r.headline.excessCagr)}`}>
                    {pct(r.headline.excessCagr)}
                  </td>
                  <td className="py-2 text-right text-ink-2">
                    {pct(r.headline.maxDrawdown, 1, false)}
                  </td>
                  <td className="py-2 text-right text-ink-2">{r.headline.sharpe.toFixed(2)}</td>
                </>
              ) : (
                <td colSpan={4} className="py-2 text-right">
                  <Badge tone={r.status === "failed" ? "warn" : "accent"}>
                    {r.status === "failed" ? "失败" : r.status === "done" ? "完成" : "进行中"}
                  </Badge>
                </td>
              )}
              <td className="py-2 pl-3">
                <CheckBadges checks={r.checks} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Modal open={comparing} onClose={() => setComparing(false)} title="回测对比" wide>
        {comparing && <CompareView ids={picked} />}
      </Modal>
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
  if (q.isLoading) return <Spinner />;
  if (!s || !version) return <ErrorNote error={q.error ?? new Error("策略不存在")} />;
  const lastDone = s.runs.find((r) => r.kind === "backtest" && r.status === "done");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">{s.name}</h1>
        <Badge>{MARKET_TEXT[s.market]}</Badge>
        <Badge tone="accent">v{version.n}</Badge>
        <div className="ml-auto flex gap-2">
          <Button
            onClick={() =>
              chat.ask(`帮我看看这个策略，有什么可以改进的？`, {
                strategyId: s.id,
                versionId: version.id,
              })
            }
          >
            问 AI
          </Button>
          <Button onClick={() => setTrack(true)}>
            <Radio className="size-4" />
            上线跟踪
          </Button>
          <Button variant="primary" onClick={() => setBacktest(true)}>
            <Play className="size-4" />
            回测
          </Button>
        </div>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: "overview", label: "概览" },
          { value: "edit", label: "编辑" },
          { value: "versions", label: `版本 ${s.versions.length}` },
          { value: "runs", label: `回测 ${s.runs.length}` },
          { value: "screen", label: "今日选股" },
          { value: "trackings", label: `跟踪 ${s.trackings.length}` },
        ]}
      />
      {tab === "overview" && (
        <div className="grid gap-4 @4xl:grid-cols-2">
          <Card title="规则" subtitle={version.note ?? undefined}>
            <DiffView changes={[]} describe={version.describe} />
          </Card>
          <Card
            title="最近一次回测"
            action={
              lastDone && (
                <Link to={`/runs/${lastDone.id}`} className="text-xs text-accent">
                  完整报告
                </Link>
              )
            }
          >
            {lastDone?.headline ? (
              <div className="space-y-2 text-sm">
                <div className="text-xs text-muted">
                  {lastDone.params.start} ~ {lastDone.params.end}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <div className="text-xs text-muted">年化</div>
                    <div className={`text-lg font-semibold ${tone(lastDone.headline.cagr)}`}>
                      {pct(lastDone.headline.cagr)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted">年化超额</div>
                    <div className={`text-lg font-semibold ${tone(lastDone.headline.excessCagr)}`}>
                      {pct(lastDone.headline.excessCagr)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted">最大回撤</div>
                    <div className="text-lg font-semibold">
                      {pct(lastDone.headline.maxDrawdown, 1, false)}
                    </div>
                  </div>
                </div>
                <CheckBadges checks={lastDone.checks} />
              </div>
            ) : (
              <Empty title="还没有跑完的回测">
                <Button size="sm" variant="primary" onClick={() => setBacktest(true)}>
                  现在回测
                </Button>
              </Empty>
            )}
          </Card>
        </div>
      )}
      {tab === "edit" && (
        <Card>
          <SpecEditor key={version.id} strategyId={s.id} initial={version.spec} />
        </Card>
      )}
      {tab === "versions" && (
        <div className="space-y-2">
          {s.versions.map((v) => (
            <Card
              key={v.id}
              title={`v${v.n}${v.id === version.id ? "（当前）" : ""}`}
              subtitle={`${dateTime(v.createdAt)} · ${v.source === "chat" ? "对话" : v.source === "preset" ? "模板" : "表单"}${v.note ? ` · ${v.note}` : ""}`}
            >
              <DiffView changes={[]} describe={v.describe} />
            </Card>
          ))}
        </div>
      )}
      {tab === "runs" && (
        <Card>
          <RunsTab runs={s.runs} />
        </Card>
      )}
      {tab === "screen" && (
        <Card
          title="按当前版本在最新数据日选股"
          subtitle={screen.data ? `数据日 ${screen.data.date}` : undefined}
        >
          {screen.isLoading ? (
            <Spinner />
          ) : screen.data ? (
            <ScreenTable result={screen.data} spec={version.spec} />
          ) : (
            <ErrorNote error={screen.error} />
          )}
        </Card>
      )}
      {tab === "trackings" && (
        <Card>
          {s.trackings.length ? (
            <ul className="divide-y divide-line">
              {s.trackings.map((t) => (
                <li key={t.id} className="flex items-center gap-3 py-2 text-sm">
                  <Link to={`/trackings/${t.id}`} className="hover:text-accent">
                    {t.startDate} 起
                  </Link>
                  <Badge tone={t.status === "active" ? "accent" : "neutral"}>
                    {t.status === "active" ? "运行中" : "已停止"}
                  </Badge>
                  <span className={`ml-auto tabular ${tone(t.excess)}`}>
                    跟踪超额 {pct(t.excess)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="还没有上线跟踪" />
          )}
        </Card>
      )}
      <BacktestDialog versionId={version.id} open={backtest} onClose={() => setBacktest(false)} />
      <TrackDialog versionId={version.id} open={track} onClose={() => setTrack(false)} />
    </div>
  );
}

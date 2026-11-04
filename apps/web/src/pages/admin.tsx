/**
 * 管理页（spec §10、§11）：用户与额度、试用申请（D109）、邀请码、数据状态与手动触发任务、数据质量（D74）、今日用量、近 14 天 LLM 用量。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PIT_DATASET_IDS, todayCN } from "@ivan/core";
import { useState } from "react";
import {
  IconBrief,
  IconCheck,
  IconChecks,
  IconClock,
  IconData,
  IconInvite,
  IconKey,
  IconMail,
  IconOffline,
  IconRefresh,
  IconUsage,
  IconUsers,
  IconWarn,
} from "../components/icons.tsx";
import { useMe } from "../components/layout.tsx";
import {
  Badge,
  Button,
  Callout,
  Card,
  CopyButton,
  cx,
  DataTable,
  ErrorNote,
  Field,
  Info,
  Input,
  LiveDot,
  Modal,
  MonoDates,
  PageHeader,
  PageSkeleton,
  Td,
  Th,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import {
  canaryBadge,
  canaryInfoText,
  captureLines,
  eventDatasetLine,
  eventsBackfillText,
  issueRuleText,
  openVersionText,
  qualitySentence,
  marketBanner,
  retryBannerText,
  softAlerts,
  sourcesLines,
  versionStatusBadge,
} from "../lib/data-status.ts";
import { dateTime, eventFactorsText, MARKET_TEXT, NA } from "../lib/format.ts";
import { usePageTitle } from "../lib/title.ts";
import type {
  DataQuality,
  DataStatus,
  EventFactorsStatus,
  EventsEstimate,
  EventsStatus,
} from "../lib/types.ts";
import { quotaPatch } from "../lib/verify.ts";

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: number;
  quota: { chatMessages: number; backtests: number; analyses: number };
  usageToday: {
    chatMessages: number;
    backtests: number;
    analyses?: number;
    tokensIn: number;
    tokensOut: number;
  } | null;
}
interface UsageDay {
  day: string;
  chatMessages: number;
  backtests: number;
  analyses: number | null;
  chatTokens: number;
  briefTokens: number;
  /** 数字核对没通过的助手回复条数（D69） */
  groundingFlagged?: number;
}
interface Invite {
  id: string;
  code: string;
  note: string | null;
  createdAt: number;
  expiresAt: number | null;
  usedBy: string | null;
  usedAt: number | null;
}
interface TrialRequest {
  id: string;
  email: string;
  name: string | null;
  message: string | null;
  status: "pending" | "invited" | "dismissed";
  inviteCode: string | null;
  notifyError: string | null;
  createdAt: number;
}
interface TrialRequests {
  enabled: boolean;
  /** 新申请会不会发邮件提醒管理员 */
  notifies: boolean;
  requests: TrialRequest[];
}
interface TrialInviteResult {
  code: string;
  link: string;
  emailed: boolean;
  emailError: string | null;
}
interface JobRow {
  id: string;
  kind: string;
  status: string;
  progress: number;
  note: string | null;
  error: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
  finishedAt: number | null;
}

const JOB_TEXT: Record<string, string> = {
  etl: "更新数据",
  settle: "结算跟踪",
  brief: "生成简报",
  backfill: "回填",
  check: "抽检",
  backtest: "回测",
  sweep: "参数扫描",
  sweep_child: "扫描子任务",
  verify: "复核数据",
  events: "补齐两融与筹码数据",
  event_cols: "补算事件因子",
};
const STATUS: Record<string, { text: string; tone: "neutral" | "accent" | "warn" }> = {
  queued: { text: "排队中", tone: "neutral" },
  running: { text: "进行中", tone: "accent" },
  done: { text: "完成", tone: "neutral" },
  failed: { text: "失败", tone: "warn" },
};

const QUOTA_FIELDS = [
  { key: "chatMessages", label: "对话", aria: "每日对话额度" },
  { key: "backtests", label: "回测", aria: "每日回测额度" },
  { key: "analyses", label: "数据查询", aria: "数据查询（次/天）" },
] as const;
type QuotaKey = (typeof QUOTA_FIELDS)[number]["key"];

/** 逐人额度：只提交改过的那几项，没动的不会被钉成当前默认值 */
function QuotaEditor({ u }: { u: AdminUser }) {
  const qc = useQueryClient();
  const initial: Record<QuotaKey, string> = {
    chatMessages: String(u.quota.chatMessages),
    backtests: String(u.quota.backtests),
    analyses: String(u.quota.analyses),
  };
  const [values, setValues] = useState<Record<QuotaKey, string>>(initial);
  const patch = quotaPatch(initial, values);
  const dirty = Object.keys(patch).length > 0;
  const save = useMutation({
    mutationFn: () => api.post(`/api/admin/users/${u.id}/quota`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-users"] }),
  });
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs text-muted">
      {QUOTA_FIELDS.map((f) => (
        <span key={f.key} className="inline-flex items-center gap-1.5">
          {f.label}
          <Input
            aria-label={f.aria}
            title={f.aria}
            className="tabular h-7 w-16 px-2 text-xs"
            inputMode="numeric"
            value={values[f.key]}
            onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
          />
        </span>
      ))}
      <Button
        size="sm"
        variant={dirty ? "primary" : "ghost"}
        icon={!dirty && save.isSuccess ? IconCheck : undefined}
        loading={save.isPending}
        disabled={!dirty}
        onClick={() => save.mutate()}
      >
        {!dirty && save.isSuccess ? "已保存" : "保存"}
      </Button>
    </span>
  );
}

/** 重置密码：v1 没有邮件服务，管理员直接给一个新密码 */
function ResetPasswordDialog({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const reset = useMutation({
    mutationFn: () => api.post(`/api/admin/users/${user!.id}/password`, { password }),
  });
  const close = () => {
    setPassword("");
    reset.reset();
    onClose();
  };
  return (
    <Modal
      open={!!user}
      onClose={close}
      title="重置密码"
      icon={IconKey}
      footer={
        reset.isSuccess ? (
          <Button variant="primary" onClick={close}>
            完成
          </Button>
        ) : (
          <>
            <Button onClick={close}>取消</Button>
            <Button
              variant="primary"
              loading={reset.isPending}
              disabled={password.length < 8}
              onClick={() => reset.mutate()}
            >
              重置
            </Button>
          </>
        )
      }
    >
      {reset.isSuccess ? (
        <Callout tone="info" icon={IconCheck} title="已重置">
          把新密码告诉 {user?.email}，他们下次登录时用它。
        </Callout>
      ) : (
        <Field label={`给 ${user?.email ?? ""} 设一个新密码`} hint="至少 8 位">
          <Input
            type="text"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            spellCheck={false}
            className="font-mono"
          />
        </Field>
      )}
      <ErrorNote error={reset.error} />
    </Modal>
  );
}

/**
 * 数据质量（D74）：近 7 天按规则统计的拦截与标记、问题最多的代码、未解决的问题；每条可以「标为已核对」。
 * 拒收 = warn，标记 = neutral。
 */
export function DataQualityCard({ quality }: { quality: DataQuality | null }) {
  const qc = useQueryClient();
  const resolve = useMutation({
    mutationFn: (id: number) => api.post(`/api/admin/data-issues/${id}/resolve`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-data"] }),
  });
  return (
    <Card
      title="数据质量"
      icon={IconChecks}
      subtitle={quality ? qualitySentence(quality) : "行情服务没有运行，暂时看不到"}
      info="写入日线前的体检：价格关系不对、成交量为负、日期不是交易日的日线不入库（拦下），这只股票这天按缺失处理；其余异常只标记，不影响写入。不同来源对不上时只标记，不自动改。标为已核对后不再计入回测的「数据问题」提示。"
    >
      {quality && (
        <div className="space-y-4">
          {quality.byRule.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {quality.byRule.map((r) => (
                <Badge
                  key={`${r.rule}-${r.severity}`}
                  tone={r.severity === "reject" ? "warn" : "neutral"}
                >
                  {issueRuleText(r.rule)} {r.n}
                  {r.severity === "reject" ? " 拦下" : r.open ? ` 待核 ${r.open}` : ""}
                </Badge>
              ))}
            </div>
          )}
          {quality.topCodes.length > 0 && (
            <p className="text-xs text-ink-2">
              问题最多：
              {quality.topCodes
                .slice(0, 5)
                .map((c) => `${c.name ?? c.code}（${c.code}）${c.n} 处`)
                .join("、")}
            </p>
          )}
          <ErrorNote error={resolve.error} />
          {quality.open.length ? (
            <DataTable minWidth={640}>
              <thead>
                <tr>
                  <Th>日期</Th>
                  <Th>股票</Th>
                  <Th>问题</Th>
                  <Th>说明</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {quality.open.map((o) => (
                  <tr key={o.id}>
                    <Td className="font-mono text-[12px] whitespace-nowrap text-muted">{o.date}</Td>
                    <Td className="whitespace-nowrap">
                      <span className="text-ink">{o.name ?? o.code}</span>{" "}
                      <span className="font-mono text-[12px] text-muted">{o.code}</span>
                    </Td>
                    <Td>
                      <Badge tone={o.severity === "reject" ? "warn" : "neutral"}>
                        {issueRuleText(o.rule)}
                      </Badge>
                    </Td>
                    <Td className="text-xs text-ink-2">
                      <span className="line-clamp-2">{o.detail ?? ""}</span>
                    </Td>
                    <Td align="right">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={IconCheck}
                        loading={resolve.isPending && resolve.variables === o.id}
                        onClick={() => resolve.mutate(o.id)}
                      >
                        标为已核对
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          ) : (
            <p className="text-sm text-muted">没有待核的数据问题。</p>
          )}
        </div>
      )}
    </Card>
  );
}

/** 「补齐历史数据」确认框：估算（4 个计数请求）+ 分段执行的说明；确认后排一个 events 任务 */
function EventsBackfillDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const estimate = useQuery({
    queryKey: ["admin-events-estimate"],
    queryFn: () => api.get<EventsEstimate>("/api/admin/events/estimate"),
    enabled: open,
    staleTime: 3_600_000,
  });
  const start = useMutation({
    mutationFn: () => api.post<{ jobId: string }>("/api/admin/events/backfill", {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-data"] });
      close();
    },
  });
  const close = () => {
    start.reset();
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={close}
      title="补齐两融与筹码的历史数据"
      icon={IconData}
      footer={
        <>
          <Button onClick={close}>取消</Button>
          <Button variant="primary" loading={start.isPending} onClick={() => start.mutate()}>
            开始补齐
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-ink-2">
        <p>从 2013 年起补齐两融明细、股东户数、限售解禁与大宗交易，已经补过的部分会跳过。</p>
        {estimate.isLoading ? (
          <p className="text-muted">正在估算请求数…</p>
        ) : estimate.data ? (
          <ul className="space-y-0.5 text-xs">
            {estimate.data.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        ) : null}
        <ErrorNote error={estimate.error} />
        <Callout tone="neutral" icon={IconClock}>
          后台分段执行，每段最多 10 分钟，16:30-21:00 暂停，不影响回测与夜间更新
        </Callout>
        <ErrorNote error={start.error} />
      </div>
    </Modal>
  );
}

/** 数据卡里的「两融与筹码数据」（S15）：每个数据集的覆盖、数据日与接口自检，后台回填进度 */
function EventsSection({
  events,
  eventFactors,
  onBackfill,
}: {
  events: EventsStatus;
  eventFactors?: EventFactorsStatus;
  onBackfill: () => void;
}) {
  const running = eventsBackfillText(events.backfill);
  // 事件因子列的按年补算（S15b）
  const factorsLine = eventFactorsText(eventFactors);
  return (
    <div className="mt-4 rounded-lg bg-surface-2/70 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-muted">两融与筹码数据</div>
        <Button
          size="sm"
          variant="ghost"
          icon={IconRefresh}
          disabled={!!running}
          onClick={onBackfill}
        >
          补齐历史数据
        </Button>
      </div>
      <ul className="mt-1 space-y-1 text-2xs text-ink-2">
        {PIT_DATASET_IDS.map((id) => {
          const d = events.datasets[id];
          if (!d) return null;
          const badge = canaryBadge(d.canary);
          return (
            <li key={id} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span>
                <MonoDates text={eventDatasetLine(d)} /> · 接口
              </span>
              {badge ? <Badge tone={badge.tone}>{badge.text}</Badge> : <span>--</span>}
              <Info label={`${d.label}接口自检：说明`}>{canaryInfoText(d)}</Info>
            </li>
          );
        })}
      </ul>
      {running && (
        <div className="mt-2 inline-flex items-center gap-1 text-2xs text-accent">
          <LiveDot />
          {running}
        </div>
      )}
      {factorsLine && (
        <div className="mt-1.5 flex items-center gap-1 text-2xs text-ink-2">
          {eventFactors && !eventFactors.complete && eventFactors.backfillComplete !== false && (
            <LiveDot />
          )}
          {factorsLine}
          <Info label="事件因子：说明">
            7 个两融与筹码因子按年补算历史（每次一年、北京时间 16:30–21:00
            不补），不重算已有因子；补完之前用到它们的回测会被拒绝，今天的选股可以先用。
          </Info>
        </div>
      )}
    </div>
  );
}

/** 试用申请（D109）：待处理的在前，发邀请（配了发信就直接发到对方邮箱）或忽略；已处理的只留最近 10 条 */
function TrialRequestsCard() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["admin-trial-requests"],
    queryFn: () => api.get<TrialRequests>("/api/admin/trial-requests"),
  });
  const [results, setResults] = useState<Record<string, TrialInviteResult>>({});
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["admin-trial-requests"] });
    void qc.invalidateQueries({ queryKey: ["admin-invites"] });
  };
  const invite = useMutation({
    mutationFn: (id: string) =>
      api.post<TrialInviteResult>(`/api/admin/trial-requests/${id}/invite`),
    onSuccess: (r, id) => {
      setResults((prev) => ({ ...prev, [id]: r }));
      refresh();
    },
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => api.post(`/api/admin/trial-requests/${id}/dismiss`),
    onSuccess: refresh,
  });
  const data = q.data;
  if (!data || (!data.enabled && data.requests.length === 0)) return null;
  const pending = data.requests.filter((r) => r.status === "pending");
  // 刚处理过的（有结果要看：邮件没发出去时的复制链接）不受「最近 10 条」限制
  const handled = data.requests.filter(
    (r, i, all) =>
      r.status !== "pending" &&
      (results[r.id] !== undefined ||
        all.slice(0, i).filter((x) => x.status !== "pending").length < 10),
  );
  const subtitle = !data.enabled
    ? "登录页已关闭申请；下面是以前的记录"
    : data.notifies
      ? "登录页可以申请；新申请会发邮件提醒你"
      : "登录页可以申请；没配发信，新申请只记在这里";
  return (
    <Card
      title={pending.length ? `试用申请 · ${pending.length} 条待处理` : "试用申请"}
      icon={IconMail}
      subtitle={subtitle}
    >
      {data.requests.length === 0 ? (
        <p className="text-sm text-muted">还没有人申请。</p>
      ) : (
        <ul>
          {[...pending, ...handled].map((r) => {
            const result = results[r.id];
            const busy =
              (invite.isPending && invite.variables === r.id) ||
              (dismiss.isPending && dismiss.variables === r.id);
            return (
              <li key={r.id} className="border-b border-line py-3 text-sm last:border-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span
                    className={cx(
                      "font-medium",
                      r.status === "pending" ? "text-ink" : "text-muted",
                    )}
                  >
                    {r.email}
                  </span>
                  {r.name && <span className="text-ink-2">{r.name}</span>}
                  {r.status === "invited" && <Badge tone="accent">已邀请</Badge>}
                  {r.status === "dismissed" && <Badge>已忽略</Badge>}
                  {r.notifyError && (
                    <span title={r.notifyError}>
                      <Badge tone="warn" icon={IconWarn} iconWeight="fill">
                        提醒没发出去
                      </Badge>
                    </span>
                  )}
                  <span className="ml-auto font-mono text-[11px] text-muted">
                    {dateTime(r.createdAt)}
                  </span>
                </div>
                {r.message && (
                  <p className="mt-1 text-[13px] leading-6 whitespace-pre-line text-ink-2">
                    {r.message}
                  </p>
                )}
                {r.status === "pending" && (
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      icon={IconInvite}
                      loading={invite.isPending && invite.variables === r.id}
                      disabled={busy}
                      onClick={() => invite.mutate(r.id)}
                    >
                      发邀请
                    </Button>
                    <Button
                      size="sm"
                      loading={dismiss.isPending && dismiss.variables === r.id}
                      disabled={busy}
                      onClick={() => dismiss.mutate(r.id)}
                    >
                      忽略
                    </Button>
                  </div>
                )}
                {result &&
                  (result.emailed ? (
                    <p className="mt-2 flex items-center gap-1.5 text-[13px] text-ink-2">
                      <IconCheck size={14} className="text-accent" />
                      注册链接已发到对方邮箱
                    </p>
                  ) : (
                    <Callout
                      tone="warn"
                      className="mt-2 text-[13px]"
                      action={<CopyButton text={result.link} label="复制注册链接" />}
                    >
                      邮件没发出去（{result.emailError}），复制注册链接自己发给对方。
                    </Callout>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
      <ErrorNote error={invite.error ?? dismiss.error} />
    </Card>
  );
}

export function AdminPage() {
  usePageTitle("管理");
  const me = useMe();
  const qc = useQueryClient();
  const isAdmin = me.data?.user.role === "admin";
  const users = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => api.get<AdminUser[]>("/api/admin/users"),
    enabled: isAdmin,
  });
  const invites = useQuery({
    queryKey: ["admin-invites"],
    queryFn: () => api.get<Invite[]>("/api/admin/invites"),
    enabled: isAdmin,
  });
  const data = useQuery({
    queryKey: ["admin-data"],
    queryFn: () =>
      api.get<{ status: DataStatus; quality: DataQuality | null; jobs: JobRow[] }>(
        "/api/admin/data",
      ),
    enabled: isAdmin,
    refetchInterval: 5000,
  });
  const usage = useQuery({
    queryKey: ["admin-usage"],
    queryFn: () => api.get<UsageDay[]>("/api/admin/usage"),
    enabled: isAdmin,
  });
  const [note, setNote] = useState("");
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const [eventsOpen, setEventsOpen] = useState(false);
  const createInvite = useMutation({
    mutationFn: () => api.post<{ code: string }>("/api/admin/invites", { note, days: 14 }),
    onSuccess: () => {
      setNote("");
      void qc.invalidateQueries({ queryKey: ["admin-invites"] });
    },
  });
  const trigger = useMutation({
    mutationFn: (b: { kind: string; market?: string }) => api.post("/api/admin/etl", b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-data"] }),
  });
  if (me.isLoading) return <PageSkeleton stats={0} />;
  if (!isAdmin) return <ErrorNote error={new Error("只有管理员能看这个页面")} />;
  const inviteLink = (code: string) => `${location.origin}/register?invite=${code}`;
  const busy = (kind: string, market?: string) =>
    trigger.isPending && trigger.variables?.kind === kind && trigger.variables?.market === market;
  const status = data.data?.status;
  return (
    <div className="space-y-6">
      <PageHeader
        title="管理"
        meta={<span>夜间任务：工作日北京时间 17:30 A 股、18:00 港股、19:00 简报</span>}
      />

      <Card
        title="数据"
        icon={IconData}
        action={
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              icon={IconRefresh}
              loading={busy("etl", "A")}
              onClick={() => trigger.mutate({ kind: "etl", market: "A" })}
            >
              更新 A 股
            </Button>
            <Button
              size="sm"
              icon={IconRefresh}
              loading={busy("etl", "HK")}
              onClick={() => trigger.mutate({ kind: "etl", market: "HK" })}
            >
              更新港股
            </Button>
            <Button
              size="sm"
              icon={IconBrief}
              loading={busy("brief")}
              onClick={() => trigger.mutate({ kind: "brief" })}
            >
              生成简报
            </Button>
          </div>
        }
      >
        {status && !status.workerUp && (
          <Callout
            tone="warn"
            icon={IconOffline}
            title="行情服务（worker）没有运行"
            className="mb-4"
          >
            手动任务会排队，等 worker 起来后才执行。
          </Callout>
        )}
        {status?.maintenance && (
          <Callout tone="warn" icon={IconWarn} title="行情仓维护中" className="mb-4">
            {status.maintenance}。升级完成前不跑夜间更新、回测与结算。
          </Callout>
        )}
        {status?.computePaused && (
          <Callout tone="neutral" icon={IconClock} className="mb-4">
            行情正在更新，回测会在更新完成后开始（{dateTime(status.computePaused.since)} 起）
          </Callout>
        )}
        {/* 辅助数据连续 3 晚失败（D73）：沿用的是旧数据，回测与跟踪也会带提示 */}
        {status?.markets.flatMap(softAlerts).map((text) => (
          <Callout key={text} tone="warn" icon={IconWarn} className="mb-4">
            {text}
          </Callout>
        ))}
        <div className="grid gap-3 sm:grid-cols-2">
          {status?.markets.map((m) => {
            const last = versionStatusBadge(m.lastVersionStatus);
            return (
              <div key={m.market} className="rounded-lg bg-surface-2/70 px-4 py-3">
                <div className="flex items-center gap-2 text-xs text-muted">
                  {MARKET_TEXT[m.market]}
                  {marketBanner(m, true)?.kind === "catch_up" ? (
                    <Badge tone="neutral">
                      补数据中{m.catchUp ? `（第 ${m.catchUp.done}/${m.catchUp.total} 天）` : ""}
                    </Badge>
                  ) : m.lastEtl?.status === "failed" ? (
                    <Badge tone="warn">最近一次更新失败</Badge>
                  ) : m.lastEtl?.retryAt ? (
                    <Badge tone="warn">等自动重试</Badge>
                  ) : status.workerUp ? (
                    <span className="inline-flex items-center gap-1 text-down">
                      <LiveDot />
                      正常
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 font-mono text-lg font-semibold text-ink">{m.asOf ?? NA}</div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted">
                  <span>数据版本 {m.dataVersion ?? NA}</span>
                  {last && (
                    <span className="inline-flex items-center gap-1">
                      上一个版本
                      <Badge tone={last.tone}>{last.text}</Badge>
                    </span>
                  )}
                </div>
                {m.openVersion && (
                  <div className="mt-1 inline-flex items-center gap-1 text-2xs text-accent">
                    <LiveDot />
                    {openVersionText(m.openVersion)}
                  </div>
                )}
                {retryBannerText(m) && (
                  <div className="mt-1 text-2xs text-warn">{retryBannerText(m)}</div>
                )}
                {m.sources && (
                  <ul className="mt-2 space-y-0.5 border-t border-line pt-2 text-2xs">
                    {sourcesLines(m.sources, todayCN()).map((l) => (
                      <li key={l.text} className={l.tone === "warn" ? "text-warn" : "text-ink-2"}>
                        <MonoDates text={l.text} />
                      </li>
                    ))}
                  </ul>
                )}
                {m.capture && (
                  <ul className="mt-2 space-y-0.5 border-t border-line pt-2 text-2xs">
                    {captureLines(m.capture, todayCN()).map((l) => (
                      <li key={l.text} className={l.tone === "warn" ? "text-warn" : "text-ink-2"}>
                        <MonoDates text={l.text} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
        {status?.events && (
          <EventsSection
            events={status.events}
            eventFactors={status.eventFactors}
            onBackfill={() => setEventsOpen(true)}
          />
        )}
        <EventsBackfillDialog open={eventsOpen} onClose={() => setEventsOpen(false)} />
        <ErrorNote error={trigger.error} />
        {data.data?.jobs.length ? (
          <DataTable className="mt-4" minWidth={560}>
            <thead>
              <tr>
                <Th>时间</Th>
                <Th>任务</Th>
                <Th>状态</Th>
                <Th>说明</Th>
              </tr>
            </thead>
            <tbody>
              {data.data.jobs.map((j) => {
                const st = STATUS[j.status] ?? { text: j.status, tone: "neutral" as const };
                return (
                  <tr key={j.id}>
                    <Td className="font-mono text-[12px] whitespace-nowrap text-muted">
                      {dateTime(j.createdAt)}
                    </Td>
                    <Td className="whitespace-nowrap text-ink">
                      {JOB_TEXT[j.kind] ?? j.kind}
                      {j.payload.market ? (
                        <span className="text-muted"> {MARKET_TEXT[String(j.payload.market)]}</span>
                      ) : null}
                    </Td>
                    <Td>
                      <Badge tone={st.tone}>
                        {j.status === "running" && <LiveDot />}
                        {st.text}
                        {j.status === "running" && j.progress > 0
                          ? ` ${Math.round(j.progress * 100)}%`
                          : ""}
                      </Badge>
                    </Td>
                    <Td className={cx("text-xs", j.error ? "text-warn" : "text-ink-2")}>
                      <span className="line-clamp-2">{j.error ?? j.note ?? ""}</span>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        ) : null}
      </Card>

      <DataQualityCard quality={data.data?.quality ?? null} />

      <TrialRequestsCard />

      <Card title="邀请码" icon={IconInvite} subtitle="一次性，14 天有效；把注册链接发给朋友">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            createInvite.mutate();
          }}
        >
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="备注（给谁的）"
          />
          <Button
            type="submit"
            variant="primary"
            icon={IconInvite}
            loading={createInvite.isPending}
          >
            生成
          </Button>
        </form>
        {invites.data?.length ? (
          <ul className="mt-3">
            {invites.data.map((i) => {
              const expired = !i.usedBy && i.expiresAt !== null && i.expiresAt < Date.now();
              return (
                <li
                  key={i.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-2.5 text-sm last:border-0"
                >
                  <code
                    className={cx(
                      "text-[13px] tracking-[0.18em]",
                      i.usedBy || expired ? "text-muted line-through decoration-faint" : "text-ink",
                    )}
                  >
                    {i.code}
                  </code>
                  <span className="min-w-0 truncate text-ink-2">{i.note}</span>
                  {i.usedBy ? (
                    <Badge>已使用</Badge>
                  ) : expired ? (
                    <Badge tone="warn">已过期</Badge>
                  ) : (
                    <CopyButton text={inviteLink(i.code)} label="复制注册链接" />
                  )}
                  <span className="ml-auto font-mono text-[11px] text-muted">
                    {dateTime(i.createdAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
        <ErrorNote error={createInvite.error} />
      </Card>

      <Card
        title="用户与额度"
        icon={IconUsers}
        subtitle="额度按人按天；今日用量从北京时间 0 点起算"
      >
        <DataTable minWidth={900}>
          <thead>
            <tr>
              <Th>用户</Th>
              <Th align="right">今日对话</Th>
              <Th align="right">今日回测</Th>
              <Th align="right">今日数据查询</Th>
              <Th align="right">今日 token</Th>
              <Th>每日额度</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {users.data?.map((u) => (
              <tr key={u.id}>
                <Td className="py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-ink">{u.name}</span>
                    {u.role === "admin" && <Badge tone="accent">管理员</Badge>}
                  </div>
                  <div className="text-xs text-muted">{u.email}</div>
                </Td>
                <Td align="right" className="text-ink-2">
                  {u.usageToday?.chatMessages ?? 0}
                </Td>
                <Td align="right" className="text-ink-2">
                  {u.usageToday?.backtests ?? 0}
                </Td>
                <Td align="right" className="text-ink-2">
                  {u.usageToday?.analyses ?? 0}
                </Td>
                <Td align="right" className="text-ink-2">
                  {(
                    (u.usageToday?.tokensIn ?? 0) + (u.usageToday?.tokensOut ?? 0)
                  ).toLocaleString()}
                </Td>
                <Td>
                  <QuotaEditor u={u} />
                </Td>
                <Td align="right">
                  <Button size="sm" variant="ghost" icon={IconKey} onClick={() => setResetting(u)}>
                    重置密码
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </Card>

      <Card
        title="LLM 用量"
        icon={IconUsage}
        subtitle="近 14 天；夜间简报记在系统账上，不占用户额度"
      >
        {usage.data?.length ? (
          <DataTable>
            <thead>
              <tr>
                <Th>日期</Th>
                <Th align="right">对话条数</Th>
                <Th align="right">回测次数</Th>
                <Th align="right">数据查询</Th>
                <Th align="right">对话 token</Th>
                <Th align="right">简报 token</Th>
                <Th align="right">
                  数字核对未通过
                  <Info label="数字核对未通过：说明">
                    助手回复里有工具结果找不到的数字、在回复下方标注出来的条数。简报的核对不在这里：没通过的简报改用模板，原因写在任务日志里。
                  </Info>
                </Th>
              </tr>
            </thead>
            <tbody>
              {usage.data.map((d) => (
                <tr key={d.day} className="transition-colors hover:bg-surface-2/60">
                  <Td className="font-mono text-[12px] whitespace-nowrap text-ink-2">{d.day}</Td>
                  <Td align="right">{d.chatMessages}</Td>
                  <Td align="right">{d.backtests}</Td>
                  <Td align="right">{d.analyses ?? 0}</Td>
                  <Td align="right">{d.chatTokens.toLocaleString()}</Td>
                  <Td align="right" className="text-ink-2">
                    {d.briefTokens.toLocaleString()}
                  </Td>
                  <Td align="right" className={d.groundingFlagged ? "text-warn" : "text-ink-2"}>
                    {d.groundingFlagged ?? 0}
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        ) : (
          <p className="text-sm text-muted">近 14 天没有用量。</p>
        )}
      </Card>
      <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} />
    </div>
  );
}

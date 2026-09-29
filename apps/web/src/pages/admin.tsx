/**
 * 管理页（spec §10、§11）：用户与额度、邀请码、数据状态与手动触发任务、今日用量、近 14 天 LLM 用量。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  IconBrief,
  IconCheck,
  IconData,
  IconInvite,
  IconKey,
  IconOffline,
  IconRefresh,
  IconUsage,
  IconUsers,
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
  Input,
  LiveDot,
  Modal,
  PageHeader,
  PageSkeleton,
  Td,
  Th,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { dateTime, MARKET_TEXT, NA } from "../lib/format.ts";
import { usePageTitle } from "../lib/title.ts";
import type { DataStatus } from "../lib/types.ts";

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: number;
  quota: { chatMessages: number; backtests: number };
  usageToday: {
    chatMessages: number;
    backtests: number;
    tokensIn: number;
    tokensOut: number;
  } | null;
}
interface UsageDay {
  day: string;
  chatMessages: number;
  backtests: number;
  chatTokens: number;
  briefTokens: number;
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
};
const STATUS: Record<string, { text: string; tone: "neutral" | "accent" | "warn" }> = {
  queued: { text: "排队中", tone: "neutral" },
  running: { text: "进行中", tone: "accent" },
  done: { text: "完成", tone: "neutral" },
  failed: { text: "失败", tone: "warn" },
};

function QuotaEditor({ u }: { u: AdminUser }) {
  const qc = useQueryClient();
  const [chat, setChat] = useState(String(u.quota.chatMessages));
  const [bt, setBt] = useState(String(u.quota.backtests));
  const dirty = chat !== String(u.quota.chatMessages) || bt !== String(u.quota.backtests);
  const save = useMutation({
    mutationFn: () =>
      api.post(`/api/admin/users/${u.id}/quota`, {
        chatMessages: Number(chat),
        backtests: Number(bt),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-users"] }),
  });
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      对话
      <Input
        aria-label="每日对话额度"
        className="tabular h-7 w-16 px-2 text-xs"
        inputMode="numeric"
        value={chat}
        onChange={(e) => setChat(e.target.value)}
      />
      回测
      <Input
        aria-label="每日回测额度"
        className="tabular h-7 w-16 px-2 text-xs"
        inputMode="numeric"
        value={bt}
        onChange={(e) => setBt(e.target.value)}
      />
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
    queryFn: () => api.get<{ status: DataStatus; jobs: JobRow[] }>("/api/admin/data"),
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
        <div className="grid gap-3 sm:grid-cols-2">
          {status?.markets.map((m) => (
            <div key={m.market} className="rounded-lg bg-surface-2/70 px-4 py-3">
              <div className="flex items-center gap-2 text-xs text-muted">
                {MARKET_TEXT[m.market]}
                {m.lastEtl?.status === "failed" ? (
                  <Badge tone="warn">最近一次更新失败</Badge>
                ) : status.workerUp ? (
                  <span className="inline-flex items-center gap-1 text-down">
                    <LiveDot />
                    正常
                  </span>
                ) : null}
              </div>
              <div className="mt-1 font-mono text-lg font-semibold text-ink">{m.asOf ?? NA}</div>
              <div className="text-2xs text-muted">数据版本 {m.dataVersion ?? NA}</div>
            </div>
          ))}
        </div>
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
        <DataTable minWidth={760}>
          <thead>
            <tr>
              <Th>用户</Th>
              <Th align="right">今日对话</Th>
              <Th align="right">今日回测</Th>
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
                <Th align="right">对话 token</Th>
                <Th align="right">简报 token</Th>
              </tr>
            </thead>
            <tbody>
              {usage.data.map((d) => (
                <tr key={d.day} className="transition-colors hover:bg-surface-2/60">
                  <Td className="font-mono text-[12px] text-ink-2">{d.day}</Td>
                  <Td align="right">{d.chatMessages}</Td>
                  <Td align="right">{d.backtests}</Td>
                  <Td align="right">{d.chatTokens.toLocaleString()}</Td>
                  <Td align="right" className="text-ink-2">
                    {d.briefTokens.toLocaleString()}
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

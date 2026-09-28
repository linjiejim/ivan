/**
 * 管理页（spec §10、§11）：用户与额度、邀请码、数据状态与手动触发任务、今日用量、近 14 天 LLM 用量。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Card, ErrorNote, Input, Spinner } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { dateTime, MARKET_TEXT } from "../lib/format.ts";
import type { DataStatus } from "../lib/types.ts";
import { useMe } from "../components/layout.tsx";

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

function QuotaEditor({ u }: { u: AdminUser }) {
  const qc = useQueryClient();
  const [chat, setChat] = useState(String(u.quota.chatMessages));
  const [bt, setBt] = useState(String(u.quota.backtests));
  const save = useMutation({
    mutationFn: () =>
      api.post(`/api/admin/users/${u.id}/quota`, {
        chatMessages: Number(chat),
        backtests: Number(bt),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-users"] }),
  });
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      对话{" "}
      <Input
        className="h-7 w-14 px-1.5 text-xs"
        value={chat}
        onChange={(e) => setChat(e.target.value)}
      />
      回测{" "}
      <Input
        className="h-7 w-14 px-1.5 text-xs"
        value={bt}
        onChange={(e) => setBt(e.target.value)}
      />
      <Button size="sm" loading={save.isPending} onClick={() => save.mutate()}>
        保存
      </Button>
    </span>
  );
}

export function AdminPage() {
  const me = useMe();
  const qc = useQueryClient();
  const users = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => api.get<AdminUser[]>("/api/admin/users"),
    enabled: me.data?.user.role === "admin",
  });
  const invites = useQuery({
    queryKey: ["admin-invites"],
    queryFn: () => api.get<Invite[]>("/api/admin/invites"),
    enabled: me.data?.user.role === "admin",
  });
  const data = useQuery({
    queryKey: ["admin-data"],
    queryFn: () => api.get<{ status: DataStatus; jobs: JobRow[] }>("/api/admin/data"),
    enabled: me.data?.user.role === "admin",
    refetchInterval: 5000,
  });
  const usage = useQuery({
    queryKey: ["admin-usage"],
    queryFn: () => api.get<UsageDay[]>("/api/admin/usage"),
    enabled: me.data?.user.role === "admin",
  });
  const [note, setNote] = useState("");
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
  const resetPwd = useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      api.post(`/api/admin/users/${id}/password`, { password }),
  });
  if (me.isLoading) return <Spinner />;
  if (me.data?.user.role !== "admin")
    return <ErrorNote error={new Error("只有管理员能看这个页面")} />;
  const inviteLink = (code: string) => `${location.origin}/register?invite=${code}`;
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">管理</h1>
      <Card title="数据" subtitle="夜间任务：工作日北京时间 17:30 A 股、18:00 港股、19:00 简报">
        <div className="flex flex-wrap items-center gap-4 text-sm">
          {data.data?.status.markets.map((m) => (
            <span key={m.market}>
              {MARKET_TEXT[m.market]}截至 <b>{m.asOf ?? "—"}</b>（版本 {m.dataVersion ?? "—"}）
            </span>
          ))}
          {data.data && !data.data.status.workerUp && <Badge tone="warn">worker 没有运行</Badge>}
          <div className="ml-auto flex gap-2">
            <Button size="sm" onClick={() => trigger.mutate({ kind: "etl", market: "A" })}>
              更新 A 股
            </Button>
            <Button size="sm" onClick={() => trigger.mutate({ kind: "etl", market: "HK" })}>
              更新港股
            </Button>
            <Button size="sm" onClick={() => trigger.mutate({ kind: "brief" })}>
              生成简报
            </Button>
          </div>
        </div>
        <ErrorNote error={trigger.error} />
        <table className="tabular mt-3 w-full text-xs">
          <tbody>
            {data.data?.jobs.map((j) => (
              <tr key={j.id} className="border-b border-line last:border-0">
                <td className="py-1.5 text-ink-2">{dateTime(j.createdAt)}</td>
                <td className="py-1.5">
                  {j.kind}
                  {j.payload.market ? ` · ${MARKET_TEXT[String(j.payload.market)]}` : ""}
                </td>
                <td className="py-1.5">
                  <Badge
                    tone={
                      j.status === "failed" ? "warn" : j.status === "done" ? "neutral" : "accent"
                    }
                  >
                    {j.status}
                  </Badge>
                </td>
                <td className="py-1.5 text-ink-2">{j.error ?? j.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="邀请码" subtitle="一次性，14 天有效；把注册链接发给朋友">
        <div className="flex gap-2">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="备注（给谁的）"
          />
          <Button
            variant="primary"
            loading={createInvite.isPending}
            onClick={() => createInvite.mutate()}
          >
            生成
          </Button>
        </div>
        <ul className="mt-3 divide-y divide-line text-sm">
          {invites.data?.map((i) => (
            <li key={i.id} className="flex items-center gap-3 py-2">
              <code className="font-mono tracking-widest">{i.code}</code>
              <span className="text-ink-2">{i.note}</span>
              {i.usedBy ? (
                <Badge>已使用</Badge>
              ) : i.expiresAt && i.expiresAt < Date.now() ? (
                <Badge tone="warn">已过期</Badge>
              ) : (
                <button
                  className="inline-flex items-center gap-1 text-xs text-accent"
                  onClick={() => navigator.clipboard.writeText(inviteLink(i.code))}
                >
                  <Copy className="size-3" />
                  复制注册链接
                </button>
              )}
              <span className="ml-auto text-xs text-muted">{dateTime(i.createdAt)}</span>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="用户与额度" subtitle="每人每日额度；今日用量">
        <table className="tabular w-full text-sm">
          <tbody>
            {users.data?.map((u) => (
              <tr key={u.id} className="border-b border-line last:border-0">
                <td className="py-2">
                  <div className="font-medium">{u.name}</div>
                  <div className="text-xs text-muted">{u.email}</div>
                </td>
                <td className="py-2">
                  {u.role === "admin" ? <Badge tone="accent">管理员</Badge> : null}
                </td>
                <td className="py-2 text-xs text-ink-2">
                  今日 对话 {u.usageToday?.chatMessages ?? 0} · 回测 {u.usageToday?.backtests ?? 0}{" "}
                  · token{" "}
                  {(
                    (u.usageToday?.tokensIn ?? 0) + (u.usageToday?.tokensOut ?? 0)
                  ).toLocaleString()}
                </td>
                <td className="py-2">
                  <QuotaEditor u={u} />
                </td>
                <td className="py-2 text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const p = prompt(`给 ${u.email} 设新密码（至少 8 位）`);
                      if (p) resetPwd.mutate({ id: u.id, password: p });
                    }}
                  >
                    重置密码
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ErrorNote error={resetPwd.error} />
        {resetPwd.isSuccess && <p className="mt-2 text-xs text-accent">密码已重置。</p>}
      </Card>
      <Card title="LLM 用量" subtitle="近 14 天；夜间简报记在系统账上，不占用户额度">
        {usage.data?.length ? (
          <table className="tabular w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="py-1.5 font-normal">日期</th>
                <th className="py-1.5 text-right font-normal">对话条数</th>
                <th className="py-1.5 text-right font-normal">回测次数</th>
                <th className="py-1.5 text-right font-normal">对话 token</th>
                <th className="py-1.5 text-right font-normal">简报 token</th>
              </tr>
            </thead>
            <tbody>
              {usage.data.map((d) => (
                <tr key={d.day} className="border-b border-line last:border-0">
                  <td className="py-1.5 text-ink-2">{d.day}</td>
                  <td className="py-1.5 text-right">{d.chatMessages}</td>
                  <td className="py-1.5 text-right">{d.backtests}</td>
                  <td className="py-1.5 text-right">{d.chatTokens.toLocaleString()}</td>
                  <td className="py-1.5 text-right">{d.briefTokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted">近 14 天没有用量。</p>
        )}
      </Card>
    </div>
  );
}

/**
 * 登录 / 注册（D11）：空库第一个注册的人自动成为管理员，之后注册要邀请码。
 */
import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button, ErrorNote, Field, Input } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { authClient } from "../lib/auth.ts";

function Shell({ title, children, foot }: { title: string; children: ReactNode; foot: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2 text-lg font-semibold">
          <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-white">
            <BarChart3 className="size-4" />
          </span>
          Ivan
        </div>
        <div className="rounded-xl border border-line bg-surface p-5">
          <h1 className="mb-4 text-base font-semibold">{title}</h1>
          {children}
        </div>
        <p className="mt-4 text-center text-sm text-muted">{foot}</p>
        <p className="mt-6 text-center text-[11px] text-muted">仅供研究，不构成投资建议。</p>
      </div>
    </div>
  );
}

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const r = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (r.error) return setErr(new Error(r.error.message ?? "登录失败"));
    navigate(params.get("next") ?? "/");
  };
  return (
    <Shell
      title="登录"
      foot={
        <Link to="/register" className="text-accent">
          没有账号？用邀请码注册
        </Link>
      }
    >
      <form onSubmit={submit} className="space-y-3">
        <Field label="邮箱">
          <Input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </Field>
        <Field label="密码">
          <Input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </Field>
        <ErrorNote error={err} />
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          登录
        </Button>
      </form>
    </Shell>
  );
}

export function RegisterPage() {
  const setup = useQuery({
    queryKey: ["setup"],
    queryFn: () => api.get<{ needsAdmin: boolean }>("/api/setup"),
  });
  const [params] = useSearchParams();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState(params.get("invite") ?? "");
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const first = setup.data?.needsAdmin;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const r = await authClient.signUp.email(
      { email, password, name: name || email.split("@")[0]! },
      { headers: invite ? { "x-invite-code": invite.trim().toUpperCase() } : {} },
    );
    setBusy(false);
    if (r.error) return setErr(new Error(r.error.message ?? "注册失败"));
    navigate("/");
  };
  return (
    <Shell
      title={first ? "创建管理员账号" : "注册"}
      foot={
        <Link to="/login" className="text-accent">
          已有账号，去登录
        </Link>
      }
    >
      {first && (
        <p className="mb-3 rounded-lg bg-info-bg px-3 py-2 text-xs text-ink-2">
          这是这个实例的第一个账号，会自动成为管理员，不需要邀请码。
        </p>
      )}
      <form onSubmit={submit} className="space-y-3">
        <Field label="名字">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="怎么称呼你" />
        </Field>
        <Field label="邮箱">
          <Input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </Field>
        <Field label="密码" hint="至少 8 位">
          <Input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
        {!first && (
          <Field label="邀请码" hint="向管理员要一个">
            <Input
              required
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
              className="uppercase tracking-widest"
            />
          </Field>
        )}
        <ErrorNote error={err} />
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          注册
        </Button>
      </form>
    </Shell>
  );
}

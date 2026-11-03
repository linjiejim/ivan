/**
 * 登录 / 注册（D11）：空库第一个注册的人自动成为管理员，之后注册要邀请码；没有邀请码的人可以申请试用（D109）。
 * 这是品牌的第一面：整幅水墨（山脊是一条从淡到浓、一路上扬的净值线），表单落在留白的那一半纸上。
 */
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import tallArt from "../assets/ink/auth-tall.webp";
import wideArt from "../assets/ink/auth-wide.webp";
import { Wordmark } from "../components/brand.tsx";
import { IconArrowRight, IconHide, IconSend, IconShow, IconSuccess } from "../components/icons.tsx";
import { Button, Callout, ErrorNote, Field, Input, Textarea } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { authClient } from "../lib/auth.ts";
import { usePageTitle } from "../lib/title.ts";

function Shell({ title, children, foot }: { title: string; children: ReactNode; foot: ReactNode }) {
  return (
    <div className="relative isolate min-h-dvh overflow-hidden bg-(--art-paper)">
      <picture className="pointer-events-none absolute inset-0 -z-10">
        <source media="(min-width: 1024px)" srcSet={wideArt} />
        <img
          src={tallArt}
          alt=""
          className="ink-art size-full object-cover object-bottom lg:object-[70%_60%]"
          draggable={false}
        />
      </picture>
      <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-6 py-8 sm:px-10 lg:py-10">
        <Wordmark size="lg" />
        <div className="flex flex-1 flex-col justify-center py-8 lg:max-w-[400px] lg:py-10">
          <h1 className="animate-enter text-[28px] leading-[1.3] font-semibold tracking-[0.01em] text-ink sm:text-[34px]">
            先让历史检验，
            <br />
            再交给时间。
          </h1>
          <p className="mt-3 max-w-[30em] animate-enter text-sm leading-6 text-ink-2 [animation-delay:60ms]">
            说出选股思路，AI 写成规则、引擎在点时正确的数据上回测；
            <span className="inline-block">上线后每个交易日收盘自动跟踪。</span>
          </p>
          <section
            aria-label={title}
            className="mt-8 animate-enter rounded-2xl border border-line bg-surface/90 p-6 shadow-pop backdrop-blur-sm [animation-delay:120ms]"
          >
            <h2 className="mb-5 text-base font-semibold text-ink">{title}</h2>
            {children}
          </section>
          <p className="mt-5 animate-enter text-sm text-ink-2 [animation-delay:160ms]">{foot}</p>
        </div>
        <p className="text-2xs text-muted">仅供研究，不构成投资建议。数据来自第三方公开接口。</p>
      </div>
    </div>
  );
}

/** 密码框：右侧可以切换显示，省得输错两遍 */
function PasswordInput({
  value,
  onChange,
  autoComplete,
  minLength,
}: {
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  minLength?: number;
}) {
  const [shown, setShown] = useState(false);
  const Ico = shown ? IconHide : IconShow;
  return (
    <span className="relative block">
      <Input
        type={shown ? "text" : "password"}
        required
        minLength={minLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        className="pr-10"
      />
      <button
        type="button"
        onClick={() => setShown(!shown)}
        aria-label={shown ? "隐藏密码" : "显示密码"}
        aria-pressed={shown}
        className="absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <Ico size={16} />
      </button>
    </span>
  );
}

/** 空库要不要建管理员、这个实例开没开放试用申请 */
function useSetup() {
  return useQuery({
    queryKey: ["setup"],
    queryFn: () => api.get<{ needsAdmin: boolean; trialRequests?: boolean }>("/api/setup"),
  });
}

function FootLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="group/foot inline-flex items-center gap-1 font-medium text-accent transition-colors hover:text-accent-strong"
    >
      {children}
      <IconArrowRight
        size={14}
        className="transition-transform duration-150 group-hover/foot:translate-x-0.5"
      />
    </Link>
  );
}

export function LoginPage() {
  usePageTitle("登录");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const trial = useSetup().data?.trialRequests;
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
        <>
          没有账号？<FootLink to="/register">用邀请码注册</FootLink>
          {trial && (
            <span className="mt-1.5 block">
              没有邀请码？<FootLink to="/apply">申请试用</FootLink>
            </span>
          )}
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="邮箱">
          <Input
            type="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </Field>
        <Field label="密码">
          <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" />
        </Field>
        <ErrorNote error={err} className="mt-0" />
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          登录
        </Button>
      </form>
    </Shell>
  );
}

export function RegisterPage() {
  usePageTitle("注册");
  const setup = useSetup();
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
        <>
          已有账号？<FootLink to="/login">去登录</FootLink>
        </>
      }
    >
      {first && (
        <Callout tone="info" className="mb-4 text-xs leading-5">
          这是这个实例的第一个账号，会自动成为管理员，不需要邀请码。
        </Callout>
      )}
      <form onSubmit={submit} className="space-y-4">
        <Field label="名字" hint="其他人看到的称呼，可以不填">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="nickname" />
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
          <PasswordInput
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            minLength={8}
          />
        </Field>
        {!first && (
          <Field
            label="邀请码"
            hint={
              setup.data?.trialRequests ? (
                <>
                  没有的话可以
                  <Link to="/apply" className="text-accent hover:text-accent-strong">
                    申请一个
                  </Link>
                  ；注册链接里带的会自动填好
                </>
              ) : (
                "向管理员要一个；注册链接里带的会自动填好"
              )
            }
          >
            <Input
              required
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
              className="font-mono tracking-[0.2em] uppercase"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        )}
        <ErrorNote error={err} className="mt-0" />
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          {first ? "创建并进入" : "注册"}
        </Button>
      </form>
    </Shell>
  );
}

export function ApplyPage() {
  usePageTitle("申请试用");
  const setup = useSetup();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.post("/api/trial-requests", { email, name, message, website });
      setDone(true);
    } catch (error) {
      setErr(error);
    } finally {
      setBusy(false);
    }
  };
  const closed = setup.data && !setup.data.trialRequests;
  return (
    <Shell
      title="申请试用"
      foot={
        <>
          已经有邀请码？<FootLink to="/register">去注册</FootLink>
        </>
      }
    >
      {done ? (
        <Callout tone="info" icon={IconSuccess} className="text-sm leading-6">
          收到了。看过之后会把注册链接发到 <span className="font-medium text-ink">{email}</span>
          ，一般一两天内。
        </Callout>
      ) : closed ? (
        <Callout tone="neutral" className="text-sm leading-6">
          这个实例没有开放申请，向管理员要一个邀请码吧。
        </Callout>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="邮箱" hint="邀请码会发到这里，只用来联系你">
            <Input
              type="email"
              required
              autoFocus
              maxLength={200}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </Field>
          <Field label="怎么称呼" hint="可以不填">
            <Input
              maxLength={50}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="nickname"
            />
          </Field>
          <Field label="想用 Ivan 看什么" hint="比如想验证的选股思路，一两句就够；可以不填">
            <Textarea
              rows={3}
              maxLength={1000}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </Field>
          {/* 蜜罐：人看不到也点不到，脚本才会填 */}
          <div aria-hidden className="absolute -left-[9999px] size-px overflow-hidden">
            <input
              tabIndex={-1}
              autoComplete="off"
              name="website"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </div>
          <ErrorNote error={err} className="mt-0" />
          <Button type="submit" variant="primary" icon={IconSend} className="w-full" loading={busy}>
            提交申请
          </Button>
        </form>
      )}
    </Shell>
  );
}

/**
 * HTTP 层（Hono）：鉴权、业务接口、SSE 进度、管理接口；生产环境顺带托管前端构建产物。
 */
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  addDays,
  describeSpec,
  factorsForMarket,
  isDateStr,
  type Market,
  PRESETS,
  toCode,
  todayCN,
  validateSpec,
} from "@ivan/core";
import { invites, jobs, newId, runs, signalDatasets, userQuotas, usageDaily } from "@ivan/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { Auth } from "./auth.ts";
import { env } from "./env.ts";
import { AppError, forbidden } from "./lib/errors.ts";
import { QUOTA_KINDS, type QuotaKind, quotaOf, usageToday } from "./lib/quota.ts";
import { worker } from "./lib/worker-client.ts";
import { dashboard, dataStatus } from "./services/dashboard.ts";
import { exportTracking, listEntries, planOn, verifyUser } from "./services/ledger.ts";
import { getSnapshot, listSnapshots, planOutcomes } from "./services/plans.ts";
import { securityEvidence } from "./services/evidence.ts";
import {
  compareRuns,
  enqueueBacktest,
  enqueueSweep,
  getRun,
  getTrades,
  listRuns,
  queryRun,
  reproduceRun,
  runCard,
  type RunQuery,
  verifyRun,
} from "./services/runs.ts";
import {
  confirmDraft,
  createFromPreset,
  discardDraft,
  getDraft,
  getStrategy,
  getVersion,
  listStrategies,
  proposeStrategy,
  setArchived,
} from "./services/strategies.ts";
import {
  getTracking,
  listTrackings,
  proposeTracking,
  stopTracking,
  trackingChart,
  verdictView,
} from "./services/trackings.ts";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

export type AppEnv = { Variables: { user: SessionUser } };

export function user(c: Context<AppEnv>): SessionUser {
  const u = c.get("user");
  if (!u) throw new AppError(401, "请先登录");
  return u;
}

async function body<T = Record<string, unknown>>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new AppError(400, "请求体不是合法 JSON");
  }
}

const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function inviteCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++)
    s += INVITE_ALPHABET[Math.floor(Math.random() * INVITE_ALPHABET.length)];
  return s;
}

export function createApp(auth: Auth, extraRoutes?: (app: Hono<AppEnv>) => void) {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof AppError)
      return c.json({ error: err.message, detail: err.detail }, err.status);
    console.error(err);
    return c.json({ error: "服务器内部错误" }, 500);
  });

  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  // 除鉴权与健康检查外，/api/* 都要登录
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/health" || c.req.path === "/api/setup") return next();
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "请先登录" }, 401);
    const u = session.user as unknown as SessionUser;
    c.set("user", { id: u.id, email: u.email, name: u.name, role: u.role ?? "user" });
    return next();
  });
  const admin = (c: Context<AppEnv>) => {
    const u = user(c);
    if (u.role !== "admin") throw forbidden();
    return u;
  };

  app.get("/api/health", (c) => c.json({ ok: true }));
  /** 注册页需要知道是不是空库（空库第一个人不需要邀请码） */
  app.get("/api/setup", (c) => {
    const { sqlite } = env().app;
    const n = (sqlite.prepare(`SELECT count(*) AS n FROM "user"`).get() as { n: number }).n;
    return c.json({ needsAdmin: n === 0 });
  });

  app.get("/api/me", (c) => {
    const u = user(c);
    return c.json({ user: u, quota: quotaOf(u.id), usage: usageToday(u.id) });
  });

  // ── 因子与模板 ──
  app.get("/api/factors", (c) => {
    const m = (c.req.query("market") ?? "A") as Market;
    return c.json({ market: m, factors: factorsForMarket(m === "HK" ? "HK" : "A") });
  });
  app.get("/api/presets", (c) =>
    c.json(PRESETS.map((p) => ({ ...p, describe: describeSpec(validateSpec(p.spec).spec!) }))),
  );

  // ── 策略 ──
  app.get("/api/strategies", (c) =>
    c.json(listStrategies(user(c).id, c.req.query("archived") === "1")),
  );
  app.post("/api/strategies/from-preset", async (c) => {
    const { presetId } = await body<{ presetId: string }>(c);
    return c.json(createFromPreset(user(c).id, presetId));
  });
  app.get("/api/strategies/:id", (c) => {
    const u = user(c);
    const s = getStrategy(u.id, c.req.param("id"));
    return c.json({
      ...s,
      runs: listRuns(u.id, { strategyId: s.id, limit: 30 }),
      trackings: listTrackings(u.id).filter((t) => t.strategyId === s.id),
    });
  });
  app.post("/api/strategies/:id/archive", async (c) => {
    const { archived } = await body<{ archived: boolean }>(c);
    setArchived(user(c).id, c.req.param("id"), !!archived);
    return c.json({ ok: true });
  });
  app.get("/api/versions/:id", (c) => c.json(getVersion(user(c).id, c.req.param("id"))));

  // ── 草稿（表单编辑器与对话都走这里；确认是唯一的生效入口） ──
  app.post("/api/drafts", async (c) => {
    const b = await body<{ strategyId?: string; spec?: unknown; patch?: []; note?: string }>(c);
    const r = proposeStrategy(user(c).id, b);
    return c.json(r, r.ok ? 200 : 400);
  });
  app.get("/api/drafts/:id", (c) => c.json(getDraft(user(c).id, c.req.param("id"))));
  app.post("/api/drafts/:id/confirm", (c) => c.json(confirmDraft(user(c).id, c.req.param("id"))));
  app.post("/api/drafts/:id/discard", (c) => {
    discardDraft(user(c).id, c.req.param("id"));
    return c.json({ ok: true });
  });

  // ── 回测 ──
  app.post("/api/runs", async (c) => {
    const b = await body<{
      versionId: string;
      start?: string;
      end?: string;
      capital?: number;
      oosMonths?: number;
      exec?: unknown;
    }>(c);
    return c.json(enqueueBacktest(user(c).id, b.versionId, b));
  });
  app.post("/api/runs/sweep", async (c) => {
    const b = await body<{
      versionId: string;
      path: string;
      values: unknown[];
      label?: string;
      start?: string;
      end?: string;
      exec?: unknown;
    }>(c);
    return c.json(enqueueSweep(user(c).id, b.versionId, b, b));
  });
  app.post("/api/runs/compare", async (c) => {
    const { ids } = await body<{ ids: string[] }>(c);
    return c.json(compareRuns(user(c).id, ids));
  });
  app.get("/api/runs", (c) =>
    c.json(
      listRuns(user(c).id, {
        strategyId: c.req.query("strategyId"),
        limit: Number(c.req.query("limit") ?? 20),
      }),
    ),
  );
  app.get("/api/runs/:id", (c) => c.json(getRun(user(c).id, c.req.param("id"))));
  /** 运行卡下载（D57） */
  app.get("/api/runs/:id/card", (c) => {
    const id = c.req.param("id");
    const card = runCard(user(c).id, id);
    c.header("Content-Disposition", `attachment; filename="ivan-run-${id}.json"`);
    return c.json(card);
  });
  /** 复核数据：排一个 compute 任务，立即返回「排队中」 */
  app.post("/api/runs/:id/verify", (c) => c.json(verifyRun(user(c).id, c.req.param("id")), 202));
  /** 完整重跑：新建一次 kind = reproduce 的运行 */
  app.post("/api/runs/:id/reproduce", (c) => c.json(reproduceRun(user(c).id, c.req.param("id"))));
  app.get("/api/runs/:id/trades", (c) =>
    c.json(
      getTrades(user(c).id, c.req.param("id"), {
        code: c.req.query("code"),
        from: c.req.query("from"),
        to: c.req.query("to"),
        limit: Number(c.req.query("limit") ?? 200),
        offset: Number(c.req.query("offset") ?? 0),
      }),
    ),
  );
  app.post("/api/runs/:id/query", async (c) => {
    const q = await body<RunQuery>(c);
    return c.json(queryRun(user(c).id, c.req.param("id"), q));
  });
  /** 进度推送：读 jobs 表直到完成（worker 写进度） */
  app.get("/api/runs/:id/events", (c) => {
    const u = user(c);
    const runId = c.req.param("id");
    getRun(u.id, runId);
    return streamSSE(c, async (stream) => {
      const { db } = env().app;
      for (let i = 0; i < 1800; i++) {
        const r = db
          .select({ status: runs.status, error: runs.error })
          .from(runs)
          .where(eq(runs.id, runId))
          .get();
        const j = db
          .select({ status: jobs.status, progress: jobs.progress, note: jobs.note })
          .from(jobs)
          .where(
            sql`${jobs.kind} IN ('backtest', 'sweep') AND ${jobs.payload} LIKE ${`%${runId}%`}`,
          )
          .orderBy(desc(jobs.createdAt))
          .get();
        await stream.writeSSE({
          event: "progress",
          data: JSON.stringify({
            status: r?.status,
            progress: j?.progress ?? 0,
            note: j?.note ?? null,
            error: r?.error ?? null,
          }),
        });
        if (!r || r.status === "done" || r.status === "failed") break;
        await stream.sleep(700);
      }
    });
  });

  // ── 行情（经 worker） ──
  app.get("/api/screen", async (c) => {
    const u = user(c);
    const { version } = getVersion(u.id, c.req.query("versionId") ?? "");
    const date = c.req.query("date");
    if (date && !isDateStr(date)) throw new AppError(400, "日期格式要是 YYYY-MM-DD");
    return c.json(
      await worker.post("/internal/screen", {
        spec: version.spec,
        date,
        limit: Number(c.req.query("limit") ?? 30),
      }),
    );
  });
  app.get("/api/securities/search", async (c) =>
    c.json(
      await worker.get(
        `/internal/securities/search?q=${encodeURIComponent(c.req.query("q") ?? "")}&market=${c.req.query("market") ?? ""}`,
      ),
    ),
  );
  /**
   * 个股证据（D67）：决策日当时可得的数据，带出处与校验值；给成交日时按前一个交易日取数；
   * 带回测 / 策略版本 / 跟踪时解释它在策略里的名次。计入数据查询额度（D59）。
   */
  app.get("/api/securities/:code/evidence", async (c) =>
    c.json(
      await securityEvidence(user(c).id, c.req.param("code"), {
        decisionDate: c.req.query("decisionDate") || undefined,
        tradeDate: c.req.query("tradeDate") || undefined,
        runId: c.req.query("runId") || undefined,
        versionId: c.req.query("versionId") || undefined,
        trackingId: c.req.query("trackingId") || undefined,
      }),
    ),
  );
  app.get("/api/securities/:code", async (c) =>
    c.json(await worker.get(`/internal/securities/${encodeURIComponent(c.req.param("code"))}`)),
  );

  // ── 跟踪 ──
  app.post("/api/trackings/propose", async (c) => {
    const b = await body<{ versionId: string; capital?: number }>(c);
    return c.json(proposeTracking(user(c).id, b));
  });
  app.get("/api/trackings", (c) => c.json(listTrackings(user(c).id)));
  app.get("/api/trackings/:id", async (c) => {
    const t = getTracking(user(c).id, c.req.param("id"));
    // 判词（D70）要看市场今天的状态与最新数据日
    return c.json({ ...t, ...verdictView(t, await dataStatus()) });
  });
  app.get("/api/trackings/:id/chart", (c) => c.json(trackingChart(user(c).id, c.req.param("id"))));
  app.post("/api/trackings/:id/stop", async (c) => {
    // 停止原因选填：没有请求体也行（旧前端）
    const b = ((await c.req.json().catch(() => null)) ?? {}) as { reason?: unknown };
    stopTracking(user(c).id, c.req.param("id"), typeof b.reason === "string" ? b.reason : null);
    return c.json({ ok: true });
  });
  // ── 计划快照（D68）：每晚的明日计划与依据，只读；计划结果回看（D79）只用提交过的数据 ──
  app.get("/api/trackings/:id/plans", (c) =>
    c.json(
      listSnapshots(user(c).id, c.req.param("id"), {
        from: c.req.query("from") || undefined,
        to: c.req.query("to") || undefined,
      }),
    ),
  );
  app.get("/api/plans/:id", (c) => c.json(getSnapshot(user(c).id, c.req.param("id"))));
  app.get("/api/plans/:id/outcomes", async (c) =>
    c.json(await planOutcomes(user(c).id, c.req.param("id"))),
  );
  // ── 决策回溯（D71）：时间线、那天看到的计划、链校验、导出（别的跟踪与简报只给哈希） ──
  app.get("/api/trackings/:id/ledger", (c) => {
    const limit = Number(c.req.query("limit"));
    return c.json(
      listEntries(user(c).id, c.req.param("id"), {
        from: c.req.query("from") || undefined,
        to: c.req.query("to") || undefined,
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      }),
    );
  });
  app.get("/api/trackings/:id/plan-on", async (c) =>
    c.json(await planOn(user(c).id, c.req.param("id"), c.req.query("date") || undefined)),
  );
  app.post("/api/ledger/verify", (c) => c.json(verifyUser(user(c).id)));
  app.get("/api/trackings/:id/export", (c) => {
    const { filename, bundle } = exportTracking(user(c).id, c.req.param("id"));
    c.header("Content-Disposition", `attachment; filename="${filename}"`);
    return c.json(bundle);
  });

  // ── 看板 ──
  app.get("/api/dashboard", async (c) => c.json(await dashboard(user(c).id)));

  // ── 信号集导入（CSV：date,code） ──
  app.get("/api/signals", (c) => {
    const { db } = env().app;
    return c.json(
      db
        .select({
          id: signalDatasets.id,
          name: signalDatasets.name,
          market: signalDatasets.market,
          count: signalDatasets.count,
          createdAt: signalDatasets.createdAt,
        })
        .from(signalDatasets)
        .where(eq(signalDatasets.userId, user(c).id))
        .orderBy(desc(signalDatasets.createdAt))
        .all(),
    );
  });
  app.post("/api/signals", async (c) => {
    const u = user(c);
    const b = await body<{ name: string; market: Market; csv: string }>(c);
    if (!b.name?.trim()) throw new AppError(400, "信号集需要名字");
    const market: Market = b.market === "HK" ? "HK" : "A";
    const rows: Array<{ date: string; code: string }> = [];
    const errors: string[] = [];
    (b.csv ?? "").split(/\r?\n/).forEach((line, i) => {
      const t = line.trim();
      if (!t || /^date/i.test(t) || t.startsWith("#")) return;
      const [d, code] = t.split(/[,\t;]/).map((x) => x.trim());
      const date = d?.replaceAll("/", "-");
      if (!date || !isDateStr(date)) return errors.push(`第 ${i + 1} 行日期不对：${line}`);
      if (!code) return errors.push(`第 ${i + 1} 行缺代码`);
      try {
        rows.push({ date, code: toCode(code, market) });
      } catch {
        errors.push(`第 ${i + 1} 行代码不对：${code}`);
      }
    });
    if (errors.length) return c.json({ ok: false, errors: errors.slice(0, 20) }, 400);
    if (!rows.length) throw new AppError(400, "没有读到任何信号");
    const id = newId("sig_");
    env()
      .app.db.insert(signalDatasets)
      .values({ id, userId: u.id, name: b.name.trim(), market, rows, count: rows.length })
      .run();
    return c.json({ ok: true, id, count: rows.length });
  });

  // ── 管理（管理员） ──
  app.get("/api/admin/users", (c) => {
    admin(c);
    const { sqlite } = env().app;
    const users = sqlite
      .prepare(`SELECT id, name, email, role, banned, createdAt FROM "user" ORDER BY createdAt`)
      .all() as Array<{
      id: string;
      name: string;
      email: string;
      role: string;
      banned: number;
      createdAt: number;
    }>;
    const today = todayCN();
    const usage = env().app.db.select().from(usageDaily).where(eq(usageDaily.day, today)).all();
    return c.json(
      users.map((x) => ({
        ...x,
        quota: quotaOf(x.id),
        usageToday: usage.find((u) => u.userId === x.id) ?? null,
      })),
    );
  });
  // LLM 用量（spec §10）：近 14 天按天汇总；夜间简报记在 user_id = "system" 上，不占任何人的额度
  app.get("/api/admin/usage", (c) => {
    admin(c);
    const rows = env()
      .app.sqlite.prepare(
        `SELECT day,
                sum(CASE WHEN user_id = 'system' THEN 0 ELSE chat_messages END) AS chatMessages,
                sum(CASE WHEN user_id = 'system' THEN 0 ELSE backtests END) AS backtests,
                sum(CASE WHEN user_id = 'system' THEN 0 ELSE analyses END) AS analyses,
                sum(CASE WHEN user_id = 'system' THEN 0 ELSE tokens_in + tokens_out END) AS chatTokens,
                sum(CASE WHEN user_id = 'system' THEN tokens_in + tokens_out ELSE 0 END) AS briefTokens
         FROM usage_daily WHERE day >= ? GROUP BY day ORDER BY day DESC`,
      )
      .all(addDays(todayCN(), -13)) as Array<{ day: string }>;
    // 数字核对没通过的助手回复（D69），按北京时间分天
    const flagged = env()
      .app.sqlite.prepare(
        `SELECT date(created_at / 1000, 'unixepoch', '+8 hours') AS day, count(*) AS n
         FROM messages
         WHERE role = 'assistant' AND created_at >= ?
           AND json_extract(usage, '$.grounding.unverified') > 0
         GROUP BY day`,
      )
      .all(Date.now() - 15 * 86_400_000) as Array<{ day: string; n: number }>;
    const byDay = new Map(flagged.map((f) => [f.day, f.n]));
    return c.json(rows.map((r) => ({ ...r, groundingFlagged: byDay.get(r.day) ?? 0 })));
  });
  /** 逐人额度覆盖：只更新请求体里出现的项（不出现 = 不变，显式 null = 清掉覆盖、回到默认） */
  app.post("/api/admin/users/:id/quota", async (c) => {
    admin(c);
    const b = await body<Record<string, unknown>>(c);
    const set: Partial<Record<QuotaKind, number | null>> = {};
    for (const k of QUOTA_KINDS) {
      if (!(k in b)) continue;
      const v = b[k];
      if (v !== null && !(typeof v === "number" && Number.isInteger(v) && v >= 0))
        throw new AppError(400, "额度要是不小于 0 的整数");
      set[k] = v as number | null;
    }
    const q = env()
      .app.db.insert(userQuotas)
      .values({ userId: c.req.param("id"), ...set });
    if (Object.keys(set).length) q.onConflictDoUpdate({ target: userQuotas.userId, set }).run();
    else q.onConflictDoNothing().run();
    return c.json({ ok: true });
  });
  app.post("/api/admin/users/:id/password", async (c) => {
    admin(c);
    const { password } = await body<{ password: string }>(c);
    if (!password || password.length < 8) throw new AppError(400, "新密码至少 8 位");
    await auth.api.setUserPassword({
      body: { userId: c.req.param("id"), newPassword: password },
      headers: c.req.raw.headers,
    });
    return c.json({ ok: true });
  });
  app.get("/api/admin/invites", (c) => {
    admin(c);
    return c.json(env().app.db.select().from(invites).orderBy(desc(invites.createdAt)).all());
  });
  app.post("/api/admin/invites", async (c) => {
    const u = admin(c);
    const b = await body<{ note?: string; days?: number }>(c);
    const code = inviteCode();
    env()
      .app.db.insert(invites)
      .values({
        id: newId("inv_"),
        code,
        note: b.note ?? null,
        createdBy: u.id,
        expiresAt: b.days ? Date.now() + b.days * 86_400_000 : null,
      })
      .run();
    return c.json({ code });
  });
  app.delete("/api/admin/invites/:code", (c) => {
    admin(c);
    env()
      .app.db.delete(invites)
      .where(and(eq(invites.code, c.req.param("code")), sql`${invites.usedBy} IS NULL`))
      .run();
    return c.json({ ok: true });
  });
  app.get("/api/admin/data", async (c) => {
    admin(c);
    const { db } = env().app;
    return c.json({
      status: await dataStatus(),
      jobs: db
        .select()
        .from(jobs)
        .where(sql`${jobs.kind} IN ('etl', 'settle', 'brief', 'check', 'backfill')`)
        .orderBy(desc(jobs.createdAt))
        .limit(30)
        .all(),
    });
  });
  app.post("/api/admin/etl", async (c) => {
    admin(c);
    const b = await body<{ kind: "etl" | "settle" | "brief"; market?: Market }>(c);
    const id = newId("j_");
    env()
      .app.db.insert(jobs)
      .values({ id, kind: b.kind, payload: { market: b.market ?? "A", manual: true } })
      .run();
    void worker.kick();
    return c.json({ jobId: id });
  });

  extraRoutes?.(app);

  // ── 前端（生产环境由 server 托管构建产物，SPA 回退到 index.html） ──
  const dist = resolve(env().cfg.root, "apps/web/dist");
  if (existsSync(dist)) {
    const root = relative(process.cwd(), dist) || ".";
    // 带哈希的构建产物永久缓存；index.html 每次都要回源确认，否则升级后浏览器还拿着旧页面
    const cacheHeader = (path: string) =>
      path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
    app.use(
      "/*",
      serveStatic({ root, onFound: (path, c) => c.header("Cache-Control", cacheHeader(path)) }),
    );
    app.get("*", (c) => {
      if (c.req.path.startsWith("/api/")) return c.json({ error: "接口不存在" }, 404);
      c.header("Cache-Control", "no-cache");
      return c.html(readFileSync(resolve(dist, "index.html"), "utf8"));
    });
  }

  return app;
}

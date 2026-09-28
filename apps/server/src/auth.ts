/**
 * 鉴权（D11）：better-auth（email + 密码 + admin 插件），直接用应用库的 SQLite。
 * - 空库时第一个注册的人自动成为管理员，不需要邀请码。
 * - 之后注册必须带有效邀请码（请求体 inviteCode 或请求头 x-invite-code），一次性、可过期。
 */
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { admin } from "better-auth/plugins";
import type Database from "better-sqlite3";

export interface AuthDeps {
  sqlite: Database.Database;
  secret: string;
  baseURL: string;
}

interface InviteRow {
  code: string;
  used_by: string | null;
  expires_at: number | null;
}

function userCount(sqlite: Database.Database): number {
  const exists = sqlite
    .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'user'`)
    .get() as { n: number };
  if (!exists.n) return 0;
  return (sqlite.prepare(`SELECT count(*) AS n FROM "user"`).get() as { n: number }).n;
}

function inviteFrom(
  ctx: { body?: unknown; headers?: Headers | null } | null | undefined,
): string | null {
  if (!ctx) return null;
  const body = ctx.body as Record<string, unknown> | undefined;
  const fromBody = typeof body?.inviteCode === "string" ? body.inviteCode : null;
  return (fromBody ?? ctx.headers?.get("x-invite-code") ?? null)?.trim() || null;
}

export function authOptions(deps: AuthDeps) {
  const { sqlite } = deps;
  return {
    database: sqlite,
    secret: deps.secret,
    baseURL: deps.baseURL,
    basePath: "/api/auth",
    emailAndPassword: { enabled: true, minPasswordLength: 8, autoSignIn: true },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    trustedOrigins: [deps.baseURL, "http://localhost:5173"],
    plugins: [admin({ defaultRole: "user", adminRoles: ["admin"] })],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") return;
        if (userCount(sqlite) === 0) return;
        const code = inviteFrom(ctx);
        if (!code) throw new APIError("BAD_REQUEST", { message: "注册需要邀请码" });
        const inv = sqlite
          .prepare(`SELECT code, used_by, expires_at FROM invites WHERE code = ?`)
          .get(code) as InviteRow | undefined;
        if (!inv || inv.used_by)
          throw new APIError("BAD_REQUEST", { message: "邀请码无效或已被使用" });
        if (inv.expires_at && inv.expires_at < Date.now()) {
          throw new APIError("BAD_REQUEST", { message: "邀请码已过期" });
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (u) => ({
            data: { ...u, role: userCount(sqlite) === 0 ? "admin" : "user" },
          }),
          after: async (u, ctx) => {
            const code = inviteFrom(ctx as { body?: unknown; headers?: Headers | null } | null);
            if (code) {
              sqlite
                .prepare(
                  `UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL`,
                )
                .run(u.id, Date.now(), code);
            }
          },
        },
      },
    },
  } satisfies BetterAuthOptions;
}

export function createAuth(deps: AuthDeps) {
  return betterAuth(authOptions(deps));
}

export type Auth = ReturnType<typeof createAuth>;

/** 启动时先建/补 better-auth 自己的表（user / session / account / verification），再创建实例。 */
export async function migrateAuth(deps: AuthDeps): Promise<void> {
  const { runMigrations } = await getMigrations(authOptions(deps));
  await runMigrations();
}

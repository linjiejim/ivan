/**
 * 管理命令行：`pnpm admin <命令>`（不需要 server 在运行，直接改应用库）。
 *   users                              列出用户
 *   reset-password <邮箱> <新密码>       重置密码（v1 没有邮件服务）
 *   invite [备注]                       生成一个 14 天有效的邀请码
 *   set-role <邮箱> <admin|user>        改角色
 */
import { loadConfig } from "@ivan/core/config";
import { invites, newId, openAppDb } from "@ivan/db";
import { hashPassword } from "better-auth/crypto";

const [cmd, ...args] = process.argv.slice(2);
const cfg = loadConfig();
const { sqlite, db } = openAppDb(cfg.appDbPath);

function userByEmail(email: string) {
  const u = sqlite.prepare(`SELECT id, email, role FROM "user" WHERE email = ?`).get(email) as
    { id: string; email: string; role: string } | undefined;
  if (!u) throw new Error(`没有用户 ${email}`);
  return u;
}

async function main() {
  switch (cmd) {
    case "users": {
      console.table(
        sqlite
          .prepare(`SELECT email, name, role, substr(createdAt, 1, 16) AS created FROM "user"`)
          .all(),
      );
      return;
    }
    case "reset-password": {
      const [email, password] = args;
      if (!email || !password || password.length < 8)
        throw new Error("用法：reset-password <邮箱> <至少 8 位的新密码>");
      const u = userByEmail(email);
      const hash = await hashPassword(password);
      const r = sqlite
        .prepare(`UPDATE account SET password = ? WHERE userId = ? AND providerId = 'credential'`)
        .run(hash, u.id);
      if (!r.changes) throw new Error("这个用户没有密码登录方式");
      sqlite.prepare(`DELETE FROM session WHERE userId = ?`).run(u.id);
      console.log(`已重置 ${email} 的密码，并登出了他的所有会话`);
      return;
    }
    case "invite": {
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      let code = "";
      for (let i = 0; i < 8; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
      const admin = sqlite.prepare(`SELECT id FROM "user" WHERE role = 'admin' LIMIT 1`).get() as
        { id: string } | undefined;
      db.insert(invites)
        .values({
          id: newId("inv_"),
          code,
          note: args.join(" ") || null,
          createdBy: admin?.id ?? "cli",
          expiresAt: Date.now() + 14 * 86_400_000,
        })
        .run();
      console.log(`邀请码：${code}\n注册链接：${cfg.publicUrl}/register?invite=${code}`);
      return;
    }
    case "set-role": {
      const [email, role] = args;
      if (!email || (role !== "admin" && role !== "user"))
        throw new Error("用法：set-role <邮箱> <admin|user>");
      sqlite.prepare(`UPDATE "user" SET role = ? WHERE id = ?`).run(role, userByEmail(email).id);
      console.log(`${email} → ${role}`);
      return;
    }
    default:
      console.log(
        "用法：pnpm admin <users|reset-password|invite|set-role> …（详见 apps/server/src/cli.ts）",
      );
      process.exitCode = cmd ? 1 : 0;
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => sqlite.close());

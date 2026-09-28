/**
 * ivan-server：对外唯一端口。启动顺序：配置 → 应用库迁移 → 鉴权表迁移 → HTTP。
 */
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createAuth, migrateAuth } from "./auth.ts";
import { env } from "./env.ts";
import { registerChat } from "./routes/chat.ts";

const { cfg, app: db } = env();
const deps = { sqlite: db.sqlite, secret: cfg.authSecret, baseURL: cfg.publicUrl };
await migrateAuth(deps);
const auth = createAuth(deps);
const app = createApp(auth, registerChat);

serve({ fetch: app.fetch, port: cfg.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`ivan-server 已启动：http://localhost:${info.port}（数据目录 ${cfg.dataDir}）`);
});

# 部署：jim-server

线上地址 **https://ivan.linjiejim.com**。按 deploy-jim-server 的标准做法：Caddy（自动 HTTPS）→ PM2 → 本机端口；
push `main` 触发 GitHub Actions 检查并部署（`.github/workflows/deploy.yml`）。

## 一览

| 项       | 值                                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------- |
| 服务器   | `ssh jim-server`（OpenCloudOS 8.8，2 核 3.6 GB，Node 22 via nvm，pnpm 10，PM2）                                        |
| 代码     | `/root/ivan/ivan`（`main`，由 CI 用只读 deploy key `~/.ssh/ivan_deploy` 拉取）                                         |
| 数据     | `/root/ivan/data`（`app.sqlite` 应用库、`market.duckdb` 行情仓）——**在仓库外**，拉代码、重置都碰不到                   |
| 配置     | `/root/ivan/ivan/.env`（不进 git；密钥在服务器上生成）                                                                 |
| 进程     | PM2 `ivan-server`（`127.0.0.1:18907`，`HOST=127.0.0.1` 只让 Caddy 访问）+ `ivan-worker`（`127.0.0.1:18917`，内部接口） |
| 反向代理 | `/etc/caddy/Caddyfile` 里的 `ivan.linjiejim.com` 一段 → `127.0.0.1:18907`                                              |
| DNS      | 腾讯云 DNSPod：`ivan.linjiejim.com` A → `43.161.221.68`                                                                |
| 日志     | `/root/ivan/ivan/logs/*.log`（`/etc/logrotate.d/ivan` 每天轮转，留 14 天）；访问日志进 Caddy → GoAccess                |
| CI 密钥  | GitHub environment `jim-server`：`DEV_SERVER_HOST / PORT / USERNAME / SSH_KEY`（专用 CI 登录 key，不是个人 key）       |

`.env` 里和默认值不同的几项：`PORT=18907`、`HOST=127.0.0.1`、`WORKER_PORT=18917`、`PUBLIC_URL=https://ivan.linjiejim.com`、
`DATA_DIR=/root/ivan/data`、`DUCKDB_MEMORY_LIMIT=384MB`（服务器只剩约 1.2 GB 可用内存，先保守，看一周 swap 再调）、
`BACKTEST_THREAD_MEMORY_MB=160`（见下面的内存预算）。

## worker 内存预算

worker 一个进程里放着 DuckDB、主线程和回测线程，pm2 超过 `max_memory_restart`（900M）就重启它，夜间结算会被打断。
按这条式子配：

```
DUCKDB_MEMORY_LIMIT + BACKTEST_POOL_SIZE × BACKTEST_THREAD_MEMORY_MB + 约 250 MB ≤ max_memory_restart − 100 MB
```

约 250 MB 是主线程、转交给回测线程的价格面板（ArrayBuffer，不受线程堆上限约束）和 DuckDB 自身开销。
jim-server：384 + 1 × 160 + 250 = 794 ≤ 800。回测线程的堆里只有结果对象，160 MB 够用；超了线程会被终止、
这次回测报错，线程自动重建，不影响后面的任务。单次回测超过 `BACKTEST_TIMEOUT_MS`（默认 120 秒）也一样终止重建。
上线后实测峰值 RSS（同时跑一个结算与一次全 A 股回测），超了**先降 `DUCKDB_MEMORY_LIMIT`**。

## 原生模块（OpenCloudOS 8 的特殊处理）

服务器是 glibc 2.28 / GCC 8 / Python 3.6，比依赖期待的新：

- **better-sqlite3 13** 把预编译打进了 npm 包，自带的 linux-x64 要 glibc 2.34，这里加载不了；默认安装在有预编译时又不编译。
  `scripts/ensure-native.sh` 在每次重装依赖后检查：能加载就跳过，加载不了就用已装的 `gcc-toolset-13` 从源码编译（约 2 分钟），
  放到预编译文件的位置（先断开和 pnpm store 的硬链接，不改 store）。
- **node-gyp** 要 Python ≥ 3.8：装了并存的 `python3.11`（`dnf install python3.11`，不替换系统的 `python3`），安装时用 `npm_config_python` 指过去。
- **DuckDB** 的预编译要 glibc 2.25，直接可用。

## 一次 push 会发生什么

1. **检查**：`pnpm install --frozen-lockfile` → lint → format → typecheck → test → build。PR 只跑这一步。
2. **部署**（只有 `main`，两次部署排队不并行），在服务器上：
   1. `scripts/deploy-wait-idle.mjs`：有任务在跑（夜间更新、回测、扫描）或有维护标记就等，最多 15 分钟；
      还忙就**放弃这次部署、什么都不动**，稍后在 Actions 里重跑即可。
   2. `git reset --hard origin/main`；`pnpm-lock.yaml` 变了才重装依赖（并 `pnpm rebuild esbuild`）。
   3. 构建前端 → `pm2 startOrRestart ecosystem.config.cjs` → 检查 server `/api/setup` 与 worker `/internal/health` 都是 200。

工作日北京时间 17:30–19:30 是夜间任务窗口，这段时间尽量别合 main（会等，等不到就放弃）。

## 维护：回填、手动重跑

worker 独占行情仓，**回填要先停 worker**。`scripts/backfill-full.sh` 把这些都包好了：放维护标记（部署会等它，不会中途重启 worker）
→ 停 worker → 回填 A 股 → 回填港股 → doctor → 不管成败都拉起 worker、去掉标记。日志在 `logs/backfill-日期.log`，可断点续跑。

```bash
ssh jim-server 'cd /root/ivan/ivan && nohup bash scripts/backfill-full.sh >/dev/null 2>&1 &'   # 现在跑
# 或者交给定时器在夜里跑（工作日避开 17:30–19:30 的夜间任务）：
ssh jim-server 'systemd-run --unit=ivan-backfill --setenv=HOME=/root --on-calendar="YYYY-MM-DD 20:30:00" /bin/bash /root/ivan/ivan/scripts/backfill-full.sh'
ssh jim-server 'tail -f /root/ivan/ivan/logs/backfill-*.log'
```

回填期间网站照常可用，但看板会提示「行情服务没有运行」；东财对服务器 IP 更敏感，被封会自动暂停、换源、等解封。

## 行情仓升级

表结构升级分两种：只加小表、小列的，worker 启动时照常自动做；**要改大表的**（第 3 版在约 2500 万行 `bars_daily` 上补 `src`、`ver` 列）
worker 启动时不做——部署健康检查只等 24 秒、pm2 有 900M 内存上限，启动时硬做可能超时或重启循环（D76）。
这时 worker 进入**维护状态**：照常起来、`/internal/health` 返回 200（带 `maintenance` 说明，部署不会失败），但调度不排任务、
任务不认领、读行情仓的内部接口返回 503，看板和管理页显示「行情仓需要升级到第 3 版，请运行 scripts/migrate.sh」。

部署 R1（S01–S03）之后跑一次升级脚本，横幅消失即完成：

```bash
ssh jim-server 'cd /root/ivan/ivan && nohup bash scripts/migrate.sh >/dev/null 2>&1 &'
ssh jim-server 'tail -f /root/ivan/ivan/logs/migrate-*.log'   # 最后一行是「行情仓已升级到第 3 版，用时 N 秒」
```

脚本和回填一样：等 worker 空闲 → 放维护标记 → 停 worker → `pnpm ivan migrate`（DuckDB 内存上限默认 512MB，
`MIGRATE_MEMORY_LIMIT=768MB bash scripts/migrate.sh` 可调）→ doctor → 不管成败都拉起 worker、去掉标记。升级语句都是
`IF NOT EXISTS`，失败了重跑即可。上线前先在一份线上行情仓的副本上用 512MB 演练一次，记下用时。
开发机想让 worker 启动时直接升级：`WAREHOUSE_MIGRATE_ON_BOOT=1`。

**回滚兼容**：

- 旧代码打开第 3 版行情仓：重跑第 2 版的建表语句（全是 `IF NOT EXISTS`，无害）并把 `schema_version` 写回 2；
  按列序追加时表尾的 `src`、`ver` 自动补空，读的时候不看这两列，照常可用。
- 回滚后再部署新代码：第 3 版语句重跑都是空操作；是否进维护状态看的是 `bars_daily` 有没有 `src` 列、不是版本号，所以不会再进维护。
  回滚期间写进来的行来源为空，界面显示「来源未记录」。
- 应用库迁移都是加列加表，旧代码不受影响；S08 起加的只追加触发器回滚后仍在，这是有意的。

## 回滚

```bash
ssh jim-server
cd /root/ivan/ivan && git log --oneline -5
git reset --hard <好的提交> && pnpm --filter @ivan/web build && pm2 restart ivan-server ivan-worker
```

之后在 GitHub 上 revert 那次提交再 push，让 `main` 和服务器一致（否则下次部署会把坏提交带回来）。

## 从零重建（一次性初始化的记录）

1. 端口：`ss -tln` 确认 18907 / 18917 空闲（登记表见 deploy-jim-server 技能）。
2. 服务器生成只读 deploy key `~/.ssh/ivan_deploy`，公钥加到仓库 Deploy keys；本机生成专用 CI key，
   公钥进服务器 `authorized_keys`（先备份），私钥进 GitHub environment `jim-server` 的 `DEV_SERVER_SSH_KEY`。
3. `git clone`（经 `ssh.github.com:443`）到 `/root/ivan/ivan`；`npm_config_python=$(command -v python3.11) pnpm install --frozen-lockfile && pnpm rebuild esbuild && bash scripts/ensure-native.sh && pnpm build`。
4. `.env`：从 `.env.example` 起，`BETTER_AUTH_SECRET` / `INTERNAL_SECRET` 用 `openssl rand -base64 32` 在服务器上生成，
   LLM key 从本机管道传过去（不回显）。
5. 行情仓：先把本机回填好的 `market.duckdb` 传上去（马上能用），再按上面的「维护」做全量回填。
6. `pm2 start ecosystem.config.cjs && pm2 save`；`curl 127.0.0.1:18907/api/setup` 应返回 `{"needsAdmin":true}`。
7. **先注册管理员再公开**（空库第一个注册的人自动成为管理员）——在服务器上直接向 `127.0.0.1:18907` 注册：

   ```bash
   ssh -t jim-server 'read -r -p "邮箱: " E; read -r -s -p "密码（至少 8 位）: " P; echo; export E P; \
     node -e "console.log(JSON.stringify({email:process.env.E,password:process.env.P,name:process.env.E.split(\"@\")[0]}))" | \
     curl -s -X POST http://127.0.0.1:18907/api/auth/sign-up/email \
       -H "Origin: https://ivan.linjiejim.com" -H "content-type: application/json" --data @-; echo'
   ```

8. Caddy 追加一段（先备份 Caddyfile）→ `caddy validate … && systemctl reload caddy`；DNSPod 加 A 记录，证书自动签发。

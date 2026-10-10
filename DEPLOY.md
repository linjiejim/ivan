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

## 从 916a43c 升级到本版（一次性，按顺序）

jim-server 现在跑的是 916a43c（R1 之前），这次一步跳到 S01–S15b。下面的各节是分版本的说明，这里是实际要做的顺序：

0. **改 `.env`**：`BACKTEST_THREAD_MEMORY_MB=160`（不改的话默认 256，384 + 256 + 250 = 890，超过下面内存预算的 800）。
   这一步要在合 main **之前**做，部署会重启 worker。
1. **备份数据**（避开夜间窗口，worker 手上没有任务时做；`df -h /root/ivan` 先看空间，行情仓有几个 GB）：

   ```bash
   ssh jim-server 'mkdir -p /root/ivan/backup && pm2 stop ivan-worker && \
     sqlite3 /root/ivan/data/app.sqlite ".backup /root/ivan/backup/app-$(date +%F).sqlite" && \
     cp /root/ivan/data/market.duckdb /root/ivan/backup/market-$(date +%F).duckdb && \
     { [ ! -f /root/ivan/data/market.duckdb.wal ] || cp /root/ivan/data/market.duckdb.wal /root/ivan/backup/market-$(date +%F).duckdb.wal; }; \
     pm2 start ivan-worker'
   ```

   应用库迁移（0001–0009，含只追加触发器）在部署时自动执行，`git reset` 只回代码、不回数据，所以备份必须在合 main 之前。
   `sqlite3 .backup` 可以在 server 运行时做；服务器上没有 `sqlite3` 命令就先 `dnf install sqlite`
   （或者把 server 也停掉，直接 `cp /root/ivan/data/app.sqlite* /root/ivan/backup/`）。行情仓的 `.wal` 文件在就要一起拷，否则少了最后写进去的那部分。

2. **合 main**（工作日避开 17:30–19:30）。CI 部署：应用库迁移自动执行；worker 起来后进维护状态（横幅「行情仓需要升级到第 3 版」），
   `/internal/health` 仍是 200，部署不会失败。维护期间不排任何定时任务（夜间更新、结算、简报），也不会事后补排。
3. **跑一次升级脚本**，一次就从第 2 版升到第 5 版（中间的第 3、4、5 版一起做，不用跑两遍）：

   ```bash
   ssh jim-server 'cd /root/ivan/ivan && nohup bash scripts/migrate.sh >/dev/null 2>&1 &'
   ssh jim-server 'tail -f /root/ivan/ivan/logs/migrate-*.log'
   ```

   日志里依次是「行情仓升级开始」「备份行情仓到 …」「行情仓已升级到第 5 版，用时 N 秒」「== 升级完成」、doctor 的输出，最后一行「== … 行情仓升级结束」。
   中间写着「worker 一直在忙，这次不升级」「磁盘剩余 …」「升级失败」的，看原因处理后重跑这一步。

4. **确认**：看板与管理页的维护横幅消失；doctor 没有报错。
5. 如果 2–4 跨过了当天的夜间窗口，在管理页手动排一次那天的 A 股、港股更新（结算跟着更新一起做），过了 19:00 再点「生成简报」
   （维护期间错过的不会自动补）。
6. **两融与筹码数据的历史**：管理页数据卡先点「估算」（只发 4 个计数请求），再点「补齐历史数据」（见下面「维护」）。
7. 回填完成后 worker 自己排上事件因子按年补算（`event_cols`）；管理页「事件因子：补算中（x / y 年）」→「已补算（第 1 版）」。
8. 按 spec 上线清单做人工抽查。

## 年度维护

- **每年 12 月**：把下一年 A 股、港股的休市日加进 `packages/core/src/holidays.ts`（现在只有 2026 年）。没有那一年时计划日按工作日推算，
  界面会标「按工作日推算」，节假日前后的计划日会错一天。
- **应用库的只追加表**（`ledger_entries`、`plan_snapshots`、`plan_items`、`tracking_health`、`brief_editions`）有触发器挡住 UPDATE / DELETE，
  手工 SQL 改它们会报 `append-only`。真要做修正迁移，迁移里先 DROP 触发器、改完再按原样建回来，并在决策账本里说明。

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
全量回填（A 股）在因子之前多了一步点时事件数据（两融、户数、解禁、大宗，约 1.7–1.9 万次请求）。

**两融与筹码数据的历史（R5 / S15）不用停 worker**（行情仓升级完、维护横幅消失之后）：先在管理页数据卡点「估算」看请求数与时长
（只发 4 个计数请求；也可以在服务器上
`curl -s -H "x-internal-secret: $INTERNAL_SECRET" "127.0.0.1:18917/internal/events/estimate?since=2013-01-01"`），
再点「补齐历史数据」。不要在 worker 运行时用 `pnpm ivan events --estimate`：worker 独占行情仓，命令行打不开。worker 在 etl 道上分段跑（每段最多 `EVENTS_JOB_BUDGET_MS`，默认 10 分钟；
没做完 1 分钟后接着排；北京时间 16:30–21:00 不开新段），进度显示在「两融与筹码数据」里，已经在排队或运行时再点会提示。
后台回填**不开数据版本**：只写 `pit_batches` 一条批次、行上盖批次号，`committedAsOf`、连续失败晚数与无成交中位数都不受影响，
回测照常跑。补完后记下实际请求数、时长与四张新表的大小（看管理页数据卡，或 `/internal/data-status`；`pnpm ivan doctor` 要先停 worker）。

## 行情仓升级

表结构升级分两种：只加小表、小列的，worker 启动时照常自动做；**要改大表的**（第 3 版在约 2500 万行 `bars_daily` 上补 `src`、`ver` 列）
worker 启动时不做——部署健康检查只等 24 秒、pm2 有 900M 内存上限，启动时硬做可能超时或重启循环（D76）。
这时 worker 进入**维护状态**：照常起来、`/internal/health` 返回 200（带 `maintenance` 说明，部署不会失败），但调度不排任务、
任务不认领、读行情仓的内部接口返回 503，看板和管理页显示「行情仓需要升级到第 3 版，请运行 scripts/migrate.sh」。

部署之后跑一次升级脚本，横幅消失即完成（不管从第几版起，一次升到当前版本）：

```bash
ssh jim-server 'cd /root/ivan/ivan && nohup bash scripts/migrate.sh >/dev/null 2>&1 &'
ssh jim-server 'tail -f /root/ivan/ivan/logs/migrate-*.log'   # 「行情仓已升级到第 5 版，用时 N 秒」之后是 doctor 的输出与「行情仓升级结束」
```

脚本和回填一样：等 worker 空闲 → 放维护标记 → 停 worker → 备份行情仓（`market.duckdb.pre-migrate-日期`，空间不够就不升级；
`MIGRATE_NO_BACKUP=1` 跳过）→ `pnpm ivan migrate`（DuckDB 内存上限默认 512MB，
`MIGRATE_MEMORY_LIMIT=768MB bash scripts/migrate.sh` 可调）→ doctor → 不管成败都拉起 worker、去掉标记。升级语句都是
`IF NOT EXISTS`，失败了重跑即可。上线前先在一份线上行情仓的副本上用 512MB 演练一次，记下用时。
开发机想让 worker 启动时直接升级：`WAREHOUSE_MIGRATE_ON_BOOT=1`。

**回滚兼容**：

- 旧代码打开第 3 版行情仓：重跑第 2 版的建表语句（全是 `IF NOT EXISTS`，无害）并把 `schema_version` 写回 2；
  按列序追加时表尾的 `src`、`ver` 自动补空，读的时候不看这两列，照常可用。
- 回滚后再部署新代码：第 3 版语句重跑都是空操作；是否进维护状态看的是 `bars_daily` 有没有 `src` 列、不是版本号，所以不会再进维护。
  回滚期间写进来的行来源为空，界面显示「来源未记录」。
- 应用库迁移都是加列加表，旧代码不受影响；S08 起加的只追加触发器回滚后仍在，这是有意的。
- 回滚到 R1 之前的代码时，它读数据版本不看 `status`，可能把一条没提交的版本（比如休市那晚的 skipped 行，截至日为空）当成最新：
  只影响界面上显示的数据版本号与截至日，不影响回测与结算的数值。

**第 4 版（R5 / S15）是轻量升级**：只加 `margin_daily`、`holder_counts`、`lockups`、`block_trades`、`pit_sync`、`pit_batches`
六张表和一个序列，worker 启动时自动做，不进维护状态；旧代码打开第 4 版行情仓不读这几张表，照常可用。

**第 5 版（R5 / S15b）是重迁移**：在约 1600 万行 `factors_daily` 表尾加 7 个事件因子列（注册表第 3 版，D83）。部署后 worker 进维护状态，
横幅「行情仓需要升级到第 5 版（新增 7 个因子列），请运行 scripts/migrate.sh」，照上面的方法跑一次升级脚本即可。
已有的因子一行都不重算（行情仓里 `factor_registry_version:A` 仍是核心版本 `2`），新列先是空的：夜间更新会把近 15 天一起算上，
历史由 worker 在事件数据回填完成后按年补算（`event_cols` 任务，每次一年、年与年之间隔 15 秒、16:30–21:00 不补，不开数据版本；
管理页「事件因子：补算中（x / y 年）」→「已补算（第 1 版）」）。补算期间回测暂停，和夜间更新一样；补完之前用到事件因子的回测会被拒绝。
上线前在线上行情仓副本上用 `DUCKDB_MEMORY_LIMIT=512MB` 演练加列与 `--down 4`，记下用时。

**从本版回滚到任何更早的提交（包括 916a43c）之前，先在当前代码上删列**：R4 和更早的代码写因子时都用
`INSERT INTO factors_daily SELECT <旧列>`，多出来的 7 列会让它报错。`--down` 只有本版的命令行有，所以要在 `git reset` **之前**、
在当前（新）代码的目录里跑，看到「已降到第 4 版」后再换代码：

```bash
ssh jim-server 'cd /root/ivan/ivan && nohup bash scripts/migrate.sh --down 4 >/dev/null 2>&1 &'
ssh jim-server 'tail -f /root/ivan/ivan/logs/migrate-*.log'   # 「行情仓已降到第 4 版（删掉了事件因子列）」
```

它删掉 7 个事件因子列、把 `schema_version` 写回 4、清掉 `meta event_factors:A` 与 `etl_progress` 里的 `event_cols:*` 进度；
事件表（第 4 版的六张表）留着无害。之后再按下面的「回滚」换代码。以后再部署 R5，worker 会重新进维护状态，跑一次 `scripts/migrate.sh` 加回这些列、
重新补算。R6、R7 的迁移只加表、加列，旧代码直接可用。

## 回滚

0. 行情仓已经升到第 5 版时，先按上面「从本版回滚到任何更早的提交之前，先删列」跑 `bash scripts/migrate.sh --down 4`。
   应用库不用动（迁移都是加列加表）；只有数据真的坏了才从升级前的备份恢复
   （`pm2 stop ivan-server ivan-worker && rm -f /root/ivan/data/app.sqlite-wal /root/ivan/data/app.sqlite-shm && cp /root/ivan/backup/app-日期.sqlite /root/ivan/data/app.sqlite`；
   行情仓同理：先删掉 `market.duckdb.wal`，再用 `market.duckdb.pre-migrate-日期` 或手动备份覆盖 `market.duckdb`——备份旁边有 `.wal` 的，
   一起拷成 `market.duckdb.wal`；最后再拉起）。

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

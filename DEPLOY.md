# 部署：自部署到 VPS

演示站 <https://ivan.linjiejim.com> 就是按这份文档部署的：反向代理（Caddy，自动 HTTPS）→ PM2 → 本机端口；
推送到 `main` 后由 GitHub Actions 检查并部署（`.github/workflows/deploy.yml`，见下文「推送即部署」）。

想自己架一个，照下面做；用 nginx、systemd 或别的进程管理器也行，要点只有四个：两个进程（server 对外、worker 只听 127.0.0.1）、
提供构建好的 `apps/web/dist`、数据目录放在仓库外、按机器内存配好 worker 的内存预算。

## 一览

| 项       | 建议                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 机器     | Linux x64，2 核、4 GB 内存的 VPS 够用（和别的服务共用、晚高峰只剩约 0.7 GB 也能跑，见「worker 内存预算」）；磁盘留 15 GB 以上 |
| 运行时   | Node 22（nvm）、pnpm 10、PM2；较老的发行版另见「较老的发行版：原生模块」                                                      |
| 代码     | 仓库克隆所在的目录（下文记作 `$APP_DIR`；`ecosystem.config.cjs` 用自身所在目录作工作目录）                                    |
| 数据     | `.env` 的 `DATA_DIR`（`app.sqlite` 应用库、`market.duckdb` 行情仓）——**建议放在仓库外**，拉代码、重置都碰不到                 |
| 配置     | `$APP_DIR/.env`（不进 git；密钥在服务器上生成）                                                                               |
| 进程     | PM2 `ivan-server`（`PORT`，设 `HOST=127.0.0.1` 只让反向代理访问）+ `ivan-worker`（`WORKER_PORT`，内部接口）                   |
| 反向代理 | 域名 → `127.0.0.1:$PORT`                                                                                                      |
| 日志     | `$APP_DIR/logs/*.log`（建议用 logrotate 每天轮转）                                                                            |

全量行情仓（A 股 + 港股，2013 年起）约 5–6 GB；升级前脚本会在旁边拷一份备份，所以磁盘要留出两倍以上。

## 第一次上线

1. **选端口**：`ss -tln` 确认 `.env` 里的 `PORT`、`WORKER_PORT`（默认 18905 / 18915）没被占用。
2. **克隆、装依赖、构建**：

   ```bash
   git clone https://github.com/linjiejim/ivan.git && cd ivan
   pnpm install --frozen-lockfile
   pnpm rebuild esbuild          # 有的主机会忽略 esbuild 的安装脚本；tsx 运行时要用它
   bash scripts/ensure-native.sh # better-sqlite3 能加载就跳过；加载不了就从源码编译（见下文）
   pnpm build
   ```

3. **`.env`**：从 `.env.example` 起。和默认值不同的通常是这几项：

   - `PORT`、`WORKER_PORT`，`HOST=127.0.0.1`；
   - `PUBLIC_URL=https://你的域名`；
   - `DATA_DIR=/某个仓库外的目录/data`；
   - `BETTER_AUTH_SECRET`、`INTERNAL_SECRET`：在服务器上用 `openssl rand -base64 32` 生成；
   - `LLM_API_KEY`：从本机经管道传过去，不要出现在命令行历史里；
   - 内存预算的几项（`DUCKDB_MEMORY_LIMIT`、`BACKTEST_PANEL_MB`、`BACKTEST_POOL_SIZE`、`BACKTEST_THREAD_MEMORY_MB`），见下一节。

4. **行情仓**：按 [README](README.md)「首次回填行情仓」回填（worker 停着时跑），或者先把本机回填好的 `market.duckdb`
   传到 `DATA_DIR`（马上能用），再按下文「维护」做全量回填。
5. **启动**：`pm2 start ecosystem.config.cjs && pm2 save`；`curl 127.0.0.1:$PORT/api/setup` 应返回 `{"needsAdmin":true}`。
6. **先注册管理员再公开**（空库第一个注册的人自动成为管理员）——在服务器上直接向本机端口注册，口令不进命令行历史：

   ```bash
   read -r -p "邮箱: " E; read -r -s -p "密码（至少 8 位）: " P; echo; export E P
   node -e "console.log(JSON.stringify({email:process.env.E,password:process.env.P,name:process.env.E.split('@')[0]}))" | \
     curl -s -X POST "http://127.0.0.1:$PORT/api/auth/sign-up/email" \
       -H "Origin: $PUBLIC_URL" -H "content-type: application/json" --data @-; echo
   unset E P
   ```

7. **反向代理与域名**：例如在 Caddyfile 里加一段（先备份），`caddy validate` 通过后 `systemctl reload caddy`：

   ```
   ivan.example.com {
   	encode zstd gzip
   	reverse_proxy 127.0.0.1:18905
   }
   ```

   域名加一条 A 记录指向服务器，证书由 Caddy 自动签发。

## worker 内存预算

worker 一个进程里放着 DuckDB、主线程、回测线程和回测用的价格面板。内存用到哪里都由配置封顶，按机器**晚高峰的可用内存**配
（`free -m` 的 available，其它服务都在跑的时候），不是按空闲时：

| 部分     | 上限                                             | 说明                                                                                                       |
| -------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| DuckDB   | `DUCKDB_MEMORY_LIMIT`                            | 查询、缓存都在里面，超了报 Out of Memory（这次查询失败，不影响进程）；打开库（含重放 WAL）时就生效         |
| 价格面板 | `BACKTEST_PANEL_MB`                              | 一次回测入选过的股票 × 交易日的 TypedArray，转交给回测线程、不受线程堆上限约束；超了这次回测报「行情太多」 |
| 回测线程 | `BACKTEST_POOL_SIZE × BACKTEST_THREAD_MEMORY_MB` | 线程堆里只有结果对象；超了线程被终止、这次回测报错，线程自动重建                                           |
| 其余     | 约 150 MB                                        | 主线程、DuckDB 自身开销                                                                                    |

```
DUCKDB_MEMORY_LIMIT + BACKTEST_PANEL_MB + BACKTEST_POOL_SIZE × BACKTEST_THREAD_MEMORY_MB + 约 150 MB
  ≤ max_memory_restart（ecosystem.config.cjs 里是 900M）− 50 MB
```

机器上也要放得下：跑大回测时 worker 比空闲时多用 `DUCKDB_MEMORY_LIMIT + BACKTEST_PANEL_MB + 线程堆`（参考配置约 600 MB），
晚高峰（worker 空闲时量）的 available 至少要比这多 200 MB；不够就先降这几项，别指望 swap——
swap 用满之前整机就会卡死，内核来不及杀进程（2026-11-03 演示站整机卡死 40 分钟，D110）。
pm2 每 30 秒才量一次内存，`max_memory_restart` 只兜慢慢涨上去的情况，挡不住几秒内的尖峰——尖峰靠上面这几个上限。
单次回测超过 `BACKTEST_TIMEOUT_MS`（默认 120 秒）终止重建线程。

**参考配置：2 核、3.6 GB、和十来个别的服务共用的机器**（演示站。11-03 晚高峰 available 只有 650–770 MB，
当时 worker 空闲也占着约 570 MB；有了空闲回收，worker 空闲约 290 MB，晚高峰 available 约 0.95 GB）：

```
DUCKDB_MEMORY_LIMIT=256MB
DUCKDB_THREADS=2
BACKTEST_POOL_SIZE=1
BACKTEST_THREAD_MEMORY_MB=160
BACKTEST_PANEL_MB=256
```

256 + 256 + 1 × 160 + 150 = 822 ≤ 850；大回测比空闲多用约 600 MB，950 − 600 ≥ 200。实测（Linux，合成行情仓，2201 只股票入选 × 约 2200 个交易日，面板约 240 MB，按流动性成交）：
一次全 A 股主板 9 年月度换仓的回测峰值 RSS 约 810 MB，`DUCKDB_MEMORY_LIMIT=384MB` 时约 940 MB；
跑完空闲 30 秒后 worker 把 DuckDB 的缓存和回测线程还回去，回到约 290 MB（D110）。

- **空闲回收**：两条道都空下来 30 秒后，worker 做一次 CHECKPOINT、临时调低 DuckDB 内存上限逐出缓存、换掉跑过任务的回测线程。
  所以夜间更新之后 worker 不会一直占着接近上限的内存。
- **回测与结算、更新不同时跑**：夜间更新、抽检、事件因子补算、单独排的结算在排队或在跑时，回测排队（界面显示「行情正在更新，回测会在更新完成后开始」），
  峰值不会叠加（D60、D110）。
- **退出**：收到 SIGINT / SIGTERM 后几百毫秒内退出（打断在跑的查询、终止回测线程、CHECKPOINT 后关库），8 秒兜底强退，
  赶在 pm2 的 `kill_timeout`（10 秒）之前；被打断的任务记「worker 重启」。
- 回填（`scripts/backfill-full.sh`）时 worker 停着，可以给 DuckDB 多一些：`BACKFILL_MEMORY_LIMIT=512MB bash scripts/backfill-full.sh`。

上线后看一次峰值 RSS（`pm2 monit`，或 `grep VmHWM /proc/<worker 的 pid>/status`），超了**先降 `DUCKDB_MEMORY_LIMIT`**，
再降 `BACKTEST_PANEL_MB`（会有更多大回测被拒绝）。

## 较老的发行版：原生模块

在 glibc 2.28 / GCC 8 / Python 3.6 这一代的系统（如 RHEL 8 系）上，依赖的预编译比系统新：

- **better-sqlite3 13** 把预编译打进了 npm 包，自带的 linux-x64 要 glibc 2.34，加载不了；默认安装在有预编译时又不编译。
  `scripts/ensure-native.sh` 在每次重装依赖后检查：能加载就跳过，加载不了就用 `gcc-toolset-13`（装了的话）从源码编译（约 2 分钟），
  放到预编译文件的位置（先断开和 pnpm store 的硬链接，不改 store）。
- **node-gyp** 要 Python ≥ 3.8：装一个并存的新版 Python（例如 `python3.11`，不替换系统的 `python3`），安装依赖时用
  `npm_config_python="$(command -v python3.11)"` 指过去。
- **DuckDB** 的预编译要 glibc 2.25，直接可用。

新一些的系统上这几步都是空操作。

## 推送即部署（可选）

`.github/workflows/deploy.yml` 在每个 PR 和 push 上跑检查（lint → format → typecheck → test → build）。
部署 job 只在 `main`、并且配了仓库变量 `DEPLOY_ENVIRONMENT` 的仓库里运行，fork 里默认不会触发；两次部署排队、不并行。在服务器上它会：

1. `scripts/deploy-wait-idle.mjs`：有任务在跑（夜间更新、回测、扫描）或有维护标记就等，最多 15 分钟；
   还忙就**放弃这次部署、什么都不动**，稍后在 Actions 里重跑即可。
2. `git reset --hard origin/main`；`pnpm-lock.yaml` 变了才重装依赖（并 `pnpm rebuild esbuild`、`scripts/ensure-native.sh`）。
3. 构建前端 → `pm2 startOrRestart ecosystem.config.cjs` → 检查 server `/api/setup` 与 worker `/internal/health` 都是 200
   （两个端口从服务器上的 `.env` 读）。

要启用：

- 建一个 GitHub environment（建议只允许 `main` 部署），配好这些 secret：
  - `DEV_SERVER_HOST` / `DEV_SERVER_PORT` / `DEV_SERVER_USERNAME` / `DEV_SERVER_SSH_KEY`（用 CI 专用的登录钥匙，不用个人钥匙）；
  - `DEPLOY_APP_DIR`：服务器上的仓库目录。它不算机密，放 secrets 是为了在公开仓库的运行日志里打码（`vars.*` 会原样印出来）。
- 配一个仓库变量 `DEPLOY_ENVIRONMENT`，值是上面那个 environment 的名字。
- 服务器拉代码用只读 deploy key（`~/.ssh/deploy_ivan`，公钥加到仓库的 Deploy keys），经 `ssh.github.com:443` 走 SSH，
  仓库私有或公开都一样；不需要的话把那几行换成 `git fetch` 公开地址即可。

PM2 的输出会列出主机上的所有进程，workflow 里都重定向到了 `/dev/null`；部署失败时到服务器上看 `logs/`，不要把日志打进公开的运行记录。

工作日北京时间 17:30–19:30 是夜间任务窗口，这段时间尽量别合 main（会等，等不到就放弃）。

## 年度维护

- **每年 12 月**：把下一年 A 股、港股的休市日加进 `packages/core/src/holidays.ts`。没有那一年时计划日按工作日推算，
  界面会标「按工作日推算」，节假日前后的计划日会错一天。
- **应用库的只追加表**（`ledger_entries`、`plan_snapshots`、`plan_items`、`tracking_health`、`brief_editions`）有触发器挡住 UPDATE / DELETE，
  手工 SQL 改它们会报 `append-only`。真要做修正迁移，迁移里先 DROP 触发器、改完再按原样建回来，并在决策账本里说明。

## 数据源风控时的夜间更新

服务器 IP 被东财、腾讯日 K 风控时（`curl` 东财 push2his 连不上、腾讯返回 501 WAF 页），夜间更新与管理页手动触发的更新最多等解封
`ETL_RATE_LIMIT_WAIT_MS`（默认 30 分钟），等不到就把被拦的股票记成缺失、交给完整性闸门，45 分钟后自动重跑，最多 2 次（D108）。
所以一次更新最多挡回测半小时左右，不用 `pm2 restart ivan-worker` 去停它（任务没有取消功能，重启会把在跑的任务标成失败，只在紧急时用）。
三次都没拿全时当天的数据停在上一个交易日、横幅写「数据没更新」；第二天的夜间更新会把缺的日子一起补上。
风控期间别手动排更新：先在服务器上各 `curl` 一次两家日 K 接口，确认放开了再点。

## 维护：回填、手动重跑

下面的命令都在服务器的 `$APP_DIR` 里跑。

worker 独占行情仓，**回填要先停 worker**。`scripts/backfill-full.sh` 把这些都包好了：放维护标记（部署会等它，不会中途重启 worker）
→ 停 worker → 回填 A 股 → 回填港股 → doctor → 不管成败都拉起 worker、去掉标记。日志在 `logs/backfill-日期.log`，可断点续跑。

```bash
nohup bash scripts/backfill-full.sh >/dev/null 2>&1 &   # 现在跑
# 或者交给定时器在夜里跑（工作日避开 17:30–19:30 的夜间任务）：
systemd-run --unit=ivan-backfill --setenv=HOME="$HOME" --on-calendar="YYYY-MM-DD 20:30:00" /bin/bash "$PWD/scripts/backfill-full.sh"
tail -f logs/backfill-*.log
```

回填期间网站照常可用，但看板会提示「行情服务没有运行」；东财对服务器 IP 更敏感，被封会自动暂停、换源、等解封。
全量回填（A 股）在因子之前多了一步点时事件数据（两融、户数、解禁、大宗，约 1.7–1.9 万次请求）。

**两融与筹码数据的历史（R5 / S15）不用停 worker**（行情仓升级完、维护横幅消失之后）：先在管理页数据卡点「估算」看请求数与时长
（只发 4 个计数请求；也可以在服务器上
`curl -s -H "x-internal-secret: $INTERNAL_SECRET" "127.0.0.1:$WORKER_PORT/internal/events/estimate?since=2013-01-01"`），
再点「补齐历史数据」。不要在 worker 运行时用 `pnpm ivan events --estimate`：worker 独占行情仓，命令行打不开。worker 在 etl 道上分段跑（每段最多 `EVENTS_JOB_BUDGET_MS`，默认 10 分钟；
没做完 1 分钟后接着排；北京时间 16:30–21:00 不开新段），进度显示在「两融与筹码数据」里，已经在排队或运行时再点会提示。
后台回填**不开数据版本**：只写 `pit_batches` 一条批次、行上盖批次号，`committedAsOf`、连续失败晚数与无成交中位数都不受影响，
回测照常跑。补完后可以在管理页数据卡（或 `/internal/data-status`）看实际请求数、时长与四张新表的大小（`pnpm ivan doctor` 要先停 worker）。

## 行情仓升级

表结构升级分两种：只加小表、小列的，worker 启动时照常自动做；**要改大表的**（第 3 版在约 2500 万行 `bars_daily` 上补 `src`、`ver` 列）
worker 启动时不做——部署健康检查只等 24 秒、pm2 有 900M 内存上限，启动时硬做可能超时或重启循环（D76）。
这时 worker 进入**维护状态**：照常起来、`/internal/health` 返回 200（带 `maintenance` 说明，部署不会失败），但调度不排任务、
任务不认领、读行情仓的内部接口返回 503，看板和管理页显示「行情仓需要升级到第 3 版，请运行 scripts/migrate.sh」。
维护期间不排任何定时任务（夜间更新、结算、简报），也不会事后补排。

部署之后跑一次升级脚本，横幅消失即完成（不管从第几版起，一次升到当前版本）：

```bash
nohup bash scripts/migrate.sh >/dev/null 2>&1 &
tail -f logs/migrate-*.log   # 「行情仓已升级到第 5 版，用时 N 秒」之后是 doctor 的输出与「行情仓升级结束」
```

脚本和回填一样：等 worker 空闲 → 放维护标记 → 停 worker → 备份行情仓（`market.duckdb.pre-migrate-日期`，空间不够就不升级；
`MIGRATE_NO_BACKUP=1` 跳过）→ `pnpm ivan migrate`（DuckDB 内存上限默认 512MB，
`MIGRATE_MEMORY_LIMIT=768MB bash scripts/migrate.sh` 可调）→ doctor → 不管成败都拉起 worker、去掉标记。升级语句都是
`IF NOT EXISTS`，失败了重跑即可。日志里写着「worker 一直在忙，这次不升级」「磁盘剩余 …」「升级失败」的，看原因处理后重跑。
在生产库上第一次升级前，先在一份行情仓的副本上用 512MB 演练一次，记下用时。
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

**回滚到 R4 或更早的代码（包括 R1 之前的首版 R0）之前，先在当前代码上删列**：R4 和更早的代码写因子时都用
`INSERT INTO factors_daily SELECT <旧列>`，多出来的 7 列会让它报错。`--down` 只有本版的命令行有，所以要在 `git reset` **之前**、
在当前（新）代码的目录里跑，看到「已降到第 4 版」后再换代码：

```bash
nohup bash scripts/migrate.sh --down 4 >/dev/null 2>&1 &
tail -f logs/migrate-*.log   # 「行情仓已降到第 4 版（删掉了事件因子列）」
```

它删掉 7 个事件因子列、把 `schema_version` 写回 4、清掉 `meta event_factors:A` 与 `etl_progress` 里的 `event_cols:*` 进度；
事件表（第 4 版的六张表）留着无害。之后再按下面的「回滚」换代码。以后再部署 R5，worker 会重新进维护状态，跑一次 `scripts/migrate.sh` 加回这些列、
重新补算。R6、R7 的迁移只加表、加列，旧代码直接可用。

## 跨多个版本升级

从很旧的版本（比如首版 R0：第 2 版行情仓、应用库只有 `0000_init`）一次升到当前版本，按这个顺序：

1. **先改 `.env`** 里的内存预算（见上文），再合并新代码——部署会重启 worker。
2. **备份数据**（避开夜间窗口，worker 手上没有任务时做；先 `df -h` 看空间）：停 worker，
   `sqlite3 "$DATA_DIR/app.sqlite" ".backup 备份目录/app-$(date +%F).sqlite"`，拷 `market.duckdb`（旁边有 `market.duckdb.wal` 的一起拷，
   否则少了最后写进去的那部分），再拉起 worker。应用库迁移在部署时自动执行，`git reset` 只回代码、不回数据，所以备份必须在部署之前。
3. **部署**：应用库迁移自动执行；worker 起来后进维护状态，`/internal/health` 仍是 200，部署不会失败。
4. **跑一次 `scripts/migrate.sh`**，一次升到当前版本（中间各版一起做）；看板与管理页的维护横幅消失、doctor 没有报错即完成。
5. 如果 3–4 跨过了当天的夜间窗口，在管理页手动排一次那天的 A 股、港股更新（结算跟着更新一起做），过了 19:00 再点「生成简报」
   （维护期间错过的不会自动补）。
6. 需要两融与筹码因子的，按上文在管理页「估算」→「补齐历史数据」；回填完成后 worker 自己排上事件因子按年补算。

## 回滚

0. 行情仓已经升到第 5 版时，先按上面「回滚到 R4 或更早的代码之前，先删列」跑 `bash scripts/migrate.sh --down 4`。
   应用库不用动（迁移都是加列加表）；只有数据真的坏了才从升级前的备份恢复
   （`pm2 stop ivan-server ivan-worker`，删掉 `app.sqlite-wal` 与 `app.sqlite-shm`，用备份覆盖 `app.sqlite`；
   行情仓同理：先删掉 `market.duckdb.wal`，再用 `market.duckdb.pre-migrate-日期` 或手动备份覆盖 `market.duckdb`——备份旁边有 `.wal` 的，
   一起拷成 `market.duckdb.wal`；最后再拉起）。

```bash
cd "$APP_DIR" && git log --oneline -5
git reset --hard <好的提交> && pnpm --filter @ivan/web build && pm2 restart ivan-server ivan-worker
```

之后在 GitHub 上 revert 那次提交再 push，让 `main` 和服务器一致（否则下次部署会把坏提交带回来）。

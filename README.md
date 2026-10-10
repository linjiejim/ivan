# Ivan

AI native 的选股策略回测与向前跟踪（A 股 + 港股），可自部署。

用自然语言描述选股思路 → AI 把它翻译成结构化策略（你在卡片上确认才生效）→ 引擎在点时正确的历史数据上回测 →
满意后上线，每个交易日收盘后按规则重放一遍模拟盘，首页看板把回测与真实表现放在同一条曲线上对照。

> 仅供研究，不构成投资建议。数据来自第三方公开接口，可能有误差与延迟；请自行确认使用合规。

## 原则

- **LLM 负责翻译和解说，引擎负责算数。** 界面上的数字都来自引擎与数据库，卡片直接渲染工具结果。
- **只有规则能回测。** 让模型站在历史时点「挑股票」等于偷看答案（训练数据里有未来）。
- **点时正确。** 财报按公告日生效；A 股股票池含退市股；估值（市值、PE、PB）由当日股本与已公告财报自算。
- **诚实。** 样本外衰减、收益集中、交易太少、参数脆弱……由引擎按固定阈值算出并主动提示。

## 架构

```
apps/server   Hono：鉴权（better-auth + 邀请码）、REST、对话 Agent（AI SDK）、托管前端
apps/worker   调度（北京时间）+ ETL + 回测/扫描/跟踪/简报任务；行情仓 DuckDB 的唯一持有者
apps/web      Vite + React：看板、策略、回测报告、对话抽屉、管理页
packages/core     策略 DSL（zod）、因子注册表、市场规则与费率、类型
packages/engine   回测/跟踪模拟器、指标、归因、诚实检查（纯函数）
packages/data     数据源（东财、腾讯、交易所、中证、外汇中心）、行情仓、ETL、选股 SQL
packages/db       应用库 schema（SQLite + Drizzle）
packages/ai       LLM provider 配置（对话与夜间简报共用）
```

设计与全部决策记录见 [docs/specs/20260928-ivan-mvp.md](docs/specs/20260928-ivan-mvp.md)，数据源覆盖见 [docs/probe-report.md](docs/probe-report.md)，
界面设计系统（颜色、字体、组件、图标、插画）见 [docs/design-system.md](docs/design-system.md)。

## 自部署

需要 Node 22+、pnpm 10+，以及一个 OpenAI 兼容（默认 DeepSeek）或 Anthropic 的 API key。除此之外不需要任何外部服务：
应用库是 `data/app.sqlite`，行情仓是 `data/market.duckdb`。

```bash
pnpm install
cp .env.example .env        # 至少改 BETTER_AUTH_SECRET、INTERNAL_SECRET、PUBLIC_URL、LLM_API_KEY
pnpm build                  # 构建前端
```

### 首次回填行情仓

回填是一次性的，**可断点续跑**（中断后重跑同一条命令即可）。worker 运行时会独占行情仓，回填要在 worker 停掉时跑。

```bash
pnpm ivan probe                         # 先确认数据源可达（只读，十几秒）
pnpm ivan backfill --market A           # A 股，2013 年起
pnpm ivan backfill --market HK          # 港股
pnpm ivan doctor                        # 看各表规模与最新日期
```

两家日 K 接口（东财 push2his、腾讯 fqkline）都有反爬：请求太密会被按 IP 暂时封禁（实测几十分钟到数小时）。
回填默认串行、0.6 秒以上一次，被封时自动暂停、换另一家、等解封后继续——全量 A 股 + 港股大约 2–4 小时，建议放到晚上跑。
只想先试用，可以只回填市值最大的一部分：`pnpm ivan backfill --market A --top 300 --since 2016-01-01`。
这样的库，夜间增量只更新已经回填过的股票（外加近 30 天的新股），不会替其余股票补历史；要补就再跑一次不带 `--top` 的回填。

收盘价定稿前（北京时间 A 股 15:30、港股 16:30 之前）回填只取到昨天，手动触发的夜间增量会直接报错——
否则盘中价会被当成收盘价写进库。

### 运行

```bash
pnpm start                                # 最简：同时拉起 server 与 worker
# 或者用 pm2（推荐，崩溃自动重启）：
pm2 start ecosystem.config.cjs && pm2 save
```

打开 `PUBLIC_URL`，**第一个注册的账号自动成为管理员**，之后注册需要邀请码（管理页生成，或 `pnpm admin invite`）。

夜间任务（工作日，北京时间）：17:30 更新 A 股并结算 A 股跟踪、18:00 港股、19:00 生成简报，周日 03:00 抽检历史日线。
管理页可以手动触发。日历、日线、因子任何一步失败，当晚不结算、首页出横幅，简报会先说明数据没更新；
汇率、简称、财报这类辅助数据失败只记日志、沿用旧数据（见 spec D36、D38）。
简报只在当天确实有新行情时才说「今天」涨跌；休市日说休市，更新失败或还没跑完时说数据没更新、不会说成休市。
简报永久保留，不再按天数清理。

回测在单独的线程里跑：线程崩溃或超过 `BACKTEST_TIMEOUT_MS`（默认 120000 毫秒）会被终止并自动重建，
线程堆上限是 `BACKTEST_THREAD_MEMORY_MB`（默认 256）。小内存机器按 `.env.example` 里的内存预算配置
（jim-server 的取值见 [DEPLOY.md](DEPLOY.md)）。

每次回测都记一张运行卡（策略、区间、成交假设、引擎、数据版本、输入指纹、结果指纹），可以在回测页下载。
「复核数据」只重新组装输入、比输入指纹，计入每日「数据查询」额度（`QUOTA_ANALYSES`，默认 100）；
「完整重跑」照原参数再跑一遍、比成交与指标，计入回测额度，不算进试错次数。
跟踪锁定上线时基准回测的成交假设；每晚重放和上次不一致时，跟踪页写明原因（数据修订、引擎升级、成交假设变更、早于指纹记录或原因不明）。

### 管理命令

```bash
pnpm admin users                              # 列出用户
pnpm admin invite 给朋友                        # 生成邀请码
pnpm admin reset-password 邮箱 新密码            # 忘记密码（v1 没有邮件服务）
pnpm admin set-role 邮箱 admin
pnpm ivan backtest strategy.json               # 命令行回测一份策略（调试用，worker 停掉时）
pnpm ivan screen strategy.json                 # 按策略在最新数据日选股
```

## 开发

```bash
pnpm dev          # server（18905）+ worker + 前端（5173，接口代理到 server）
pnpm test         # 单测（全部离线）：点时正确、复权分解、引擎手算夹具与 1.1.0 金标准、API 越权与额度、worker 任务
pnpm typecheck && pnpm lint
```

## 已知局限

- 港股没有退市名单，港股回测有幸存者偏差（结果里常驻提示）。
- 港股财报没有公告日，按法定披露期限保守推算生效日（年报 +90 天，中报/季报 +60 天）。
- 2018 年以前的沪市股票与沪市退市股，ST 用「最近两期年报都亏损」近似判定。
- 行业用东财的当前行业分类，不是历史分类。
- 数据来自非官方接口，接口变动时用 `pnpm ivan doctor` 排查。

## 许可证

尚未确定（公开发布前定）。

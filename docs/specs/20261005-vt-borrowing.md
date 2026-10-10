# Ivan 借鉴 Vibe-Trading：更广的数据源、更准的回测、可回溯的决策辅助

- **日期**：2026-10-05
- **状态**：draft（第 2 稿：已按评审修订，处理说明见决策记录末尾「评审处理」）
- **依赖**：[20260928-ivan-mvp](20260928-ivan-mvp.md)（D1–D54 继续有效；本 spec 的决策从 D55 起编号）。
  参照对象是 Vibe-Trading（HKUDS，Python）当前发行版，只读研究、只借思路，不复制代码。
- **范围**：
  - 做（一期，22 个切片分 7 批上线，见「设计（一期）」与「实施清单」）：
    测试底座与回测线程池加固；运行合约（成交假设 ExecConfig、运行卡、输入指纹、复核与重跑、漂移归因）；
    行情仓第 3 版（数据版本先开后提交、每行记来源与版本、点时属性快照与财报首见留底）；
    规则表第 2 版与指标第 2 版；按流动性成交；可信度（区间、PSR、净值扇形）与试错计数修正；
    选股解释与个股证据；决策账本与计划快照；数字核对；跟踪健康度与简报第 2 版；决策回溯页；
    数据源接口与回退链；完整性闸门、日线体检与运行的数据来源；更贴切的基准与港股通股票池；
    点时事件数据（两融明细、股东户数、限售解禁、大宗交易）与 7 个事件因子；Tushare 可选数据源（有 token 的实例多一个不封 IP 的 A 股日线备用源、
    官方交易日历、2018 年以前沪市的真实 ST、官方停牌、交易所涨跌停价、财报实际披露日）；持仓记录、持仓风险透视、压力回放、情景对照与持仓证据。
  - **本轮给用户的新数据**：中证 500 / 1000 / 红利全收益基准与港股通股票池（S14）；A 股点时事件数据（S15、S15b）：
    融资融券明细、股东户数、限售解禁、大宗交易，都按「公布后才可得」的日期入库，成为 7 个新因子（可以当筛选条件、排序项），
    出现在个股证据里，对话里有专门的「两融与筹码」卡；新列按列补算、不重算已有因子，旧回测、旧跟踪逐字节不变（D83）。
    有 Tushare token 的实例还可以打开 S16–S16c：它不带来新的数据集，只把 Ivan 已有的几处近似换成更准的事实；没有 token 时行为逐字节不变。
    用户自己的持仓（S17–S17c）是新的产品面：只做记录、估值与描述性的风险透视，不进回测、不给买卖建议。
    取舍记录：第 2 稿把这些放在二期，是因为要先有数据源接口、健康检查与试错计数。接口（S12）与软步骤留痕（S13）本轮已经有了；
    健康检查只做最小版（每个事件报表一条金丝雀，D82），完整版仍在二期。Jim 确认本轮做。已公告未除息的分红预案（接口未核实）仍在二期。
  - 做（二期、三期）：只定方向和顺序，开工前各自补设计，见「路线图」。
  - 不做：见「不借鉴的部分」。MVP 的不做清单照旧（实盘下单与券商对接、A+H 混合策略、AI 判断型策略、
    分钟数据、指数成分股历史池、策略分享、英文界面）。

## 背景与目标

Jim 的要求：以 Vibe-Trading 为参照增强 Ivan，借它值得借的功能，让 Ivan 更完整：投资者能接入更广的数据源拿到更全的数据，
回测更准，给出更有针对性、能回溯的决策参考。

之前已经说定的方向：Ivan 的价值是**窄而准**。Vibe-Trading 有 28 个数据源、加密货币、券商网关、IM 推送，
这些不追；只挑能让 A 股 + 港股的「规则选股 → 回测 → 向前跟踪」更可信的东西。逐项研究后的结论是：

1. **数据**：本轮先把「能接更多数据源」的骨架做对：统一的数据源接口、按封禁风险排序的回退链、每行记来源、
   拿不全就停（不再把缺数据悄悄当成停牌）、坏 K 线拦在库外、辅助数据连续失败要报出来。
   用户直接用得上的是三个全收益基准和港股通股票池（内地投资者只能经港股通买港股）。
   真正的新数据集（两融、股东户数、解禁、一致预期……）放二期，因为它们要先有这套骨架和接口健康检查。
2. **回测更准**：成交不再是「任何金额都按开盘价免费成交」；规则表补上新规；指标从投入第一笔钱算起；
   每个主要数字给出按历史重抽样的区间；试错次数不再能靠挪一天起点重置。
3. **决策参考能回溯**：每晚 Ivan 给每个跟踪做的计划不可改地留底（为什么选它、排第几、哪条没满足、估算仓位、
   用的哪一版数据和引擎）；之后能看到「按现在的数据重放，这条计划执行得怎样、后来怎么样」；
   个股「为什么是它、为什么是那天」只用决策日可得的数据回答；AI 写出的数字由机器核对；
   每个跟踪有确定性算出来的状态（正常 / 偏离 / 可能失效 / 数据未更新）。

### Ivan 已经比 Vibe-Trading 做得好、保留不动的

| 方面 | Ivan 现状 | Vibe-Trading 的做法 |
|---|---|---|
| 复权 | 从仿射后复权价反推等比因子与公司行动（D28、D31）；加法复权是仿射的特例，同一套算法就能还原 | 实测东财 / 腾讯前复权是「加法」，只出警告不修 |
| A 股 / 港股规则费率 | 按日期生效的印花税、港股各项费用、科创板 200 股起、港股按每手（D6、§5） | 平印花税、不识别 ST、创业板一律 20%、科创板也按 100 股、港股每手固定 100、费用名称标错 |
| 点时财报 | 公告日生效，港股按法定期限保守推算，退市股入池，ST 三档（D20–D22） | 多数工具没有公告日滞后 |
| 回测与跟踪 | 同一个 `simulate`，每晚从上线日重放并比对（D13、D37） | 回测结束强制清仓，不适合向前跟踪 |
| 交易盈亏 | 扣费后的盈亏 | 胜率、盈亏比按毛利算 |
| 抓取 | 按域名串行限速、风控识别、自动等解封（D27、D31） | 节奏类似，Ivan 的更保守 |
| LLM 权限 | 只能写草稿，用户确认后才生效（D4） | 有直接下单与「委员会」给目标价的路径 |
| 市场边界 | 一个策略一个市场（D12），不混币种 | 跨市场组合，靠运行时警告 |

### 设计原则怎么守

| 原则 | 本轮的做法 |
|---|---|
| 1. LLM 翻译解说，引擎算数 | 新卡片都渲染工具结果；数字核对把「只能照抄工具结果」从提示词变成机器检查（简报不通过就用模板，对话里标注出来）；健康状态、判词、证据项都由确定性代码给出，LLM 只复述；提示词明确区间与「把握」不是概率、判词「可能失效」不说停止或卖出、口径不同的回测先说口径 |
| 2. 只有规则能回测 | 不引入任何 LLM 选股路径；个股证据、计划快照只解释规则的结果；持仓本轮只做记录、估值与描述性的风险透视（S17–S17c），交割单放二期以后，都不进回测；持仓相关的工具与卡片只陈述证据和风险，不说加减仓 |
| 3. 点时正确 | 个股证据只有一个点时读取器（今天与历史同一套），按决策日（成交日的前一个交易日）取数；财报优先用当时首次见到的数值；计划快照存当时的因子值而不是引用；属性快照（行业、港股通）从首次记录日起才算点时，之前用首次名单并明确提示；成交用的日均成交额、波动率取决策日的值，早于次日开盘成交；回测、结算、选股只读提交过的数据版本；事件数据每行存可得日与规则（两融、大宗 T+1，户数按公告日，解禁按规则推算后以首次见到为准），撤下的记录软删除而不是物理删除，补算历史时当时知道的仍然算 |
| 4. 可复现 | 成交假设成为记录在案的回测参数，旧结果用「旧口径」锁定、逐字节复现；运行卡记下策略、数据、引擎、成交假设、输入指纹与指纹口径版本；结果指纹分「成交与指标」和「提示项」两部分，重跑逐笔一致只看前者；可信度的种子来自输入指纹；漂移能说清原因；需要 token 的来源（Tushare）拉到的数据逐行记来源、落进行情仓；运行卡写明用了哪些，复核与重跑只读行情仓、不需要 token；每次持仓风险透视都留成不可改的快照并记账 |
| 5. 诚实 | 新检查项：可信度不足、回撤偏乐观、容量受限、流动性差、各年表现不一致、数据缺口、数据问题、财报久未更新、基准不匹配、港股通名单为近似；跟踪状态「样本不足」从不算「正常」，第一个读数不好不会先显示「正常」；健康度的误报率与检出率都写明 |
| 6. 自部署零外部依赖 | 不新增外部服务；新数据源都是可选的接口实现；测试全部离线；DuckDB 禁止自动下载扩展；内存预算写进部署文档并实测；Tushare 是可选的，token 为空就完全不发请求 |

## 路线图

一期是本轮。二期、三期只排顺序，开工前各自补设计；「来源」一列是研究阶段的提案编号（研究记录里有出处与移植说明）。

| 阶段 | 内容 | 来源 | 为什么在这一期 |
|---|---|---|---|
| 一期 R1 · S01 | 测试底座、回测线程池加固、哈希工具、引擎金标准、市场当日状态、简报两处线上修正 | 横切 | 后面每个切片都要用；简报休市说「今天」是线上 bug |
| 一期 R1 · S02 | 运行合约：成交假设、运行卡、输入指纹、复核与重跑、漂移归因 | ACC-1 + DATA-3 指纹部分 + DEC-5 重跑 | 所有引擎改动的前提；没有它旧跟踪会被悄悄改写 |
| 一期 R1 · S03 | 行情仓第 3 版：数据版本开 / 提交、每行来源与版本、属性快照、财报首见留底、升级脚本 | DATA-1 表结构 + DATA-8 采集 + DATA-12 留底 | 只能向前积累的数据，R1 一上线就开始攒 |
| 一期 R2 · S04 | 规则表第 2 版 + 指标第 2 版 | ACC-2 + ACC-3 | 小而确定的修正，后面的可信度要用新口径 |
| 一期 R2 · S05 | 按流动性成交（买入参与率上限、半价差、冲击成本、拒单诊断、容量） | ACC-4（部分） | 回测偏乐观的最大来源 |
| 一期 R2 · S06 | 可信度（平稳块自助法区间、PSR、净值扇形）+ 试错计数修正 | ACC-5 + ACC-6 的小修 | 每个主要数字给出诚实的区间 |
| 一期 R2 · S07 | 选股解释与个股证据（点时、带出处、可校验） | DEC-1 解释部分 + DATA-7 | 「为什么是它」的唯一答案来源 |
| 一期 R2 · S08 | 决策账本与计划快照（含重放成交留底、计划结果回看的最小版、节假日表） | DEC-1 + DEC-3 最小版 | 回溯的核心，快照也是只能向前积累的数据 |
| 一期 R3 · S09 | 数字核对（简报闸门、对话标注、用量与模型留痕） | DEC-2 | 原则 1 机器化 |
| 一期 R3 · S10 | 跟踪健康度、判词、简报第 2 版 | DEC-4 | 线上 bug + 让完整性闸门的后果看得见 |
| 一期 R3 · S11 | 决策回溯页 | DEC-5（精简） | 让用户看得到 S08 的记录 |
| 一期 R4 · S12 | 数据源接口与回退链 | DATA-1 | D9 落地，接新源的接缝 |
| 一期 R4 · S13 | 完整性闸门、日线体检、辅助数据失败可见、运行的数据来源 | DATA-1 闸门 + DATA-2 | 数据不再悄悄退化 |
| 一期 R4 · S14 | 中证 500 / 1000 / 红利全收益基准、「基准不匹配」提示、港股通股票池 | DATA-5（部分）+ DATA-8 港股通部分 | 中小盘、红利策略别再拿沪深300比；港股回测只选买得到的股票 |
| 一期 R5 · S15 | 点时事件数据集：两融、股东户数、限售解禁、大宗交易；通用可续跑的点时数据集运行器（走 S12 的接口，与具体来源无关）；每个报表一条最小金丝雀（失败就关）；夜间软步骤与后台分段回填 | DATA-6（数据部分）+ DATA-4（最小版） | 最想要的新数据；S12 的接口、S13 的软步骤留痕与数据问题都已就位 |
| 一期 R5 · S15b | 事件因子（注册表第 3 版，核心与事件分版本）、按列按年补算不重算旧因子、补完前提前拒绝、个股证据第 2 版、「两融与筹码」卡与 `get_security_events` | DATA-6（因子部分） | 让新数据能回测、能解释，同时旧结果不变 |
| 一期 R6 · S16 | Tushare 可选数据源（一）：客户端与错误分类、能力状态、A 股日线备用（交易所前收口径 + 复权核对）、官方交易日历、运行的 token 来源、管理页与探针 | DATA-9（部分） | 接一家新源只是「再加一个实现」；没有 token 的实例不受影响 |
| 一期 R6 · S16b | Tushare（二）：2018 年以前沪市 ST、财报实际披露日、回填与清除脚本 | DATA-9（部分） | 把两处已知近似换成事实 |
| 一期 R6 · S16c | Tushare（三）：官方停牌进完整性闸门、交易所涨跌停价进引擎（规则表第 3 档，只对新运行）与日线体检、规则表夜间核对 | DATA-9（部分） | 唯一改引擎的部分，单独成片，挂在记录在案的字段上 |
| 一期 R7 · S17 | 持仓：账户、只追加的持仓快照、券商 CSV 导入、点时估值、删除与清除、`propose_holdings` / `get_portfolio`、持仓页 | DEC-6 | 有了用户自己的持仓，参考才能「针对你这本账」 |
| 一期 R7 · S17b | 持仓风险透视：纯函数风险模块（与以后的回测风险透视共用）、上限与超限、实测断言的压力回放、透视快照与账本、`get_portfolio_xray` | DEC-7 + ACC-9 的计算部分 | 描述性、可手算、可回溯 |
| 一期 R7 · S17c | 情景对照、持仓证据卡（沿用个股证据）、按现在的数据重算、之后怎么样、导出、`get_holding_evidence`、看板卡片 | DEC-7 余下 | 回看与解释 |
| 二期 | 修订日志与分区校验（逐行说清哪些 K 线被改过） | DATA-3 余下部分 | 让计划快照的「数据修订」精确到行 |
| 二期 | 数据源健康检查完整版：独立健康表、定时检查全部报表、按健康度调整回退链（S15 已有事件报表的最小金丝雀） | DATA-4 | 新数据集上线前必须先有 |
| 二期 | 已公告未除息股息率（分红预案，接口先实测） | DATA-6 | 最想要的新数据；要先有接口、金丝雀与试错计数 |
| 二期 | 计划结果统计（买入后 20 天跑赢比例、卖出后表现、实盘 IC） | DEC-3 余下 | 单条「后来怎么样」在 S08 / S11 已有；统计要攒约 8 周快照，可以事后补算 |
| 二期 | 多重检验（DSR、PBO）与滚动检验 | ACC-6、ACC-10 | 扫描与版本多了才有意义；新因子放开前做 |
| 二期 | 退市与长期停牌的估值（锁死退市打折、指数法估值） | ACC-11 | 用 S13 的停牌记录 |
| 二期 | 按流动性成交的余下部分：卖单部分成交、全天均价成交 | ACC-4 余下 | 状态路径多，单独做 |
| 二期 | 港股恒生科技基准、无风险利率（Shibor / HIBOR，指标第 3 版） | DATA-5 余下 | 接口与代码要先实测 |
| 二期 | 行业、每手股数的点时因子（用 S15b 的按列补算，不全量重算） | DATA-8 余下 | 快照历史够长才有意义 |
| 二期 | 跟踪改用新成交假设（显式升级，记账本） | D55 | 现有跟踪先锁旧口径 |
| 二期 | 规则提醒与复核清单（DEC-8）、回测页风险透视分页（ACC-9 的界面部分，直接用 S17b 的 `risk/` 模块） | DEC-8、ACC-9 | 新产品面，要先有真实券商样本 |
| 三期 | 财报第 2 版（三大表、审计意见、重述版本） | DATA-12 | 注册表升级、全量重算 |
| 三期 | 研报一致预期 | DATA-10 | 接口未核实，财年映射是主要风险 |
| 三期 | Tushare 余下能力：分红预案、限售解禁备用（实现 S15 的事件接口即可）、业绩预告 / 快报、三大表首发数值、港股退市股、Shibor / HIBOR 备用（跟着 DATA-6 余下、DATA-12、DATA-5 各自的数据集一起做） | DATA-9 | 只有有 token 的人受益，授权条款要先弄清 |
| 三期 | 自有数据导入（因子面板） | DATA-11 | 点时正确性只能靠导入方声明，要在试错计数之后 |
| 三期 | 交割单体检、执行一致性、分市况证据、选股能力检验、港股人民币视图与股息税、投资论点、影子策略 | DEC-10、DEC-11、ACC-7、ACC-8、ACC-12、DEC-9、DEC-12 | 价值依次递减或依赖前面各项 |

## 设计（一期）

各节标题后的 Sxx 是实施切片编号。切片按编号顺序在同一棵工作树里实现，每个切片结束时 `pnpm test`、
`pnpm typecheck`、`pnpm lint` 全绿；**分 7 批上线**（D76、D98）：R1 = S01–S03，R2 = S04–S08，R3 = S09–S11，R4 = S12–S14，R5 = S15–S15b，R6 = S16–S16c，R7 = S17–S17c。
实现顺序就是编号顺序：S15 → S15b → S16 → S16b → S16c → S17 → S17b → S17c。
每批单独部署、单独写落地记录与人工核对；每批的迁移对上一批可回滚。只能向前积累的数据（属性快照、财报首见、
计划快照）因此在 R1 / R2 上线时就开始攒，而不是等到最后一批。

### 1. 测试底座与运行时加固（S01）

**为什么先做**：packages/data 没有任何 HTTP 假件，worker 一个测试都没有（`env.ts` 没有测试注入）；
回测线程崩了不会重启、也没有超时，结算在串行的 etl 道里调它，一次 OOM 能把当晚的结算和简报全堵住。

- **HTTP 假件**：`http.ts` 导出 `HttpLike = Pick<Http, "text" | "json" | "isBlocked" | "earliestUnblock">`，
  `EtlContext.http` 与所有 `sources/*.ts` 改用它（只改类型）。命令行 `openCtx` 同时返回具体的 `Http`，
  `printHttp` 对它调用 `stats()`。`@ivan/data/testing` 提供 `FakeHttp`（正则路由 → 固定返回 / `BlockedError` / `HttpError`，
  记录每次请求）与 `loadFixture(name)`。夹具放 `packages/data/src/testing/fixtures/`：已有测试里的真实片段优先，
  否则按接口文档字段手工构造；绝不在测试里联网，也不含 token。
- **worker 测试环境**：`setWorkerEnvForTest(env)`；`WorkerEnv` 增加可注入的 `today()`（`etlContext`、简报都用它）。
  `apps/worker/src/testing/harness.ts`：临时目录的 SQLite（`openAppDb`）+ 内存 DuckDB + `fakeJobContext()` + `seedTracking()`；
  `@ivan/data/testing` 的 `seedSyntheticMarket(wh, …)` 一次写入小型合成市场（交易日历、证券、日线、因子、指数、数据版本）。
  证券的板块、行业、一级行业默认同时写进 `factors_daily` 的同名列（选股 SQL 按 `factors_daily` 筛选与分组），可被逐日覆盖。
- **回测线程池**：线程崩溃（`error` / 非零 `exit`）时拒绝当前调用并重建线程；单次调用超时
  `BACKTEST_TIMEOUT_MS`（默认 120000）后终止并重建；`resourceLimits.maxOldGenerationSizeMb = BACKTEST_THREAD_MEMORY_MB`
  （默认 256）。线程工厂可注入，测试用假线程，不起真线程。
- **内存预算**（写进 `.env.example` 与 `DEPLOY.md`）：`DUCKDB_MEMORY_LIMIT + BACKTEST_POOL_SIZE × BACKTEST_THREAD_MEMORY_MB
  + 约 250 MB（主线程、转交的价格面板、DuckDB 自身开销）≤ pm2 max_memory_restart − 100 MB`。
  jim-server（max_memory_restart 900M、DuckDB 384MB、线程池 1）设 `BACKTEST_THREAD_MEMORY_MB=160`：线程堆里只有结果对象，
  价格面板是转交的 ArrayBuffer、不算在线程堆上限里。超了先降 DuckDB 内存；验收 12 实测。
- **哈希工具**：沿用 `canonicalJson`（键排序；数字按 `JSON.stringify`，NaN / ±∞ 输出 `null`），不做舍入。
  `@ivan/core/node`（新子路径，只在 Node 里用，web 不引入）提供 `sha256Hex`、`sha256Canonical`、流式 `Sha256Stream`
  与 `specHashOf(spec)`（= `sha256Hex(canonicalJson(spec))` 前 16 位，`strategy_versions.spec_hash`、扫描的 `specOverride`、
  试错计数都用它，避免 16 位与 64 位混比）。其余新哈希全长 64 位十六进制，界面显示前 8 位。
- **引擎金标准**（D56）：在改动 `simulate.ts` 之前，把夹具集中到 `packages/engine/src/testing/fixtures.ts`，
  用 `legacyView(result)`（只取 1.1.0 已有的字段）的 `sha256Canonical` 记进 `__fixtures__/legacy-1.1.0.json`。
  夹具一共 10 个，覆盖后面要改的每条路径：现有的 A 股主板基础、月初调仓、三种仓位控制；新增**港股**（每手 500 与 2000，
  交易跨过 2021-08-01、2023-01-01、2023-11-17 三个费率变化日）、**信号模式**、**单只上限 maxWeight**、**退市清出**、
  **科创板**（200 股起、20% 涨跌幅）。之后每个切片都要让它保持一致。
- **市场当日状态**（D78）：`apps/worker/src/market-day.ts` 的 `marketDayStatus(market, today)` 返回四态之一，
  简报、判词（S10）、数据横幅、`/internal/data-status` 共用：
  - `traded`：有一个提交过的数据版本 `as_of = 今天`；
  - `closed`：今天是周末，或今天这个市场的 etl 任务已完成且结果是 `tradingDay: false`；
  - `stale`：今天这个市场有失败的 etl 任务且之后没有成功（S13 起也包括排着队等自动重跑的）；
  - `pending`：其余（还没跑或正在跑）。
- **简报两处线上修正**：休市日不再把上一交易日的涨跌说成「今天」：每个跟踪带 `lastDate`，只有 `lastDate = 今天`
  才有当日收益；只有用户涉及的市场**全部是 `closed`** 时模板第一句才是「今天休市，没有新的行情」；`stale`、`pending`
  的市场照旧说「数据没更新」，**永远不说休市**（原来开市日指数步骤失败时，交易日历里没有今天，会被误判成休市）。
  不再删除 90 天前的简报（D70）。

> **实现备注**（S01）：
> - `FakeHttp.earliestUnblock` 与真实 `Http` 同口径：给定域名**全部**被封时返回最早解封时刻，有一个没被封就返回 0
>   （切片计划写的是「被封域名里最早解封的时刻」，与 `Http` 不一致；假件跟着真实实现走，免得回退链的测试与线上行为不同）。
> - `fakeJobContext()` 记录进度的字段叫 `progressCalls`（`progress` 已是 `JobContext` 上的函数）。
> - `classifyMarketDay`：失败之后另起的重跑任务还在排队或在跑时仍算 `stale`（「失败且之后没有成功」）；
>   同一个任务被自动重新排队（`attempt > 0`）在 S13 才算 `stale`，本切片是 `pending`。
> - 简报模板里 `pending` 的市场说「数据还没更新完」，`stale` 说「数据没更新成功」，都不说休市。
> - 引擎金标准的 10 个夹具在 `packages/engine/src/testing/fixtures.ts`，记录脚本拒绝在 `ENGINE_VERSION ≠ 1.1.0` 时运行。
>   10 个夹具都以空的待执行订单收尾；另有 6 个截到区间中途、收尾有待执行订单的变体（止损、止盈、调出、调仓、持有到期，建仓、信号买入），
>   指纹是在未改动的 1.1.0 引擎（916a43c）上算的，直接写在 `legacy.test.ts` 里（`legacy-1.1.0.json` 不重录）。
> - 港股夹具的日历是**四段**：除了上面三个日子，还围着 2022-01-01（1.1.0 从这天起收财汇局交易征费；
>   2023-01-01 在 1.1.0 里没有费率变化，是给 S04 的港股交易费准备的）。信号夹具让满仓、次日停牌、已持有重复信号
>   三条跳过分支都在「有空位」或「满仓」的对应状态下走到；`legacy.test.ts` 另有断言盯着夹具确实走到这些分支和费率日。
> - 简报模板里没有当日涨跌的跟踪：市场 `closed`（或旧 facts 没有当日状态）写「最近交易日 X」；市场 `traded`
>   而跟踪没结算到今天（数据入库后结算失败）写「今天还没结算，停在 X」；`stale` / `pending` 写「数据停在 X」。
>   结算失败但数据版本已提交的市场仍是 `traded`（D78 不变）。
> - 夜间增量在指数日 K 没有今天时，只有指数报价日期**明确早于今天**才判休市；报价请求失败或读不出日期时任务失败
>   （→ `stale`），不再当成休市（`confirmNonTradingDay`，原本留给 S13 的一处，提前修，免得开市日说休市）。

### 2. 运行合约：成交假设、运行卡、复核与重跑（S02）

**成交假设 `ExecConfig`**（`packages/core/src/exec.ts`，D55）是回测参数，不属于策略版本；券商佣金仍在 `spec.costs`。
每个字段都带「旧口径」默认值，`resolveExec(partial)` 用旧口径补齐缺省字段，所以以前存下的运行与跟踪永远按旧口径解析：

| 字段 | 旧口径 `LEGACY_EXEC` | 新回测默认 `defaultExec(market)` | 引入切片 |
|---|---|---|---|
| `v` | 1 | 1 | S02 |
| `rules` 规则表版本 | 1 | 2 | S04 |
| `metrics` 指标版本 | 1 | 2 | S04 |
| `slippageBps` 单边滑点 | 0 | A 股 5、港股 10 | S05 |
| `tickSpread` 加半个最小价位 | false | true | S05 |
| `impact` / `impactEta` 冲击成本 | none / 0 | sqrt / 0.5 | S05 |
| `participation` 单笔不超过日均成交额的比例 | null | 0.10 | S05 |

规则：引擎还没实现的字段不进 schema，也不进默认值；每个字段在实现它的那个切片里加。
`BacktestParams.exec?` 缺省按 `LEGACY_EXEC`；`normalizeParams` 把用户覆盖项（严格校验、不认识的键报错）
合并到 `defaultExec`，存进 `runs.params.exec` 的永远是完整对象；回测任务把它原样传给 `buildSimInput`，
并断言 `result.exec` 与运行卡记的一致。`describeExec(exec)` 给出一行中文摘要；`defaultExec`、`describeExec` 在 `@ivan/core`
主入口（纯 zod，不依赖 Node），web 直接引入，不另开接口。

**跟踪锁定成交假设**：`trackings.exec_config`（非空，迁移默认 `{"v":1}` = 旧口径），现有跟踪全部是旧口径；
新上线的跟踪抄基准回测的 `exec`，没有基准回测就用 `defaultExec`。改口径要显式升级（二期，升级会记进账本）。
基准回测是旧口径、而当前市场已经有更新的口径时（R2 起），上线提案带 `legacyBaseline: true`，卡片写
「基准回测用的是旧口径，上线后也会沿用；建议先按新口径重新回测」；回测页多一个 ghost 按钮「按新口径重新回测」，
打开回测对话框并预填原来的区间与资金、成交假设为 `defaultExec`。

**引擎版本**（D56）：本轮只升一次，`ENGINE_VERSION` 1.1.0 → 1.2.0（在 S02），之后各切片的新行为都挂在 exec 字段上，
不再改版本号。`SimResult` 回显 `exec`。金标准测试扩展为「`exec` 缺省」与「`exec = LEGACY_EXEC`」两种都逐字节一致。

**输入指纹**（`packages/data/src/query/input-hash.ts`，D57）：`hashSimInput(input, {cut?, rule?})` 流式 sha256，
必须在 `runSimulation` 之前算（线程转交会让 TypedArray 失效）。组成：

- `selectionHash`：纳入的决策日 + 有序代码；信号按（日期, 代码）排序。纳入规则 `rule`：
  - `all`（默认，回测与复核用）：决策日 ≤ cut；
  - `executed`（跟踪前缀用）：决策日的**执行日**（日历上的下一个交易日）≤ cut。这样「今晚 cut = 昨天」与「昨晚 cut = 昨天」
    纳入的决策完全相同，不受「昨天是不是周末前最后一个交易日」这类边界影响。
- `priceHash`：上面这些代码排序后，每只 `code:from:长度`、证券信息（名称、板块、每手、行业、退市日、上市日），
  再接各价格数组截到 cut 的原始字节（open、high、low、close、adj、st，以及 S05 之后存在的 adv、sigma）。
- `benchHash`：截到 cut 的日历与基准字节、基准名称。
- `inputHash = sha256(canonicalJson({hashVersion, spec, start, capital, exec, cut, rule, selectionHash, priceHash, benchHash}))`。
- 检查项说明（`dataCaveats`）与试错次数**不进输入指纹**，它们是报告；运行卡单独记 `caveatsHash`。
- `HASH_VERSION`（本轮起 1）：指纹的组成或 `resolveExec` 的输出形状一变就加 1（R2 的 S04 加上市日与规则 / 指标字段时升到 2）。
  口径版本不同的两个指纹不比，归因记「早于记录」。

**运行卡**（`packages/core/src/runcard.ts` 纯类型与组装，哈希函数注入）：

```ts
interface RunCard {
  schema: 1;
  kind: "backtest" | "sweep_child" | "reproduce";
  spec: { versionId: string; specHash: string };
  params: { start: DateStr; end: DateStr; capital: number; oosMonths: number };
  exec: ExecConfig;
  engine: { version: string; rulesVersion: 1 | 2; metricsVersion: 1 | 2 };
  data: { market: Market; versionId: number | null; asOf: DateStr | null; factorRegistry: number;
          warehouseSchema: number; hashVersion: number; inputHash: string; selectionHash: string;
          priceHash: string; benchHash: string; caveatsHash: string;
          provenance?: RunProvenance /* S13 */ };
  seeds: { validation: number | null /* S06，来自 inputHash */ };
  outputs: { coreHash: string; reportHash: string };
  cardHash: string; // 覆盖卡片本身，不含 runId、createdAt
}
```

`coreHash` = 结果中 `series、trades、holdings、metrics、segments、attribution、final`（以及 S05、S06 加的 `diagnostics`、`validation`）
的 `sha256Canonical`；`reportHash` = `checks` 的 `sha256Canonical`。检查项里有从数据派生的提示（数据问题、基准不匹配、
试错次数），它们可以在 K 线一根没变的情况下变化，所以「逐笔一致」只看 `coreHash`。
应用库 `runs` 加 `card`、`card_hash`、`input_hash`、`verify` 四列。

**复核两级**（合并原提案里的三个入口为一个流程）：

1. 「复核数据」：`POST /api/runs/:id/verify` 计入新的每日额度 `analyses`（默认 100，D59），在 compute 道排一个
   `verify` 任务（和回测共用线程池名额与「ETL 写库时不认领」的规则，不会在夜间更新时读到写了一半的数据，也不会多个一起
   把内存撑爆；同一用户同时只能有一个，否则 409「上一次复核还没结束」），立即返回「排队中」。任务用原参数（含截到的终点）
   重新组装输入、算指纹，把 `{sameInput, engineSame, hashVersionSame, dataVersionThen, dataVersionNow}` 写进原运行的 `verify`；
   回测页轮询直到完成。早于指纹记录的回测写「这次回测早于指纹记录，没法只比输入，可以完整重跑」。
2. 「完整重跑」：`POST /api/runs/:id/reproduce` 新建一次 `kind = "reproduce"` 的运行（参数完全照抄，计入回测额度），
   跑完比 `coreHash`：逐笔一致 / 数据已修订 / 引擎不同 / 指纹口径升级过 / 原因不明；`reportHash` 不同时另加一句中性的
   「提示项有变化（例如数据提示或试错次数）」。结果写回原运行的 `verify` 列。重跑不计入试错次数。

**漂移归因**（`packages/engine/src/drift.ts`，一个函数，计划快照的版次原因也用它）：
`attributeDrift(prev, cur, replay)`，prev 是上一晚存的 `{engineVersion, execHash, prefixHash, hashVersion, lastDate}`，
cur 是今晚按 `cut = prev.lastDate, rule = executed` 重算的前缀指纹。没有漂移 → none；上一晚没存指纹或指纹口径版本不同 → unrecorded；
引擎不同 → engine；成交假设不同 → exec；前缀指纹不同 → data；都相同却有漂移 → unexplained（记日志，属于程序问题）。
不能拿整窗指纹比：窗口每晚变长，指纹每晚都会变。结算把 `engineVersion、dataVersion、execHash、inputHash、prefixHash、
hashVersion、lastDate` 与归因写进 `trackings.summary`，跟踪页的说明从「数据被修订过」改成具体原因。

**界面**：回测页抬头的「回测设置」ⓘ 改为「复现信息」：策略 v3（指纹）· 数据截至 2026-09-30（#412）· 引擎 1.2.0 ·
成交假设摘要 · 输入指纹（可复制）· 运行卡指纹；两个按钮「复核数据」「完整重跑」，结果用 Badge（输入一致 / 数据已修订 /
逐笔一致 / 结果不同）；「下载运行卡」（`GET /api/runs/:id/card`）。对话 `get_run` 的模型摘要加上运行卡指纹前 8 位、
引擎、数据截至、成交假设摘要。新额度 `analyses` 在管理页的额度编辑器（只更新提交的那几项，不会把别的覆盖项清空）、
用量表（「数据查询」列）与账户菜单的额度显示里都看得到。

> **实现备注**（S02）：
> - `resolveExec` 遇到读不懂的存储值（比如以后版本写入的字段）抛 `ExecConfigError`，不悄悄按旧口径跑；
>   回测页与跟踪页读取时兜底为 `null`（显示「--」），结算与回测任务则直接报错。
> - 完整重跑的比对结果同时写进原运行与重跑运行的 `verify`（原运行的 `verify` 之后可能被新的复核覆盖，重跑页仍要能说清结论），
>   并带一个 `cause`，用与漂移归因同一个 `changeCause` 判断（结果不同且各项指纹都相同时记 `unexplained`）。
> - 原运行早于运行卡（没有 `coreHash`）时，完整重跑从存档两边同口径地重算结果指纹（净值、成交、持仓、指标、归因、期末），
>   所以旧回测也能判断「逐笔一致」；这时 `sameInput` 为 `null`，结果不同记「原回测早于指纹记录」。两边都先投影到 1.1.0 存过的字段
>   （`@ivan/engine` 的 `legacyView`，和金标准同一个冻结视图）再算：1.2.0 在旧口径下也给 `final.pending` 写预估价、股数这些字段，不能因此报「结果不同」。
> - 复核只接受跑完的回测（否则 409「这次回测还没跑完」）；参数扫描的父记录没有输入，要到子回测上复核（400）。
>   worker 重启时，卡在「排队中 / 复核中」的 `verify` 一并标成失败。
> - 管理员改额度的接口沿用原来的 `POST /api/admin/users/:id/quota`，改为只更新请求体里出现的项；管理页的额度编辑器也只提交改过的项。
> - `GET /api/runs/:id` 另外返回策略的 `market`（判断「按新口径重新回测」要用）；跟踪接口返回 `execConfig` 与 `execText`。
> - `pnpm ivan backtest` 也显式传 `defaultExec(market)`，并打印引擎、成交假设与输入指纹前 8 位。
> - 「原参数（含截到的终点）」「参数完全照抄」里的终点都指原运行实际用到的、截到数据截至日之后的那天（运行卡 `params.end`；
>   早于运行卡的取存下的 `params.end`，回测跑完时本来就改写成截过的终点）。复核按它重组输入、用默认 cut 算指纹；
>   完整重跑把它钉进新运行的参数。这样之后夜间更新多出来的交易日不会进窗口，「第二天才重跑」也逐笔一致。
> - 复核与完整重跑都写原运行的 `verify`，所以互斥：这次回测的复核任务还没结束时不能重跑，重跑还没跑完时不能复核（都是 409）；
>   重跑运行本身不能复核（400「重跑的结果请到原回测上复核」）。重跑跑完后比对出错或原回测已不在，记 `verify.status = failed`
>   （重跑本身仍是跑完），重跑页不会一直显示「正在和原回测比对」。
> - 基准回测的成交假设读不懂时，上线提案与确认给 409「基准回测的成交假设读不懂，请先重新回测」。
> - 结算存下的 `lastDate` 与今晚前缀指纹的 cut 是同一个日期（日历上最后一个 ≤ 数据截至日的交易日）。

### 3. 行情仓第 3 版：数据版本、行级来源、点时快照（S03）

`SCHEMA_VERSION` 2 → 3，全部用 `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`，一次升级：

- `bars_daily`、`corp_actions`、`index_bars`、`financials`、`share_changes` 表尾加 `src VARCHAR`、`ver INTEGER`。
  `Warehouse.append` 按列序写，所有写入方的行元组在末尾补这两个值；列序测试守着。
  `src` 取值：`em`（东财）、`tx`（腾讯日 K）、`txq`（腾讯实时报价）、`csi`（中证官网）、`prov`（临时补齐的全收益）。
  已有的行为空，界面显示「来源未记录」。
- 新表 `bar_status(code, date, status /*suspended|no_trade|missing*/, reason, src, ver)`、
  `data_issues(id, ver, dataset, code, date, rule, severity /*reject|flag*/, detail, src, created_at, resolved_ver, resolved_by)`、
  `attr_history(code, attr, value, valid_from, valid_to /*不含；NULL = 当前*/, src, ver)`、
  `financials_seen(code, report_date, row_hash, first_seen, ver, row_json /*按列名的对象*/)`。本轮 S03 只建表，后两张开始写；
  `bar_status`、`data_issues` 由 S13 开始写。
- `data_versions` 加 `status`（`open | ok | incomplete | failed | skipped`；旧行为空 = ok）、`started_at`、`completeness`（JSON）、
  `sources`（JSON）、`registry_version`。
- 新的每股表都加进 `purgeHkRmbCounters` 的表清单。

**数据版本先开后提交**（D60）：`recordDataVersion` 拆成 `beginDataVersion(ctx, market, kind)`（先把残留的 `open` 行关成 `failed`，
再写一行 `open`，返回 id）与 `commitDataVersion(ctx, id, {status, completeness?, sources?, note?, revisedRows?})`。
夜间增量在**写任何东西之前**开版本（指数与交易日历也盖上版本号）；确认休市时提交 `skipped`（不会被引用）；成功提交 `ok`；
抛错时提交 `failed` 再抛。回填与每周抽检同样。`EtlContext.ver` 带上当前版本号，写入方盖章。
`latestDataVersion` 只返回 `ok` 的版本；新增 `committedAsOf(wh, market)` = 最新 ok 版本的截至日，**所有决定「读到哪一天」的地方都用它**：
`buildSimInput` 的终点截断与「补下一个交易日」的锚点、`settleMarket` 的最新交易日、`/internal/screen` 的默认日期、
个股证据与选股解释的默认日期。某晚写了因子却失败时，回测、结算、选股都还停在上一个提交过的版本上。

**ETL 写库期间不跑回测**：etl 道里有 `etl` / `check` 任务排队或运行时，compute 道（回测、扫描、复核）不认领新任务；
etl 道认领 `etl` / `check` 前等正在跑的回测结束（不会饿死：compute 道这时已经不再认领）。
`/internal/data-status` 给出 `computePaused {reason, since}`，回测页与对话里排队中的回测显示「行情正在更新，回测会在更新完成后开始」。

**升级方式**（D76）：在约 2500 万行日线上补列不能在 worker 启动时做（部署只等 24 秒健康检查，pm2 有 900M 内存上限）。
- `Warehouse.open(path, {migrate: "light"})`：worker 默认用它。需要改大表（`bars_daily` 还没有 `src` 列）时不执行升级，
  进入维护状态：调度不排任务、runner 不认领、`/internal/health` 照常 200 并带 `maintenance`、读行情仓的内部接口返回 503，
  数据横幅显示「行情仓需要升级到第 3 版，请运行 scripts/migrate.sh」。`WAREHOUSE_MIGRATE_ON_BOOT=1` 可以强制启动时升级（开发机用）。
- `pnpm ivan migrate` 与 `scripts/migrate.sh`（照 `backfill-full.sh` 的样子）：等 worker 空闲 → 放维护标记 → 停 worker →
  用 `DUCKDB_MEMORY_LIMIT`（默认 512MB）升级 → 拉起 worker → 去掉标记；日志写 `logs/migrate-日期.log`。
- 回滚兼容（写进 DEPLOY.md）：旧代码打开第 3 版行情仓时会重跑第 2 版的建表语句（全是 IF NOT EXISTS，无害）并把版本号写回 2，
  按列序追加时表尾两列自动补空；下次再部署新代码，第 3 版语句重跑都是空操作，不会再触发维护状态（判断的是列在不在，不是版本号）。
  应用库迁移都是加列加表，旧代码不受影响；S08 起的只追加触发器回滚后仍在，这是有意的。

**点时属性快照**（D61，只采集，不改因子）：`etl/snapshots.ts` 的 `upsertSnapshot(wh, attr, current, date, src, ver)`：
值变了就把旧区间的 `valid_to` 设成今天并开新区间；从当前名单里消失就关区间；新代码开区间；
第一次快照从当天起算，绝不回填。同一天重跑幂等。一天里超过 30% 的代码同时变化时整批不记，日志提示
「行业分类一天变了 X%，可能是数据源改了名，先不记录，请管理员核对」，并记进 `meta`，管理页显示成一行警示。
采集点（零额外请求）：`refreshSecuritiesA` 记 `industry_l1`、`industry`；`refreshSecuritiesHK` 记 `industry_l1`、`lot_size`，
并在已有的 `RPT_HKF10_INFO_SECURITYINFO` 请求里加 `GANGGUTONGBIAODISHEN` 列，记 **`hk_connect_sz`**
（这一列是深港通标的；「是」→ Y，其余 → N；整批都拿不到这列时不记）。沪港通的标记列名还没核实：探针加一条只在命令行运行的检查，
列出这张报表所有含 `GANGGUTONG` 的列；找到后在 S14 加采 `hk_connect_sh`。读取函数 `attrAsOf(attr, code, d)` 返回
`{value, from, preSnapshot}`，S07 的个股证据、S14 的港股通股票池用它。

**财报首见留底**（只采集，S07 起读）：`writeFundamentals` 删除重写之前，对每个（代码, 报告期）算数值字段的 `row_hash`，
没见过的组合追加进 `financials_seen`（first_seen = 今天、带版本号与按列名的原始行）。从此以后被重述的财报能被发现；
首次留底之前的历史只有最新值，个股证据会如实提示。

**采集看得见**：`/internal/data-status` 加 `capture`：各属性的首次记录日、当前区间数、近 7 天变化数、最近一次被跳过的整批变化；
`financials_seen` 的行数与近 7 天新增。管理页数据卡显示「行业快照自 2026-10-20 起 · 近 7 天变化 12」这类一行，
跳过的整批变化显示成 warn。管理页也显示正在更新的版本（「正在更新（版本 #id，{时间} 开始）」）与上一个版本的状态。

> **实现备注**（S03）：
> - `trade_calendar` 也在表尾加了 `ver`（小表，worker 启动时照常补列），夜间增量写的日历行盖上版本号。
> - 回填没选因子这一步（`--steps` 不含 factors）时提交 `incomplete`（备注「没有重算因子」）而不是 `skipped`：
>   `skipped` 只留给休市，管理页把它显示成「休市」；`incomplete` 同样不会被引用。
> - 不新增交易日的提交不前移截至日：`commitDataVersion` 加可选的 `maxAsOf`（截至日上限，`null` = 不给截至日）。
>   每周抽检传开版本前的 `committedAsOf`（从没提交过时为 `null`）；带 `--codes` 的回填在已有提交时同样传它（首次建库不设上限）。
>   否则一晚写了一半因子后失败，周日的抽检会以 ok 把那天「提交」出去（有测试）。
> - `computeBlocked` 与提示文案放在 `@ivan/db`（`jobs-gate.ts`）：worker 的 runner 用它决定认不认领，server 的 `getRun`
>   用它给排队中的回测 / 复核返回 `computePaused`；回测页、对话里的回测卡与 `get_run` / `get_overview` 的模型输出都说
>   「行情正在更新，回测会在更新完成后开始」。etl 道的结算、简报不受影响。
> - `/internal/data-status` 在维护状态下只返回 `{ markets: [], maintenance, computePaused }`；维护状态下仍可访问的内部接口只有
>   健康检查、数据状态与唤醒，其余一律 503。
> - `attrAsOf` 在首次快照之后、某天不在任何区间里（当时不在名单上）时返回 `null`；首次快照之前只在这只股票的最早一段
>   正好从首次快照日开始时返回首次名单（`preSnapshot: true`），否则也是 `null`。`attr_history` 没有市场列，按代码后缀区分市场。
> - 同一天里值变了又变回原值时，并回前一个区间（删掉当天开的一段、把前一段重新打开），不留两段相同的值。
> - 管理页的「整批变化被跳过」只显示近 7 天内的；`meta` 里一直留着最近一次。

### 4. 市场规则表第 2 版（S04）

`packages/core/src/rules.ts` 改成按日期的表格：`DatedRow<T> = {from, value, cite}`，`effective(date, rows)`；
`rules = 1` 时走原来的代码，逐字节不变（S01 的港股、科创板金标准守着费用与涨跌幅路径）。第 2 版（D62）：

- `priceLimitPct(market, board, isST, date, {rules, listDate, daysSinceList})`：港股 null；北交所 0.30（潜在，北交所未回填）；
  新股不设涨跌幅的窗口：`daysSinceList < N` 返回 null，N = 5 当（科创板且上市日 ≥ 2019-07-22）或（创业板且 ≥ 2020-08-24）
  或（主板且 ≥ 2023-04-10），否则 N = 1（只有上市首日）；科创板 0.2；创业板 2020-08-24 起 0.2，之前 ST 0.05、其余 0.1；
  主板非 ST 0.1，ST 按表：2025-07-07 前 0.05、起 0.10。
- `tradeFees(…, rules)`：A 股过户费 2022-04-29 起 0.001%，之前 0.002%；港股交易费 2023-01-01 起 0.00565%，之前 0.005%；
  港股印花税每边按整港元向上取整。原有的按日期印花税、证监会征费、会财局征费、结算费不变。
- `tickSize(market, price, date)`：A 股 0.01；港股价位表（≤0.25：0.001，≤0.5：0.005，≤10：0.01，≤20：0.02，≤100：0.05，
  ≤200：0.1，≤500：0.2，≤1000：0.5，≤2000：1，≤5000：2，其余 5）。2025 年港交所缩窄价位的调整核实后再加一行。
- `SecurityInfo.listDate`（`securities.list_date`）进入价格面板，引擎按交易日历算 `daysSinceList`。
  上市日进入输入指纹、`resolveExec` 多了 `rules`、`metrics` 两个字段，所以 `HASH_VERSION` 在这里升到 2（R2 一起上线）。
- **表里出自记忆的日期（ST 10%、各板新股窗口、两项费率）上线前要逐条对照交易所 / 港交所公告原文**，
  每行的 `cite` 写公告名；错了只改一行。

> **实现备注**（S04）：
> - 新股窗口的表按板块分（`IPO_NO_LIMIT.star / gem / main`，各自 1990 起 1 天、注册制起 5 天），用 `effective(上市日, 表)` 取 N；
>   新股窗口先于板块判断，所以北交所也是「上市首日不设限、之后 30%」。出自记忆的行在 `cite` 里写了「待核对公告原文」。
> - 引擎里没有前收的那天（上市首日、长期停牌后第一天）仍按原来的写法不设限；上市日早于日历或不知道时按老股算。
> - `tickSize` 先只给出表与函数，S05 的半价差再接进成交。
> - `describeExec` 新口径写成「开盘价成交，不计滑点；规则表第 2 版，指标第 2 版」（S05 再换前半句）。
> - 完整重跑归因比成交假设时，先按 `resolveExec` 补齐再算指纹：S04 之前的运行卡记的是 `{v:1}`，与现在的旧口径同义，不能报「成交假设不同」。

### 5. 指标第 2 版（S04）

`exec.metrics = 2`（D63），第 1 版原样保留给旧运行：

- **从投入第一笔钱算起**：指标计算时在序列前虚拟加一点（决策日，净值 1，基准按决策日收盘归一）。
  总收益 = 期末资产 ÷ 初始资金 − 1，含首日买入费用与首日开盘到收盘的涨跌。只在指标里加，不改存下的序列与跟踪日。
  月度、年度分桶里锚点**只作第一个桶的起点**，不单独成桶（否则起点前一个月和前一年会多出一行 0%，
  拉低月度胜率、多算一年）。
- **交易统计去掉仓位控制的增减**：买入、卖出次数与「交易太少」只数建仓 / 信号买入；新增「完整持仓」：
  从建仓到最后一笔卖出（含中间的减仓、加仓）合成一笔，胜率改为「按完整持仓」，加盈亏比（扣费）、平均盈利、平均亏损。
- **风险指标**（观测少于 30 个时为空）：索提诺、跟踪误差、信息比率、β、α、单日 VaR / ES（95%、99%，历史法，损失记正数）、
  偏度、峰度（非超额）、溃疡指数、最长 / 当前水下天数、月度胜率（跑赢基准的月份占比）、滚动 12 个月超额的最小 / 中位 / 最大 /
  为正比例、逐年一致性（年数、跑赢年数、最差年份）。年化沿用样本估计的每年交易日数。
- **两个公式修正**：样本外起点改用 `addMonths(终点, −N)`（月末自动截断；原来 3 月 31 日减 1 个月会算到 3 月 2 日）；
  「交易成本吃掉超额」的毛超额改为 期末资产 + 费用 −（初始资金 × (1 + 基准收益)）。
- **新检查** `inconsistent_years`（info，只用于回测）：至少 3 年、跑赢年数不到一半而年化超额为正时提示
  「8 年里只有 3 年跑赢基准，超额主要来自少数年份。」
- **界面**：主指标仍是 4 个；「更多指标」ⓘ 加索提诺、信息比率、跟踪误差、β、最长水下天数、单日 VaR(95%)、月度胜率、
  盈亏比、胜率（按完整持仓），并说明口径「从投入第一笔资金算起」或「旧口径：从首日收盘算起」。

> **实现备注**（S04）：
> - `Metrics.roundTrips` 存完整持仓的笔数（不存明细）；`riskMetrics`、`roundTrips`、`oosStart(series, months, version)` 从
>   `@ivan/engine` 导出。界面的「盈亏比」是平均盈利 ÷ 平均亏损的绝对值（`payoff`）；`profitFactor`（盈利合计 ÷ 亏损合计）只进结果与对话。
> - 「观测少于 30 个时为空」只管收益分布类（索提诺、跟踪误差、信息比率、β、α、VaR / ES、偏度、峰度）；溃疡指数、水下天数、
>   月度胜率、滚动 12 个月、逐年一致性是路径与分桶统计，照常给出（滚动 12 个月不足一个窗口时为空）。`riskMetrics` 带一个
>   `minObs` 参数只给单测用。
> - 仓位控制把一只持仓减到 0、之后又建仓时，上一笔完整持仓按它最后一笔卖出结掉；到区间末还拿着的不算。
> - 第 2 版「交易成本吃掉超额」的毛超额先只加回费用，S05 有了滑点成本再一并加回。
> - 「更多指标」里新增的几行只在第 2 版的回测上显示，旧口径只多一行口径说明（旧结果没有这些数，不显示一排「--」）。

### 6. 按流动性成交（S05）

**要解决的**：小市值和港股低价股在回测里「免费成交任意金额」。本轮（D64）：

- **价格面板**加两列（`Float32Array`）：`adv` = `turnover_20d` × 1e8（日均成交额，元），`sigma` =
  `volatility_60d` ÷ 100 ÷ √250（日波动）。只在成交假设需要时加载；加入线程转交清单与输入指纹。约 8 字节 / 股·日。
  **取哪天的值**：第 k 天开盘的成交用 k − 1（决策日）及以前最后一个有效值；面板第 k 格的 `turnover_20d` 含第 k 天自己的成交量，
  开盘时还不知道，用它就是偷看。明日计划的估算用最后一个交易日的值。
- **报价** `packages/engine/src/fill.ts` `quote(ctx, wantValue)`：
  - 参考价 = 当日开盘；半价差 h = `slippageBps` +（`tickSpread` 时）0.5 × 最小价位 ÷ 参考价 × 1e4（bp）；
  - 冲击 I = `impactEta` × σ_d ×√(min(想买金额, 上限) ÷ ADV) × 1e4（σ_d 缺失时用 0.025，并计数）；
  - 买价 = min(涨停价, 参考价 × (1 + (h + I)/1e4))；卖价 = max(跌停价, 参考价 × (1 − (h + I)/1e4))；
  - 买入上限 = `participation` × ADV；ADV 未知的买单拒绝（`no_liquidity`），卖单不设上限（部分成交下一期）。
  - 旧口径（滑点 0、无价位、无冲击、无上限）时不经过 `quote`，直接用开盘价，保证逐字节一致。
- **模拟器**：买单股数 = min(按预算的股数, 上限 ÷ 价格向下取整到交易单位)；被上限截小时空位照样占用（D15），
  记一次 `capacity` 拒单与没买到的金额；取整后为 0 记 `lot_zero` 并顺延名单。原有的涨停、停牌、跌停顺延都记进拒单统计。
  仓位控制的加减也付价差与冲击。成交记录加 `ref`（参考价）、`slip`（价差与冲击金额）、`part`（金额 ÷ ADV）。
- **诊断** `SimResult.diagnostics`：按（买 / 卖, 原因）的拒单次数与金额、**最近** 500 条样例（跟踪要看最近的），**旧口径也算**
  （只是新增字段，金标准不看）；以下只在新口径下有：买入参与率分布（中位 / 90% / 最大）、被截小的买单占比、ADV 未知次数、
  滑点与冲击合计、容量估计 = 资金 × 参与率上限 ÷ 买入参与率的 90 分位。指标加 `slippageCost`，费用拖累拆成费用与滑点两部分；
  第 2 版指标的毛超额加回滑点。
- **检查**：`capacity_limit`（warn：被截小的买单超过 10%；info：容量估计不到当前资金的 5 倍）、
  `illiquid_holdings`（info：买入参与率 90 分位超过 5%），都只用于回测。
- **明日计划的估算**（给 S08 用）：待执行的单补上 `estPrice`、`estShares`、`estWeight`、`refClose`、`curWeight`，
  用同一个 `quote` 在最后收盘价上估算，预算规则与真实买入一致。只是新增字段，不影响旧字段。
- **界面**：回测对话框加可展开的「成交假设」：单边滑点（bp）、加上半个最小价位、计入冲击成本、
  单笔不超过日均成交额（不限 / 5% / 10% / 20%）、恢复默认；回测页新分页「成交与容量」（拒单表、参与率、容量估计、
  滑点与冲击合计）；旧口径的运行显示提示「这次回测用的是旧成交假设（开盘价成交、不计滑点），结果偏乐观」。
- **口径不同不直接比**：对照视图多一行「成交假设」与「指标口径」，两者不同时顶部一个 warn Callout
  「这几次回测的成交假设或指标口径不同，数字不能直接比」；对话 `compare_runs` 的模型摘要带每次的成交假设、指标版本与
  `comparable`，提示词加「口径不同的回测先说明口径，不直接比数字」。对话 `run_backtest` 可带 `exec`，`query_run` 加 `what: "execution"`。
- 冲击系数 0.5 是文献默认值，没有在 A 股 / 港股上校准，ⓘ 里写明，可以改。

> **实现备注**（S05）：
> - `describeExec` 的分隔用「，」不用「·」（设计系统：一行最多一个「·」），例如「开盘价成交，单边滑点 5bp + 半个最小价位，冲击成本（平方根，系数 0.5），
>   单笔不超过日均成交额 10%；规则表第 2 版，指标第 2 版」；旧办法成交写「开盘价成交，不计滑点」，等于 `LEGACY_EXEC` 时再加「（旧口径）」。
>   `isLegacyFill(exec)`（滑点 0、无价位、无冲击、无上限）在 `@ivan/core`，引擎、服务端、web 共用。
> - 「被截小」按上限实际压低了股数算（不是「上限 < 预算」）；截到 0 手记 `capacity`（不算 `lot_zero`），退一手退到 0 记 `cash`；
>   都不占空位。`cappedBuyShare` 的分母是过了报价、按预算算了股数的买单。旧口径的拒单也记金额与样例（只是新增字段，从不改变决定）。
> - 按流动性成交时持仓的 `entryPrice` 是含价差的成交价（止盈止损按它算）；`costDrag` = `feeDrag` + `slipDrag`，
>   回测页「更多指标」分两行显示。第 2 版指标的 `cost_drag` 检查把滑点也算进「交易成本」。
> - 仓位控制的增减用 `QuoteCtx.uncapped`：付价差与冲击，但不设上限、不因日均成交额未知拒绝。
> - `RejectReason`、`SimDiagnostics`、`RejectSample` 的类型放在 `@ivan/core`（web 要用），`fill.ts` 转出。
>   应用库加 `runs.diagnostics` 与 `run_trades.ref / slip / part`（迁移 0002）。
> - `compareRuns` 返回 `{ runs, comparable }`（每次带 `execText`、`rulesVersion`、`metricsVersion`；指标口径取结果里实际的版本）。
> - 容量的 info 变体标题写「资金容量有限」，warn 仍是「容量受限」。`TextLink` 加了 `onClick` 变体给「恢复默认」。
> - 明日计划的估算只在引擎结果里；跟踪的 `tracking_orders` 还没存这些字段（S08 的计划快照接）。

### 7. 可信度（S06）

**方法**（D65）：日收益（策略, 基准）成对做平稳块自助法（Politis–Romano，平均块长 L：周度调仓 5、月度 21、季度 63，
信号模式取持有天数中位数，夹在 5–63），B = 1000 次，最多用最近 4000 个交易日；
**种子 = `sha256Canonical({inputHash, v: VALIDATION_VERSION})` 的前 8 位**（来自这次回测实际读到的输入，不来自每晚都变的数据版本号：
输入没变，第二天重跑也是同一个种子、同样的区间）；`VALIDATION_VERSION = 1`。
不用 Vibe-Trading 的逐笔打乱 p 值（打乱不改变平均盈亏，测不出有没有优势）。

- 纯函数放 `packages/engine/src/stats/`：`prng`（mulberry32）、`normal`（Φ 与 Φ⁻¹）、`moments`（S04 已建）、
  `bootstrap`（区间）、`fan`（未来一年净值扇形）、`psr`。
- **输出**：年化收益、年化超额、夏普、信息比率、最大回撤各自的 95% 区间；跑赢基准的把握（主动收益的 PSR，
  T < 30 时为空）；超额为正的重抽样占比；实际最大回撤在重抽样里的分位；扇形 = 1000 条一年路径在 60 个时点的
  5 / 25 / 50 / 75 / 95 分位（按绝对净值）、一年内最大回撤分布、亏损概率。约 400 万次随机数、0.5 MB，在线程里 50–150 毫秒。
- **只对第 2 版口径的新回测做**（旧运行重跑要和当初逐字节一致）。线程消息改为 `{id, input, tasks, seed}`，
  返回 `{result, validation}`；`runs.validation`（摘要）与 `runs.validation_z`（扇形数组，压缩）两列。`validation` 进 `coreHash`。
- **检查**（只用于回测，进 `reportHash`）：`low_confidence`（warn）：年化超额为正但区间下沿 ≤ 0，「年化超额 +4.2%，但按历史重抽样的
  95% 区间是 −1.8% ~ +9.9%，不能排除是运气。」；`optimistic_drawdown`（info）：实际回撤比 75% 以上的重抽样路径都轻。
- **跟踪**：结算时读基准回测的扇形，算跟踪净值在第 k 天落在扇形的哪一档，存 `summary.navFanPercentile`。
  它按**绝对净值**算（市场整体涨跌会影响它），和按超额算的「跑赢回测同期」不是一回事，所以不并排放：
  放进「跑赢回测同期」的 ⓘ 里，写成「按绝对净值：处于回测重抽样区间第 38 百分位（不扣基准）」；对话里字段名也分开。
- **界面**：回测页新分页「可信度」：各项区间、跑赢基准的把握、扇形图（新组件 `fan-chart.tsx`，按需加载，
  标题「未来一年的净值区间（按历史重抽样）」，一年内最大回撤的中位数与 95 分位用文字写在图下）。区间带按设计系统 §11
  新增的例外画：两条分位线之间低透明度填充、不从 0 起，只用于重抽样区间。ⓘ「按历史日收益成段重抽样 1000 次
  （平均段长 21 天，种子 …）。这是区间，不是预测。」文案不说「盈利概率」。对话 `get_run` 加年化超额区间与跑赢基准的把握；
  提示词加「可信度区间和『跑赢基准的把握』只能说成按历史重抽样的结果，不说概率、不说预测」。
- **试错计数修正**（D66，完整的 DSR / PBO 二期做）：`priorVersionsOnPeriod` 改为 `countTrials`：同一策略、
  `kind` 为回测或扫描子回测、状态完成、区间与本次重叠 ≥ 50% 的运行，按「实际用的策略内容」去重
  （版本用 `spec_hash`，扫描子回测用 `specHashOf(specOverride)`，两边同一个 16 位函数）；重跑不算。挪一天起点不再清零，扫描计入。
  检查文案改为「这个策略在重叠的区间里试过 23 种不同设置（含参数扫描）……」。

> **实现备注**（S06）：
> - 纯函数在 `packages/engine/src/stats/`（`prng`、`normal`、`psr`、`bootstrap`、`fan`、`validation`），类型
>   `Interval`、`Confidence`、`Fan`、`ValidationResult` 放在 `@ivan/core`（web 要用）。`Confidence` 比原设计多一个
>   `mddMedian`（重抽样最大回撤的中位数），「回撤偏乐观」的文案要用它。`coreHash` 里的 `validation` 是 `{confidence, fan}` 整体。
> - 线程消息 `{id, input, tasks?, seed?}` → `{id, result, validation?}`；线程、主线程退路、CLI 共用 worker 的
>   `runSimTasks`（模拟 + 指标第 2 版时算可信度并追加检查），种子函数 `validationSeed(inputHash)` 也在那里。
>   跟踪结算不请求可信度。扇形与区间用同一个「最近 4000 个交易日」窗口；回测不到一年时扇形只到历史长度（标题不变，图下注明）。
> - 跟踪的扇形分位按天数 `series.length` 取（扇形第 d 天 = 从净值 1 起的第 d 个日收益；跟踪净值 = 资产 ÷ 资金，
>   到最后一天正好 `series.length` 个日收益），不是 `series.length − 1`；超过扇形的一年后为 null；分位保留一位小数，
>   `summary.navFanBand` 取「<5 / 5-25 / 25-50 / 50-75 / 75-95 / >95」。
> - 主动收益波动为 0（如全程空仓）时 `psrActive` 为 null；信号模式没有完整持仓时平均段长按 21 天。
> - `countTrials(strategyId, params, exceptSpecHash)` 的第三个参数是本次的策略内容指纹；扫描在排队时按每个取值各算一次
>   （写进任务的 `variants[].priorVersions`，子回测存进自己的 `params.priorVersions`），同一次扫描里的兄弟取值还没跑完，不算。
>   「新建策略从零算」写在回测页诚实检查的 ⓘ 里。

### 8. 选股解释与个股证据（S07）

**选股解释与回测同一条 SQL**（D67）：`compileSelection` 重构成共用的构造器，`trace` 模式在同一组 CTE 里多输出
每个排序项的 `percent_rank`（t0…tn）。另加：

- `runSelectionScored` 返回带得分的名单（回测仍只取代码）。今日选股（`screenOn`）也改成取它的候选名单，只剩一条路径。
- `explainSelection(wh, spec, date, {limit, codes})`：当天大盘状态（D53）、候选名单（名次、得分、各项分位、用到的因子值），
  以及指定代码的逐条判定：`whereSql` 拆成带中文标签的条件（板块、ST、次新、亏损、市值、行业、每条筛选
  `describeCondition`），用一次查询把每条条件算成布尔列，列出没满足的；排序因子缺值、行业上限截掉、当天没数据
  都给出原因；通过筛选的给出全体合格股里的名次。
- 一致性测试：同一天候选的顺序与得分和 `runSelectionScored` 完全一致（含大盘切换日、行业上限、按代码打破平局），
  得分 = Σ 权重 × 分位 ÷ Σ 权重。

**个股证据**（`packages/data/src/query/evidence.ts`）`securityDossier(wh, code, asOf, {factorKeys})`：
唯一的点时读取器，今天与历史同一套，所有读取都限定「当时可得」：

- 不晚于 asOf 的最后一个交易日的因子（默认一组常用估值、质量、成长、技术、标记；带策略时用策略的筛选与排序因子；
  因子项按 `FactorDef.markets` 过滤，外加 `group === 'flag'` 且为真的因子，不按键名前缀，D97），引用这天日线的 `src`、`ver`；
- `eff_date ≤ asOf` 的最新一期财报（报告期、公告日、生效日；港股注明生效日是推算的）。数值优先用 `financials_seen` 里
  `first_seen ≤ asOf` 的那一版（当时首次见到的值）；留底开始之前的，加提示「财报数值为最新版本，可能含事后更正」；
- 近 365 天的分红送转；ST 判定的精确度档位（深市官方 / 沪市 2018 起每日简称 / 近似）；
- 近 20 个交易日的停牌 / 无成交 / 缺数据天数（S13 起有数据）与未解决的数据问题；
- 行业属性快照（从哪天起记录；早于首次快照时注明「用的是 X 日的分类」）。

每项是 `EvidenceItem {group, key, label, value, unit, asOf, availDate, ref: {table, key, src, ver}}`；
整份的 `hash = sha256Canonical(items)`，可以用 `POST /internal/dossier/verify` 复核。

**决策日，不是成交日**：成交记录上的日期是次日开盘的成交日。「为什么 3 月 5 日买了 X」要看的是 3 月 4 日收盘后的数据，
用 3 月 5 日的收盘价就是偷看一天。所以工具与接口都区分 `decisionDate` 与 `tradeDate`：给了成交日就取交易日历上它的前一个交易日
作为决策日，卡片抬头写「决策日 3 月 4 日（次日 3 月 5 日开盘成交）」。

**接口与对话**：worker `GET /internal/securities/:code/dossier?asOf&factors`（asOf 默认并截到 `committedAsOf`；早于第一根 K 线返回
「这只股票那天还没有数据」）、`POST /internal/explain`、`POST /internal/dossier/verify`、`GET /internal/calendar/prev?market&date`；
server `GET /api/securities/:code/evidence?decisionDate&tradeDate&runId&versionId&trackingId`（计入 `analyses`）。
新工具 `get_security_evidence {query, decisionDate?, tradeDate?, runId?, versionId?, trackingId?}` 合并原提案的 `explain_pick`：
- 带 `runId`：策略内容 = 这次运行的 `specOverride`（扫描子回测）或版本的策略；这次回测记的数据版本和现在不同时加提示
  「这次回测之后数据修订过，名次可能和当时不同」；
- 带 `trackingId`：用跟踪的策略版本（S08 起，那天有计划快照时先给第 1 版计划里的记录，个股证据只作补充）；
- 一张「个股证据」卡，分组显示估值与价格 / 财报 / 数据状态，每行有来源 Tag（东方财富、腾讯、中证、来源未记录）与「数据日」，
  带策略时多一块「在『价值组合』里排第 12（得分 0.83）」或「没进股票池：没满足 ROE(TTM) ≥ 12%」与各项分位；
  卡片底部「数据版本 #812 · 校验 3f9a1c2e」和「仅供研究，不构成投资建议」。模型只拿到 ≤ 16 项四舍五入后的摘要（按组留位置：因子最多 7 项，收盘价、财报、数据状态、两融与筹码各留几项；实现备注）。
- 提示词路由：回测里的交易或任意一天的个股 → 它（带 runId 与成交日）；跟踪过去某晚为什么买卖 → `get_plan`（S08）。

**页面入口**：回测页成交表每行、持仓表每行（用持仓快照的日期作成交日）、跟踪页持仓每行各一个 IconButton「证据」，
打开 Modal 渲染同一张卡（新组件 `evidence-modal.tsx`）。图标是新概念「证据」（Phosphor `FileMagnifyingGlass`），
加进 `icons.tsx` 与设计系统 §7 的表（「选股」的 `ListMagnifyingGlass` 不复用）。

**今日选股可追溯**：`/internal/screen` 返回 `dataVersion {id, asOf}` 与 `listHash`（名单的 `sha256Canonical`），
选股卡底部「数据版本 #812 · 校验 3f9a1c2e · 仅供研究，不构成投资建议」。

> **实现备注**（S07）：
> - `selectionSql(spec, dates, limit, {trace, noLimit})` 是唯一的构造器，每个排序项的分位表达式只生成一次，得分求和与 t 列共用；
>   `compileSelection` 的文本逐字不变（快照测试）。`screenOn` 移到 `query/explain.ts`（取 `explainSelection` 的候选名单），
>   候选多带一个 `close`（今日选股表要用）。`whereParts` 里市场那条的标签仍为 null，解释时它没满足就写「不在策略的市场里」。
> - 被同行业上限截掉的代码 `passed = false`、`cappedOut = true`、原因「同行业已满 N 只」，得分与分位取同一个构造器去掉上限后的结果。
>   `/internal/explain` 的日期同样截到已提交的截至日。证据的 asOf 与解释的日期截完后再落到交易日（`lastTradingDay`：
>   日历上不晚于它的最后一个交易日），问周末、节假日时按前一个交易日回答，抬头的决策日也是那个交易日。
> - 证据条目的键整份唯一：财报项带 `fin_` 前缀（`fin_np`、`fin_np_yoy`…），否则和同名因子 `np_yoy`、`debt_ratio` 撞键。
>   港股的「生效日按法定期限推算」写在报告期那一项的标签上。`financials_seen` 只由东财财报写入，引用的来源记 `em`。
>   金额按亿显示，币种不是本币时注明。证据里先带上 `evidenceVersion: 1`（D97），第 1 版的校验值仍是 `sha256Canonical(items)`。
> - 近 20 个交易日的逐日状态：这个市场在 asOf 之前一条 `bar_status` 都没有（S13 之前）时值为空、注明「那时还没有逐日记录」，不写 0。
>   行业另有两条提示：`industry_pre_snapshot`（用的是首次记录时的分类）、`industry_current`（没有快照，用当前分类）。
> - 只给校验值没法说出「哪一项变了」：`verifyDossier` / `POST /internal/dossier/verify` 另收可选的 `factorKeys`（带策略的证据按策略因子生成，
>   复核要用同一组）与 `items`（原来的条目，用来逐项比），返回 `{same, hash, changed}`；只给校验值时 `changed` 为空。
> - 证据接口的 `strategy` 多带 `top`、`hold`（top × buffer），`band` = `top`（会买入）/ `buffer`（已持有就继续拿）/ `out`；
>   信号模式的策略没有名次，加提示 `signals_mode`。卡片在三组之外多一组「质量与成长」（`quality` 组的因子）。
> - `run_data_revised` 按设计比运行卡的数据版本号与当前已提交版本号；版本号每晚都涨，所以隔夜以后的回测都会带这条提示
>   （措辞是「可能不同」）。S08 / S11 有了解释指纹后可以收窄成「名次真的变了才提示」。

### 9. 决策账本与计划快照（S08）

**账本**（D68）应用库新表 `ledger_entries(id, user_id, seq, kind, subject_type, subject_id, as_of, payload_table, payload_id,
payload_z, payload_hash, prev_hash, hash, created_at)`，`UNIQUE(user_id, seq)`。每个用户一条链：
`hash = sha256Canonical({seq, prevHash, kind, subjectType, subjectId, asOf, payloadHash, createdAt})`，
第一条的 `prevHash` 是 64 个 0。追加在 `BEGIN IMMEDIATE` 事务里读链尾、算哈希、插入，server 与 worker 两个进程不会分叉；
结算的整段写入也用 `IMMEDIATE` 事务（先拿写锁再读链尾），账本追加在里面是保存点。
本轮的条目类型：`plan`、`replay_drift`、`tracking_start`、`tracking_stop`、`health_transition`（S10）、`brief`（S10）。

**计划快照**：`plan_snapshots`（跟踪、决策日、计划日与计划日依据、版次、原因、策略版本与指纹、数据版本与截至日、引擎版本、
成交假设指纹、输入指纹、指纹口径版本、**解释指纹**、解释版本、注册表版本、大盘状态、仓位系数、资产与现金、**基准代码与决策日基准收盘**、
压缩的持仓与候选名单、内容指纹）与 `plan_items`（方向、原因、细分原因、名次、得分、估算价格 / 股数 / 仓位、参考收盘、当前仓位、
没满足的条件、因子值、各项分位）。三张表都有 `BEFORE UPDATE / DELETE` 触发器直接报错「append-only」；
以后真要改只能显式删触发器、改完再建（写进迁移说明）。`tracking_orders` 保留并加 `snapshot_id`，现有界面不受影响。

**每晚怎么写**：结算重放后，用 S07 的 `explainSelection`（明天是调仓日时带候选名单）与 S05 的估算组装快照，算内容指纹
与解释指纹（候选名单与各代码的因子值、分位、没满足的条件、大盘状态的 `sha256Canonical`）：
同一（跟踪, 决策日）没有快照 → 第 1 版、原因 initial；内容指纹相同 → 不写；不同 → 加一版，原因按顺序判断：
引擎变了 = 引擎变更；指纹口径版本变了 = 程序升级；成交假设变了 = 成交假设变更；
输入指纹、解释指纹、数据版本任一变了 = 数据修订（包括没改名次的因子修订）；都没变 = 原因不明（记日志）。
第 1 版就是用户当晚看到的，永不改写。卖出的细分原因：止盈、止损、到期、退市、仓位控制，或「掉出前 N 名（排第 31）」/
「不再满足：ROE(TTM) ≥ 12%」。有重放漂移时另记一条 `replay_drift`。

**上线前的首日计划**：还没到上线日时结算不跑模拟，快照是精简版：明日买入 = 选股解释的前 N 名（原因 entry，带名次、得分、分位、
因子值），估算仓位 = min(1 / N, 单只上限)，其余估算为空，输入指纹为空（只有解释指纹与数据版本参与版次判断）。

**重放成交留底**：结算把重放里的成交与拒单（S05 的最近样例）整体重写进 `tracking_trades`（和 `tracking_days` 一样每晚重写，
不是只追加），回溯页用它回答「这条计划按现在的数据重放执行得怎样」。

**计划日**：新增 `packages/core/src/holidays.ts`，A 股与港股当年和下一年的休市日静态表（每行写「交易所休市安排」公告名），
`nextTradingDay(market, date)` 先查表，没有这一年就退回下一个工作日；跟踪补的「下一个交易日」与快照的 `plan_date` 都用它，
快照记 `plan_date_basis = holiday_table | weekday`。这也修掉一个现有问题：周度策略在长假前最后一个交易日该不该调仓，
原来按名义的下一个工作日判断会判错，第二晚又被重放改写。每年 12 月补下一年的表（人工清单）。

**后来怎么样**（DEC-3 的最小版，D79）：纯函数 `evaluatePlanItem(item, snapshot, bars, benchBars)`：买入给出实际次日开盘价与估算价之差、
之后 5 / 20 个交易日的收益与超额（基准从决策日收盘起算）；卖出给出卖出后 5 / 20 天这只股票的涨跌。worker `POST /internal/plan-outcomes`
用提交过的数据计算；S11 的回溯页显示。汇总统计（命中率、实盘 IC）仍在二期。

**停止与上线留痕**：`propose_stop_tracking` 改为写一条 `tracking_stop` 草稿（可带原因），卡片上确认才停；
页面上的停止弹窗加选填的「停止原因」；两条路都记账本。确认上线时记 `tracking_start`（版本、指纹、资金、起始日、
基准回测、成交假设）。

**接口、对话、界面**：`GET /api/trackings/:id/plans?from&to`、`GET /api/plans/:id`；对话工具 `get_plan`
（只读，计划卡：方向、名称、原因文字、名次、得分、估算仓位、关键因子、没满足的条件，元信息「数据截至 X · 第 n 版」）；
`get_security_evidence` 带 `trackingId` 与日期且那天有快照时，先给第 1 版计划里这只股票的记录。
提示词路由：「明天买卖什么、为什么」与「跟踪过去某晚为什么买卖 X」→ `get_plan`。
原因文字表从 `run.tsx` 挪到 `lib/format.ts`，格式化都是纯函数并有单测。跟踪页与看板的明日计划显示原因，每项一个 ⓘ
（排名、得分、因子分位、没满足的条件、估算仓位、参考价）和「证据」按钮；第 2 版起显示 Badge「已修订」；
计划日旁注依据（按交易所休市安排 / 按工作日推算，遇节假日顺延）。

**诚实说明**：单机自部署时，管理员能改数据库文件，哈希链证明的是「内部一致、改动能被发现」，不是第三方不可抵赖；
导出时把链头哈希带出去才能对外证明（S11）。

> **实现备注**（S08）：
> - 快照的决策日用结算的「最后结算日」（日历上最后一个 ≤ 已提交截至日的交易日，与 S02 的 `summary.lastDate`、前缀 cut 同一个字符串），
>   不是原始的截至日；两者通常相同。
> - `plan_snapshots` 多一列 `band`（持有名次线 = ⌈top × buffer⌉），「掉出前 N 名（排第 31）」要用；它由策略内容决定，不进内容指纹。
>   内容指纹里仓位系数写成 `exposure: {current, next}`（两者都空时为 `null`）。
> - 原因文字表（`REASON_TEXT`、`REASON_DETAIL_TEXT`、`formatPlanReason`、版次原因 `PLAN_CAUSE_TEXT`）放在 `@ivan/core` 的 `plan.ts`，
>   `lib/format.ts` 再导出：给模型看的 `planForModel`（`@ivan/ai`）与网页用同一张表。条件文字里选股解释自带的「没满足：」前缀在拼「不再满足：…」时去掉。
> - `runForModel` 挪到 `@ivan/ai` 后不能依赖 `@ivan/db`，所以 `COMPUTE_PAUSED_TEXT` 改定义在 `@ivan/core`，`@ivan/db` 原样再导出。
> - 信号模式没有选股解释：解释指纹为空，细分原因按成交原因（卖出的调出 / 不再满足分别记 ranked_out / failed_filter，不带名次与条件）。
> - 上线前的精简快照：决策日按交易日历落到交易日；计划日 = 下一个交易日与上线日中较晚的那个（数据还没更新到上线日前一天时就是上线日）。
> - `tracking_trades` 的拒单行 `amount` 是没成交的金额（想成交 − 已成交），价格、股数、费用为空。
> - 带跟踪与日期的个股证据有那晚的快照时，返回 `planRecord`（第 1 版计划项；不在计划里但在候选名单里时给候选名次）并跳过按现在数据的名次解释
>   （`strategy` 为空），免得同一张卡里出现两个名次。
> - 已停止的跟踪再停（页面或确认卡）返回 409，不重复记账。上线提案的上线日也改用 `nextTradingDay`。
> - `POST /internal/plan-outcomes` 先由 server 的 `GET /api/plans/:id/outcomes` 接出来（只读、不计额度），回溯页（S11）再显示。
>   不计额度的读接口都带缓存，反复刷新不压到 worker 与请求线程：计划结果按（快照、市场当前提交的数据版本）缓存，结果接口与回溯页共用一份；
>   链校验（`POST /api/ledger/verify`）按（链头序号、条数）缓存 1 分钟。
> - 休市日表只录了 2026 年（A 股、港股，待核对公告原文）：2027 年的国务院节假日安排与港交所交易日历还没发布，表里没有时按工作日推算并在界面注明。

### 10. 数字核对（S09）

`packages/ai/src/grounding.ts`（纯函数，`GROUNDING_VERSION = 1`，D69）：

- **抽数**：先规范化（全角数字与符号、U+2212、零宽字符、数字中间的千分位逗号）；日期、证券代码、版本号（v3）、行首序号、
  反引号里的内容豁免；带 % / 个百分点 / 小数点 / 货币或单位（元、港元、万、亿、倍、bp）的是「量」，要核对；
  跟着 天 / 只 / 笔 / 次 / 名 的整数是「计数」，要和某个计数完全相等；其余裸整数（200 日均线、前 15 名）不核对。
- **证据**：遍历工具给模型看的 JSON，每个有限数字按键名归类。**因子先按因子表的单位**：键是因子名，或在 `{factor, value}` 条件里，
  就按 `FACTOR_MAP` 的单位归类（`%` → 百分点，因为 Ivan 存的是 4.25 这样的百分数；`亿` → 金额 × 1e8；`x` → 普通数；
  `名`、`天`、`年` → 计数）；其余再按键名归为比例、百分点（`*Pct`、percentile、beatBacktest）或金额
  （equity、capital、amount、value、cash、pnl、fees）；数组长度算计数。
- **匹配**：写成 d 位小数的百分数 p 与比例 r 匹配当 ||p|/100 − |r|| ≤ max(0.5×10⁻ᵈ/100, 0.005×|r|)；百分点、金额同理
  （万、亿先换算）；证据为负而文字既无负号也无「跌、回撤、亏、跑输、落后、下滑」时记符号不符。不允许推算数字。
- **简报是闸门**：`writeBrief` 生成后核对 `factsForModel(facts)`，有对不上的数字就把清单加进提示词重写一次，
  还不行就用模板（`fallbackReason`「数字核对没通过：…」），核对结果存进简报（`briefs.grounding` 列）。
- **对话是标注**：流式输出撤不回来，所以只标注。`routes/chat.ts` 改用 `createUIMessageStream`：合并模型流、
  等所有步骤结束后用每个工具的 `toModelOutput` 重建「模型实际看到的」证据（只取本轮与本会话最近 6 次工具结果，
  加上页面上下文摘要里的数），核对后写一个 `data-grounding` 片段再结束；保留 `x-thread-id` 与原有落库。
  每条助手消息的 `messages.usage` 记 `{inputTokens, outputTokens, model, grounding: {checked, unverified, version}}`
  （原来这一列从没写过）。
- **界面**：助手气泡下的 `GroundingNote`（有对不上的才显示）：「有 1 个数字没在工具结果里找到：+12.4%，请以卡片为准」，
  ⓘ 列出最接近的工具数。管理页用量表加一列「数字核对未通过」。提示词规则 1 加一句「百分比照抄工具结果（保留 1 位小数），
  不要自己换算、相减或改写舍入」。`GroundingNote` 写进设计系统 §8。

> **实现备注（S09）**
> - 证据归类多了两条：带 `unit` 的 `{ value, unit }`（`evidenceForModel` 的证据项、计划的关键因子不带因子键，只带单位）按单位归类；
>   个股卡与证据里的财报字段（`roe`、`revenue_yoy` 是百分数，`revenue`、`np`、`deducted_np`、`ocf` 是元）按 FIN_FIELDS 的单位归类；
>   容器键是 `*Pct`（如 `termPct: { pe_ttm: 85 }`）时里面的数一律是百分点。单独的键 `value` 不按金额归类（条件、证据项里的 value 先按因子或单位）。
> - 工具结果里**字符串**写出的数（检查项说明、原因文字、策略描述）也算证据，与页面上下文摘要同一套抽法；对话还把**用户这条消息**里写的数算作证据
>   （「ROE 大于 15%」复述出来不是编造）。
> - 「前 N 名 / 只」是规则参数，与「200 日均线」一样不核对；`1.2.0` 这类点分版本号、字母数字混写的标识（MA20、H00905）豁免，但后面紧跟计量单位的不算标识：「ROE15%」「PE12.5倍」照样核对。
> - 回看窗口的天数不核对（D69）：「近 / 过去 / 最近 / 每 N 天（个交易日）」，以及紧跟指标名的「60 天波动率」「20 个交易日均成交额」；「平均持有 23 天」这类计数照样核对。
> - 符号：证据为负而文字写了「+」时，前面有「跌、回撤」也算符号不符；提示词词表多了「下降、负」。
> - 对话流：`execute` 里先逐块转发 `toUIMessageStream({ sendFinish: false })`（不用 `writer.merge`，保证 `data-grounding` 一定在正文之后），
>   核对后写 `data-grounding` 与 `finish`；每条助手回复都带核对片段（全对上时界面不显示）。简报存的 `grounding` 是最后一次 LLM 正文的核对加 `attempts`；
>   没调 LLM 的模板简报为空。管理页「数字核对未通过」按 `messages.usage.grounding.unverified > 0` 按北京时间分天计数。

### 11. 跟踪健康度、判词与简报第 2 版（S10）

**健康状态机**（`packages/engine/src/health.ts`，`HEALTH_VERSION = 1`，D70）：

- 每晚一个读数，指标取最差的那个：跑赢回测同期（越高越好，正常 ≥ 5、注意 ≥ 1、衰减 ≥ 0.5，再低为严重）；
  回撤比 = 跟踪最大回撤 ÷ 基准回测最大回撤（越低越好，≤ 1.2、≤ 1.5、≤ 2.0，再高为严重）。跟踪不足 20 天或没有可用指标
  = 样本不足，从不算正常。
- 状态带滞回：观察期 → 正常（第一个够样本的读数是正常）；观察期 → 偏离（第一个够样本的读数不正常；最近 5 个都是衰减或严重则
  直接可能失效）；正常 → 偏离（连续 5 个读数不正常）；偏离 → 正常（最新读数正常）；偏离 → 可能失效（连续 5 个衰减或严重）；
  可能失效 → 偏离（连续 3 个正常或注意）。永不自动停止。
- **阈值以校准测试为准**：20 条合成基准回测（2000 天）× 每条 10 个同分布的跟踪 × 250 天，偏离或可能失效的天数占比 < 10%、
  可能失效 < 5%；把超额去掉的跟踪，被标出的天数占比至少是前者的 2 倍。修订时的预演：同分布 7–8%（可能失效 3–5%）；
  超额完全消失时 18% 的天数被标出，一年内约一半的跟踪至少被标出一次。原稿的 25 / 10 / 3、连续 3 次在预演里误报 24–39%。
  所以 ⓘ 写明：健康度是提醒，不是检验；超额消失后一年内大约只有一半能被它发现。
- 新表 `tracking_health(tracking_id, date, signal, state, per_metric, inputs, version)`，只追加；同一天重跑时**沿用已有的那一行与它之前的状态**，
  不重复计入历史、不再判状态变化、不记账本（管理员重跑与 S13 的自动重跑都会同晚重算）。状态变化记账本 `health_transition`。
  阈值集中定义、带版本，改阈值不改写历史读数。
- **上线第一晚补算**：一个跟踪还没有任何健康读数时，先按已存的 `tracking_days` 逐日补算（每天的偏离百分位对基准回测、到那天为止的
  最大回撤），写进 `tracking_health`（`inputs.backfilled = true`），再判今晚；补算后的状态不是观察期时记一条
  `health_transition`，原因「按历史补算」。已经落后很久的跟踪第一晚就显示偏离或可能失效，不会先显示几天「正常」。

**判词**：`verdictOf` 按顺序：结算失败（`summary.lastError` 是这次的）→ 数据未更新（跟踪最后结算日早于 `committedAsOf`、
市场当日状态是 `stale`、或持仓股在今晚的缺失名单里）→ 观察期 → 可能失效 → 偏离 → 正常。`settleMarket` 把每个跟踪的
失败写进 `summary.lastError`（成功时清掉），不再只进日志。

**简报第 2 版**：`factsVersion: 2`、各市场的当日状态（D78）、每个跟踪的最后结算日、判词与上一期判词（只存一层；没有上一期判词按「没变」处理，
所以上线第一晚不会每个跟踪都算「状态变化」）、计划快照 id、健康状态与各指标。开头先说判词变化（「『价值组合』状态：偏离（上次：正常）」）；
没有市场开市、判词没变、也没有新提示时不调 LLM，直接用模板。提示词：「判词已经算好，原样说出状态和变化，不要自己评价好坏」；
「可能失效」一律写成「建议复核规则是否仍然有效」，不说停止、不说卖出；对话提示词加同样的规则。
**简报按版次只追加**：新表 `brief_editions(id, user_id, date, edition, facts, content, model, grounding, created_at)`，触发器同 S08；
`briefs` 仍是看板读的「当前版」。每次生成都加一版并记一条账本 `brief`（指向这一版），「当时告诉了我什么」能原样拿出来。

**界面与对话**：看板跟踪列表加判词 Badge（文字 + 颜色按设计系统：正常 down、偏离 warn、可能失效 warn（实心图标）、观察期 neutral、
数据未更新 warn、结算失败 warn），ⓘ 列各指标与阈值（「跑赢回测同期 3（正常 ≥ 5，注意 ≥ 1）」）；跟踪页抬头同一个 Badge；
简报卡加 ⓘ「依据」把事实逐条列出；数据横幅加结算失败。`get_tracking` 的模型摘要加健康状态与判词，字段改名 `beatBacktestPct`
（与简报一致），并有了自己的卡片（跟踪卡）。判词 Badge 与跟踪卡写进设计系统 §8。

> **实现备注**（S10）：
> - 阈值、取值与文字（`HEALTH_THRESHOLDS`、`HEALTH_VERSION`、`VERDICT_TEXT`、状态 / 读数文字、`TrackingHealth`）放在 `@ivan/core` 的 `health.ts`，
>   引擎的 `health.ts` 再导出并负责计算：网页的 ⓘ 要列阈值，而网页不依赖引擎。读数分级的类型叫 `HealthSignal`（`@ivan/core` 已有信号集的 `Signal`）。
> - 跟踪最大回撤用 `maxDrawdownOf`（峰值从净值 1 起算），补算与每晚同一个函数，不读 `result.metrics.maxDrawdown`：旧口径指标的峰值从第一天收盘起算，
>   补算的最后一行与之后每晚的读数会差一点。健康读数的日期是重放序列的最后一天（与 `summary.lastDate` 相同）。
> - 补算用今晚重放出的逐日序列（就是今晚整体写回 `tracking_days` 的那一份），数据修订后也和存下的一致。
> - 判词的「结算失败」：结算成功会整份重写 `summary`，所以 `summary.lastError` 存在就是最近这一次；`verdictOf` 不再比日期。
> - 简报「不调 LLM」的条件按字面：用户涉及的市场全部休市、判词没变、没有新提示、没有计划买卖（长假前留下的下一交易日计划仍会调一次 LLM）。
> - 看板、跟踪页、对话共用引擎的 `trackingVerdict(summary, lastDate, {marketDay, committedAsOf})`；server 从 `/internal/data-status` 取当日状态与数据日，
>   worker 简报用 `marketDayStatus` 与 `committedAsOf`。结算的健康度测试在 `apps/worker/src/jobs/settle-health.test.ts`。
> - 测试注入：`WorkerEnv.briefModel`（简报用的模型），用来断言休市日不调 LLM。

### 12. 决策回溯页（S11）

跟踪页新分页「回溯」（D71）：

- **时间线**：计划（第几版、原因）、重放差异、状态变化、简报、上线、停止，按日期倒序；每条带哈希前 8 位。
- **那天看到的计划**：选一个决策日，左边第 1 版（当晚看到的）、右边最新版，下面列差异（新增、移除、方向 / 名次 / 估算仓位 /
  细分原因的变化）与版次原因。差异是纯函数 `diffPlans`。之后的数据修订大多不会加新版次（它们改写的是重放，不是那晚的计划），
  所以每条计划还对照**按现在的数据重放的执行结果**（`tracking_trades` 在计划日的成交或拒单）：「计划买 X → 按现在的数据重放：
  没买到（涨停开盘）」或「成交 12.31」；有 `replay_drift` 的首个漂移日 ≤ 计划日时显示 Badge「这晚之后数据修订过」。
- **后来怎么样**：超过 5 个交易日的计划项多一列（`evaluatePlanItem`）：「+3.1%，跑赢基准 +1.2%」；没到时间显示「--」；
  底部「仅供研究，不构成投资建议」。
- **校验**：`POST /api/ledger/verify` 重算当前用户整条链，Badge「已校验 · 共 n 条」或指出第一处断点与原因
  （序号断开、前一哈希不符、记录哈希不符、内容哈希不符、内容缺失）。
- **导出**：`GET /api/trackings/:id/export` 下载 `ivan-trace-<id>-<date>.json`：跟踪、策略版本与指纹、基准回测参数与运行卡、
  本跟踪的账本条目与内容、链头哈希、各算法版本清单与清单指纹（不含时间戳），以及一节 `verification`：
  用文字写清 `canonicalJson` 的规则和每种哈希的输入，任何人都能自己重算。别的跟踪的条目与简报条目只给序号与哈希，不给内容
  （简报事实覆盖用户的全部跟踪）。管理员可以用 `pnpm admin verify-bundle <file>` 离线校验（退出码 0 / 1，参考实现）；
  页面文案「管理员可用 pnpm admin verify-bundle 校验，任何人也可按文件里的说明重算」。CSV 导出与全部决策记录的总页放二期。

> **实现备注**（S11）：
> - 导出文件里本跟踪的计划条目，内容 = 快照参与内容指纹的那部分（`planContent` 的输出），inline 条目 = 原样的 JSON，两种都是
>   `payloadHash = sha256Canonical(payloads[seq])`，`payloads` 按条目序号取；版次、原因与各维度指纹另放在 `plans`（按快照 id），不参与校验。
>   文件层面另校验两项：链尾等于 `chain.headHash`、`manifestHash` 重算一致（断点的 seq 为空）。组装与参考校验在 `@ivan/db` 的 `bundle.ts`
>   （`buildTraceBundle`、`verifyBundle`），断点文字表 `LEDGER_BREAK_TEXT` 在 `@ivan/core`，网页与命令行共用。
> - 导出清单要写指纹口径版本与选股解释版本，而 server 不依赖 `@ivan/data`（会带进 DuckDB）：`HASH_VERSION`、`EXPLAIN_VERSION` 挪到
>   `@ivan/core` 的 `versions.ts`，`@ivan/data` 原样再导出，取值不变（以后加版本改那里）。
> - 「那天看到的计划」的重放结果按代码与方向对 `tracking_trades` 计划日的行：有成交 = 成交（同时有拒单时注明部分没成交的原因），
>   只有拒单 = 没买到 / 没卖出（原因），都没有 = 没有执行；计划日晚于跟踪的最后结算日时不给重放结果（界面写「计划日还没结算」），
>   免得把还没发生的成交说成「没有执行」。「后来怎么样」满 5 个交易日（按休市日表从决策日往后数，对比提交过的数据日）才去 worker 算；
>   不满 20 天时用 5 天并注明「（5 天）」，卖出写「卖出后」。worker 不在时这一列写「--」，不让整块报错。
> - 时间线里的简报条目只取跟踪存续期间（上线确认到停止后一天）的；「加载更早的」把 `to` 设成已取到的最早日期再取一次，按序号去重。
> - `pnpm admin` 的应用库改为按需打开：`verify-bundle` 只读文件、不碰库。

### 13. 数据源接口与回退链（S12）

D9 承诺的接口落地（D72），本轮只覆盖日线、实时报价、指数三种能力，只为本轮真的会用的东西开口子：

- `packages/data/src/sources/types.ts`：`SourceId`（`eastmoney | tencent | csindex`）、`Capability`、`PriceCaliber`
  （`raw+ref_prev_close`、`raw+hfq_affine`、`raw+adj_factor`、`total_return`、`price_index`，**没有前复权**，所以无法声明）、
  `SourceAdapter`（中文名、域名、封禁风险 1–3、各能力支持的市场、各能力的方法）。token 成员见 §18（S16）；
  事件数据能力见 §16（S15）；本地导入仍在三期。
- `sources/adapters/eastmoney.ts`、`tencent.ts`、`csindex.ts` 包装现有函数，行为不变。
- `registry.ts`：默认链 日线 A `[eastmoney, tencent]`、日线 HK `[eastmoney, tencent]`、报价 `[tencent]`、
  指数 `[eastmoney, tencent]`（全收益指数仍是中证官网与 ETF 两条专用路径）。`IVAN_CHAIN_BARS_A=tencent,eastmoney`
  这类环境变量只接受默认集合的重排，否则日志「数据源顺序配置无效，沿用默认顺序」；`KLINE_SOURCE` 保留为显式单一来源、不回退。
- `chain.ts`：`fetchWithChain(chain, what, fn, isEmpty)` 被封、空结果、报错都换下一家；全部被封时抛最早解封时间的
  `BlockedError`，现有的等解封逻辑照常工作。`FetchLedger` 按任务统计各来源服务的股票数、回退次数、失败明细，
  提交数据版本时写进 `data_versions.sources`；管理页显示「今晚东财 N 只、腾讯 M 只（回退 K 次）」。
- `compute/normalize.ts`：`toIvanBars(code, sourceBars)` 把各口径换成 Ivan 的「不复权 + 等比因子」：
  参考前收 → `adjFromRefPrices`；仿射后复权 → `decomposeHfq`（加法复权是 a = 1 的仿射，同样能还原，**不另做加法口径检测**）；
  复权因子 → 因子归一、跳变处生成除权事实（纯函数，单测覆盖，给三期的 Tushare 用）；其他口径抛 `CaliberError`。
  还原出来的因子非有限或 ≤ 0 时也抛 `CaliberError`，这只股票记缺失（S13 记原因 `rejected:caliber`）。
- `fetchOnce`、`fetchIndex` 改走链；`updateBars` 每批报价单独 try / catch，失败批次的股票转去逐股补日线；
  报价请求了但响应里没有的代码（腾讯偶尔漏）也转去逐股补日线。一批报价出错不再让整晚失败。
- 探针修正：A 股日线、价格指数的检查改为东财优先（与 D27 一致）；吞吐检查改为串行、间隔 600 毫秒（D31），
  不再用并发 4 / 50 毫秒冒封 IP 的风险。节奏与检查顺序抽成导出的常量，单测守着（探针本身只在命令行联网）。

> 实现备注（S12）：
> - `SourceAdapter.hosts` 按能力分（`{ bars, quotes, index }` → 域名列表），不是一个扁平数组：腾讯的日 K（web.ifzq）
>   与报价（qt.gtimg）是两个域名，日 K 被封时报价照常可用，链只在「这个能力的域名全被封」时跳过这家。
> - `fetchWithChain(chain, what, fn, isEmpty, gate)`：第 5 个参数是 `HttpLike` 的 `isBlocked` + `earliestUnblock`，
>   用来跳过被封的来源并算出最早解封时间。没有一家给出非空结果、但有一家正常答了「没有数据」时返回这个空结果
>   （`empty: true`，台账记 `empty`），不算整条链失败——能连上的来源说没有就是没有，缺不缺留给 S13 的闸门判断；
>   只有一家都没答上（被封或报错）才抛错。
> - 台账 `data_versions.sources` 第 1 版：`{v: 1, served: {em, tx, txq}, fallbacks, empty, failed, failures(≤50), index: {指数: 来源}}`，
>   `served` 按股票去重、以最后一次写入的来源为准（港股轮换刷新复权的股票先记 txq、再记 em）。只有夜间增量与回填写台账，
>   每周抽检不写；管理页读最近一个夜间增量（跳过休市夜）的台账，腾讯 = 腾讯日 K + 批量报价，批量报价另起一行。
> - `updateBars` 返回值多了 `quoteFallback`（报价失败或漏掉、转去逐股补的只数），S13 的 `quote_omitted` 可以接着用。

### 14. 完整性闸门、日线体检与运行的数据来源（S13）

**完整性闸门**（修正 D36，D73）：纯函数 `assessCompleteness({expected, updated, noTrade, missing, critical, noTradeHistory})`，
在 `updateBars` 之后、财报与因子计算**之前**判断（拿不全就别往下算）：

- 缺失（整条链都没拿到、被体检拒收、口径换算失败，或报价漏掉又补不上的 `quote_omitted`）超过 A 股 max(3, ⌈0.2% × 应更新数⌉)、
  港股 max(5, ⌈0.3% × 应更新数⌉) → 失败；
- 无成交数 > max(2 × 近 20 个版本的中位数, 中位数 + 30)（历史不足 5 个版本时跳过）→ 失败（防止报价没更新）；
- 缺失的股票里有运行中跟踪的持仓或明日计划 → **不让整晚失败**，记进 `completeness.missingCritical`，
  相关跟踪的判词变成「数据未更新」（S10）。
- 失败时提交版本 `incomplete`，抛 `IncompleteDataError`：「A 股有 12 只股票今天的日线没拿到，已停止更新，以免被当成停牌」。
  应急开关 `ETL_ACCEPT_MISSING=代码1,代码2` 放行指定代码，并记进完整性 JSON 与之后的运行来源。
- **自动重跑**：`jobs` 加 `not_before`、`attempt` 两列，认领时跳过未到时间的任务；`IncompleteDataError` 和
  「开市了但指数日 K 还没有」两种失败在 45 分钟后自动再排一次，最多 2 次。排队等重跑期间市场当日状态是 `stale`（D78），
  数据横幅显示「A 股今天的数据没更新完整：…。18:15 自动重试（第 1/2 次）」，简报与判词也照此说「数据没更新」。
  重跑成功而当天的简报已经写过时，再排一次简报（加一版，S10）。
- **日线状态**：`updateBars` 写 `bar_status`：报价日期不是今天或开盘价为 0 → `no_trade`；整条链失败 → `missing`；
  之后补上的删掉 `missing`。
- **辅助数据失败要看得见**：汇率、证券表、简称、财报与股本这些「失败沿用旧数据」的步骤，把结果写进
  `completeness.soft = [{step, ok, rows, error}]`；`/internal/data-status` 给出每类数据最近一次成功的日期与连续失败的晚数；
  连续 3 晚失败时管理页横幅提示；财报与股本连续 3 个交易日没成功时，回测与跟踪加数据提示 `stale_fundamentals`（warn）
  「财报与股本已经 3 个交易日没更新成功，估值、ROE、市值可能是旧的」。

**日线体检**（`compute/hygiene.ts`，D74）`validateBars(code, rows, ctx)`，写入日线和报价路径都过一遍：

| 规则 | 级别 | 条件 |
|---|---|---|
| R1 ohlc | 拒收 | 任一价格 ≤ 0；最高 < max(开, 收)；最低 > min(开, 收)；最高 < 最低 |
| R2 volume | 拒收 | 成交量 < 0 或非有限值（成交量 0 但收盘变了只标记） |
| R3 calendar | 拒收 | 日期不在交易日历或晚于今天 |
| R4 重复日期 | 标记 | 同批重复日期保留最后一条 |
| R5 limit_breach（A 股） | 标记 | 相对复权参考前收的涨跌幅超过规则表第 2 版限幅 + 0.5%，当天无公司行动；上市前 5 个交易日跳过 |
| R6 adj_jump | 标记 | 复权因子跳变但当天没有公司行动 |
| R7 hk_jump | 标记 | 港股单日涨跌超过 50% 且无公司行动 |
| R8 stale_print | 标记 | 开高低收量与前一天完全相同且量 > 0 |

拒收的行不入库，代码记 `bar_status = missing`（原因 `rejected:<规则>`），计入完整性闸门；拒收与标记都写 `data_issues`。
每周抽检除了收盘价，再比归一后的复权因子（差 > 0.1%）与成交量（差 > 1%），只标记不自动修（不知道哪家对）；
收盘价不一致时仍按原逻辑整段重拉。

**数据问题会被关掉**：同一（代码, 日期）后来重写且通过体检、没有再触发同一条规则时，之前版本的问题记为已解决（`resolved_by = refetch`）；
周检的复权与成交量标记在后来的周检比对一致时解决（`check`）；管理页「数据质量」卡每条可以点「标为已核对」（`admin`，只有管理员）。

**运行的数据来源**：`buildSimInput` 多一次 `GROUP BY src` 查询，得到面板里各来源的行数与「来源未记录」行数，
写进运行卡 `data.provenance`；面板里的代码与区间碰到 `missing` 状态时加检查 `data_gap`（warn）「有 N 只股票共 D 天的日线
没拿到，回测把这些天当成停牌处理」；**入选过的股票**在区间里有未解决的数据问题时加 `data_issue`（只有标记时 info，有拒收时 warn）。
这些都是数据提示，只影响 `reportHash`，不影响「逐笔一致」。
「复现信息」ⓘ 加一行「行情来源：东方财富 97.1%、腾讯 2.9%；缺失 0 天」。管理页「数据质量」卡：近 7 天按规则统计的拦截与标记、
问题最多的代码，例「近 7 天拦下 3 根异常日线（高价低于低价 2、日期不是交易日 1），标记 11 处待核」。

> **实现备注**（S13）：
> - 闸门的计数不含 `critical` 与 `ETL_ACCEPT_MISSING` 放行的代码（前者进 `missingCritical`，后者进 `accepted`）；
>   `missing` 列表含全部缺失代码（最多 200 个）。完整性 JSON 另记 `date`（那一晚），连续失败晚数按晚汇总：
>   同一晚重跑过的算一晚、有一次成功就算成功；没跑到那一步的版本（闸门没过的 incomplete）不算。
>   `/internal/data-status` 的 `soft` 每项多给 `firstFailDate`（stale_fundamentals 判断「区间终点 ≥ 第一晚失败」用）。
> - 逐股日 K 补数成功、但里面没有今天的股票记 `no_trade`（来源是那家日 K），只有报价说过今天有成交（除权日）的才记缺失；
>   整条链没拿到或来源说「没有」（`empty`）记缺失，原因按是不是报价漏掉 / 报价批次失败转来的分 `quote_omitted` / `chain_failed`。
>   报价路径被体检拒收的直接记缺失（`rejected:<规则>`），不再转逐股补。
> - R3 只在日历非空、日期不早于日历第一天时判「不是交易日」（还没建日历的库、日历开始之前的回填不误拒）；晚于今天始终拒收。
>   ST 用这只股票最新一天的 `flag_st`（近似，只影响 R5 标记）。
> - 「未解决」统一按 `resolved_by IS NULL` 判断（管理员在还没有提交版本的库上标已核对时 `resolved_ver` 为空）；S07 个股证据里的
>   「未解决的数据问题」一并改成这个口径。同一（代码, 日期, 规则）已有未解决的问题时不重复记；`check_*` 不随重写关闭，只由抽检关。
> - 每周抽检的 `check_adj` / `check_volume` 每只股票每条规则只记一条（第一个不一致的日子，详情写共几天）；收盘价不一致整段重写时不再比因子与成交量。
> - `computeBlocked(sqlite, now)` 跳过 `not_before` 在未来的排队任务（不只 etl），认领也一样。`settleMarket` 不给 `staleCodes` 时
>   （管理员单独重跑结算）读最新提交的夜间版本里记下的 `missingCritical`，判词不因重跑丢掉「数据未更新」。
> - 命令行 `daily` 不读应用库的跟踪，持仓股用 `--critical c1,c2` 指定；`ETL_ACCEPT_MISSING` 两边都认。
> - 运行的来源、缺口与数据问题都按面板区间（日历起点，含仓位控制往前多带的几天，到最后一个已提交的交易日）与面板代码
>   （各决策日名单里出现过的代码，含缓冲名次与信号模式的代码）统计。`get_run` 的模型摘要多一个 `dataSources`（各来源占比是小数）。
> - 辅助步骤、数据问题规则、行级来源的中文叫法放在 `@ivan/core`（`SOFT_STEP_LABEL`、`ISSUE_RULE_TEXT`、`BAR_SOURCE_TEXT`），行情仓、管理页与模型摘要共用。

### 15. 更贴切的基准与港股通股票池（S14）

- 新指数（D75）：`csi500_tr`（中证官网 H00905）与价格孪生 `csi500`（1.000905 / sh000905）、`csi1000_tr`（H00852）与
  `csi1000`（1.000852 / sh000852）、`csi_div_tr`（H00922）与 `csi_div`（1.000922 / sh000922）；临时补齐的配对同步加上。
  某个指数库里一行都没有时，第一次更新自动从 2013-01-01 拉全（不用停 worker 跑回填）。
- `BENCHMARKS` 加 `csi500`「中证500全收益」、`csi1000`「中证1000全收益」、`csi_div`「中证红利全收益」；
  DSL 的 `benchmark` 枚举由 `BENCHMARKS` 的键生成，旧策略照常通过。
- **基准没数据时提前拒绝**：`normalizeParams` 按 `/internal/data-status` 给的各基准首个数据日校验，起点前一个交易日没有基准数据时
  直接 400，不排任务、不扣额度：「基准『中证1000全收益』从 {首个数据日} 才有数据，请把起点设在这之后，或换个基准」；
  一行都没有时「基准『X』还没有数据，等今晚行情更新后再试」。`buildSimInput` 里同样的检查只对回测抛错（不拿一条平线来比）；
  跟踪（补下一个交易日的那条路）不抛错，加数据提示，免得全收益基准晚到一天就让结算失败。
- **基准不匹配**提示 `bench_mismatch`（info）：用一次查询算各决策日入选股票的 `mcap_rank` 中位数。A 股基准是沪深300 且
  中位排名 > 800 → 建议中证1000，> 500 → 建议中证500；排序里股息率权重占 ≥ 30% 而基准不是中证红利 → 建议中证红利全收益；
  港股基准恒指且中位排名 > 300 → 「持仓多是中小盘，恒指可能不是合适的比较基准」。例：「持仓中位市值排名约第 1,150 名，
  沪深300 可能不是合适的比较基准，可试试中证1000」。
- **港股通股票池**（D77）：DSL `universe.hkConnect?: true`（只用于港股策略）。选股 SQL 加一条条件「是港股通标的」：
  `attr_history` 里 `hk_connect_sz`（S03 起采集；找到沪港通列后加 `hk_connect_sh`，取并集）在决策日有效的区间值为 Y；
  早于首次记录日的日期用首次记录的名单。回测区间早于首次记录日时加数据提示 `hk_connect_approx`（info）
  「港股通名单从 {首次记录日} 起逐日记录，之前的日期用的是那天的名单（以后才纳入的股票会被当成一直能买）」；
  只记了深港通时提示里写明。一行快照都没有时 400「港股通名单还没有记录，等今晚证券表刷新后再试」。
  选股解释的条件标签「不是港股通标的」；编辑器加复选框「只选港股通标的（内地投资者能买到的）」；提示词的 DSL 说明加一行。
  名单变化进入选股结果，所以已经被输入指纹覆盖。
- 编辑器的基准选择列出新基准与「含分红」Tag。探针加三条中证全收益代码的检查（只在命令行联网，不进测试）。
- 无风险利率、恒生科技、中证 A500 与科创 50 的全收益放二期：接口和代码要先实测，夏普口径要和指标第 3 版一起改。

> **实现备注**（S14）：
>
> - 收尾时改了 `bench_missing` 的说法：引擎把基准按前一天的值带过去，提示写「这些天按前一天的基准值近似」，不再写「超额按缺值处理」（只进 reportHash，只有跟踪会出）。
>   `hk_connect_approx` 按第一次决策日（起点前一个交易日）判断，起点正好是首次记录日时也提示。
> - 提交前的校验是 `services/runs.ts` 里单独的 `checkDataReady(specs, start)`（异步，data-status 缓存 60 秒），在 `normalizeParams`
>   之后、`consume` 之前调用；`normalizeParams` 仍是同步的纯参数校验。server 没有交易日历，按「首个数据日 ≥ 起点」判断
>   （指数日期都是交易日，等价于起点前一个交易日没有数据）。worker 不在或 data-status 没给这些字段时不拦，交给建输入时的同一检查。
> - 跟踪的 `bench_missing` 覆盖起点前一个交易日到最后一个已提交交易日之间基准缺值的日子（写第一天与天数），全收益晚到一天也在内。
> - 只记了深港通时，即使回测起点不早于首次记录日也加 `hk_connect_approx`（只写「目前只记录了深港通名单」），免得把深港通当成港股通整体。

## 不借鉴的部分

| 类别 | 不借鉴什么 | 原因 |
|---|---|---|
| 数据广度 | 美股、加密货币、期货、外汇等 20 多个数据源 | 超出 A 股 + 港股的定位；类型系统也只有 A / HK |
| 数据广度 | 通达信 TCP（mootdx）、baostock | 只有 Python 实现，要起 Python 旁路进程，违背全 TS 与自部署简单 |
| 数据广度 | 富途 OpenD、长桥网关、恒生聚源付费 MCP | 要本地网关和账户凭证，或是机构付费服务；接口留好了，以后可以接 |
| 数据广度 | 北向 / 南向资金日流向 | 2024 年 8 月起停止披露（北向净买入为 0、南向是常数），做成因子只会喂进 0 和常数 |
| 数据广度 | 个股主力资金流、龙虎榜席位 | 上游只保留 120 个交易日，无法回测；前向积累每晚要约 7600 次请求；龙虎榜是短线信号且带事后收益列 |
| 数据广度 | push2 全市场选股、问财自然语言选股 | 只有当前快照不能回测；问财等于自然语言选股，违背原则 2 |
| 数据广度 | 新闻与情绪分 | 没有归档、不点时，情绪分会把 LLM 判断带进回测 |
| 数据广度 | 同花顺一致预期接口 | 2026-10-05 返回空；改为三期从单篇研报重建 |
| 数据广度 | 磁盘响应缓存 | Ivan 的单写入方行情仓就是缓存；再加一层会和数据版本打架 |
| 数据广度 | 加法复权口径 + 运行时警告、加法口径检测器 | Ivan 自己从仿射后复权重建等比因子（D28），加法是仿射的特例，同一套算法就能还原；接口里没有前复权口径，无法声明 |
| 数据广度 | FRED 宏观、指数成分历史、概念板块成员 | 美国宏观对 A / 港选股意义小且要 key；成分历史是 MVP 不做；板块成员只有当前值 |
| 数据广度 | 新浪处罚抓取、按裸代码猜交易所 | 抓 GBK 网页太脆；Ivan 的证券表是权威来源，猜代码会把北交所 920 开头误判 |
| 回测 | 逐笔交易打乱的蒙特卡洛 p 值、独立同分布自助法 | 打乱不改平均盈亏测不出优势（样例 p = 0.63），还把逐笔夏普按 √252 年化；改用平稳块自助法 |
| 回测 | Vibe-Trading 的 A 股 / 港股规则书、前复权口径、结束强制清仓、按毛利算胜率 | Ivan 的更准（见上文对比表） |
| 回测 | 「ln(1+g) / (2·笔数·仓位)」的保本费率公式 | 只对单只持仓成立，多只持仓错 1.1–6.5 倍；三期按重新模拟精确求解 |
| 回测 | Brinson 归因、截面 WLS 风格模型 | 没有点时的指数成分权重，算出来是编的；二期用反事实分解与描述性风格分位 |
| 回测 | 均值方差等权重优化器、固定 252 年化、文件式运行卡 | 要二次规划求解器、易过拟合、和 D32 的不再平衡冲突；年化 Ivan 已按样本估计；运行卡存进数据库 |
| 回测 | 跨币种组合、资金二分拟合、做空借券 | D12 一个策略一个市场；Ivan 的预算规则已经确定且有意义；只做多 |
| 决策 | 券商网关同步持仓、任何下单路径、委员会给出的多空 / 目标价 / 止损 / 仓位 | 需要凭证与外部服务；等于 LLM 给买卖建议，违背原则 1、2 与「策略信号」措辞 |
| 决策 | 让模型声明数字角色的完整核对栈（约 5000 行）、交易价位的核对分支 | Ivan 回复短，聚焦版够用；Ivan 从不输出交易价位 |
| 决策 | 只用盈利交易聚类出规则的影子账户、日内时段规则 | 以结果为条件挖规则，天然过拟合；Ivan 只有日线 |
| 决策 | IM / 邮件 / 微信推送、以 LLM 结论收尾的定时研究 | 外部服务；判词由引擎确定性给出，LLM 只复述 |
| 决策 | 研究目标台账的预算与 12 种状态、模型治理字段（四眼原则等） | 太重；草稿 + 确认已经管住动作；企业级模型风险管理不适合给朋友用的自部署实例 |
| 决策 | frankfurter 汇率、PDF 报告、单独的假设登记表 | 用自己的外汇中心中间价并且失败即停；页面 + 可校验的 JSON 导出代替 PDF；假设并进三期的投资论点 |

## 验收标准

1. **旧结果不变**：1.1.0 金标准（10 个夹具：A 股主板、月初调仓、三种仓位控制、港股跨三个费率日、信号模式、单只上限、退市清出、科创板）
   在 `exec` 缺省与 `exec = LEGACY_EXEC` 下逐字节一致；现有跟踪的 `exec_config` 都是旧口径，升级后第一晚结算重放 0 漂移。
2. **能复核**：新回测都有运行卡与输入指纹；同一数据下「复核数据」得到「输入一致」；改一根 K 线后得到「数据已修订」；
   复核作为 compute 任务排队，夜间更新时不会读到写了一半的数据；「完整重跑」在数据没变时逐笔一致（只多了数据提示或第二天才重跑也一样），
   提示项变化单独说明；重跑不计入试错次数。
3. **漂移能说清原因**：跟踪重放漂移被归到 数据修订 / 引擎变更 / 成交假设变更 / 原因不明 / 早于记录（含指纹口径升级）之一，有单测；
   前缀指纹在周末前最后一个交易日这类边界上也稳定。
4. **计划能回溯**：每晚每个运行中的跟踪写一份计划快照与账本条目；同一晚同样的数据重跑不加版次；同一晚数据修订（包括没改名次的因子修订）
   后重跑加第 2 版并写明原因；之后的修订在回溯页里表现为「按现在的数据重放」与第 1 版计划的对照；SQL 改或删账本、快照、简报版次会报错；
   链校验通过；导出文件能用 `verify-bundle` 离线校验，篡改一个值后报出位置。
5. **数字核对**：简报里编造的数字被拦下（重写一次仍不对就用模板）；对话里工具没给过的数字被标注，因子单位（%、亿）不误报；
   `messages.usage` 记有模型、token 与核对结果。人工抽检 20 条真实对话回复：没有标注的编造数字为 0、误报的标注 ≤ 2 条
   （补上 MVP 验收 5 只抽了 6 条的缺口）。
6. **休市不说今天，开市不说休市**：节假日的简报没有「今天 ±x%」；开市日更新失败或在等自动重跑时，简报不说休市、说数据没更新。
7. **成交更真实**：默认成交假设下，小盘策略报告给出拒单、参与率、容量估计；滑点与冲击成本单列；买价不超过涨停价；
   成交日当天的放量不影响那天开盘的成交（用决策日的日均成交额）。
8. **可信度**：新回测给出年化超额的 95% 区间、跑赢基准的把握、一年净值扇形；同样的输入（含第二天在没变的数据上重跑）区间完全一致；
   区间跨 0 时出 `low_confidence` 警示；挪一天起点不会让试错次数清零。
9. **数据不悄悄退化**：一批报价失败或漏报不再让整晚失败；日线缺失超阈值时整晚失败、45 分钟后自动重跑（最多 2 次）；
   持仓股缺失只让对应跟踪显示「数据未更新」；被拒收的坏 K 线不入库并出现在数据质量卡；数据问题会被关掉；
   财报等辅助数据连续 3 晚失败时管理页与回测都看得到；每次回测能看到行情来源占比。
10. **点时留底**：每晚证券表刷新记录行业、深港通、每手股数的变化区间；财报首次见到的数值留底；管理页看得到采集情况。
11. **个股证据点时**：同一调用对今天和历史某天都只用当时可得的数据（单测：公告日前一天看不到那期财报）；给成交日时按前一个交易日取数；
    扫描子回测按它自己的策略内容解释；每项有来源与数据日；校验值可复核。
12. **性能与内存**：jim-server 上（pm2 实际配置）全 A 股、2016 年至今、月度、前 20 只、默认成交假设并含可信度计算的回测 ≤ 30 秒；
    同时跑一个结算任务时 worker 峰值 RSS ≤ 800 MB（低于 900M 重启线 100 MB）。R2、R4 上线后各测一次。
13. **测试离线**：`pnpm test` 不访问网络；新增测试全部离线；typecheck、lint 全绿。
14. **不越权**：对话工具都写不了策略版本、跟踪、账本、快照；停止跟踪必须经确认卡。
15. **港股通股票池**：勾选后港股回测只选决策日在名单里的股票；早于首次记录日的区间有提示；没有名单时提前拒绝。
16. **分批上线**：每批单独部署且能回滚到上一批；R1 的行情仓升级用脚本完成，worker 启动时不做重迁移，部署健康检查不超时；R5 之后回滚到 R4 之前先运行 `scripts/migrate.sh --down 4`（删掉 7 个事件因子列）；R6、R7 的迁移只加表、加列，旧代码直接可用。
17. **三条用户路径有场景测试**：（a）跟踪一晚结算 → 计划快照 → `get_plan` 的模型输出带原因、名次与数据版本；
    （b）默认成交假设的小盘回测 → `get_run` 的模型输出带容量提示、区间与行情来源。

## 决策记录

- **D55 成交假设是回测参数，不是策略的一部分；旧结果用「旧口径」锁定。** `ExecConfig` 每个字段都有旧口径默认值，
  缺省字段一律按旧口径解析，存下的运行与跟踪永远可复现；新回测用 `defaultExec(market)`；跟踪上线时抄基准回测的成交假设并锁定，
  基准是旧口径而已有新口径时明确提示并给出「按新口径重新回测」；改口径要显式升级（二期，记账本）。券商佣金仍在 `spec.costs`。
  引擎还没实现的字段不进 schema。放弃的方案：把滑点写进策略 DSL（同一策略换个资金规模就要出新版本，版本历史被成交假设淹没）；
  直接改默认行为（每晚重放会悄悄改写所有现有跟踪的历史）。
- **D56 本轮引擎版本只升一次（1.1.0 → 1.2.0），新行为都挂在记录在案的字段上。** 旧口径必须逐字节复现 1.1.0 已有的字段
  （新增字段可以有）；金标准在第一处引擎改动前提交，覆盖港股费用、信号模式、单只上限、退市、科创板这些后面会动的路径。
  放弃的方案：每个改动各升一个小版本（版本号失去意义，跟踪归因会反复报「引擎变更」）。
- **D57 运行卡 + 输入指纹；结果指纹分成交与提示两部分；复核分两级；漂移归因只有一个函数，用前缀指纹。** 复核先比指纹
  （便宜，计入 analyses，作为 compute 任务排队），需要时再完整重跑（计入回测额度）。「逐笔一致」只看 `coreHash`：
  检查项里有从数据派生、K 线不变也会变的提示（数据问题、基准不匹配、试错次数），放进 `reportHash` 单独说明，
  也不进输入指纹（运行卡另记 `caveatsHash`）。跟踪不能拿整窗指纹逐晚比较，因为窗口每晚变长；改为按上一晚的最后结算日重算前缀指纹，
  前缀按「执行日 ≤ cut」纳入决策，边界上两晚一致。指纹带口径版本 `HASH_VERSION`，分批上线时口径变了记「早于记录」，不误报数据修订。
  原提案里的三个复核入口、三个归因函数合并成一个。指标引用（JSON 指针）不做，数字核对已覆盖。
- **D58 哈希规范：沿用 `canonicalJson`，不舍入；sha256 只在 `@ivan/core/node`。** web 引入 `@ivan/core`，不能把 node:crypto
  放进主入口。全长 64 位十六进制，界面显示前 8 位；策略内容的指纹统一用 `specHashOf`（16 位，与历史的 `spec_hash` 相同）。
- **D59 新增每日额度 `analyses`（默认 100）。** 复核、个股证据这类要 worker 组装数据的读请求计量；原来选股、个股卡不计量，
  接入更多数据后会更贵。管理页可以给单个用户改，用户在账户菜单里看得到。
- **D60 数据版本先开后提交，只有 ok 的版本能被引用，「读到哪一天」只看提交过的版本；ETL 写库时不跑回测与复核。**
  原来的数据版本只是日志，回测可能读到写了一半的数据却记成上一个版本。版本在写任何东西之前打开（指数与日历也盖章），
  休市记 `skipped`。`committedAsOf` 统一回测、结算、选股、证据的截止日。放弃的方案：给 DuckDB 加跨步骤事务
  （日线、财报、因子分很多步，一个事务太大，512 MB 内存扛不住）。已知局限：失败的一晚可能已经重算了近 15 天的因子，
  下一次提交前读到的是这些行；输入指纹如实记下读到的内容，复核能发现。
- **D61 只能向前积累的点时数据，本轮起留底。** 行业、深港通、每手股数按区间快照；财报按（代码, 报告期, 数值指纹）
  留下首次见到的值，个股证据优先用它。首次快照之前的历史明确标为「当前值 / 首次名单」。行业、每手接入因子要攒够历史
  并和其他注册表升级合并一次（二期）；港股通先作为股票池条件用（D77）。深港通的列不能当成「港股通」整体记，沪港通列核实后另记。
- **D62 规则表第 2 版是按日期的表格，每行写出处。** ST 主板 10%（2025-07-07）、新股不设涨跌幅窗口、北交所 30%、过户费与港股交易费历史、
  港股印花税取整、港股价位表。出自记忆的日期上线前逐条对照公告原文。放弃的方案：把 Vibe-Trading 的规则书搬过来（更粗）。
- **D63 指标第 2 版：从投入第一笔钱算、按完整持仓算胜率、补风险指标、修两个公式。** 虚拟锚点只在指标里加，不改存储的序列，
  跟踪日与偏离百分位不受影响；月度、年度分桶不为锚点单独成桶。第 1 版原样保留。主指标仍只有 4 个，其余放 ⓘ。
- **D64 按流动性成交，本轮只限买入。** 半价差含最小价位、平方根冲击、单笔不超过日均成交额 10%、拒单诊断、容量估计。
  日均成交额与波动率用决策日的值（第 k 天开盘不知道第 k 天的成交量）。卖单不设上限（部分成交会多出很多状态路径，二期）；
  ADV 未知的买单拒绝（不能假设无限流动性）。冲击系数是文献值，写明、可改。拒单计数与最近样例旧口径也算（跟踪的回溯要用）。
  口径不同的回测在对照视图与对话里都先说口径。
- **D65 可信度用平稳块自助法与 PSR，种子来自输入指纹，只对第 2 版口径的新回测做。** 区间是「按历史重抽样」的范围，不是预测；
  文案与提示词都不说概率。种子不用数据版本号：版本号每晚都涨，会让没变的输入第二天重跑得到不同区间。
  放弃的方案：独立同分布自助法（忽略自相关）、逐笔打乱（测不出优势）。
- **D66 试错计数：扫描计入，区间重叠 ≥ 50% 算同一区间，按实际策略内容去重。** 新建一个策略仍会清零，ⓘ 里说明；
  跨策略计数与 DSR / PBO 放二期。
- **D67 选股解释与回测共用同一个 SQL 构造器，个股证据只有一个点时读取器。** 解释与实际选股不一致是最糟的回溯，
  所以结构上共用并有一致性测试；今日选股也走同一条路。证据今天和历史同一套代码，按决策日（不是成交日）取数，
  保证解释不会用到未来数据。
- **D68 决策账本只追加、哈希链、触发器；计划快照第 1 版永不改写。** 修订按版次追加并写明原因（引擎变更 / 程序升级 /
  成交假设变更 / 数据修订 / 原因不明）；数据修订看输入指纹、解释指纹与数据版本三者，没改名次的因子修订也算数据修订。
  快照存因子值本身而不是引用，以后数据怎么修订都改不了当时的记录；之后的修订在回溯页里用「按现在的数据重放」的成交对照。
  计划日按交易所休市安排表推算。单机下哈希链证明的是内部一致、改动能被发现。放弃的方案：只靠 `tracking_orders` 加历史表
  （可以被 UPDATE，没有防篡改）；JSONL 文件链（多进程写要文件锁）。
- **D69 数字核对：简报是闸门，对话是标注。** 简报无人值守、发给所有用户，必须拦；对话是流式的撤不回来，诚实地标注。
  只核对「量」，日期、代码、窗口天数不核对；因子数值按因子表的单位核对；允许四舍五入，不允许推算。
  放弃的方案：移植 Vibe-Trading 让模型声明数字角色的完整版（太重）。
- **D70 跟踪健康状态机带滞回、样本不足不算正常、第一个读数不好不先报正常、永不自动停止；阈值以校准测试为准；判词确定性计算；
  简报以判词变化开头、休市不说今天、按版次只追加、永久保留并记账。** 修正 MVP 里「简报只留 90 天」。上线第一晚按历史补算健康读数。
  阈值来自合成数据校准：同分布误报 < 10%，并写明检出率有限。
- **D71 决策回溯页先做精简版。** 时间线、第 1 版对最新版、对照按现在数据的重放、后来怎么样、链校验、JSON 导出；
  导出里别的跟踪与简报只给哈希（不泄露有哪些其他跟踪的内容），并写明哈希规则让任何人都能重算。CSV 与总览页放二期。
- **D72 数据源接口落地（D9 的实现），只开本轮要用的口子。** 回退链按封禁风险排序（东财串行 0.6 秒在前，容易触发 WAF 的腾讯在后）；
  环境变量只能重排不能增删；显式来源不回退；口径换算不成「不复权 + 等比因子」的数据在接口处拒收。本轮只做日线、报价、指数三种能力；
  token 成员在 S16 随 Tushare 加入（D86），本地导入仍在三期。
- **D73 完整性闸门（修正 D36）。** 全市场缺失超阈值才整晚失败，判断在财报与因子计算之前，并在 45 分钟后自动重跑最多 2 次；
  持仓股缺失只让对应跟踪「数据未更新」，不拖累所有用户；被拒收的坏 K 线、报价漏掉又补不上的都算缺失。辅助数据「失败沿用旧数据」
  仍不让整晚失败，但结果留痕、连续失败要报出来。原因：原来缺数据被引擎当成停牌，会悄悄改变成交与跟踪重放。
- **D74 日线体检：R1–R3 拒收，其余只标记；不同来源打架只报告、不自动修；数据问题有生命周期。** 标记永远不阻断；
  涨跌幅规则读规则表，只有一个出处。不做加法复权检测：仿射分解已经能还原加法复权，检测器反而会把只派现金的股票误判。
- **D75 新基准 + 「基准不匹配」提示；起点前没有基准数据就拒绝回测（提交前就拒，不扣额度）；跟踪只提示不失败；
  无风险利率二期与指标第 3 版一起做。** 放弃的方案：没数据的日子基准按 0 收益（等于拿平线比）；本轮就用未实测的 Shibor 接口
  （夏普口径会改两次）。
- **D76 分 4 批上线，行情仓升级走维护脚本。** R1 = S01–S03，R2 = S04–S08，R3 = S09–S11，R4 = S12–S14；每批单独部署、单独落地记录，
  迁移对上一批可回滚。只能向前积累的数据因此尽早开始攒。worker 启动时不做改大表的迁移（部署健康检查只等 24 秒、pm2 有内存上限），
  改由 `scripts/migrate.sh` 停 worker 后执行。放弃的方案：14 个切片一次上线（快照与留底晚几周才开始）；启动时自动迁移（可能重启循环）。
- **D77 港股通股票池是本轮唯一新的选股数据。** 用每晚采集的深港通（核实后加沪港通）名单按区间点时筛选，首次记录之前用首次名单并提示；
  不升级因子注册表、不重算。原因：内地投资者只能经港股通买港股，回测选到买不到的股票是最直接的不真实。
- **D78 市场当日状态四态（已更新 / 休市 / 没更新 / 进行中），简报、判词、数据横幅共用一个函数。** 「休市」只认当天 etl 任务
  明确返回非交易日（或周末），不再从交易日历里有没有今天来推断：开市日指数步骤失败时日历里也没有今天。
- **D79 计划结果回看的最小版。** 快照存基准代码与决策日基准收盘，纯函数 `evaluatePlanItem` 给出单条计划的次日成交与 5 / 20 天后表现，
  回溯页显示；这样攒下来的快照足够二期做统计，不会因为缺字段白攒。命中率、实盘 IC 等统计仍在二期。
- **评审处理**（第 2 稿）：评审提出的 2 个阻断项与全部主要问题都已改进设计；以下几处保留了不同做法：
  - 计划版次原因的判断顺序保留「引擎 → 指纹口径 → 成交假设 → 数据」，与漂移归因一致（评审建议数据优先）：引擎与成交假设只在部署或显式升级时变，
    同时发生时归给部署更准确；各维度的指纹都存在快照里，任何人都能重算全部原因。
  - 健康度阈值没有用评审举例的 10 / 3 / 1：预演里它仍有 11–15% 的误报；按「校准测试为准」选了 5 / 1 / 0.5、回撤比 1.2 / 1.5 / 2.0、连续 5 次。
  - 两融余额作个股证据没有放进本轮，而是在范围里写明取舍请 Jim 确认（评审的建议是「预算允许就做」）。
  - 净值扇形保留按绝对净值（投资者计划回撤时关心的是绝对数），按评审的另一个选项改了标题与位置，不和「跑赢回测同期」并排。
  - 加法复权检测器整个不做（评审建议只留给乘法口径的来源）：本轮没有这样的来源，留着就是没人用的代码。

## 风险

| 风险 | 缓解 |
|---|---|
| 引擎改动悄悄改写现有跟踪的历史 | 旧口径锁定 + 金标准在先（10 个夹具覆盖港股、信号、上限、退市、科创板）+ 每个切片跑金标准测试；跟踪的 `exec_config` 迁移默认旧口径 |
| 新默认让新回测看起来比旧的差，用户以为「变差了」 | 回测页、对照视图显示成交假设与指标口径；口径不同时对照视图与对话都先说口径；旧口径运行显示提示 |
| 规则表、费率、指数代码、休市日出自记忆 | 表格每行带出处；上线前逐条核对公告；错一行改一行；探针核对中证代码与港股通列 |
| 完整性闸门让夜间任务失败更多 | 阈值留余量；持仓股缺失不整晚失败；自动重跑；应急开关；失败原因写清楚 |
| 改的是最热的 ETL 路径 | 接口只包装现有函数；假件测试钉住回退顺序；列序测试守住按位追加；R4 最后上线，前面三批已经稳定 |
| 行情仓在 ~2500 万行上补列 | 维护脚本停 worker 后升级；先在生产库副本、512 MB 内存限制下演练并记耗时；worker 启动时不做重迁移 |
| jim-server 内存与 CPU | 线程池加超时、重启与内存上限；内存预算公式写进部署文档；自助法有界（B ≤ 1000、T ≤ 4000）；复核走任务队列；面板只多 8 字节 / 股·日；R2、R4 后实测验收 12（≤ 800 MB） |
| 账本触发器挡住以后的修正迁移 | 这是有意的；迁移说明写清楚删触发器、改、重建的做法 |
| 数字核对误报 | 裸整数不核、按写出的精度留余量、按类型匹配、因子按单位、证据池只取最近的工具结果；人工抽检 20 条定误报上限 |
| 健康阈值是经验值、检出率有限 | 集中定义、带版本、校准测试为准；ⓘ 写明误报率与检出率 |
| 计划日期遇节假日不准 | 静态休市日表（当年与下一年）+ 每年 12 月补表；没表时退回工作日并标注 |
| 港股通名单只有深港通、且只从首次记录日起点时 | 提示写明；沪港通列核实后加采取并集；首次记录前用首次名单并提示 |
| 自部署下哈希链不等于不可抵赖 | 文案如实说明；导出带链头哈希与重算说明 |
| 分批上线时指纹口径变化被误报成数据修订 | `HASH_VERSION`；口径不同记「早于记录」 |

## 实施清单（一期）

**R1（S01–S03）**：上线后行情仓升级、属性快照与财报首见开始积累。

- [ ] S01 测试底座、回测线程池加固、哈希工具、引擎金标准、市场当日状态、简报两处线上修正
- [ ] S02 运行合约：成交假设、运行卡、输入指纹、复核与重跑、漂移归因
- [ ] S03 行情仓第 3 版：数据版本开 / 提交、行级来源、ETL 期间不跑回测、属性快照、财报首见留底、升级脚本
- [ ] 人工：在生产行情仓副本上演练第 3 版升级（`DUCKDB_MEMORY_LIMIT=512MB`），记下耗时
- [ ] 人工：`pnpm ivan probe` 核对港股资料里的 `GANGGUTONGBIAODISHEN`，并列出所有含 `GANGGUTONG` 的列（找沪港通标记）
- [ ] 人工：jim-server 设 `BACKTEST_THREAD_MEMORY_MB=160`，部署后跑 `scripts/migrate.sh`，确认横幅消失、当晚数据版本是 ok
- [ ] R1 落地记录

**R2（S04–S08）**：上线后计划快照开始积累。

- [ ] S04 规则表第 2 版 + 指标第 2 版
- [ ] S05 按流动性成交
- [ ] S06 可信度 + 试错计数修正
- [ ] S07 选股解释与个股证据
- [ ] S08 决策账本与计划快照
- [ ] 人工：对照交易所公告核对主板 ST 10%（2025-07-07）、科创板 / 创业板 / 主板注册制新股不设涨跌幅窗口、
      过户费 2022-04-29、港股交易费 2023-01-01、港股印花税取整；港交所 2025 年价位调整
- [ ] 人工：按交易所休市安排录入并核对当年与下一年的 A 股、港股休市日
- [ ] 人工：jim-server 上测验收 12（≤ 30 秒、峰值 RSS ≤ 800 MB）
- [ ] R2 落地记录

**R3（S09–S11）**

- [ ] S09 数字核对
- [ ] S10 跟踪健康度、判词、简报第 2 版
- [ ] S11 决策回溯页
- [ ] 人工：验收 5 的抽检（20 条真实对话回复：未标注的编造数字 0、误报 ≤ 2）
- [ ] 人工：看一遍上线第一晚的健康度补算结果（落后很久的跟踪不显示「正常」）
- [ ] R3 落地记录

**R4（S12–S14）**

- [ ] S12 数据源接口与回退链
- [ ] S13 完整性闸门、日线体检、辅助数据失败可见、运行的数据来源
- [ ] S14 中证 500 / 1000 / 红利全收益基准、基准不匹配提示、港股通股票池
- [ ] 人工：`pnpm ivan probe` 核对中证 H00905 / H00852 / H00922 与东财 1.000905 / 1.000852 / 1.000922
- [ ] 人工：jim-server 上复测验收 12
- [ ] 文档对齐：README（夜间任务、管理命令、已知局限）、DEPLOY（迁移、内存预算、回滚）、docs/probe-report、设计系统 §3 / §7 / §8 / §11、
      两个 CLI 的用法说明；`grep -rn "90 天\|D36\|KLINE_SOURCE\|doctor"` 逐条确认；MVP spec 的 D9、D36、§8「简报只留 90 天」追加指向本 spec 的说明
- [ ] R4 落地记录
- [ ] （Jim 决定）把 MVP spec 的 Phase 6 勾上并改状态，补一条部署落地记录

**每年 12 月**：补下一年的休市日表（`packages/core/src/holidays.ts`）。

## 落地记录

（落地后按批次追加。）

---

## 追加：一期 R5–R7（S15–S17c）

> 本文件是对 `docs/specs/20261005-vt-borrowing.md` 的追加稿。设计各节插在「设计（一期）」§15 之后，编号 §16–§23；
> 决策从 D80 起；验收从 18 起。最前面一节列出已有段落要怎么改。
> **背景**：第 2 稿把新数据集（DATA-6）、Tushare（DATA-9）、持仓与持仓风险透视（DEC-6、DEC-7，与 ACC-9 共用风险模块）都放在二期、三期。
> Jim 看过后要求本轮就做，所以追加三批：R5 点时事件数据（S15、S15b）、R6 Tushare 可选数据源（S16、S16b、S16c）、
> R7 持仓与持仓风险透视（S17、S17b、S17c）。三批都排在 R4（S12–S14）之后，因为它们要用 S12 的数据源接口、
> S13 的软步骤留痕与数据问题、S03 的行级来源与属性快照、S07 的个股证据、S08 的账本、S14 的新基准。

## 〇、需要同步改的已有段落

**头部「范围」**

- 「做（一期，14 个切片分 4 批上线……）」改为「做（一期，22 个切片分 7 批上线……）」，列表末尾加：
  「点时事件数据（两融明细、股东户数、限售解禁、大宗交易）与 7 个事件因子；Tushare 可选数据源（有 token 的实例多一个不封 IP 的 A 股日线备用源、
  官方交易日历、2018 年以前沪市的真实 ST、官方停牌、交易所涨跌停价、财报实际披露日）；持仓记录、持仓风险透视、压力回放、情景对照与持仓证据。」
- 「**本轮给用户的新数据只有两样**」整段（含「这是有意的取舍，请 Jim 确认」）替换为：

  > **本轮给用户的新数据**：中证 500 / 1000 / 红利全收益基准与港股通股票池（S14）；A 股点时事件数据（S15、S15b）：
  > 融资融券明细、股东户数、限售解禁、大宗交易，都按「公布后才可得」的日期入库，成为 7 个新因子（可以当筛选条件、排序项），
  > 出现在个股证据里，对话里有专门的「两融与筹码」卡；新列按列补算、不重算已有因子，旧回测、旧跟踪逐字节不变（D83）。
  > 有 Tushare token 的实例还可以打开 S16–S16c：它不带来新的数据集，只把 Ivan 已有的几处近似换成更准的事实；没有 token 时行为逐字节不变。
  > 用户自己的持仓（S17–S17c）是新的产品面：只做记录、估值与描述性的风险透视，不进回测、不给买卖建议。
  > 取舍记录：第 2 稿把这些放在二期，是因为要先有数据源接口、健康检查与试错计数。接口（S12）与软步骤留痕（S13）本轮已经有了；
  > 健康检查只做最小版（每个事件报表一条金丝雀，D82），完整版仍在二期。Jim 确认本轮做。已公告未除息的分红预案（接口未核实）仍在二期。

**「设计原则怎么守」表**

- 第 2 行把「持仓、交割单这类『用户自己的判断』放到二期以后，且只做描述性统计」改为
  「持仓本轮只做记录、估值与描述性的风险透视（S17–S17c），交割单放二期以后，都不进回测；持仓相关的工具与卡片只陈述证据和风险，不说加减仓」。
- 第 3 行末尾加：「事件数据每行存可得日与规则（两融、大宗 T+1，户数按公告日，解禁按规则推算后以首次见到为准），撤下的记录软删除而不是物理删除，
  补算历史时当时知道的仍然算」。
- 第 4 行末尾加：「需要 token 的来源（Tushare）拉到的数据逐行记来源、落进行情仓；运行卡写明用了哪些，复核与重跑只读行情仓、不需要 token；
  每次持仓风险透视都留成不可改的快照并记账」。
- 第 6 行末尾加：「Tushare 是可选的，token 为空就完全不发请求」。

**「路线图」表**

在「一期 R4 · S14」之后插入：

| 阶段 | 内容 | 来源 | 为什么在这一期 |
|---|---|---|---|
| 一期 R5 · S15 | 点时事件数据集：两融、股东户数、限售解禁、大宗交易；通用可续跑的点时数据集运行器（走 S12 的接口，与具体来源无关）；每个报表一条最小金丝雀（失败就关）；夜间软步骤与后台分段回填 | DATA-6（数据部分）+ DATA-4（最小版） | 最想要的新数据；S12 的接口、S13 的软步骤留痕与数据问题都已就位 |
| 一期 R5 · S15b | 事件因子（注册表第 3 版，核心与事件分版本）、按列按年补算不重算旧因子、补完前提前拒绝、个股证据第 2 版、「两融与筹码」卡与 `get_security_events` | DATA-6（因子部分） | 让新数据能回测、能解释，同时旧结果不变 |
| 一期 R6 · S16 | Tushare 可选数据源（一）：客户端与错误分类、能力状态、A 股日线备用（交易所前收口径 + 复权核对）、官方交易日历、运行的 token 来源、管理页与探针 | DATA-9（部分） | 接一家新源只是「再加一个实现」；没有 token 的实例不受影响 |
| 一期 R6 · S16b | Tushare（二）：2018 年以前沪市 ST、财报实际披露日、回填与清除脚本 | DATA-9（部分） | 把两处已知近似换成事实 |
| 一期 R6 · S16c | Tushare（三）：官方停牌进完整性闸门、交易所涨跌停价进引擎（规则表第 3 档，只对新运行）与日线体检、规则表夜间核对 | DATA-9（部分） | 唯一改引擎的部分，单独成片，挂在记录在案的字段上 |
| 一期 R7 · S17 | 持仓：账户、只追加的持仓快照、券商 CSV 导入、点时估值、删除与清除、`propose_holdings` / `get_portfolio`、持仓页 | DEC-6 | 有了用户自己的持仓，参考才能「针对你这本账」 |
| 一期 R7 · S17b | 持仓风险透视：纯函数风险模块（与以后的回测风险透视共用）、上限与超限、实测断言的压力回放、透视快照与账本、`get_portfolio_xray` | DEC-7 + ACC-9 的计算部分 | 描述性、可手算、可回溯 |
| 一期 R7 · S17c | 情景对照、持仓证据卡（沿用个股证据）、按现在的数据重算、之后怎么样、导出、`get_holding_evidence`、看板卡片 | DEC-7 余下 | 回看与解释 |

二期、三期表格相应修改：

- 「数据源健康检查（金丝雀），每个东财报表一条」改为「数据源健康检查完整版：独立健康表、定时检查全部报表、按健康度调整回退链（S15 已有事件报表的最小金丝雀）」。
- 「点时事件数据：融资融券、股东户数、限售解禁（再到大宗交易、已公告分红）」改为「已公告未除息股息率（分红预案，接口先实测）」。
- 「行业、每手股数的点时因子（……与 DATA-6 合并一次注册表升级）」改为「行业、每手股数的点时因子（用 S15b 的按列补算，不全量重算）」。
- 「持仓录入与券商 CSV 导入 → 持仓风险透视与压力回放（……）→ 规则提醒与复核清单」改为「规则提醒与复核清单（DEC-8）、回测页风险透视分页（ACC-9 的界面部分，直接用 S17b 的 `risk/` 模块）」。
- 三期「Tushare 可选接口（届时再给数据源接口加 token 与显式来源）」改为「Tushare 余下能力：分红预案、限售解禁备用（实现 S15 的事件接口即可）、业绩预告 / 快报、
  三大表首发数值、港股退市股、Shibor / HIBOR 备用（跟着 DATA-6 余下、DATA-12、DATA-5 各自的数据集一起做）」。

**「设计（一期）」开头一段**

「分 4 批上线（D76）：R1 = S01–S03，R2 = S04–S08，R3 = S09–S11，R4 = S12–S14」改为
「分 7 批上线（D76、D98）：R1 = S01–S03，R2 = S04–S08，R3 = S09–S11，R4 = S12–S14，R5 = S15–S15b，R6 = S16–S16c，R7 = S17–S17c」。
实现顺序就是编号顺序：S15 → S15b → S16 → S16b → S16c → S17 → S17b → S17c。

**已有节里的几处**

- §13（S12）「token、显式专用来源、本地导入这些三期才用的成员不在本轮的接口里，接 Tushare 时再加」改为
  「token 成员见 §18（S16）；事件数据能力见 §16（S15）；本地导入仍在三期」。D72 末句同样改为「token 成员在 S16 随 Tushare 加入（D86），本地导入仍在三期」。
- §8（S07）「因子项按 `FactorDef.markets` 过滤，外加为真的 flag_*」明确为「外加 `group === 'flag'` 且为真的因子」（不按键名前缀，D97）。
- §9（S08）账本条目类型加 `holdings`、`holdings_purge`、`xray`，主体类型加 `holding_account`、`portfolio`；`verifyChain` 认「内容已按用户要求清除」（D91）。
  计划快照版次原因的数据维度加 `plan_date_basis`（官方日历打开后同一晚重跑，计划日依据变了算数据修订，不算程序问题）。
- `packages/core/src/factors.ts` 文件头注释改为：「改**核心因子**口径时把 `FACTOR_CORE_VERSION` 加 1（夜间全量重算）；改**事件因子**口径时把
  `EVENT_FACTOR_VERSION` 加 1（只按列补算事件列）；`FACTOR_REGISTRY_VERSION` 只是记录。新因子只能加在数组末尾」。

**验收 14、16**

- 验收 14 末尾加：「唯一例外：风险透视工具把它自己的输出追加为审计记录（`xray` 条目，D95），不改变任何用户状态」。
- 验收 16 末尾加：「R5 之后回滚到 R4 之前先运行 `scripts/migrate.sh --down 4`（删掉 7 个事件因子列）；R6、R7 的迁移只加表、加列，旧代码直接可用」。

---

### 16. 点时事件数据集：两融、股东户数、限售解禁、大宗交易（S15）

**实测**（2026-10-05 北京时间 17:29–17:36，国庆休市期间，经本机代理，`datacenter-web.eastmoney.com/api/data/v1/get` 共 12 次 GET、间隔 ≥ 1.5 秒）：

| 报表 | 实测到的 | 结论 |
|---|---|---|
| `RPTA_WEB_RZRQ_GGMX` 两融明细 | 2026-09-29 全市场 4,454 行（含 ETF），`pageSize=5000` 只回 500 行、`pages=9`；2013-01-04 只有 288 行；2026-09-30 只有 2,001 行**沪市**数据，深市还没有 | 单页上限 500；**深市 T 日数据要到下一个交易日才有**，可得日必须是 T+1，并且要按交易所检查是否到齐 |
| 同上，字段 | `RZYE` 融资余额（元）、`RZMRE` 融资买入额（元）、`RZCHE` 融资偿还额（元）、`RQYE` 融券余额（元）、`RQYL` 融券余量（股）、`SZ` 流通市值（元，ETF 为空）、`RZYEZB` 融资余额占流通市值（%）、`SECUCODE` 如 `600519.SH` | 600519：17,233,521,533 ÷ 1,573,377,704,650 × 100 = 1.09532 = `RZYEZB` |
| `RPT_HOLDERNUM_DET` 股东户数 | 全表 441,010 行，最早公告日 2013-01-19；`HOLD_NOTICE_DATE` 是公告日、`END_DATE` 是截至日（截至 2026-06-30、公告 2026-08-01）；`PRE_END_DATE` 可能不是季末（如 2026-05-29）；`HOLDER_NUM_RATIO` 是 %；多列排序可用 | 可得日 = 公告日，绝不用截至日；环比只拿季末对季末 |
| `RPT_LIFT_STAGE` 限售解禁 | 2013 年起 28,468 行；股数列是万股；`FREE_RATIO` 是**比例**，= 本次解禁 ÷（`FREE_SHARES` − 本次解禁）；`LIFT_MARKET_CAP`（万元）= 解禁股数 × `NEW`（最新价）；有 `B20_ADJCHRATE` / `A20_ADJCHRATE`；没有公告日列，`EUTIME` 是更新时间 | 市值类、最新价、事后涨跌列一律禁用；历史可得日只能按规则推算，每晚首次见到后变准 |
| `RPT_DATA_BLOCKTRADE` 大宗交易 | 2013 年起 649,801 行；`PREMIUM_RATIO` 是比例，= 成交价 ÷ 当日收盘 − 1（11.84 ÷ 13.13 − 1 = −0.09825）；`DEAL_VOLUME` 股、`DEAL_AMT` 元；`CHANGE_RATE_1DAYS / 5DAYS / 10DAYS / 20DAYS` 是事后涨跌 | 事后涨跌列禁用；同一天同一只可以多笔 |
| 字段变了的样子 | 请求不存在的列：`{"success":false,"code":9501,"message":"NO_SUCH_COLUMN_X返回字段不存在"}`；空结果仍是 9201 | 9501 或「字段不存在」= 结构变了 |

**四个数据集**（D80，都只有 A 股；按事件日期窗口整市场拉，不逐只拉）：

| 数据集 | 表 | 键 | 可得日 `avail_date` | 写法 | 回填分块 |
|---|---|---|---|---|---|
| 两融明细 | `margin_daily` | （代码, 日期） | 日期之后的下一个交易日 | 按块整窗替换 | 每个交易日一块 |
| 股东户数 | `holder_counts` | （代码, 截至日, 公告日） | **公告日**，绝不用截至日 | 合并：新键追加，消失的键软删除 | 按公告月 |
| 限售解禁 | `lockups` | （代码, 解禁日, 类型） | min(规则日, 首次见到日)；规则：类型以「首发」开头且上市日 ≤ 解禁日 → 上市日（`ipo_terms`）；其他 → 解禁日前 `LOCKUP_NOTICE_LEAD_TD` 个交易日（`notice_bound`，默认 3，上线前按公告抽样实测定，见下） | 合并，同上 | 按解禁年（含明年） |
| 大宗交易 | `block_trades` | （代码, 成交日, 序号） | 成交日之后的下一个交易日 | 按块整窗替换 | 按成交月 |

- 单位在入库时统一：股数（万股 × 1e4）、金额（元）、比例存小数（`ratio_float`、`premium`），只有东财的 `rzyezb` 原样存 %（留作核对）。
  不在证券表里的代码（ETF、基金）丢弃。下一个交易日超出交易日历时用 S08 的休市日表；表里没有那一年就按工作日数，规则记成 `notice_bound:weekday`。
- **撤下的记录软删除**（D80）：股东户数与解禁按「合并」写，窗口里本来有、这次没取到的行设 `gone_from = 今天`、记数据问题 `row_removed`（附原行），
  不物理删除；补算因子与证据只看 `avail_date ≤ d 且 (gone_from 为空 或 gone_from > d)` 的行。所以一条后来被取消的解禁，在它取消之前的日子仍然算「已知」，
  补算历史时不会带上「后来取消了」这个事后信息。同一（代码, 截至日）出现新公告日时追加一行并记 `avail_moved`。
  后来又出现的行把 `gone_from` 清空并记 `row_returned`。两融与大宗交易是 T+1 的事实，东财偶尔更正就按块整窗替换。
- **`LOCKUP_NOTICE_LEAD_TD` 先实测再定**：上线前在巨潮资讯抽约 50 条非首发解禁的提示性公告，记下公告日到解禁日的交易日数分布，写进
  `docs/probe-report.md`。少于 3 个交易日的占比明显（≥ 5%）时，把常量改成实测的第 5 百分位（最少 1），`event_avail_approx` 提示照常保留。

**表结构**（行情仓第 4 版，`SCHEMA_VERSION` 3 → 4，只加表，轻量升级，不进维护状态）：

```sql
CREATE TABLE IF NOT EXISTS margin_daily (code VARCHAR NOT NULL, date DATE NOT NULL, avail_date DATE NOT NULL,
  rzye DOUBLE, rzmre DOUBLE, rzche DOUBLE, rqye DOUBLE, rqyl DOUBLE, float_mcap DOUBLE, rzyezb DOUBLE,
  src VARCHAR, ver INTEGER, batch INTEGER);
CREATE TABLE IF NOT EXISTS holder_counts (code VARCHAR NOT NULL, end_date DATE NOT NULL, notice_date DATE NOT NULL,
  avail_date DATE NOT NULL, holder_num DOUBLE, pre_holder_num DOUBLE, pre_end_date DATE,
  first_seen DATE NOT NULL, last_seen DATE NOT NULL, gone_from DATE, src VARCHAR, ver INTEGER, batch INTEGER);
CREATE TABLE IF NOT EXISTS lockups (code VARCHAR NOT NULL, free_date DATE NOT NULL, type VARCHAR NOT NULL,
  unlock_shares DOUBLE, able_shares DOUBLE, float_after DOUBLE, ratio_float DOUBLE, ratio_total DOUBLE,
  avail_date DATE NOT NULL, avail_rule VARCHAR NOT NULL, first_seen DATE NOT NULL, last_seen DATE NOT NULL, gone_from DATE,
  src VARCHAR, ver INTEGER, batch INTEGER);
CREATE TABLE IF NOT EXISTS block_trades (code VARCHAR NOT NULL, trade_date DATE NOT NULL, seq INTEGER NOT NULL,
  avail_date DATE NOT NULL, deal_price DOUBLE, close_price DOUBLE, premium DOUBLE, deal_volume DOUBLE, deal_amount DOUBLE,
  buyer_inst BOOLEAN, seller_inst BOOLEAN, src VARCHAR, ver INTEGER, batch INTEGER);
CREATE TABLE IF NOT EXISTS pit_sync (dataset VARCHAR PRIMARY KEY, backfill_from DATE, covered_from DATE,
  window_through DATE, synced_at DATE, nightly_since DATE, last_ok_at TIMESTAMP, last_status VARCHAR,
  last_detail VARCHAR, canary VARCHAR);
CREATE SEQUENCE IF NOT EXISTS pit_batch_seq START 1;
CREATE TABLE IF NOT EXISTS pit_batches (id INTEGER PRIMARY KEY, kind VARCHAR NOT NULL /* nightly|backfill|check|event_cols */,
  datasets VARCHAR, data_version INTEGER, started_at TIMESTAMP, finished_at TIMESTAMP, status VARCHAR,
  chunks INTEGER, rows INTEGER, requests INTEGER, note VARCHAR);
```

- 每行带 `src`（本轮只有 `em`）、`ver`（写它的那次**夜间数据版本**；后台回填写的行为空）与 `batch`（`pit_batches.id`，永远有值）。
- `pit_sync` 的四个日期各管一件事：`backfill_from` 回填从哪天起；`covered_from` 回填**全部完成**后才设为 `backfill_from`（之后不再因为个别缺口移动）；
  `window_through` 数据窗口到哪天（两融、大宗是最后一个完整的数据日；解禁、户数不用）；`synced_at` 最近一次成功同步（回填或夜间）是哪天。
  过期判断（S15b）用 `window_through`（两融、大宗）或 `synced_at`（解禁、户数），所以回填把解禁窗口取到明年年底，也不会让夜间连续失败时还说「没有已知解禁」。

**后台写入不开数据版本**（D81，修正评审阻断项）：S03 的 `committedAsOf` 取最新一个 ok 版本，`as_of` = 因子表的最大日期；S13 读「近 20 个版本」算连续失败晚数和
无成交中位数。如果每段回填都提交一个 ok 版本，一个写了一半因子的失败夜之后，回填段会把那些因子「提交」出去，近 20 个版本也会被回填段挤满。所以：

- **夜间**的四个事件步骤在 `daily()` 里跑，行盖当晚的数据版本号（`ver = ctx.ver`），和别的软步骤一样。
- **后台回填**（`events` 任务）和 S15b 的**事件列补算**（`event_cols` 任务）**不开数据版本**：每段写一条 `pit_batches`，行上盖 `batch`。
  `latestDataVersion`、`committedAsOf`、S13 的连续失败晚数与无成交中位数都不受影响（有测试：一晚因子写了一半后失败，接着跑一段回填，`committedAsOf` 仍是前一天）。
- 管理页与 `/internal/data-status` 从 `pit_batches` 读进度；S12 的 `data_versions.sources` 只在夜间记事件数据集。

**数据源接口**（D81，与来源无关）：S12 的 `Capability` 加 `events`。

```ts
// packages/core/src/pit.ts（纯，web 可用）
export type PitDatasetId = 'margin' | 'holders' | 'lockups' | 'blocks';
// packages/data/src/sources/types.ts
export interface PitChunk { id: string; from: DateStr; to: DateStr }
export interface PitFetchResult<R> { rows: R[]; rawCount: number; requests: number;
  byExchange?: { sh: number; sz: number } }            // 两融到齐检查用，统计的是原始行（含 ETF）
export interface CanaryResult { status: 'ok' | 'empty' | 'schema_drift' | 'unit_drift' | 'blocked' | 'error';
  source: SourceId; at: string; detail: string }       // detail 不含 URL 与查询串
export interface PitFetcher<R> {
  fetchChunk(sctx: SourceCtx, chunk: PitChunk): Promise<PitFetchResult<R>>;
  canary(sctx: SourceCtx, today: DateStr, prevTd: DateStr): Promise<CanaryResult>;
}
export interface SourceAdapter { /* S12 的成员 */ events?: Partial<Record<PitDatasetId, PitFetcher<unknown>>> }
```

`R` 是规范化后的行（`MarginRow`、`HolderRow`、`LockupRow`、`BlockRow`，单位已统一），运行器只认这些，不认东财的报表、列名与过滤串。
默认链每个数据集只有 `[eastmoney]`；`IVAN_CHAIN_EVENTS_MARGIN` 这类变量照 S12 的规则只能重排。三期接 Tushare 的解禁时，实现同名 fetcher 追加到链里即可。

**东财实现**（`sources/adapters/eastmoney-events.ts`，报表名、列清单、禁用列、过滤串、翻页与单位自检都在这里）：

| 数据集 | 只请求这些列 | 禁用列 | 过滤 | 排序（完整、唯一） |
|---|---|---|---|---|
| 两融 | `DATE,SECUCODE,RZYE,RZMRE,RZCHE,RQYE,RQYL,SZ,RZYEZB` | — | `(DATE='{d}')` | `SECUCODE` |
| 户数 | `SECUCODE,END_DATE,HOLD_NOTICE_DATE,HOLDER_NUM,PRE_HOLDER_NUM,PRE_END_DATE,HOLDER_NUM_RATIO` | `CLOSE_PRICE,TOTAL_MARKET_CAP,AVG_MARKET_CAP,INTERVAL_CHRATE` | 公告日窗口 | `HOLD_NOTICE_DATE,SECUCODE,END_DATE` |
| 解禁 | `SECUCODE,FREE_DATE,FREE_SHARES_TYPE,CURRENT_FREE_SHARES,ABLE_FREE_SHARES,FREE_SHARES,FREE_RATIO,TOTAL_RATIO` | `LIFT_MARKET_CAP,ALIFT_MARKET_CAP,NEW,B20_ADJCHRATE,A20_ADJCHRATE` | 解禁日窗口 | `FREE_DATE,SECUCODE,FREE_SHARES_TYPE` |
| 大宗 | `SECUCODE,TRADE_DATE,DEAL_PRICE,CLOSE_PRICE,PREMIUM_RATIO,DEAL_VOLUME,DEAL_AMT,BUYER_NAME,SELLER_NAME` | `CHANGE_RATE_1DAYS/5DAYS/10DAYS/20DAYS` | 成交日窗口 | `TRADE_DATE,SECUCODE,DEAL_AMT,DEAL_PRICE,DEAL_VOLUME,BUYER_NAME,SELLER_NAME` |

- 另有全局禁用正则 `^(CHANGE_RATE_\d+DAYS|[AB]\d+_ADJCHRATE|A?LIFT_MARKET_CAP|NEW)$`，列清单不能是 `ALL`，模块加载时断言（`assertColumns`，东财实现的单测守着）。
- `emQueryPaged` 翻完所有页（单页 500），核对「拿到的行数 = 报表给的 count」，并检查同一块里没有完全相同的两行（排序不唯一时翻页会重一行、丢一行而总数照样对得上）；
  任一不满足就重取这一块一次，还不满足就这一块失败。9501 或「字段不存在」或请求过的键缺失 → `SchemaDriftError`。
- 估算用的计数请求也带同一份列清单（`emCountCols`），所以「任何请求都不含禁用列、不用 ALL」的测试覆盖全部请求。

**运行器**（`etl/pit-runner.ts`）`syncPitDataset(ctx, id, {mode: 'nightly' | 'backfill' | 'check', from?, to?, budgetMs?, force?})`：

1. **金丝雀**（DATA-4 的最小版，D82）：链上第一个金丝雀是 `ok` / `empty` 的来源负责这一次。东财的金丝雀每个报表一次请求、取 5 行样本（用第一行字段齐全的核对单位，都缺字段只记「没能核对」、不算单位变化；实现备注）、
   用和正式抓取**完全相同的列常量**，固定样本（两融、户数用 600519.SH，解禁、大宗用最近的窗口），判定 `ok` / `empty`（9201，只有大宗与解禁可以为空）/
   `schema_drift` / `unit_drift`（两融 |融资余额 ÷ 流通市值 × 100 − `RZYEZB`| > 1%；大宗 |成交价 ÷ 收盘 − 1 − `PREMIUM_RATIO`| > 0.001；
   解禁 |本次 ÷（`FREE_SHARES` − 本次）− `FREE_RATIO`| > 1%；户数 |(本期 ÷ 上期 − 1) × 100 − `HOLDER_NUM_RATIO`| > 0.01）/ `blocked` / `error`。
   没有一家通过 → **这个数据集今晚不删不写**，`pit_sync.last_status = canary_failed`，`last_detail`「东财『两融明细』接口字段变了：…，今晚没更新」，
   因子按过期规则变空（S15b）。
2. **分块**：回填与 `--force` 以外，跳过 `etl_progress` 里任务 `pit:<id>` 已 `done` 的块；**夜间与周检窗口从不写这些进度键**（它们只用于回填的完成判断）。
   超过 `budgetMs` 就在下一块之前停下。
3. **每块**：`fetchChunk`（规范化行 + 原始计数）→ 两融到齐检查：沪、深两市原始行都 > 0，且总数 ≥ 上一个完整交易日原始行数的 80%，否则记 `partial`
   （写入但不算完成，之后的夜里重取；20 个交易日后仍不全记数据问题 `partial_exchange`）→ 算可得日 → **写入**：先把行追加进连接内的临时表，
   再用**一次** `wh.run` 执行一整段 `BEGIN TRANSACTION; …; COMMIT;`（整窗替换：删窗口再从临时表插入；合并：更新已有键的数值与 `last_seen`、插入新键、
   给消失的键设 `gone_from`），所以同一连接上的读请求不会看到删了还没插的空窗口（Warehouse 只有一个连接，显式事务挡不住同连接的读，只能靠一次调用完成）。
   → `markDone` / `markPartial`（新 helper，detail `{rows, sh, sz}`）/ `markFailed`（只回填）。
4. **`pit_sync`**：`window_through` = 最后一个 `done` 的数据日（两融、大宗）；`synced_at` = 今天（本次至少一块成功时）；回填全部块 `done` 或 `partial` 后
   `covered_from = backfill_from`（失败的块要重跑成功才算完成，个别 `partial` 的两融日只记数据问题，不移动覆盖起点）；首次成功的夜间写 `nightly_since`。
5. 夜间时 `ctx.ledger?.recordDataset(id, {servedBy, requests, rows})`，进 S12 的 `data_versions.sources`。

**夜间、周检与回填**：

- **夜间**（A 股交易日，S13 的软步骤，在财报之后、因子之前）：两融取前两个交易日 + 近 20 个交易日里 `partial` 的日子；户数取公告日近 14 天；
  解禁取解禁日 [今天 − 7, 今天 + 180]；大宗取成交日近 7 天（T 当晚可能不全，`window_through` 只记到前一个交易日，第二晚再取）。
  加 4 次金丝雀，每晚约 30–40 次请求、半分钟左右。失败不让整晚失败，结果进 `completeness.soft`（步骤名「两融明细」等）与 `completeness.datasets`，
  连续 3 晚失败照 S13 出管理页横幅。
- **周检**（`weeklyCheck`，已有的 `check` 任务）加一次更宽的补扫：户数公告日近 120 天、大宗近 30 天、解禁 [今天 − 30, 今天 + 365]。东财晚入库的行由此补上，
  新找到的行数记进那次检查版本的 `completeness.datasets[id].lateRows`。
- **回填请求数**（东财数据中心节奏：同域名两次请求至少隔 100 毫秒、加抖动，块内串行翻页、块与块串行）：

| 数据集 | 历史行数（2013 年起） | 回填请求数 | 夜间请求数 |
|---|---|---|---|
| 两融明细 | 约 3,330 个交易日，288 → 4,454 行 / 日，约 600 万行（丢掉 ETF 后约 500 万） | 约 1.4–1.6 万 | 4–27 |
| 股东户数 | 441,010 | 约 1,050 | 1–13 |
| 限售解禁 | 28,468 | 约 75 | 2–3 |
| 大宗交易 | 649,801 | 约 1,470 | 1–2 |
| 合计 | | **约 1.7–1.9 万** | 约 30–40（含 4 次金丝雀） |

  按节奏下限约 40 分钟；按服务器直连约 0.6 秒 / 次估约 3 小时。`pnpm ivan events --estimate` 只用 4 次计数请求，按每块的分页上下限给出区间。
- **回填不停 worker**：管理页「补齐历史数据」（管理员）→ worker 排一个 etl 道的 `events` 任务，每段最多 10 分钟（`EVENTS_JOB_BUDGET_MS`），
  没做完就 1 分钟后再排下一段；北京时间 16:30–21:00 不开新段（把夜间更新让出来）。它只写事件表，不算「写行情仓的任务」（回测不读事件表；S15b 的
  补算才算），回测照常跑。已有回填在排队或运行时，第二次点击返回 409。全部做完自动排 S15b 的补算。
  命令行 `pnpm ivan events --market A [--datasets margin,holders,lockups,blocks] [--since 2013-01-01] [--estimate] [--force]` 直接跑（要先停 worker），
  全量回填（`BACKFILL_STEPS`）在 factors 之前加 `events` 一步。

**管理页**：数据卡加「两融与筹码数据」：每个数据集一行「两融明细：自 2013-01-04 · 数据到 2026-09-29 · 接口 健康」（Badge：健康 / 字段变了 / 单位异常 /
被风控 / 出错，ⓘ 写金丝雀详情与时间），回填进行中显示「后台补齐中：两融 812 / 3,330 天」；按钮「补齐历史数据」打开确认框，写明估算的请求数与时长、
「后台分段执行，每段最多 10 分钟，16:30–21:00 暂停，不影响回测与夜间更新」。数据质量卡的规则名加：`partial_exchange` 只拿到一个交易所的两融、
`avail_moved` 公告日变了、`row_removed` 记录被撤下、`row_returned` 撤下的记录又出现了。

**实现备注（S15）**：

- 取数台账 `data_versions.sources` 升到第 2 版（加 `datasets`，夜间每个事件数据集一条 `{servedBy, requests, rows}`），`lastFetchSources` 两版都认。
- 两融每天到齐与否另记在进度任务 `pit_days:margin`（夜间、周检、回填都写，detail `{rows, sh, sz}`），夜间重取「近 20 个交易日里 partial 的日子」读它；
  回填完成判断用的 `pit:<id>` 键仍只有回填写。20 个交易日后仍没到齐的记一次 `partial_exchange`（没有代码），状态改成 `stale_partial` 不再重取。
- 两个保护：一块一行都没取到、库里这个窗口却有行时不动（不当成「全部撤下」）；两融没到齐、而且比库里已有的行少时保留库里的（之后的夜里再取）。
- 合并写在同一段事务里用「删掉键相同的旧行 + 从临时表插入」实现「更新已有键」，首次见到的日子由临时表带过去；效果与 UPDATE 相同。
- `PitFetcher` 多一个可选的 `estimateRows(from, to)`（东财用带列清单的 `emCountCols`），估算因此也与来源无关。
- 个股证据第 1 版的「未解决的数据问题」只数 `dataset = 'bars'`：事件数据的撤下、公告日变动不改旧证据的值（S15 之前只有日线问题，旧校验值不变）。
- server 调 worker 时 409 原样转回（「已经有一个事件数据回填在排队或运行」），其余非 404 错误仍是 500。
- 重复行不再一律算翻页漂移：大宗可能真有几笔完全相同的成交（同价同量、同一卖方卖给同一个「机构专用」席位）。`emQueryPagedChecked`
  对不上时换一个单页行数（400）重取，页边界错开；两次都只是「行数对得上、但有完全相同的行」且两次拿到的行（多重集合）一模一样，
  就按真有重复记录写入（`seq` 按出现顺序区分），日志记一句；两次不一样、或行数对不上，仍是这一块失败。
- 覆盖起点按「从 `backfill_from` 到今天」的完整块清单判断：命令行带 `--to` 的有界回填做完了也不设 `covered_from`。
- 后台回填只有「每个要补的数据集都跑完、没有失败块、并设上了覆盖起点」才记「事件数据回填完成」（S15b 只在这里排补算）；
  金丝雀没过或中途接口字段变了的数据集另记「事件数据回填停下：…」，不重排、不算完成。
- 〇 里的 §8（S07 风险标记）、§9（账本条目类型）、`factors.ts` 文件头注释与验收 14、16 的追加留给 S15b / S17 各自同步；其余条目已改。
  （S15b 已同步 §8、`factors.ts` 文件头与验收 16；§9 与验收 14 留给 S17。）

### 17. 事件因子、按列补算、证据与对话（S15b）

**新因子**（注册表第 3 版，只加在末尾，全部只适用于 A 股，分组 `event`「两融与筹码」，D84）：

| 键 | 名称 | 单位 | 口径（决策日 d，只用 `avail_date ≤ d` 且未在 d 之前撤下的行） | 什么时候为空 |
|---|---|---|---|---|
| `margin_ratio` | 融资余额占流通市值 | % | 最近一条两融记录的 融资余额 ÷ 流通市值 × 100（同一行，T+1 可得） | 不是两融标的；最近一条早于 d 之前 5 个交易日；两融数据窗口早于 d 前 5 个交易日（同步失败） |
| `margin_chg_20d` | 融资余额 20 日变化 | % | 最近一条 ÷ 正好 20 个交易日前那条 − 1 | 同上；20 个交易日前没有记录 |
| `margin_eligible` | 两融标的 | 布尔 | 5 个交易日内有融资余额 > 0 的记录 | 两融覆盖起点后 7 天之前；两融同步失败超过 5 个交易日 |
| `holder_num_qoq` | 股东户数环比 | % | d 时已公告的**最新一个季末**户数 ÷ 上一季末户数 − 1（上一季末那条也必须在 d 时已公告） | 最新季末的公告超过 200 天；上一季末没有；户数同步早于 d 30 天以上 |
| `unlock_days` | 距下次解禁 | 天 | 已知的下一次解禁日 − d（自然日，只看 180 天内）；180 天内没有已知解禁记为 **181** | 解禁数据不可用（覆盖起点之前，或最近一次成功同步早于 d 3 天以上） |
| `unlock_ratio_30d` | 30 天内解禁占流通股 | % | 未来 30 个自然日内已知解禁的 `ratio_float` 之和 × 100；没有已知解禁为 **0** | 同上 |
| `block_premium_20d` | 大宗交易折溢价（20 日） | % | 近 20 个交易日（按可得日）大宗交易 成交价 ÷ 当日收盘 − 1，按成交额加权；负数是折价 | 没有大宗交易；大宗数据窗口没到 d 的前一个交易日 |

- 「没有」与「不知道」分开：`unlock_days > 90` 这样的筛选不会把绝大多数没有解禁的股票排除（它们是 181）；数据不可用时才为空。
- 两融标的叫 `margin_eligible` 不叫 `flag_margin`：S07 的证据按 `group === 'flag'` 收「风险标记」，这个因子不是风险标记，也避免按键名前缀误收（D97）。
- 每个因子的 `describe` 写明可得规则（例「融资数据按 T+1 可得：决策日用的是前一个交易日的两融数据」「按公告日可得，不是截至日」
  「180 天内没有已知解禁记为 181」「解禁的可得日在每晚同步开始之前是按规则推算的」）。

**注册表第 3 版不触发全量重算**（D83）：`FACTOR_REGISTRY_VERSION` 2 → 3 只是记录；新增 `FACTOR_CORE_VERSION = 2`（逐股计算与横截面那些因子，变了才全量重算；
行情仓里仍记在原来的 `factor_registry_version:<市场>`，所以回滚到 R4 的代码也不会触发重算）和 `EVENT_FACTOR_VERSION = 1`（事件因子口径）。
事件因子不在逐股计算里算，而是一条 SQL（`compute/event-factors.ts`），结果 `UPDATE` 回去：

- 交易日历编号（`row_number() OVER (ORDER BY date)`）；两融用 `ASOF` 连接取 `avail_date ≤ d` 的最近一条，同一窗口函数算 20 个交易日前那条（要求编号正好差 20）。
- **户数用「状态时间线」，不直接 ASOF**：只看季末行；对每只股票取所有变化点（各行的 `avail_date` 与 `gone_from`），在每个变化点 t 上找 t 时可见的季末行，
  每个季度取公告最早的一条，再取**截至日最大**的那个季度和它的上一季末（也要在 t 时可见），得到 (code, t) → 环比；决策日 ASOF 连接这条时间线。
  这样一季报先于年报公告（年报 4 月 29 日、一季报 4 月 25 日）时，4 月 30 日用的仍是一季报对年报，不会因为年报更晚可得就倒退回去（评审指出的问题）。
- 解禁、大宗用范围连接：解禁 `l.free_date ∈ (d, d + 180]`、`l.avail_date ≤ d`、`l.gone_from` 为空或 > d；大宗 `t.avail_date ≤ d` 且可得日在近 20 个交易日内。
- 「数据可用」的判断用 `pit_sync`：两融看 `window_through`，户数、解禁看 `synced_at`，大宗看 `window_through`，都和 `covered_from` 一起作为字面量拼进 SQL（先校验日期格式）。
- SQL 的列别名由 `EVENT_FACTOR_KEYS` 生成，有测试钉住二者一致。

**夜间与历史怎么填**：

- **夜间**：`computeFactors` 建好暂存表后、写回正式表之前，对暂存表跑一遍事件 SQL（近 15 天），所以事件列和别的因子一起换上；港股不跑。
  **它是软步骤**：出错（事件表缺失、512 MB 下内存不够、字面量异常）就把暂存表里这 15 天的事件列从正式表原样拷回来（今天的新行留空），
  记 `SoftOutcome {step: '事件因子', ok: false}`，整晚照常提交。过期规则与 `stale_events` 提示负责让用户看见。
- **历史**：新的 `event_cols` 任务（etl 道，**算**「写行情仓的任务」，排队与运行时回测暂停）每次只补一年：`UPDATE factors_daily … WHERE date` 在这一年，
  每年约 130 万行；`etl_progress` 记 `event_cols:v{EVENT_FACTOR_VERSION}:{签名}` 的年份，断点续跑；年与年之间隔 15 秒，让排队的回测先跑；
  北京时间 16:30–21:00 不开新的一年（顺延到 21:00）。**不开数据版本**，每段写一条 `pit_batches(kind = event_cols)`（D81）。
  签名 = `{EVENT_FACTOR_VERSION, 各数据集的 covered_from（按月）}` 的指纹；`covered_from` 只在回填完成时设一次（§16），所以个别缺口不会让签名来回变、触发 14 年重算。
  补完写 `meta event_factors:A = {v, sig, complete, batch}`。
- **什么时候排**：S15 的回填全部完成时；部署后发现签名或 `EVENT_FACTOR_VERSION` 变了时；`pnpm ivan event-cols --market A [--force]`。
  回填还没完成时不排（否则会按不完整的签名补一遍、完成后再补一遍）。
- 表尾加 7 列在约 1600 万行的 `factors_daily` 上做，按 D76 当成重迁移：`SCHEMA_VERSION` 4 → 5，worker 发现缺列进维护状态，
  横幅「行情仓需要升级到第 5 版（新增 7 个因子列），请运行 scripts/migrate.sh」。**回滚**：R4 的代码写因子时用 `INSERT INTO factors_daily SELECT <旧列>`，
  多出来的列会让它报错，所以回滚到 R4 之前先跑 `scripts/migrate.sh --down 4`（删掉这 7 列、版本号写回 4、清掉 `event_factors:A` 与 `event_cols:*` 进度；新表留着无害），写进 DEPLOY.md。

**旧结果怎么保持不变**：

1. 已有的因子一行都不重算（核心版本仍是 2），新列只加在表尾；不用新因子的策略，选股 SQL 文本逐字节不变（快照测试守着），
   所以选股结果、输入指纹不变：旧回测「复核数据」是「输入一致」，「完整重跑」逐笔一致；引擎没动，金标准不变。
2. 注册表版本只记进运行卡与数据版本，**不是漂移原因**：它的影响已经体现在选股结果里，输入指纹会如实反映。
3. 跟踪升级后第一晚重放 0 漂移；计划快照的内容与解释指纹（只含策略用到的因子与固定的一组常用因子）不变，不会加版次。
4. 个股证据加了「两融与筹码」组，证据从此带版本号（见下「证据版本」）；以前的校验值按第 1 版的条目重算复核，照样能通过。
5. 用到事件因子的新回测，运行卡多记 `data.events`：事件因子版本、签名、补算批次，与各数据集的 `covered_from`、`window_through`、`synced_at`。

**补完之前提前拒绝**（照 S14 的做法，在扣额度之前）：`/internal/data-status` 给出每个事件因子的 `{from, ready}`，
`from` = 覆盖起点 + 预热天数（`margin_ratio` / `margin_eligible` 7 天、`margin_chg_20d` 40 天、户数 200 天、解禁 0 天、大宗 40 天），
`ready` = 补算完成且签名、版本都对得上。策略用到事件因子而历史还没补完 →
400「两融与筹码类因子的历史还在补算（7/14 年），补完后才能回测；今天的选股可以先用」；起点早于 `from` →
400「因子『融资余额 20 日变化』从 2013-02-13 起才有数据，请把起点设在这之后」。`buildSimInput` 同样的检查对回测抛错，对跟踪只加提示 `event_coverage`（warn）。
新提示（只进 `reportHash`）：`stale_events`（warn）「『两融明细』已经 3 晚没更新成功，相关因子按过期规则为空，选股可能变少」；
`event_avail_approx`（info，用到解禁因子且起点早于 `nightly_since`）「解禁数据在 {日期} 之前按规则推算可得日：首发限售按上市日、
其他类型按解禁前 {n} 个交易日，可能少算提前已知的解禁」。

**证据版本**（D97，S15b 起，S16、S17c 沿用）：S07 的校验值只是 `sha256Canonical(items)`，不记它是按哪套条目、哪些因子、哪些选项生成的；
三个追加切片都要往证据里加东西，所以统一成：

- `SecurityDossier` 加 `evidenceVersion`、`factorKeys`、`options`（S17c 的 `trend`、`financialPeriods`、`peerPct`）。第 2 版起
  `hash = sha256Canonical({evidenceVersion, factorKeys, options, items})`；第 1 版保持 `sha256Canonical(items)`（旧值照样能复核）。
- 版本：1 = S07 的条目；2 = S15b 加「两融与筹码」组；3 = S16b 的 ST 档位 `sh_tushare`（早年沪市按 Tushare 简称历史）；4 = S16c 加「决策日收盘涨停 / 跌停（交易所价）」与停牌天数的来源。
  新生成的证据用当前版本；`securityDossier(..., {version})` 能按任一旧版本的条目集合重新生成。
- 复核接口 `POST /internal/dossier/verify {code, asOf, hash, evidenceVersion?, factorKeys?, options?}`：给了版本就按那一版；没给（S07 时代的旧值）就先按第 1 版、
  再按当前版本试，返回 `{same, matchedVersion, changed}`。
- 「风险标记」一律按 `group === 'flag'` 收，有单测（新加的 `margin_eligible` 不会混进第 1 版的条目）。

**证据、对话与界面**（D85）：

- 个股证据第 2 版（A 股）加一组「两融与筹码」：7 个因子值（引用 `factors_daily`）；最近一条两融（融资余额、数据日、可得日，引用 `margin_daily`）；
  最近一期户数（截至日、公告日）；下一次已知解禁（日期、类型、股数、可得日依据：上市时已知 / 按解禁前 n 个交易日的提示性公告推算 / {日期} 首次记录）；
  近 20 个交易日大宗交易（笔数、成交额、加权折溢价）。每项的 `availDate ≤ 决策日`，引用表、键、`src`、`ver`、`batch`。数据集连续 3 晚失败时提示 `event_stale`。
- 新只读工具 `get_security_events {query, asOf?, datasets?}`（计入 `analyses`，只看 asOf 当时可得且未撤下的行）→「两融与筹码」卡：
  两融近 60 个交易日的融资余额迷你折线与最新一行；股东户数最近 8 期（截至日 / 公告日 / 户数 / 环比）；asOf 时已知的 180 天内解禁
  （日期 / 类型 / 股数 / 占流通股 / 可得日依据 Tag）；近 20 个交易日大宗交易（日期 / 成交价 / 折溢价 / 成交额 / 买方是否机构）。
  港股返回「两融、股东户数、解禁、大宗交易目前只有 A 股」。个股证据弹窗加分页「两融与筹码明细」渲染同一张卡（按决策日）。
- 策略编辑器的因子下拉加分组「两融与筹码」，历史没补完的因子带「补算中」并禁用，否则后缀「自 2013-02-13」；`list_factors` 带上 `dataset`、`from`、`ready`。
  提示词：「两融与筹码类因子只适用于 A 股，按公布后可得的日期算（两融与大宗 T+1、户数按公告日、解禁按规则推算）；回测起点不能早于它们的数据起点；
  个股的融资余额、户数、解禁、大宗 → get_security_events；为什么那天选它 → get_security_evidence。股东户数可以照抄整数，也可以写成『x.x 万户』」。
- 数字核对（S09）加「户」为计数单位，`holderNum` 这类键归为计数；**带「万 / 亿」的计数**按写出的精度核对：写成 x 万（d 位小数）时，
  |x × 10⁴ − n| ≤ 0.5 × 10^(4−d) 才算对上（「4.8 万户」对 48,212 成立，对 48,600 不成立）。`GROUNDING_VERSION` 1 → 2。
- 管理页数据卡加一行「事件因子：补算中（2019 / 2026）」或「已补算（第 1 版）」。新图标概念「筹码」= Phosphor `UsersThree`，写进设计系统 §7；
  「两融与筹码」卡写进 §8。

**实现备注（S15b）**：

- 事件 SQL 的 `from` 用各数据集的 `covered_from`（S15 回填全部完成后才有）：回填没完成时事件因子全部为空；回填完成、按年补算还没完时，
  夜间的近 15 天照常有值（「今天的选股可以先用」指的是这段时间）。`syncedAt` / `windowThrough` 为空时那个数据集当作不可用。
- 户数时间线的变化点取「[$from, $to] 里的变化点 + 每只股票 $from 之前最后一个变化点」，和「$from − 400 天起 + 之前最后一个」结果相同、扫的行更少。
- 夜间填充在 `computeFactors` 的写库段里做（A 股，暂存表并入别的股票、删正式表之前），按自然年分段，所以核心版本变了要全量重算时也是一年一段；
  出错时把这段日期的事件列从正式表拷回来，`SoftOutcome {step: 'event_factors'}`（`SOFT_STEP_LABEL`「事件因子」），整晚照常提交。
- 证据第 2 版：普通因子项不再收事件因子（统一放进「两融与筹码」组，键唯一）；`factorKeys` 记的是按市场过滤、去重后的普通因子集；
  `options` 这一版只认 `{}`。大宗一项拆成 `blocks.20d.count / amount / premium` 三项。复核没对上、带了旧条目时，和条目最接近的那一版逐项比。
- `get_security_events` 的模型摘要里百分数的键都以 `Pct` 结尾（`marginRatioPct`、`marginChg20dPct`、`premium20dPct`、`qoqPct`、`ratioFloatPct`），
  按 S09 的规则归为百分点，否则对的回复会被数字核对误报；20 日变化在摘要里按「第 21 条之前那条」算并写出 `comparedWith`。
  港股在 server 端直接回「只有 A 股」、不扣额度。数字核对第 2 版同时把「万股」「亿股」也当计数单位（裸「股」不算：「每 10 股派 3 元」
  里的整数在证据里没有，按第 1 版当裸整数），「折价」「减少」「回落」「缩水」「少了」算说清了方向。「证据为正、文字却写了负号」这一反向的符号检查没做。
- 回测前的拒绝在补算没开始（S15 回填都没完成、`totalYears = 0`）时写「两融与筹码类因子的历史数据还在补齐，补完后才能回测；今天的选股可以先用」。
- 编辑器里 worker 不在（不知道 `ready`）时事件因子不禁用、不加后缀，由提交时的检查拦。
- `committedAsOf` / `latestDataVersion` 挪到 `query/versions.ts`（`query/backtest.ts` 原样再导出），让 `etl/event-columns.ts` 引用它而不和回测模块互相引用。
- 收尾时的修正（还没发布，`EVENT_FACTOR_VERSION` 仍是 1）：选股里事件类的是非因子（两融标的）为空 = 不知道，`is` / `not` 都不让它通过
  （`flag_*` 仍把空当「否」，不用事件因子的选股 SQL 逐字节不变）；`unlock_ratio_30d` 在 30 天内有已知解禁但缺比例时为空；
  户数每个季度取当时可见的**最新**一次公告（与事件卡片、证据同一规则）；大宗的 20 个交易日窗口按日期范围连接，可得日落在非交易日的算进下一个交易日起的窗口。
  夜间事件步骤：拷回也失败时只把正式表之后的新日子置空、仍不让整晚失败；最近一次算成功的日子记在 meta `event_factors_ok:A`，
  连续失败到留空的日子滑出 15 天重算范围时，重开那几年的按年补算（完成标记改为未完成）；它本身连续失败 3 晚也进 `stale_events`、证据与事件卡片的提示。
  完整重跑在扣额度之前也查事件因子是否补完。导出清单加 `factorCoreVersion`、`eventFactorVersion`、`evidenceVersion`（不进旧文件的指纹）。

### 18. Tushare 可选数据源（一）：客户端、能力状态、日线备用、官方交易日历（S16）

**为什么现在做**：S12 的数据源接口、S13 的完整性闸门与数据问题、S03 的行级来源都有了，接 Tushare 就是「再加一个接口实现，加几个夜间软步骤」。
它补的恰好是 Ivan 已知的几处近似：2018 年以前的沪市 ST（`st_approx`）、靠每年 12 月手录的休市日表推算计划日、分不出真停牌、涨跌停价按规则表公式推算
（规则表里还有出自记忆的日期）、东财缺公告日的财报按「报告期 + 120 天」生效。Tushare Pro 要用户自己的 token，按积分分级，所以 S16 默认关闭。
三个切片分开：S16 只接源与日历（不改任何已有结果），S16b 改写两处历史近似，S16c 动完整性闸门与引擎。每片都以「没有 token 时逐字节不变」为门槛。

**有 token 得到什么，没有 token 时什么不变**（积分要求按 2026-10-05 的官网文档，Tushare 会调整，以实际返回为准）：

| 能力 | 切片 | 有 token 时 | 接口与积分 | 没有 token（不变） |
|---|---|---|---|---|
| A 股日线备用 | S16 | 链变成 东财 → Tushare → 腾讯 | `daily`，120 | 东财 → 腾讯 |
| 复权交叉核对 | S16 | 由 Tushare 补的日线，交易所前收与 adj_factor 两种算法对照，不一致记数据问题 | `adj_factor`，2000 | 无 |
| 交易日历 | S16 | 官方日历决定**未来**的计划日，并核对手录的休市日表 | `trade_cal` / `hk_tradecal`，2000 | 休市日表 → 工作日 |
| 早年沪市 ST | S16b | 按真实简称历史判定 | `namechange`，探针实测 | 「最近两期年报都亏损」近似 |
| 财报生效日 | S16b | 东财缺公告日的财报改用实际披露日；Tushare 更晚时取更晚 | `disclosure_date`，2000 | 报告期 + 120 天 |
| 停牌 | S16c | 闸门与缺口提示分清真停牌 | `suspend_d`，2000 | 只能从「没有 K 线」推断 |
| 涨跌停价 | S16c | 新运行（规则表第 3 档）用交易所公布价；日线体检 R5；每晚核对规则表 | `stk_limit`，2000 | 规则表公式 |

只有 120 积分的 token 只能用日线备用；其余能力第一次返回「没有权限」时自动关闭 24 小时，管理页写明「积分不足」，夜间任务照常成功。
港股只接官方日历：`hk_daily` 只有不复权价，没有交易所前收或复权因子，不进日线链。

**配置与 token 保密**（D86）：

- `Config.sources.tushare = {token, baseUrl, minIntervalMs, allowHttp}`：`TUSHARE_TOKEN`（空串或占位符 `your-tushare-token` 都算关闭）；
  `TUSHARE_BASE_URL` **默认 `https://api.tushare.pro`**；`TUSHARE_MIN_INTERVAL_MS` 默认 400（每分钟 ≤ 150 次）。官方文档写的是明文 `http://api.tushare.pro`，
  token 在请求体里会被网络上的人看到，所以只有 `TUSHARE_ALLOW_HTTP=1` 且地址是 http 时才允许明文，管理页数据源一行常驻 warn Badge「数据源令牌以明文传输」；
  http 地址而没设 `TUSHARE_ALLOW_HTTP` 视为配置错误，Tushare 不启用并在日志与管理页说明。探针实测 HTTPS 是否可用并写进 probe-report。
- token 只放在 `TushareClient` 的私有字段 `#token` 里（`JSON.stringify(ctx)` 也拿不到），只出现在 POST 请求体中，URL 里没有。错误信息与日志里出现 token 原文的地方
  一律先换成 `***`，再截到 200 字。`/internal/data-status`、管理页、运行卡、导出文件只有 `tushare.enabled`；`tokenFp`（`sha256Hex(token)` 前 8 位）只存在行情仓
  `source_status` 里，用来判断 token 换没换，不出 worker。
- `Http` 为 Tushare 域名注册节奏：间隔 `minIntervalMs`、并发 1。worker 的 `env.ts` 与 CLI 的 `openCtx` 在 token 有效时创建 `EtlContext.tushare`；
  没有 token 时这个字段不存在，S16–S16c 的代码路径一条都不进，也不会向 Tushare 发任何请求（有测试断言）。

**客户端**（`packages/data/src/sources/tushare.ts`）：`TushareClient.call(api, params, fields)` / `callAll(api, params, fields, {pageSize = 5000, maxPages = 20})`，
请求 `POST {baseUrl}`，请求体 `{api_name, token, params, fields}`，`fields` 是逗号拼接的字符串（官方 HTTP 文档如此）。响应 `{code, msg, data: {fields, items, has_more}}`：
`code = 0` 时按 `data.fields` 把每行映射成对象，请求的字段只要有一个不在 `data.fields` 里就抛 `schema`「Tushare {api} 少了字段 {f}」。

- **错误分类**（`code ≠ 0`，先看文字再看代码，按顺序）：① 文字含 token 且含「无效 / 不对 / 错误 / 不存在 / 过期 / invalid」→ `token`；
  ② 「每天 / 每日 / 今日 / 当天」后 12 个字以内出现「最多 / 上限 / 次数」→ `rate_day`；③ 「每分钟 / 每小时 / 频率 / 太频繁 / rate limit / too many requests」→ `rate_minute`；
  ④ `code = 2002`（官方文档唯一写明的代码）或文字含「权限 / 积分」→ `permission`；⑤ 其余 → `other`。
  「您每分钟最多访问该接口 500 次」归 `rate_minute`，「您没有访问该接口的权限」归 `permission`：「访问该接口」两种消息里都有，不能单靠它判断（Vibe-Trading 把它当成限频）。
- **重试**：`rate_minute` 依次等 5、20、40 秒，第 4 次仍失败就抛出；碰到过一次后，本进程给自己加一段额外间隔（起点 `minIntervalMs`，每次再碰到翻倍，最多 2000 毫秒）。其余不重试。
- **分页**：`limit = pageSize`、`offset = k × pageSize`；一页不满或 `has_more === false` 就停；第 k > 0 页的第一行和第 0 页完全相同说明接口不认 `offset`，抛 `paging`，调用方改用更窄的区间；
  超过 `maxPages` 抛「Tushare {api} 超过 20 页，请缩小查询区间」。

**能力状态**（`sources/status.ts`，行情仓新表 `source_status(source, cap, status, detail, until, token_fp, last_ok, rows, updated_at, PRIMARY KEY (source, cap))`）：
`TsCap = 'bars' | 'adj_check' | 'calendar_a' | 'calendar_hk' | 'names' | 'fin_dates' | 'suspend' | 'limits'`。`permission` → `denied` 24 小时；`rate_day` → `quota` 到北京时间次日 0 点；
`token` → 整个来源 `invalid_token`，直到 token 指纹变化；其他 → `error`（第二天照常再试）；成功 → `ok`。`tsGate(wh, client, cap)` 决定这一步跑不跑；
ETL 开头发现指纹变了就清掉 tushare 的全部状态。日线适配器的 `available()` 读同一套状态，被关掉时链直接跳过它，不算回退。

**日线备用**（D87）：

- `sources/adapters/tushare.ts`：`id 'tushare'`、`banRisk 1`、`capabilities {bars: ['A']}`。`daily {ts_code, start_date, end_date}`（单次最多 6000 行，2013 年至今约 3300 行一次取完）：
  返回按日期倒序，先排成正序；`vol` 单位「手」× 100 → 股；`amount` 单位「千元」× 1000 → 元；`chg = close − pre_close`；口径 `raw+ref_prev_close`，和东财 A 股走同一个
  `adjFromRefPrices`。**不用 adj_factor 作主口径**：换来源不改复权因子；120 积分就够；避开 Vibe-Trading「复权因子没拉到就退回不复权价」算出的假收益（300750 上 −41.82%）。
- **单位守卫**：换算后各行 `amount / (close × volume)` 的中位数在 [0.5, 2] → 正常；在 [0.005, 0.02] → vol 其实已经是股，不再乘 100 并记日志；其余 → `CaliberError`，链换下一家。
- **复权核对**：只对由 Tushare 补的那段做，且 `adj_check` 可用：凡任一算法有跳变（> 0.1%）的日子，比较前收推出的比值与 `adj_factor` 推出的比值，相对差 > 0.1% 写
  `data_issues`（dataset `bars`、rule `xsrc_adj`、flag），detail「前收推出 1.010781，复权因子推出 1.012500」。只标记、不改数据（D74）。adj_factor 没权限时跳过，日线照常入库。
- **链**：`defaultChains({tushare})`：有 token 时 A 股日线 `['eastmoney', 'tushare', 'tencent']`，其余不变；没有 token 时与 S12 完全相同（快照测试）。
  `IVAN_CHAIN_BARS_A` 仍只接受默认集合的重排；没 token 却写了 tushare 算无效配置。`KLINE_SOURCE` 不接受 tushare。`srcCode('tushare', *) = 'tushare'`，
  管理页「今晚东财 N 只、Tushare K 只、腾讯 M 只（回退 J 次）」。

**官方交易日历**（D88）：

- 新表 `trade_calendar_official(market, date, is_open, src, ver, fetched_at)`。夜间软步骤 `tushare:calendar_*`：一次取「今天 − 30 天」到「明年 12 月 31 日」，同市场同区间先删后写；
  A 股 `trade_cal {exchange: 'SSE'}`（三个交易所日历相同），港股 `hk_tradecal` 按年取（单次 2000 行）。
- **「已公布」从严**：某年要覆盖 1 月 1 日到 12 月 31 日的每一天，且工作日休市天数 A 股 ≥ 7、港股 ≥ 6，且 1–2 月里有连续 ≥ 3 个（港股 ≥ 2 个）工作日休市（春节）。
  只填了元旦、或按工作日预填的年份都不算，退回休市日表。
- `holidays.ts`（S08）：`nextTradingDay(market, d, official?)` 返回 `{date, basis: 'official' | 'holiday_table' | 'weekday'}`，年份已公布时按官方日历走，否则退回原逻辑；
  `plan_snapshots.plan_date_basis`、`BuiltInput.nextDayBasis` 加 `official`；S08 计划快照版次原因的数据维度加 `plan_date_basis`。回测与历史重放不变（用 `trade_calendar`）。
- `diffHolidayTable(market, official)`：对表和官方都有的年份列出不一致的日期，写进 `meta holiday_table_mismatch:{market}`，管理页 warn「休市日表与官方日历不一致：A 股 2027-02-16（表里没有）」。
- `daily()` 的休市判断**仍由 K 线与报价交叉验证（`confirmNonTradingDay`）决定**；官方日历只用来写日志与标注原因（「按官方交易日历今天休市」），和 K 线矛盾时只记日志。

**来源留痕与可复现**（D89）：

- 每一行 Tushare 数据都带 `src = 'tushare'`（`name_changes` 用 `source = 'tushare'`）和 `ver`。回测、结算、选股、证据只读行情仓，所以**复核、完整重跑、导出校验都不需要 token**，
  同一个行情仓文件（或备份）在没有 token 的机器上照样逐笔复现。
- `RunProvenance`（S13）加 `tokenSources?: Array<{source: 'tushare'; datasets: Array<'bars' | 'calendar' | 'st_names' | 'fin_dates' | 'suspensions' | 'limits'>; rows}>`，
  S16 填 `bars`（S13 `bySource.tushare`）与 `calendar`（补下一个交易日的依据是 `official`，只有跟踪会有），S16b、S16c 各补自己的。全为 0 时整个字段不出现，运行卡逐字节同前。
- 数据提示 `token_source`（info，只进 `reportHash`）：「这次回测用到了 Tushare 的{数据集}。这些数据存在本实例的行情仓里，用同一个行情仓复核不需要 token；
  没有 Tushare token 的实例从头回填行情仓，结果会不同。」「复现信息」ⓘ 加一行「需要 token 的来源：Tushare（…）」。
- 复核（S02 第 1 级）加 `tokenSourcesThen` / `tokenSourcesNow`；输入指纹不同且两者不同时，「数据已修订」后面写明「新增了 Tushare 的{数据集}」或「当时用到了 Tushare 的{数据集}，现在的行情仓里没有」。
  S02 的漂移归因文案同样带上这句。

**界面、探针、命令行**：

- 管理页数据卡加「数据源」一行：没有 token「Tushare：未启用（没有设置 TUSHARE_TOKEN）」；有 token「Tushare：已启用」+ 每项能力的 Badge（正常 / 积分不足 / 今日额度已用完 / token 无效），
  明文传输时常驻 warn。`/internal/data-status` 加 `tushare {enabled, insecure, caps, backfill, holidayMismatch}`，不含 token 与指纹。
- 来源 Tag（`lib/format.ts`）`tushare` →「Tushare」；数据质量卡规则名加 `xsrc_adj` 两种复权算法不一致。跟踪页计划日旁注加「按官方交易日历（Tushare）」。
  不加对话工具，提示词补一句「来源是 Tushare 的数据，说明是本实例管理员配置的」。
- `pnpm ivan probe --tushare`（只在命令行联网、有 token 才跑）：逐项试调（1–5 行），报告状态、实际 `code` 与脱敏的 `msg`、字段是否齐全、600519.SH 跨 2022-06-30 除权日的
  前收比值与复权因子比值、688981.SH 的成交量单位、明年日历是否已公布、`disclosure_date` 最早的报告期、`stk_limit` / `suspend_d` 是否支持 offset、
  `https://api.tushare.pro` 能否使用。输出里 token 只写「已设置（不显示）」，结果写进 `docs/probe-report.md` 的「Tushare（需要 token，管理员自测）」一节。
- `.env.example` 加一节「可选：Tushare Pro（填你自己的 token；不填就完全不用）」，写明积分分级与授权条款需要管理员自行确认。

### 19. Tushare 可选数据源（二）：早年沪市 ST 与财报实际披露日（S16b）

**简称历史**（D88）：

- `name_changes` 加 `ver` 列（表尾）。`namechange` 返回区间 `(name, start_date, end_date, ann_date)`：每只股票按 start_date 排序转成变化点
  `(code, date = start_date, before = 上一个区间的简称, after = name, 'tushare', ver)`；同一 (code, start_date) 多行取 ann_date 最晚的那行。
- **回填**：逐个 2018-01-02 以前上市（含退市）的沪市代码 `namechange {ts_code}`，约 1800 次，`etl_progress` 任务 `ts:names`。
- **夜间**：`namechange {start_date: 10 天前, end_date: 今天}`（按公告日过滤）只用来找**哪些代码**有新变化；对每个这样的代码再取一次完整历史 `namechange {ts_code}`
  并**整只替换**它的 tushare 行（每晚通常几只）。不能拿近期区间直接删了重写：那会抹掉这只股票回填过的 2018 年以前历史，也丢掉「上一个简称」（评审指出的问题）。
- `stResolver` 的 `NameChange.source` 加 `'tushare'`，**只改原来近似的那一段**：深市有深交所记录就照旧；沪市 d 不早于这只股票第一条 `em_daily` 时照旧用 `em_daily`，
  更早的日子有 tushare 区间就按它判，否则仍走年报近似。2018 年以后已经精确的 ST 不变，现有跟踪（都在 2018 年以后起步）不会因此漂移。
- 回填完成后写 `meta tushare:names:complete` 与 `tushare:names:uncovered`（2018-01-02 以前上市却没有任何 tushare 记录的沪市证券数）。`st_approx`：完成且 0 → 不再出；
  > 0 →「2018 年以前有 N 只沪市股票 Tushare 也没有简称记录，仍按『最近两期年报都亏损』近似」；没回填 → 原文。个股证据的 ST 档位加 `sh_tushare`（证据第 3 版：第 1、2 版的条目照旧不读 Tushare，D97）。

**财报实际披露日**（D90）：

- 新表 `fin_disclosure(code, report_date, actual_date, pre_date, schedule_ann_date, modify_date, src, ver)`，`disclosure_date` 字段一一对应：
  `actual_date → actual_date`（**唯一**用于生效日的日期）、`pre_date → pre_date`、`ann_date → schedule_ann_date`（这是披露计划的公告日，不是财报的公告日）、`modify_date → modify_date`。
  只存 `actual_date` 不为空的行。`financials` 加 `eff_basis`（`notice | report_120 | hk_statutory | ts_actual | ts_later`；旧行为空，按 notice_date 是否为空推断）。
- 夜间软步骤 `tushare:fin_dates`（财报增量之前）：最近两个报告期；回填从 2010-03-31 起逐个报告期 `callAll`，约 66 期、130 次请求。
- `aFinRow` 定 `eff_date`：东财没有公告日 → 实际披露日（`ts_actual`）；两边都没有 → 报告期 + 120 天（`report_120`）。东财有公告日而 Tushare **晚** 3 天以上 → 取较晚的（`ts_later`）并记
  `fin_date_mismatch`；Tushare **早** 3 天以上 → 不改（东财那个日期可能是更正公告的日期，往前挪会把更正后的数值泄漏到更早），只记同一条问题。港股不变。
  原来一律「报告期 + 120 天」让一季报、半年报、三季报晚生效几个月，又让晚于 4 月 30 日披露的年报提前生效（有前视）。

**这会改写哪些历史，谁会看到**（评审要求如实写明）：早年沪市 ST 只影响起点早于 2018 年的回测；财报生效日的改写会动到 2018 年以后的行，
受影响代码的因子要重算，**运行中的跟踪重放会出现「数据被修订」并加计划版次**，用到这些股票的旧回测复核会报「数据已修订（新增了 Tushare 的财报实际披露日）」。
这是更正，不是悄悄改：

- `scripts/tushare-backfill.sh` 先跑 `pnpm ivan tushare backfill --dry-run`，打印「这次回填会改写 N 只股票的财报生效日（其中 M 只在运行中跟踪的持仓或股票池里）、
  K 只沪市股票 2018 年以前的 ST；影响 T 个运行中的跟踪」，管理员输入 `yes` 才继续（`--yes` 跳过确认，供自动化用）。
- 回填步骤：日历 → 简称 → 披露日 → 一条 `UPDATE financials … FROM fin_disclosure` 按上面的规则改写已有行并收集 `eff_date` 变了的代码 → 写 names 两个 meta →
  只对受影响的代码重算因子（`computeFactors(ctx, 'A', DEFAULT_SINCE, {codes})`）→ 提交一个 `kind 'backfill'`、note `tushare` 的数据版本（这是正常的行情仓回填，开版本）。
  S16c 的停牌、涨跌停价回填接在后面。各步有 `etl_progress`，可以断点续跑；脚本照 `backfill-full.sh`（等 worker 空闲 → 维护标记 → 停 worker → 跑 → 拉起），
  日志 `logs/tushare-backfill-日期.log`。**打开 token 本身不会触发回填**，不回填时只有当天起的日历等开始积累，ST 与财报日期不变。
- `tokenSources` 补 `st_names`（A 股、起点早于 2018-01-02 且 names 已回填）与 `fin_dates`（生效日不晚于终点、`eff_basis` 为 `ts_*` 的 A 股财报行数）。

**清除**：`pnpm ivan tushare purge --yes`（命令行，给停用 Tushare 或对授权条款有顾虑的管理员）：删 `trade_calendar_official`、`fin_disclosure`、
`name_changes` 里 source = tushare 的行（S16c 之后还有 `price_limits`，以及 `bar_status` 里 tushare 的停牌行改回 `missing`、原因 `purged_tushare`，不直接删，
免得 S13 的缺口统计少算）；`eff_basis` 为 `ts_*` 的财报还原成原来的规则；重算受影响代码的因子；清掉 tushare 的 meta 与能力状态；提交一个 note 为 `tushare purge` 的版本。
**不删** `src = 'tushare'` 的日线（删了会留下缺口），只报出行数并提示「如需替换，对这些股票跑 backfill --force --codes」。

### 20. Tushare 可选数据源（三）：停牌与交易所涨跌停价（S16c）

**停牌**：

- 夜间软步骤 `tushare:suspend`（`updateBars` 之前）：`suspend_d {start_date: 今天 − 10 天, end_date: 今天, suspend_type: 'S'}` 分页取（官网写「不定期更新」，晚到的要能补上）；
  回填按月，`etl_progress` 任务 `ts:suspend`，分页被拒时改逐日取。只记全天停牌（`suspend_timing` 为空）：写 `bar_status(status 'suspended', reason 'full_day', src 'tushare', ver)`，
  原来是 `missing` 或 `no_trade` 的行改写成 `suspended`（改写 `missing` 等于这段缺口有了解释）；这天库里有成交量 > 0 的 K 线 → 不写，记 `suspend_conflict`。
- **完整性闸门**（S13）：`CompletenessInput` 加 `suspended`（今天官方全天停牌的代码，只在今天这一步成功时给）。规则（c）改用「没成交且不在官方停牌里」的数量，
  历史中位数取各版本的 `noTradeUnexplained ?? noTrade`；缺失的代码里今天官方停牌、且最后一根 K 线就是上一个交易日的，改记为停牌、不算缺失。
- 个股证据的「近 20 个交易日停牌 / 无成交 / 缺数据天数」里，停牌一项带来源 Tag「Tushare」（证据第 4 版）。`tokenSources` 补 `suspensions`。

**交易所涨跌停价**（D88、D89）：

- 新表 `price_limits(code, date, pre_close, up, down, src, ver)`。夜间软步骤 `tushare:limits`（`updateBars` 之前；官网说每个交易日 9 点左右入库当天的价格）：
  `stk_limit {trade_date: 今天}` 分页取，先删当天再写；回填按交易日逐日取，`ts:limits`。只保留证券表里的 A 股代码。
- **挂在记录在案的字段上，不改已有运行**（修正评审指出的跟踪漂移）：S04 的 `ExecConfig.rules` 加第 3 档：`rules = 3` =「涨跌停价用交易所公布价，没有的日子按规则表第 2 版公式」。
  `resolveExec` 的形状不变（还是同一个字段），所以 `HASH_VERSION` 不升。已有的运行与跟踪是 1 或 2，**永远不读** `price_limits`，金标准、重放、计划快照都不受影响。
  新的 A 股回测在 `normalizeParams` 里按 `/internal/data-status` 决定默认：本实例 `price_limits` 有数据（`tushare.backfill.limitsFrom` 不为空）时默认 3，否则仍是 2；
  所以没有 token 的实例，新回测的运行卡也和以前一样。`describeExec` 加「涨跌停价按交易所公布价（缺数据的日子按规则表）」。
- **引擎**（`simulate.ts`、S05 的 `fill.ts`）：`PriceSeries` 加可选的 `up?: Float64Array`、`down?: Float64Array`（与已有数组一样用 Float64，没有值为 NaN）。
  `limitBand(code, i)`：`exec.rules >= 3` 且这只有 `up` 且当天有限 → 官方 `{up, down}`，比较容差半分钱 0.005；否则走原来的公式（容差 1e-6 不变）。`limitHit`、`quote()` 的买价上限与卖价下限都改用它。
- `buildSimInput` 只在 A 股且 `rules >= 3` 时一次查询填数组；一行都没有就不挂。**输入指纹**：`priceHash` 只在 `rules >= 3` 时，在 adv、sigma 之后先写一个存在标记（`up:1` / `up:0`），
  有数组时再接 `up`、`down` 截到 cut 的字节；`rules ≤ 2` 的组成与以前逐字节相同。
- **日线体检 R5**（S13）：有官方价的日子，收盘价高于 up + 0.005 或低于 down − 0.005 才标记，不再按「规则表限幅 + 0.5%」近似。
- **规则表核对**：每晚因子算完后（软步骤，只出统计），对今天每一行用 `stk_limit` 自带的 pre_close 和规则表第 2 版算公式价，与官方价比较，不一致的写进
  `completeness.tushare.limitRuleDiff = {n, samples ≤ 20}`；用交易所前收，比的纯粹是规则表的涨跌幅与取整。`pnpm ivan tushare check-rules [--since 2019-01-01]`
  对全部历史做同样的比较，按（板块，ST，年份）汇总，并输出 `diffHolidayTable`。S04「上线前逐条核对规则表」从此有了数据依据。管理页「涨跌停价：近 7 天与规则表第 2 版不一致 3 处」。
- 个股证据加「决策日收盘涨停 / 跌停（交易所涨停价 12.34）」，来源 Tushare（决策日的涨跌停价当天 9 点前已公布，点时安全；证据第 4 版）。`tokenSources` 补 `limits`（面板里官方价有限的格子数）。
- 数据质量卡规则名加 `suspend_conflict` 停牌与成交冲突、`fin_date_mismatch` 财报日期两家不一致。

**夜间顺序**（S13 + S15 + S16–S16c 合在一起，A 股；港股只有日历与原有步骤）：开版本 → 指数 → `tushare:calendar` → 休市判断（K 线 + 报价）→ 汇率 / 证券表 →
`tushare:limits`、`tushare:suspend` → `updateBars`（体检用今天的官方涨跌停价）→ 完整性闸门（用今天的停牌）→ `tushare:names`、简称 → `tushare:fin_dates`、财报 →
两融明细、股东户数、限售解禁、大宗交易 → 因子（含事件列）→ 规则表核对 → 提交。每个 tushare 步骤经 `tsGate`、记一条 `SoftOutcome {step: 'tushare:<cap>'}`；
被跳过的记 `ok: true, skipped`，不算连续失败。提交时 `completeness.tushare = {enabled, caps, rows, suspendedToday?, limitRuleDiff?}`。

### 21. 持仓：账户、不可改的持仓快照、导入与估值（S17）

**为什么**：Jim 刚手工做过一次持仓复盘。要让 Ivan 给出「针对你这本账」的参考，先得有用户自己的持仓，而且要能回溯：哪天记的、从哪个文件来的、当时值多少。
这里只做记录与估值，不做任何买卖建议（原则 1、2）；持仓不是策略，A 股与港股可以放在一起（D12 只约束策略）。

**表**（应用库；一次生成的迁移 `holdings` + 一次自定义触发器迁移 `holdings_triggers`，做法同 S08）：

- `holding_accounts`（不叫 `accounts`：better-auth 已经有 `account` 表）：`id`（`ha_`）、`user_id`、`name`、`broker`（`ths | eastmoney | futu | generic | manual`）、`note`、
  `import_mapping`（json，列映射兜底时记下）、`archived`、`deleted_at`、`created_at`、`updated_at`。每人最多 20 个账户。可改（改名、归档），不进账本。
- `holding_snapshots`（只追加）：`id`（`hs_`）、`user_id`、`account_id`、`as_of`（这份持仓对应的日期，≤ 今天、≥ 2013-01-01）、`source`（`csv | manual | chat`）、
  `parser`（如 `ths_holdings@1`）、`source_hash`（原始文件字节的 sha256）、`encoding`、`line_count`、`content_hash`、`supersedes`、
  `body_z`（压缩 JSON：持仓行、现金、警示、文件名）、`purged_at`、`created_at`。敏感内容只在 `body_z` 里。每改一次（导入、手动保存、对话草稿确认）都新建一份并记账本 `holdings`。
- `holding_prefs`（每人一行，可改，不进账本）：`user_id`、`base_ccy`（`CNY | HKD`，默认 CNY）、`caps`（json，S17b 用）、`bench`（json，S17b 用）、`updated_at`。
  本切片只用 `base_ccy`，表在这里一次建好，S17b 不再加迁移。
- 触发器：`BEFORE DELETE` 一律报「append-only」；`BEFORE UPDATE` 只允许一种变化：`purged_at` 从空变非空、`body_z` 变空，**其余每一列**都用 `IS` 比较不变
  （包括 `encoding`、`line_count`；有一列漏比就成了改内容的后门）。

**持仓行与内容指纹**（`packages/core/src/holdings/content.ts`，纯函数）：

```ts
interface HoldingLine {
  code: string;            // 规范后的 600519.SH / 00700.HK；不支持的保留原文
  name: string | null;     // 文件里的名称
  market: "A" | "HK" | "other";
  supported: boolean;      // 北交所、B 股、美股、基金 / ETF、债券 / 逆回购 = false，保留但不估值
  unsupportedReason?: string;
  qty: number;             // > 0
  costPrice: number | null; costCcy: "CNY" | "HKD" | "USD" | null;
  brokerValue: number | null; brokerValueCcy: "CNY" | "HKD" | "USD" | null; // 只作参考，从不用来估值
}
holdingContent = { accountId, asOf, source, parser, sourceHash, cash: { CNY, HKD }, lines /* 按 code 排序，同代码合并 */ }
content_hash = sha256Canonical(holdingContent)   // 账本 payload_hash 就是它
```

**导入**（`packages/core/src/holdings/`，纯函数、不加依赖，D91）：

- `decodeBytes(buf)`：先查魔数：`D0 CF 11 E0 A1 B1 1A E1`（真 Excel）或 `50 4B 03 04`（xlsx / zip）→「请在券商软件里另存为 CSV 或文本（暂不支持 Excel 文件）」；
  BOM：`EF BB BF` → utf-8，`FF FE` → utf-16le，`FE FF` → utf-16be；没有 BOM 但前 512 字节的奇（偶）位 ≥ 30% 是 0 → utf-16le（be）；
  `TextDecoder("utf-8", {fatal: true})` 成功即 utf-8，否则 `TextDecoder("gb18030")`（GBK / GB2312 的超集，Node 22 自带 full-icu，已实测）。
  解出来是网页（以 `<` 开头且含 `<table`，部分券商的「.xls」其实是网页）→「这个文件是网页格式，请在券商软件里导出为 CSV 或文本」。
- `sniffTable(text)`：在 `,`、`\t`、`;` 里选前 20 个非空行列数最一致的分隔符；支持双引号与 `""` 转义；单元格去掉 Excel 的 `="600519"` 包装；
  表头 = 前 10 行里第一行同时含代码别名与数量别名的那一行（跳过「持仓明细 2026-10-05」这类标题行），表尾的合计行（代码为空）跳过。
- 表头别名（去空格、全角括号转半角、英文小写后**整格相等**，不做子串匹配，避免「可用余额」被当成「股票余额」）：
  代码 `证券代码|股票代码|代码|证券编号|symbol|code|ticker`；名称 `证券名称|股票名称|名称|证券简称|name|stock name`；
  数量 `股票余额|证券数量|持仓数量|实际数量|当前持仓|持股数|持有数量|股份余额|quantity|qty|position`（按此顺序取第一个出现的列）；
  成本 `成本价|参考成本价|摊薄成本价|持仓成本价|买入成本|average cost|avg cost|diluted cost|cost price`；
  市值 `市值|最新市值|参考市值|证券市值|market value`；币种 `币种|币别|交易币种|currency`；市场 `交易市场|市场|市场类型|market|exchange`。
- 格式识别（只决定 `parser` 名称）：有「股票余额」或（证券代码 + 证券名称 + 交易市场）→ 同花顺 `ths_holdings@1`；有「持仓数量」且有「最新市值」或「当前价」→ 东方财富 `em_holdings@1`；
  有 `symbol` + `quantity`，或代码列出现 `HK.` / `US.` 前缀 → 富途 `futu_holdings@1`；只认出代码与数量 → `generic_holdings@1`；
  连代码和数量都认不出 → 返回 `needsMapping`，页面让用户选列，确认后记进 `holding_accounts.import_mapping`，下次同账户自动套用（`mapped_holdings@1`）。
- `cleanNumber(s)`：全角转半角、U+2212 与全角减号转 `-`、去千分位、去货币符号与代码、`(1,234.00)` 记 −1234；`-- - — N/A` 与空串 → `null`，**从不记成 0**。
- `normalizeHoldingCode(raw, hint)`：`HK.00700 / HK00700 / 700.HK / 00700.HK` → `00700.HK`；`SH600519 / SH.600519 / 600519.SH` → `600519.SH`；去掉 Excel 小数尾巴（`600519.0`）；
  市场列匹配 `/港|HK|香港/`（先于沪、深判断，所以「沪港通」「深港通」算港股）→ 港股、补足 5 位；6 位数字：`60`、`68` 开头 → SH，`00`、`30` 开头 → SZ；
  `4`、`8`、`92` 开头 →「暂不支持北交所」；`900`、`200` 开头 →「暂不支持 B 股」；`51`、`56`、`58`、`15`、`16`、`50` 开头 →「暂不支持基金 / ETF」；
  `11`、`12`（可转债）、`204`、`131`（逆回购）、`01`、`10`（国债等）开头 →「暂不支持债券 / 逆回购」；`US.`、`.US`、纯字母 →「暂不支持美股」；
  不足 6 位且没有港股提示：全文件其余代码都是 6 位时按 A 股左补零并警示「代码 {raw} 少于 6 位，按 A 股补零为 {code}，请核对」（Excel 会吃掉 000001 的前导零），否则按港股。
  不支持的行**保留在快照里**，它们的券商市值计入覆盖率的分母（基金、逆回购常是大额现金类仓位，悄悄丢掉会让股票权重显得更高）。
- **和行情仓核对**：预览时把规范后的代码批量送 worker `POST /internal/securities/resolve`；行情仓里没有 →「行情仓里没有这只股票」；已退市 → 保留、标「已退市（{日期}）」；
  文件里的名称与行情仓名称对不上（去掉空格、全角、`XD XR DR N C *ST ST S*ST` 前缀与 `-W -S -SW -R` 后缀后既不相等也不互相包含）→ 警示
  「代码 {code} 在行情仓里是「{名称}」，文件里写的是「{文件名称}」，请核对」。这一条专门兜住 000001（平安银行）被读成 00001.HK（长和）这类错误。
- 上限：文件 ≤ 2 MB、≤ 5000 行数据、合并后 ≤ 500 行持仓。现金不从文件里读，确认时手动填人民币、港币两栏（选填）。

**估值**（`packages/data/src/query/portfolio.ts` + worker `POST /internal/portfolio/value`，D92）：估值日 D（默认今天）。每个市场的数据日
`D_m` = 交易日历里 ≤ min(D, `committedAsOf(m)`) 的最后一天。每个账户取 `as_of ≤ D` 的最新一份快照，没有就不计入并提示。

- 价格 = `bars_daily.close`（**不复权**，数量是真实股数）在 `D_m` 及以前的最后一根；早于 `D_m` 前 5 个交易日 → `stale_price`「最近一次收盘在 {date}（可能停牌），按这天的收盘价估值」；
  一根都没有、不在证券表、已退市 → 不估值，写明原因。
- 汇率：`fx_hkd` 里 `ccy = 'CNY'` 的 `rate` = 1 人民币兑多少港币，取 `date ≤ min(D, committedAsOf('HK'))` 的最后一行（截到提交过的港股版本：失败的港股夜里写的汇率不用）；
  港币 → 人民币 = 港币 ÷ rate。最后一行早于 D 超过 **14 个自然日**（开发库实测 2016–2026 中间价最长空档 11 天）→ 港股行不估值、整份 `complete = false`、警示「缺少 {D} 前 14 天内的港币汇率」。
  **从不按 1 处理**。有港币资产时提示「港股按人民币中间价（{fxDate}）折算，与港股通结算汇率略有差异」。
- **送转**（修正评审指出的问题）：A 股东财路径写 `corp_actions` 时 `split` 为空，要用因子计算同一个解析器还原。新 helper
  `corpActionsResolved(wh, codes, from, to)` 读 `corp_actions` 与 `share_changes`，调 `resolveActions(facts, shares, SPLIT_REASON_RE)`（加一个返回字段
  `splitSource: 'given' | 'share_change' | 'none'`）。快照 `as_of` 之后、`D_m` 及以前：|split| > 1e-4 → 按 `qty × Π(1 + split)` 估值、标 `split_scaled`
  「{名称} 在 {date} 有送转（每 10 股送转 {10×split}），已按比例折算持股数，请更新持仓确认」；`splitSource = 'none'` 且（前收 − 参考价）÷ 前收 > 10%（没找到股本变动、又不像派现）
  → 不估值、`complete = false`「{名称} 在 {date} 可能有送转，持股数无法确定，请更新持仓」。
- 输出：每行 `{code, close, closeDate, fxRate, fxDate, valueLocal, valueBase, weight, status, flags, accounts}`；合计 `{valued, cash, book, unvalued}`、
  `coverage`（已估值市值 ÷（已估值 + 未估值行的券商市值，有的话））、`complete`、`warnings`、`dataDates`、`dataVersions`。
  没估值的行不进合计、不进权重，**从不按 0 计**。快照的 `as_of` 早于 D 超过 30 天时提示「这份持仓是 {n} 天前记的」。基础货币按 `holding_prefs.base_ccy`。

**接口**（server，全部要登录，资源一律按 `user_id` 查，别人的 id 一律 404）：

- `GET / POST /api/holding-accounts`、`PATCH /api/holding-accounts/:id {name?, archived?}`、`DELETE /api/holding-accounts/:id {confirmName}`（见「删除」）。
- `POST /api/holding-accounts/:id/import?asOf=&mapping=`（`application/octet-stream`，**文件名放在请求头 `X-File-Name`（URI 编码）**，不进查询串，免得进 Caddy 与 Hono 的访问日志；
  先看 `content-length` 再读）→ 预览 `{previewId, format, parser, encoding, delimiter, header, lines, skipped, warnings, needsMapping?, sourceHash}`。**预览不写库**：
  解析结果放进 server 进程内的预览缓存（30 分钟过期、每进程最多 50 个、带 userId），确认时只认 `previewId`，过期返回 410「预览已过期，请重新上传」。
- `POST /api/holding-accounts/:id/snapshots {previewId? | lines, asOf, cash}`：导入确认或手动保存；同样过一遍规范化与行情仓核对；在 `IMMEDIATE` 事务里写快照并 `appendLedger('holdings')`。
  与上一份内容指纹相同 → 不新建，返回上一份（「和上一份持仓完全相同，没有新建记录」）。
- `GET /api/holding-accounts/:id/snapshots`、`GET /api/holding-snapshots/:id`、`GET /api/portfolio?date&accounts=ha_1,ha_2`（估值不计额度）、`GET / PUT /api/portfolio/prefs`。
- worker：`POST /internal/securities/resolve {codes ≤ 500}`、`POST /internal/portfolio/value {lines, cash, date?, baseCcy}`。

**对话里的持仓也要能删**（D91，修正评审指出的问题）：

- 持仓相关工具（`get_portfolio`、`propose_holdings`，以及 S17b、S17c 的透视与持仓证据工具）的输出**只存模型摘要与引用** `refs: {accountIds, holdingSnapshotIds, xrayId?, draftId?}`，
  **不存金额**；卡片按引用向服务器取数（取不到就显示「内容已按用户要求清除」）。
- `DELETE /api/holding-accounts/:id` 要求 `confirmName` 等于账户名；在一个 `IMMEDIATE` 事务里：该账户全部快照 `body_z = NULL, purged_at = now`；
  引用了这些快照的透视记录（S17b）`result_z = NULL, purged_at = now`；该用户的消息里 `refs` 命中这些账户、快照、透视或草稿的工具部件，输入与输出都换成
  `{purged: true}`；这个账户的 `holdings` 草稿内容清空并标为放弃；账户 `deleted_at = now`、名字与备注清空；记一条账本 `holdings_purge`，内联
  `{accountId, snapshotIds: [...], xrayIds: [...], messages: n, drafts: m}`。
- 账本里的哈希留着。链校验（S08 `verifyChain`）把「内容已清除」的条目计为 `purged`，**但只有被后面同一用户的 `holdings_purge` 条目列出的才算**；
  没被列出却已清除的记为断点 `purged_unlisted`（有数据库权限的人不能靠设一个 `purged_at` 悄悄藏掉记录）。回溯页显示「已校验 · 共 n 条（其中 k 条内容已按用户要求清除）」。
- 页面文案：「删除后这个账户的持仓明细、相关的风险透视和对话里的持仓卡片内容会被清除，账本里只留哈希，无法恢复。你在对话里自己打的文字不会被改，需要的话可以删除整段对话。」

**对话**：

- `propose_holdings {accountId?, accountName?, asOf?, mode: "replace" | "adjust", lines: [{query, qty, costPrice?}], cash?}` → 草稿 `kind = "holdings"`；
  名字经 worker 证券搜索解析，有歧义把候选当错误返回给模型；`adjust` = 在该账户最新快照上逐行设数量（数量 0 = 删掉这行）。
  卡片 `HoldingsDraftCard`：表格 + 「确认」「放弃」，确认时写快照（`source = chat`）并记账本。模型只拿到 `{draftId, lines: n, accountName, asOf}`。
- `get_portfolio {date?, accountIds?, includeAmounts?}`（只读）→ 持仓卡。模型输出：`{asOf, complete, coverage, accounts, cashWeight, lines: 前 15 行 {name, code, market, weight, industry}, unvalued, warnings}`；
  **默认不给金额**，`includeAmounts: true` 才加总资产（取整到百元）与各行金额。提示词：「要录入或更新持仓 → propose_holdings；只看持仓明细 → get_portfolio；用户没问金额时不要说金额」。

**界面**：账户菜单加「我的持仓」（图标「持仓」Briefcase，复用）；导航不变（D40）。新页面 `/portfolio`（按需加载），本切片先做：抬头（估值日、基础货币切换、「导入」secondary、
「手动录入」ghost、「隐藏金额」开关记在 localStorage）、账户切换（全部 / 各账户 / 新账户）、「持仓」分页（名称、市场 Tag、数量、收盘、市值、仓位、成本价与浮动盈亏（本币）、状态；
未估值的行放最后并写原因）、「记录」分页的快照列表（日期、来源 Tag、行数、校验前 8 位、文件指纹前 8 位，点开 Modal 看当时的表）、账户设置 Modal（改名、归档、删除）。
导入 Modal：选文件 + 账户 + 持仓日期 → 预览（格式与编码 Tag、表格、跳过的行与警示、需要时的列映射 Select、现金两栏）→「确认导入」。空账户用 `Empty`（插画 start）：
「导入券商导出的持仓 CSV，或手动录入。持仓只存在这台服务器上，AI 默认看不到金额。」页脚「仅供研究，不构成投资建议」。

### 22. 持仓风险透视与压力回放（S17b）

**风险模块**（`packages/engine/src/risk/`，纯函数，`RISK_VERSION = 1`，D93）：`series.ts`、`concentration.ts`、`tail.ts`、`contrib.ts`、`caps.ts`、`stress.ts` + `stress-windows.ts`、
`index.ts`（`xray(input): XrayResult`）；S17c 再加 `scenario.ts`、`scorecard.ts`、`follow-up.ts`。分位数、样本标准差用 S04 的 `quantile7`、`sampleSd`，
VaR / ES 定义与指标第 2 版一致。以后回测页的风险透视（ACC-9 的界面部分，二期）直接调 `concentration`、`contributions`。

输入由 worker 组装：估值后的股票行 `{code, name, market, ccy, industry, industryNote, value(基础货币), adv, stylePct}`、现金、联合交易日历 `dates`（持仓涉及的市场的交易日并集，
最近 751 天，**以 `trade_calendar` 为准**：开发库实测 `index_bars` 里有不在日历上的行，如 csi300_tr 的 2016-01-01、2018-06-18，恒指含分红的 2023-09-01、09-08 台风停市日）、
每只股票的本币复权价 `close × adj`、各市场的交易日掩码、汇率序列（往前补不超过 14 天，截到提交过的港股版本）、各市场基准（默认 A 股 `csi300_tr`、港股 `hsi_tr`，偏好里可换成同市场的任一基准，
含 S14 的三条）、上限、压力窗口的数据。

| 指标 | 口径 | 最少观测 |
|---|---|---|
| 权重 | 总资产 B = 已估值股票 + 现金（基础货币）；w_i = V_i / B，现金 w_c，股票合计 E；前一 / 三 / 五 / 十大、行业、市场、币种都按总资产算 | -- |
| 集中度 | HHI = Σ(w_i / E)²，有效持股数 = 1 / HHI（只看股票部分） | -- |
| 收益序列 | 基础货币价格 = 本币复权价 ×（需要时）汇率；上市后的空缺往前补价，上市前为 NaN；r_B = (E / c_t) Σ_{有数} w_i r_i，c_t = 当天有数的股票权重，c_t < 0.5E 的日子剔除；现金收益 0 | -- |
| 年化系数 | P = 有效观测数 ÷（首末日相隔天数 / 365.25），与 metrics.ts 一致 | -- |
| 波动 | 近 60 个 r_B 的样本标准差 × √P；另给近 250 个 | 40 / 200 |
| β | 按市场分开：该市场股票部分（本币、只用该市场交易日）对该市场基准，近 250 对，β = cov / var，另给相关系数；每只股票也各算一个 | 120 |
| VaR / ES | 历史法、单日：近 500 个 r_B，VaR_α = −quantile7(r, 1−α)，ES_α = −mean(r ≤ −VaR_α)；另列近 750 天最差的 5 天 | 95%：250；99%：500 |
| 最大回撤 | 按现在的权重每天再平衡，近 750 个 r_B 的净值路径：最大回撤、峰值日、谷底日、修复日 | 250 |
| 风险贡献 | 近 250 个联合交易日；窗口开始前已上市的股票（其余列为「历史不足」）；Σ = 样本协方差；贡献占比 = w_i(Σw)_i / σ²；年化 σ√P；分散度 = Σw_iσ_i / σ；前 30 大的平均两两相关；ρ ≥ 0.7 的前 3 对 | 2 只 |
| 流动性 | ADV = 数据日 `turnover_20d` × 1e8（本币，换成基础货币；`bars_daily.amount` 开发库实测 2026 年 97% 为空，所以不用）；卖出天数 = V_i ÷（参与率 × ADV），参与率默认 10% | -- |
| 风格画像 | 各自市场里数据日的横截面分位，按股票权重加权：市值、便宜（1 − pb 分位）、动量（mom_12_1）、质量（roe_ttm）、低波（1 − volatility_60d 分位）、股息；分位只在非空值里排（`PARTITION BY market, f IS NULL`）；给出覆盖权重 | -- |

上市不满 3 年的持仓列进 `shortHistory`。所有排序以代码打破平局，没有随机数，同样的输入逐字节同样的结果。

**上限与超限**（D94）：`CAP_DEFAULTS = {single: 0.15, top5: 0.60, industry: 0.30, effNMin: 5, liquidityDays: 5, participation: 0.10}`，存在 `holding_prefs.caps`，
页面「风险上限」Modal 可改（单只 2%–100%、前五大 5%–100%、行业 5%–100%、有效持股数 1–50、卖出天数 1–60、参与率 1%–50%，带「恢复默认」）。每次透视记下当时用的上限。
超出（严格大于，`1e-9` 容差；有效持股数是严格小于）出 warn：「单只持仓超过上限」「{名称} 占 18.3%，上限 15%」；「前五大合计超过上限」；「行业集中」；「有效持股数偏少」
「相当于 3.4 只等权股票，下限 5」；「卖出需要较长时间」「{名称} 按日均成交额的 10% 卖出约需 7.2 天」。提示（info）：幸存者偏差、汇率口径、行业不是点时、历史不足、有未估值的行（warn）、送转折算（warn）。

**压力回放**（D94）：`STRESS_WINDOWS` 是固定常量，每个窗口 `{id, label, markets, from, to, kind, expect}`。回放 = 把今天的权重在 `from` 收盘买入持有到 `to` 收盘（现金不动）：
纳入 `from` 当天（往前补价最多 10 个交易日）已有价格的股票，按纳入权重放大到全部股票权重；覆盖率 < 60% 显示「覆盖不足：现在的持仓里只有 54% 那时已经上市」、数字为空。
输出区间收益（含现金、只看股票两种）、区间最大回撤、最差一天、各相关市场基准的区间收益与最大回撤、没纳入的股票。整块顶部常驻 Callout：
「用你现在的持仓回放历史：不代表当时能选出或买到这些股票，只含当时已经上市的持仓。」

| id | 名称 | 市场 | 起（收盘） | 止（收盘） | 断言 | 开发库实测（2026-10-05，数据自 2016 年） |
|---|---|---|---|---|---|---|
| a_2015_crash | 2015 年股灾 | A | 2015-06-12 | 2015-08-26 | csi300_tr ≤ −35% | **生产库核对** |
| hk_2015_2016 | 2015–16 年港股下跌 | HK | 2015-04-28 | 2016-02-11 | hsi_tr ≤ −30% | **生产库核对** |
| a_2016_meltdown | 2016 年初熔断 | A | 2015-12-31 | 2016-01-28 | csi300_tr ≤ −15% | −17.7% |
| a_2018_trade | 2018 年贸易摩擦 | A | 2018-01-24 | 2019-01-03 | csi300_tr ≤ −25% | −30.9% |
| hk_2018 | 2018 年港股调整 | HK | 2018-01-26 | 2018-10-30 | hsi_tr ≤ −18% | −22.8% |
| covid_2020 | 2020 年疫情冲击 | A、HK | 2020-01-20 | 2020-03-23 | hsi_tr ≤ −18%；csi300_tr ≤ −12% | −24.0%；−15.7% |
| a_2021_2024_bear | 2021–24 年 A 股熊市 | A | 2021-02-10 | 2024-02-02 | csi300_tr ≤ −35% | −41.6% |
| hk_2021_2022 | 2021–22 年港股熊市 | HK | 2021-02-17 | 2022-10-31 | hsi_tr ≤ −40% | −49.4% |
| a_2024_microcap | 2024 年初小盘股踩踏 | A | 2024-01-02 | 2024-02-05 | csi1000_tr ≤ −20%；没有时 chinext ≤ −12% | 创业板指 −15.8% |
| rally_2024_09 | 2024 年 9 月底急涨 | A、HK | 2024-09-23 | 2024-10-08 | csi300_tr ≥ +20% | +32.5% |
| tariff_2025_04 | 2025 年 4 月关税冲击 | A、HK | 2025-04-02 | 2025-04-08 | hsi_tr ≤ −10% | −13.6% |

- 日期出自记忆，**断言以 `index_bars` 实测为准**：`verifyStressWindow` 单测守住函数与常量自洽；`pnpm ivan stress-windows` 在真实行情仓上逐个实测、打印表格、有一个不过就退出码 1，
  上线前在生产库跑并贴进 `docs/probe-report.md`，不过的窗口改端点到实测的峰谷收盘日（不放宽断言凑数）；每次透视运行时也实测，不满足的窗口照常显示数字但加 Badge「区间待核」。
  页面上展示的永远是实测数，不是记忆里的数。

**透视快照与账本**（D95）：应用库新表 `xray_snapshots`（只追加，触发器同持仓快照：只允许清除，其余每列 `IS` 不变）：`id`（`xr_`）、`user_id`、`kind`（`xray | scenario | recompute`）、
`base_xray_id`、`as_of`、`base_ccy`、`account_ids`、`holding_snapshot_ids`、`data_versions`（各市场 `{id, asOf}`）、`risk_version`、`input_hash`、`context_hash`（S17c 填，本切片为空）、
`content_hash`、`complete`、`breaches`、`result_z`、`purged_at`、`created_at`。

- `input_hash`：worker 用 `Sha256Stream` 按固定顺序流式哈希 `{riskVersion, asOf, baseCcy, 各行(code, value, industry, adv, stylePct), cash, caps, bench, scenario, dates}` 的 canonicalJson
  与各价格数组、汇率、基准、压力窗口数组的原始字节。
- `content_hash = sha256Canonical({riskVersion, asOf, baseCcy, holdingSnapshotIds, dataVersions, inputHash, contextHash, caps, bench, scenario, baseXrayId, result})`。
- **每次透视都存**；同一用户已有相同 `(risk_version, input_hash, context_hash)` 的记录时不新建、不记账，直接返回那一条。新建时在 `IMMEDIATE` 事务里写入并
  `appendLedger('xray')`（`subject_type = portfolio`，`payload_hash = content_hash`）。对话工具触发的透视也留底：这是工具自己输出的审计记录，
  不改变任何用户状态，作为验收 14 的唯一例外写明（D95）。

**接口、对话、界面**：

- worker `POST /internal/portfolio/xray {lines, cash, date?, baseCcy, caps, bench}` → `{result, inputHash, dataVersions, dataDates}`；股票超过 150 只返回 400
  「持仓超过 150 只，风险透视只支持 150 只以内」。server：`POST /api/portfolio/xray {date?, accounts?}`、`GET /api/xrays?limit`、`GET /api/xrays/:id`（都计 1 次 `analyses`，读取除外）；
  `GET /api/portfolio` 返回最近一次透视的摘要与 `stale`（持仓快照、提交过的数据版本、上限、基准、基础货币任一与那条记录不同）。
- `get_portfolio_xray {date?, accountIds?}`（计入 `analyses`，会留底）→ 透视卡。模型输出（四舍五入、默认没有金额）：`{xrayId, asOf, complete, coverage, top1, top5Weight, effN, cashWeight,
  vol60, betaA, betaHK, var95, es95, maxDrawdown3y, breaches, topRiskContrib: 前 3, stress: 前 4 {label, ret, benchRet, coverage}, liquidity, caveats}`。
  `get_overview` 加 `portfolio {accounts, asOf, xrayId, breaches}`；`PageRef` 加 `xrayId`。
- 提示词：选工具「问我的持仓、集中度、风险、压力测试 → get_portfolio_xray」；硬性规则加：「持仓相关只陈述证据和风险：不说加仓、减仓、买入、卖出、调仓、止损，不说『建议』『应该』；
  超限照卡片说，不评价好坏；压力回放要说明是用现在的持仓回放历史；用户没问金额时不说金额。」所有新卡片底部「仅供研究，不构成投资建议」。比例字段用 0–1 的小数。
- `/portfolio` 加「概览」「压力回放」分页：抬头动作「风险透视」（新图标概念「风险透视」= Phosphor `Scan`；过期或从没透视过时是 primary）与「风险上限」；
  打开页面时最近一次透视过期就自动透视一次（计 1 次额度）。概览：4 个 Stat（前五大占比、有效持股数、年化波动（60 日）、单日 VaR（95%））、超限 `Checks`、提示 ⓘ、
  行业分布横条（标出行业上限的竖线）、市场与币种、风格画像、风险贡献前 5、高度同涨同跌的组合、β、最大回撤。「记录」分页加透视记录（估值日、数据版本、校验前 8 位、Badge 不完整 / 内容已清除）。
  对话卡片 `XrayCard`；`TOOL_META`「风险透视 / 正在做风险透视」。
- 页脚：「仅供研究，不构成投资建议 · 透视 #{id 前 8} · 校验 {content_hash 前 8} · 数据：A 股 #{id}（{asOf}）、港股 #{id}（{asOf}）」。

### 23. 情景对照、持仓证据与透视回看（S17c）

**情景对照**（D94）：只做一种可解释的假设：「单只上限 X%（5 / 8 / 10 / 12 / 15 / 20 / 25 / 30%），超出部分转为现金或宽基指数」。`applyCapScenario` 把超过 X 的股票砍到 X，
超出部分加进现金，或按市场汇总成一行 `IDX:A` / `IDX:HK`（价格 = 该市场的透视基准，行业「宽基指数」，卖出天数 0，不参与单只上限检查，按一只持仓计入集中度并注明）。
总资产不变，用同一组日期与价格把全部指标、超限、压力回放重算一遍；`compareXray` 给出「现在 / 情景 / 变化」对照行。没有股票超过 X 时说「没有超过 X% 的持仓，情景与现状相同」。
文案：「假设情景：单只上限 10%，超出部分转为现金。这是按同一段数据重算的对照，不是调仓建议。」

**持仓证据卡**（D96）：给仓位前 30 的持仓各生成一行，**沿用 S07 的唯一点时读取器** `securityDossier`，在数据日取数，加三个可选项（默认关闭，现有调用的结果与校验值不变）：
`trend`（`dist_ma200`、`ma200_slope_20d`）、`financialPeriods: 2`（最近两期，优先首见值）、`peerPct: ["pe_ttm", "pb", "dividend_yield_ttm"]`（本市场、本一级行业里的分位，非空值里排，PE 只在 > 0 里排）。
选项写进证据本身并进校验值（D97），持仓证据卡的「证据」按钮用**同样的选项**打开 S07 的证据弹窗，看到的是同一个校验值，能复核。

`scorecard(dossier, ctx)`（纯函数）只陈述、不评价：

- 趋势：「在 200 日线上方 8.2%，200 日线向上（20 天 +1.3%）」；两者同向归为「向上 / 向下」，否则「分歧」。
- 基本面：最近两期净利同比（A 股另给扣非）与营收同比、ROE(TTM)、ROE 三年最低；净利同比变化 > 5 个百分点「改善」、< −5「走弱」、其余「持平」；财报距今 > 200 天提示。
- 估值：PE(TTM)、PB、股息率；自身 5 年分位 ≤ 20「处于自身 5 年较低位置」、≥ 80「较高位置」；全市场与同行业分位。
- 标记：`group === 'flag'` 且为真的风险标记为 Tag；ST 判定档位；港股不在港股通名单；未解决的数据问题「数据待核 n 处」。
- 事件（A 股，来自证据第 2 版「两融与筹码」组，键名在 `SCORECARD_EVENT_KEYS` 一处对齐 S15b 的真实键）：`margin_ratio`、`margin_chg_20d`、`holder_num_qoq`、
  `unlock_days`、`unlock_ratio_30d`、`block_premium_20d` 里取有值的最多 3 项；`unlock_ratio_30d ≥ 5` 记 warn Tag「30 天内解禁 {x}% 流通股」；下一次已知解禁照证据项写日期与类型。
- 策略视角：用户最多 10 个策略（先运行中的跟踪，再按更新时间取未归档策略的当前版本），对同市场的持仓各调一次 `explainSelection(…, {codes})`：
  「在『价值组合』里排第 12（得分 0.83）」或「不在『价值组合』的股票池：没满足 ROE(TTM) ≥ 12%」；运行中的跟踪还给出 S08 最新计划快照里它的状态。这是策略信号的事实陈述，不是建议。
- 风险：仓位、风险贡献占比、β、波动、卖出天数（来自透视）。每行带证据校验值。

跟踪重合度：每个运行中的跟踪，用最新计划快照的持仓算 Σ min(u_i, t_i)：「你的持仓和『价值组合』跟踪重合 34%（共同持有 4 只）」。

**透视的第二个指纹**（修正评审指出的问题）：证据卡与重合度依赖的不只是价格。`context_hash = sha256Canonical({strategies: [{versionId, specHash, trackingId?, planSnapshotId?}],
scorecards: [{code, dossierHash, evidenceVersion}], overlaps})`。去重与「按现在的数据重算」都比 `(input_hash, context_hash)` 两个：用户改了策略、跟踪出了新计划、
某个因子被修订，都会生成新记录，重算也会如实报「数据已修订」而不是「输入一致」。

**回看**：

- 「按现在的数据重算」：`POST /api/xrays/:id/recompute` 用同样的持仓快照、估值日、上限、基准与基础货币重算一条 `kind = recompute`：两个指纹都一致显示「输入一致」，
  否则「数据已修订」并列出变化超过 0.1 个百分点的指标，以及哪些持仓的证据变了。
- 「之后怎么样」：`GET /api/xrays/:id/follow-up`，纯函数 `followUp` 用当时的权重（固定权重）走数据日之后到现在提交过的数据：交易日数、组合收益、各市场基准收益、最大回撤、
  实现波动（≥ 20 天）、亏损超过当时单日 VaR(95%) 的天数与按 5% 应有的天数：「之后 43 个交易日：按当时的权重 +3.2%，沪深300全收益 +1.1%；有 4 天亏损超过当时的单日 VaR（按 5% 预期约 2 天）」。
  不足 5 个交易日显示「还不到 5 个交易日」。
- 「导出」：`GET /api/xrays/:id/export` 下载 `ivan-xray-<id>.json`（内容、两个指纹、对应账本条目与链头哈希、`verification` 说明，格式同 S11）；`pnpm admin verify-bundle` 认 `kind: "xray"`。

**接口、对话、界面**：

- server：`POST /api/xrays/:id/scenario {cap, excessTo, indexKey?}`、`POST /api/xrays/:id/recompute`、`GET /api/xrays/:id/follow-up`、`GET /api/xrays/:id/export`、
  `GET /api/portfolio/holdings/:code/evidence?date`；情景、重算、之后怎么样、单只证据各计 1 次 `analyses`（D59）。worker 加 `POST /internal/portfolio/follow-up`、
  `POST /internal/portfolio/holding-evidence`，透视接口加 `scenario?`、`strategies`、`scorecardTop: 30`。
- `get_portfolio_xray` 加 `scenario?: {cap, excessTo}`（有它时是对照卡，模型输出 `rows: [{label, before, after}]`）；新工具 `get_holding_evidence {query, date?}` → 持仓证据卡，
  模型只拿到 ≤ 12 项摘要。提示词选工具加「如果某只不超过 X% 会怎样 → get_portfolio_xray 带 scenario；问持仓里某只股票 → get_holding_evidence」；
  硬性规则加「情景对照只说成『假设单只上限是 10%，按同一段数据……』」。
- `/portfolio`：「持仓」分页加证据卡各列（风险贡献、β、趋势、基本面、估值、标记、卖出天数、策略视角、「证据」按钮）；「情景对照」分页（单只上限 Select、超出部分 Segmented、「计算」→ 对照表 +
  info Callout）；「记录」分页的透视记录加「查看」「按现在的数据重算」「之后怎么样」「导出」。看板：有账户时多一张「我的持仓」卡（前五大、有效持股数、单日 VaR、超限条数、
  「完整透视 ›」，过期时一行「持仓或数据有更新，打开后会重新透视」）。对话卡片 `HoldingEvidenceCard`，`XrayCard` 加对照表。
- **性能**：jim-server 上 40 只（A + 港）、5 个策略、证据卡 30 行的一次透视 ≤ 8 秒，worker 内存增量 ≤ 50 MB（验收时实测，超了就把证据卡行数降下来）。

## 不借鉴的部分（追加两行）

| 类别 | 不借鉴什么 | 原因 |
|---|---|---|
| 数据广度 | 北向个股持股、已公告未除息的分红预案（本轮） | 北向持股只有最新快照，不能点时；分红预案接口 `RPT_SHAREBONUS_DET` 未核实，放二期 |
| 决策 | 组合优化器、按任意权重做情景、给每只持仓打综合分 | 都等于让引擎或 AI 出调仓方案或评级，违背「只描述、不建议」；情景只做「单只上限 X%」一种 |

## 决策记录（追加）

- **D80 四个点时事件数据集按事件日期窗口整市场拉取，每行存可得日与规则；撤下的记录软删除。** 两融与大宗交易 T+1（实测深市 T 日两融到 T+1 才有）；
  股东户数按公告日，绝不用截至日；解禁取 min(规则日, 首次见到日)：首发按上市日，其他按解禁前 `LOCKUP_NOTICE_LEAD_TD` 个交易日（默认 3，上线前按公告抽样实测定），
  以后靠每晚首次见到的日期变准。用最新价算的市值、最新价、事后涨跌这些列在请求里就禁用。户数与解禁按「合并」写，消失的行设 `gone_from` 而不删，
  所以补算历史时，当时已知、后来被取消的解禁仍然算已知。放弃的方案：逐只拉（两融要约 3.2 万次请求）；照搬 Vibe-Trading（不滞后、用截至日、用最新价市值）；
  消失就物理删除（补算历史时带上事后信息）。
- **D81 一个与来源无关、可续跑的点时数据集运行器；夜间是软步骤；后台回填与补算不开数据版本。** 接口是 `fetchChunk` + `canary`，东财的报表、列、翻页与单位自检都在东财实现里；
  三期的 Tushare 解禁只要实现同样两个方法。整块取完、核对行数与重复行再写，写入是一次调用里的一个事务，同连接的读不会看到空窗口；两融按交易所检查到齐。
  后台回填（每段 10 分钟、避开 16:30–21:00）与事件列补算只写 `pit_batches`、行上盖 `batch`，不提交数据版本：否则一晚写了一半因子后失败，回填段会把那些因子「提交」出去，
  近 20 个版本也会被回填段挤满、让 S13 的连续失败与无成交中位数失真。覆盖起点只在回填完成时设一次，个别缺口记数据问题，不移动起点。
  放弃的方案：停 worker 跑 3 小时回填；每段回填提交一个 ok 版本（评审指出会破坏 D60）。
- **D82 每个事件报表一条最小金丝雀，失败就关。** 一次请求、同一份列常量、单位自检；结构变了（9501）或单位不对时这个数据集当晚不删不写，因子按过期规则变空，结果记进数据版本。
  周检加一次更宽的补扫，补上东财晚入库的行。完整的健康检查（独立表、定时跑全部报表、按健康度调整回退链）仍在二期。
- **D83 注册表第 3 版分成核心版本与事件版本，新因子按列按年补算，不重算已有因子；注册表版本不是漂移原因。** 已有因子与不用新因子的选股 SQL 逐字节不变，
  旧回测复核「输入一致」、重跑逐笔一致，跟踪 0 漂移、计划快照不加版次。补完之前用到新因子的回测提前拒绝、不扣额度。夜间的事件列填充是软步骤，失败时保留已有的值。
  补算避开夜间时段，只在回填完成或签名、版本变化时排。加列是重迁移，走维护脚本，回滚前删列。放弃的方案：升注册表全量重算（jim-server 上要停几个小时，还会无谓地改写所有历史因子行）；
  新因子放进另一张表（选股 SQL、解释、证据都要多一次连接，口径分两处）。
- **D84 事件因子「没有」与「不知道」分开，过期即空。** 两融窗口早于 5 个交易日、最近一条两融早于 5 个交易日、户数同步早于 30 天或公告超过 200 天、解禁同步早于 3 天、
  大宗窗口没到前一交易日都为空；数据可用而没有已知解禁时 `unlock_ratio_30d = 0`、`unlock_days = 181`；户数环比按 d 时可见的最新季末对上一季末（不按可得日排序）；
  20 日变化要求正好相隔 20 个交易日。每个因子有覆盖起点与预热天数，回测起点早于它就拒绝。数据集连续失败与解禁可得日为推算时，回测与跟踪都有提示。
- **D85 新数据进证据与对话，只解释规则，不替用户判断。** 个股证据第 2 版加「两融与筹码」组；新工具与卡只读、点时、带出处；编辑器显示因子的数据起点；
  提示词与数字核对跟上（「户」是计数单位，带「万」的计数按写出的精度核对）。
- **D86 Tushare 是可选数据源，token 为空就完全不进入；默认走 HTTPS。** token 只放在客户端私有字段和 POST 请求体里，不进 URL、日志、错误、接口、运行卡与导出；行情仓只存它的指纹。
  官方文档的地址是明文 HTTP，token 会在网络上可见，所以默认 `https://api.tushare.pro`，明文要显式 `TUSHARE_ALLOW_HTTP=1` 并在管理页常驻警示。
  错误按文字分类：每分钟限频按 5 / 20 / 40 秒重试；每日额度用完暂停到次日；没有权限暂停 24 小时；token 无效整个来源关闭。积分门槛不写死，靠接口自己的返回探测。
  放弃的方案：启动时按积分表决定开哪些能力（积分表会变）；把 token 放进 `SourceCtx` 传给所有适配器（扩大泄露面）。
- **D87 Tushare 进 A 股日线链的第二位（东财 → Tushare → 腾讯），口径用交易所前收，adj_factor 只做交叉核对。** 它不封 IP，排在容易触发 WAF 的腾讯前面；
  不排第一，是为了不白花额度、让绝大多数行保持同一个来源。前收口径与东财 A 股走同一个 `adjFromRefPrices`，换来源不改复权因子，120 积分就够。港股不进链。
  放弃的方案：adj_factor 作主口径（要 2000 积分，两家因子要再对齐一次）；默认排第一。
- **D88 Tushare 的专有数据只当「更准的事实」接到已有的使用点上，每项都保留没有 token 时原来的做法；分三片上线。** 官方日历只决定未来的计划日并核对休市日表，
  休市与否仍以 K 线和报价为准，「已公布」要有春节连休等足够的工作日休市；简称历史只替换 2018 年以前沪市的近似，夜间按代码取完整历史替换；停牌只让闸门和缺口提示分清真停牌；
  涨跌停价只给规则表第 3 档的运行用，并每晚核对规则表。打开 token 不会自动改写历史，历史回填由管理员停 worker 后显式运行。
  放弃的方案：一开 token 就自动回填并重算（会在夜间任务里改写大量历史）；一个切片做完（48 个文件、混着数据与引擎改动，评审认为无法审阅）。
- **D89 需要 token 的数据落进行情仓、逐行记来源；运行写明用了哪些；复核不需要 token；交易所涨跌停价挂在规则表第 3 档。** 回测只读行情仓，同一个行情仓在任何机器上都能逐笔复现。
  `ExecConfig.rules = 3` 是「交易所公布价优先」；已有的运行与跟踪是 1 或 2、永远不读涨跌停表，所以金标准、跟踪重放、计划快照都不变；新的 A 股回测只在本实例有涨跌停数据时默认 3，
  没有 token 的实例新回测的运行卡也和以前一样。`resolveExec` 形状不变、`rules ≤ 2` 的输入指纹组成不变，`HASH_VERSION` 不升。复核与漂移归因在 token 来源变化时说清原因。
  放弃的方案：数据存在就用官方价（评审指出：R2 起的跟踪默认第 2 档，回填后会集体漂移）；新加一个成交假设字段（要升指纹口径版本，所有跟踪都报一次「早于记录」）；
  每次回测按需现拉 Tushare（不可复现，还会把 token 依赖带进回测）。
- **D90 财报生效日只往「更安全」的方向改，改写历史前先告诉管理员影响面。** 东财缺公告日的行改用实际披露日；两家都有日期时只取较晚的那个，较早的只记数据问题
  （东财存的数值可能是事后更正过的，把日期往前挪会把更正泄漏到更早）。只用 `actual_date`，`ann_date` 是披露计划的公告日。这会改动 2018 年以后的部分财报与因子，
  运行中的跟踪会报「数据被修订」并加计划版次，所以回填脚本先列出影响的股票与跟踪，管理员确认后才写。首发数值仍在三期 DATA-12。
- **D91 持仓是用户自己的记录：账户 + 只追加的持仓快照，三条入口都产生新快照并记账；导入只认 CSV / 文本；用户删除时连对话里的持仓卡片一起清除。**
  编码按 BOM → utf-16 零字节 → 严格 utf-8 → gb18030 嗅探，表头整格匹配别名，认不出就让用户选列并记住；代码规范化后和行情仓核对名字；北交所、B 股、美股、基金、债券保留但不估值，
  计入覆盖率分母。持仓工具的输出只存摘要与引用、不存金额。删除时快照、透视、对话里的工具部件、草稿的内容都清除，哈希留在链上；清除必须被 `holdings_purge` 条目列出，
  否则链校验报断点。文件名不进 URL。放弃的方案：引入 SheetJS 读 Excel（npm 上的版本过旧）；券商接口同步（要凭证与外部网关）；持仓行单独成表（清除时要动两张表）。
- **D92 估值点时且失败即停。** 估值日 D 只用 ≤ D 的不复权收盘、截到提交过的港股版本且不早于 14 天的人民币中间价、快照日之后按因子同一个解析器还原的送转比例；
  缺价、缺汇率、比例未知的送转都让这一行不估值、整份「不完整」，从不按 0 或汇率 1 处理；券商导出的市值只作参考。放弃的方案：沿用券商市值（口径与时点不一）；
  只认 `corp_actions.split`（评审指出 A 股东财路径这一列为空，送转全部会变成「未知」）。
- **D93 风险透视是一个纯函数模块，口径写死、带版本，与回测风险透视（ACC-9）共用。** 权重按总资产（含现金）算，有效持股数只看股票部分；收益含汇率、按联合交易日历（以 `trade_calendar` 为准）、
  上市后补价；各指标有最少观测数，不够就空；VaR / ES 与指标第 2 版同一定义；β 按市场分开。放弃的方案：参数法 VaR（日收益厚尾）；组合优化器；用 `bars_daily.amount` 算流动性。
- **D94 上限可配、压力窗口固定且实测、情景只有一种。** 上限默认单只 15%、前五大 60%、行业 30%、有效持股数 5、卖出 5 天（参与率 10%），每次透视记下所用上限；
  压力窗口日期写在常量里，断言以 `index_bars` 实测为准（单测 + 命令行 + 每次透视运行时），页面只显示实测数；情景对照只做「单只上限 X%，超出转现金或宽基指数」，文案是假设、不是调仓建议。
- **D95 每次透视都留成不可改的快照并记账，按两个指纹去重；能回看、能按现在的数据重算、能看之后的实际表现。** `input_hash` 管价格与权重，`context_hash` 管策略版本、计划快照与证据校验值，
  两个都一致才算同一次透视、才说「输入一致」。对话工具触发的透视也留底，这是验收 14 的唯一例外：它只记录工具自己的输出。放弃的方案：只在用户点「保存」时留底（回溯时会缺「当时 AI 看到的那一份」）；
  只用价格指纹去重（评审指出改了策略后会返回旧的证据卡）。
- **D96 持仓证据沿用唯一的点时读取器，模型只复述；入口不进主导航。** `securityDossier` 加趋势、多期财报、同业分位三个可选项（默认关闭），选项进校验值；
  证据卡只陈述趋势、基本面方向、估值位置、风险标记、事件与「你自己的策略怎么看它」，不给结论；模型默认看不到金额。页面入口在账户菜单与看板卡片，D40 不变。
  放弃的方案：另写一套持仓用的读取器（违背 D67）；给每只持仓打综合分（变相评级）。
- **D97 个股证据带版本、因子集与选项，按记录的版本复核。** 第 1 版 = S07，第 2 版 = S15b 的「两融与筹码」，第 3 版 = S16b 的 ST 档位，第 4 版 = S16c 的交易所涨跌停与停牌来源；
  第 2 版起校验值覆盖 `{evidenceVersion, factorKeys, options, items}`，第 1 版保持原算法所以旧值照样能复核；复核接口带版本与选项，没带时先按第 1 版再按当前版本试。
  风险标记按 `group === 'flag'` 收，不按键名前缀。放弃的方案：三个切片各自往证据里加条目（评审指出旧校验值会悄悄对不上，持仓证据卡的校验值也没法在证据弹窗里复核）。
- **D98 追加三批 R5–R7，按依赖顺序上线。** R5 = S15–S15b（事件数据先开始每晚积累，历史在后台补），R6 = S16–S16c（Tushare，可选），R7 = S17–S17c（持仓）；
  实现顺序 S15 → S15b → S16 → S16b → S16c → S17 → S17b → S17c。每批单独部署、单独落地记录；R5 的加列迁移要先删列才能回滚到 R4，R6、R7 只加表加列，旧代码直接可用。
  原因：R6 与 R5 改同一段夜间流程、同一张管理页数据卡；R7 的持仓证据要读 S15b 的事件组与 S16 的证据版本。

## 验收标准（追加）

18. **事件数据点时**：两融与大宗交易 T 日的数据 T+1 才进因子；股东户数在公告日之前看不到（截至 6 月 30 日、8 月 1 日公告的户数，7 月 31 日用的是上一期）；
    年报晚于一季报公告时环比仍用一季报对年报；解禁只按可得日计入，被撤下的解禁在撤下之前的日子仍算已知；请求里没有任何禁用列、不用 ALL；深市两融没到齐的日子记为未完成并在之后的夜里补上。
19. **失败就关、不污染数据版本**：任一报表字段变了（9501）或单位不对时，那个数据集当晚不删不写、因子按过期规则为空、管理页看得到原因，整晚不失败；事件因子 SQL 出错时整晚照常提交；
    连续 3 晚失败有横幅，用到相关因子的回测与跟踪有提示；后台回填与补算不产生数据版本，`committedAsOf` 与 S13 的连续失败统计不受它们影响。
20. **旧结果不变**：升级到第 5 版行情仓并补完事件因子后，已有因子的值逐行一致；不用新因子的策略选股 SQL 文本不变；旧回测「复核数据」为「输入一致」、「完整重跑」逐笔一致；
    运行中的跟踪第一晚 0 漂移、不加计划版次；以前的个股证据校验值仍能复核通过；`--down 4` 之后 R4 的代码能正常算因子。
21. **新因子能用、能解释**：补完之后能用 7 个新因子写筛选与排序并回测；补完之前与起点早于数据起点时提前拒绝、不扣额度；`unlock_days > 90` 不会把没有解禁的股票排除；
    个股证据与「两融与筹码」卡里每项有来源、数据日与可得日，且都不晚于决策日；「4.8 万户」按精度核对。
22. **回填不停服务**：后台分段回填可以中断续跑、重跑幂等、避开 16:30–21:00，期间回测照常、读请求不会看到空窗口；补算一年一段、避开夜间时段；`--estimate` 用 4 次请求给出请求数与时长区间。
23. **没有 token 一切不变**：`TUSHARE_TOKEN` 为空时，对 Tushare 域名的请求数为 0，数据源链、运行卡（含新回测）、输入指纹、金标准与 S16 之前逐字节一致。
24. **token 不外泄**：token 不出现在任何日志、错误、`/internal/data-status`、管理页、运行卡或导出文件里（包括服务器把 token 回显的情况）；默认走 HTTPS，明文要显式打开且管理页有警示。
25. **能力按积分自动降级**：120 积分的 token 只开日线备用，其余能力显示「积分不足」，夜间任务照常成功；每分钟限频按 5 / 20 / 40 秒重试；每日额度用完后暂停到次日。
26. **日线备用不改复权、官方日历只管未来**：同一只股票由 Tushare 补和由东财补，入库的不复权价、成交量（股）、成交额（元）、复权因子一致，两种算法不一致时记数据问题；
    长假前最后一个交易日的明日计划日落在节后第一个交易日、依据「官方」，还没真正公布的年份退回休市日表，休市判断仍由 K 线与报价决定。
27. **早年沪市 ST 与财报日期**：回填后 2016 年起的 A 股回测不再出 `st_approx`（或只说没覆盖的那几只），2018 年以后的 `flag_st` 不变，夜间新改名的股票不丢早年历史；
    财报生效日按 D90 改写；回填脚本先列出影响的股票与跟踪，确认后才写。
28. **停牌与涨跌停**：官方停牌不计入「没成交激增」、不算缺口；规则表第 3 档的新回测在官方价与公式不一致的那天按官方价判断，第 1、2 档的运行与跟踪不受影响、输入指纹不变；
    管理页与 `tushare check-rules` 给出规则表核对结果。
29. **能说清来源、能复现**：用到 Tushare 数据的回测，运行卡有 `tokenSources` 与 `token_source` 提示，「复现信息」写明；把行情仓拷到一台没有 token 的机器上，「完整重跑」逐笔一致；
    回填前后的复核与漂移文案写明「新增了 Tushare 的…」。
30. **清除**：`tushare purge` 之后 Tushare 独有的表为空、停牌行改回缺失、财报生效日还原、受影响因子重算，日线保留并报出行数。
31. **导入**：同花顺（GBK 制表符、`="…"` 与标题行）、东方财富（UTF-8 BOM）、富途（英文、`HK.00700`、含美股行）、UTF-16、分号分隔、未知表头（列映射）的夹具都解析成预期的行；
    真 Excel 与网页格式给中文提示；`--` 与空值从不变成 0；`000001` 被吃成 `1` 时补零并警示，名字对不上时警示；ETF 与逆回购保留为不支持；预览不写库、文件名不在 URL 里。
32. **估值点时、失败即停**：港股按 ≤ D 且截到提交过的港股版本的中间价折算；汇率空档超过 14 天、比例未知的送转、没有 K 线的行都让整份「不完整」且不进合计；
    东财路径的 A 股 10 转 4 按 1.4 倍折算并提示；估值日早于快照日的账户不计入。
33. **风险数字可手算**：HHI、有效持股数、VaR / ES、β、风险贡献、最大回撤、卖出天数在手算夹具上逐项相等；观测不足时为空；同样的输入两次结果逐字节相同。
34. **超限与压力窗口**：恰好等于上限不报；`pnpm ivan stress-windows` 在生产行情仓上全部通过（不过的改端点），结果写进 probe-report；覆盖不足的窗口不出数字；页面有幸存者偏差说明。
35. **情景与证据**：情景「单只 10% 转现金」后前一大 = 10%、现金增加超出部分、对照表各行有值；没有超限时说明情景与现状相同；持仓证据卡的校验值能在证据弹窗里用同样的选项复核；
    策略视角与 `explainSelection` 一致；事件列在 S15b 的数据可用时有值。
36. **留底与回看**：每次新透视一条快照 + 一条账本 `xray`，两个指纹都相同才复用；改一根 K 线或改一个策略后「按现在的数据重算」显示「数据已修订」；「之后怎么样」给出 VaR 超出天数；
    导出文件能用 `verify-bundle` 校验。
37. **不越权与隐私**：所有持仓接口对别人的 id 返回 404；对话工具写不了持仓、策略、跟踪，`propose_holdings` 只写草稿，`get_portfolio_xray` 对账本只追加 `xray`；
    模型输出默认没有金额，提示词与卡片里没有加减仓建议；删除账户后快照、透视、对话里的持仓工具部件、草稿都没有持仓内容，链校验通过并显示清除条数；
    SQL 改或删持仓快照、透视快照（除清除外）报错，只设 `purged_at` 而没有清除条目会被链校验发现。
38. **性能**：jim-server 上 40 只、5 个策略、证据卡 30 行的一次透视 ≤ 8 秒，worker 内存增量 ≤ 50 MB；事件补算期间同时跑一个结算，峰值 RSS 仍满足验收 12。

## 风险（追加）

| 风险 | 缓解 |
|---|---|
| 东财报表字段或单位悄悄变了 | 每晚金丝雀用同一份列常量并做单位自检，失败就关；逐页核对键齐全、行数与重复行 |
| 回填 1.7–1.9 万次请求触发风控 | 沿用数据中心节奏、块内串行、每段 10 分钟、避开夜间时段；被封时照现有逻辑等解封，断点续跑 |
| 解禁的历史可得日是推算的 | 提前天数上线前按公告抽样实测；规则写进因子说明与 `event_avail_approx` 提示；每晚同步开始后用首次见到的日期 |
| `factors_daily` 加列与删列是重迁移 | 维护脚本停 worker 执行；在生产库副本上演练并记耗时；回滚前先删列 |
| 事件 SQL 在 512 MB 下内存吃紧 | 按年补算，必要时改半年（进度键支持任意块）；夜间填充是软步骤，失败保留旧值 |
| Tushare 积分门槛、错误代码出自文档或记忆 | 不写死门槛，靠返回自动关闭能力；错误先按文字分类；探针记下实测值 |
| Tushare 授权条款不允许转给第三方 | 由实例管理员配自己的 token；界面只展示由它算出的结果和少数证据项；提供清除命令 |
| `price_limits` 全量约 1600 万行 | 只有配了 token 并回填才有；只在规则表第 3 档时加载面板代码与区间；回填后复测验收 12 |
| Tushare 回填改写历史（早年 ST、财报生效日） | 只在管理员显式回填时发生；脚本先列影响面并要求确认；2018 年以后的 ST 不变；涨跌停只影响新运行；改写记数据版本，复核与漂移归因写明原因 |
| 券商导出格式随版本变 | 别名表 + 列映射兜底 + 上线前换成真实脱敏样本 |
| 持仓敏感 | 只按用户隔离、无管理员接口、模型默认看不到金额、工具输出不存金额、可删除且连对话里的卡片一起清除 |
| 压力窗口日期出自记忆 | 单测 + 命令行 + 每次透视运行时三重实测断言，页面只显示实测数 |
| 持仓证据卡在 worker 主线程上慢 | 8 秒预算上线前实测，超了就减少证据卡行数 |

## 实施清单（追加）

**R5（S15、S15b）**：S14 之后上线；上线后点时事件数据开始每晚积累，历史在后台补齐。

- [ ] S15 点时事件数据集：表、与来源无关的运行器、东财实现与金丝雀、夜间软步骤与周检补扫、后台分段回填（不开数据版本）与估算、管理页状态
- [ ] S15b 事件因子（注册表第 3 版、核心与事件分版本）、夜间软填充、按年补算、提前拒绝与提示、证据版本、个股证据第 2 版、「两融与筹码」卡与 `get_security_events`、数字核对第 2 版
- [ ] 人工：上线前 `pnpm ivan probe` 再跑一遍 4 条事件金丝雀；在巨潮资讯抽约 50 条非首发解禁公告定 `LOCKUP_NOTICE_LEAD_TD`，结果写进 docs/probe-report.md
- [ ] 人工：在生产行情仓副本上演练第 5 版升级（加 7 列）与 `--down 4`（删列），`DUCKDB_MEMORY_LIMIT=512MB`，记耗时
- [ ] 人工：jim-server 上 `pnpm ivan events --estimate` 后在管理页点「补齐历史数据」，记下实际请求数、时长与新表大小；补完后确认补算自动排上并完成
- [ ] 人工：补完后抽 3 只股票，对照东财网页核对融资余额、户数（公告日）、解禁日与大宗折价
- [ ] 人工：jim-server 上复测验收 12（同时跑一段事件补算）
- [ ] R5 落地记录

**R6（S16、S16b、S16c）**：可选；没有 token 的实例部署后行为不变。

- [ ] S16 Tushare 客户端与错误分类、能力状态、配置与保密（默认 HTTPS）、A 股日线备用与复权核对、官方交易日历、`tokenSources`、管理页、探针
- [ ] S16b 早年沪市 ST（夜间按代码整只替换）、财报实际披露日、回填脚本（先列影响面）、清除命令
- [ ] S16c 官方停牌进完整性闸门、交易所涨跌停价（规则表第 3 档）进引擎与体检、规则表夜间核对与 `check-rules`
- [ ] 人工（有 token 的管理员）：`pnpm ivan probe --tushare`，把实测的错误代码、积分门槛、分页、科创板成交量单位、HTTPS 能否使用写进 docs/probe-report.md
- [ ] 人工：确认 Tushare 的授权条款允许在自部署实例上给朋友看由它算出的结果；不允许就不配 token，或运行 `pnpm ivan tushare purge --yes`
- [ ] （Jim 决定）jim-server 是否配 token；配的话停 worker 后运行 `scripts/tushare-backfill.sh`，看完影响面再确认，记下耗时与行情仓增长，然后复测验收 12
- [ ] 人工：看一遍 `pnpm ivan tushare check-rules` 的输出，有不一致就逐条对照公告修正 S04 规则表
- [ ] R6 落地记录

**R7（S17、S17b、S17c）**

- [ ] S17 持仓：账户、只追加的快照、CSV 导入、点时估值（送转用同一个解析器）、偏好、删除与清除（含对话与草稿）、`propose_holdings` / `get_portfolio`、持仓页（持仓与记录）
- [ ] S17b 风险模块、透视输入、上限与超限、压力回放与 `stress-windows` 命令、透视快照与账本、`get_portfolio_xray`、概览与压力回放分页
- [ ] S17c 情景对照、证据可选项与持仓证据卡、`context_hash`、重算、之后怎么样、导出、`get_holding_evidence`、看板卡片
- [ ] 人工：收集同花顺、东方财富、富途（中、英文界面）各一份真实持仓导出，脱敏后替换合成夹具（上线前必须）
- [ ] 人工：生产行情仓上跑 `pnpm ivan stress-windows`（2015 年两个窗口与中证1000全收益断言要实测通过），结果写进 docs/probe-report.md
- [ ] 人工：jim-server 上测透视耗时（≤ 8 秒）与内存增量
- [ ] 文档对齐：README（两融与筹码、Tushare 一节与三个命令、持仓与风险透视、隐私与删除、已知局限）、DEPLOY（R5 迁移与回滚、Tushare 回填与清除、应用库触发器）、
      `.env.example`、设计系统 §7 / §8、docs/probe-report.md
- [ ] R7 落地记录

## 评审处理（第 3 稿，追加部分）

追加稿经过一轮评审，1 个阻断项与全部主要问题都已改进设计，次要问题全部采纳。阻断项：后台回填与补算原来每段提交一个 ok 数据版本，会把失败夜写了一半的因子「提交」出去，
并挤满 S13 读的近 20 个版本；改为不开数据版本、只记 `pit_batches`（D81）。主要问题的处理：

- 点时接口原来按东财的报表形状设计，改成 `fetchChunk` + `canary`。
- 户数环比原来按可得日 ASOF，会被晚公告的旧季度带回去，改成状态时间线。
- 撤下的解禁与户数原来物理删除，改成软删除。
- 覆盖起点原来按连续完成的块算，改成回填完成时设一次。
- 夜间事件填充原来是硬步骤，改成软步骤。
- 三个切片原来各改证据，改成统一的证据版本（D97）。
- Tushare 夜间简称原来会抹掉早年历史，改成按代码整只替换。
- 涨跌停价原来随数据出现而生效，会让跟踪漂移，改成规则表第 3 档（D89）；财报生效日改写会造成的漂移如实写明，回填前先确认。
- 送转原来只读 `corp_actions.split`，改用同一个解析器。
- 删除原来漏了对话与草稿，现在一起清除。
- 透视原来只有价格指纹，加了 `context_hash`。
- Tushare 原来默认走明文 HTTP，改为默认 HTTPS。
- S16、S17b 原来太大，拆成 S16–S16c、S17b–S17c。
- 切片依赖与夜间顺序原来不一致，统一成一份（§20 末尾）。


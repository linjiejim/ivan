/**
 * 应用库（SQLite，spec §12）。鉴权表（user / session / account / verification）由 better-auth 自己建，
 * 这里只放应用表。时间戳一律毫秒整数；交易日期一律 'YYYY-MM-DD' 文本（D14）。
 */
import { sql } from "drizzle-orm";
import {
  blob,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch() * 1000)`;
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

export const invites = sqliteTable(
  "invites",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull().default(now),
    expiresAt: integer("expires_at"),
    usedBy: text("used_by"),
    usedAt: integer("used_at"),
  },
  (t) => [uniqueIndex("invites_code").on(t.code)],
);

/** 每人每日额度覆盖（为空用实例默认值） */
export const userQuotas = sqliteTable("user_quotas", {
  userId: text("user_id").primaryKey(),
  chatMessages: integer("chat_messages"),
  backtests: integer("backtests"),
  /** 数据查询：复核、个股证据这类要 worker 组装数据的读请求（D59） */
  analyses: integer("analyses"),
});

export const usageDaily = sqliteTable(
  "usage_daily",
  {
    userId: text("user_id").notNull(),
    day: text("day").notNull(),
    chatMessages: integer("chat_messages").notNull().default(0),
    backtests: integer("backtests").notNull().default(0),
    analyses: integer("analyses").notNull().default(0),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

export const strategies = sqliteTable(
  "strategies",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    market: text("market").notNull(),
    currentVersionId: text("current_version_id"),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [index("strategies_user").on(t.userId)],
);

export const strategyVersions = sqliteTable(
  "strategy_versions",
  {
    id: text("id").primaryKey(),
    strategyId: text("strategy_id").notNull(),
    n: integer("n").notNull(),
    spec: json<Record<string, unknown>>("spec").notNull(),
    specHash: text("spec_hash").notNull(),
    note: text("note"),
    /** form | chat | preset | import */
    source: text("source").notNull().default("form"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("versions_strategy_n").on(t.strategyId, t.n)],
);

/** LLM 或表单提出的修改：用户在卡片上确认后才生效（D4、验收 6） */
export const drafts = sqliteTable(
  "drafts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** strategy | tracking | tracking_stop（停止跟踪，D68） */
    kind: text("kind").notNull(),
    strategyId: text("strategy_id"),
    baseVersionId: text("base_version_id"),
    payload: json<Record<string, unknown>>("payload").notNull(),
    summary: text("summary"),
    /** pending | confirmed | discarded */
    status: text("status").notNull().default("pending"),
    threadId: text("thread_id"),
    /** 确认后生成的版本 / 跟踪 id */
    resultId: text("result_id"),
    createdAt: integer("created_at").notNull().default(now),
    resolvedAt: integer("resolved_at"),
  },
  (t) => [index("drafts_user").on(t.userId)],
);

export const signalDatasets = sqliteTable("signal_datasets", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  market: text("market").notNull(),
  rows: json<Array<{ date: string; code: string }>>("rows").notNull(),
  count: integer("count").notNull(),
  createdAt: integer("created_at").notNull().default(now),
});

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    strategyId: text("strategy_id").notNull(),
    versionId: text("version_id").notNull(),
    /** backtest | sweep（参数扫描）| sweep_child（扫描的子回测）| reproduce（完整重跑，params.reproOf 指向原运行） */
    kind: text("kind").notNull().default("backtest"),
    parentId: text("parent_id"),
    label: text("label"),
    params: json<Record<string, unknown>>("params").notNull(),
    /** queued | running | done | failed */
    status: text("status").notNull().default("queued"),
    error: text("error"),
    dataVersion: integer("data_version"),
    dataAsOf: text("data_as_of"),
    engineVersion: text("engine_version"),
    metrics: json<Record<string, unknown>>("metrics"),
    segments: json<Record<string, unknown>>("segments"),
    checks: json<unknown[]>("checks"),
    attribution: json<Record<string, unknown>>("attribution"),
    final: json<Record<string, unknown>>("final"),
    /** 净值序列与持仓快照（deflate 压缩的 JSON） */
    seriesZ: blob("series_z", { mode: "buffer" }),
    holdingsZ: blob("holdings_z", { mode: "buffer" }),
    /** 运行卡（D57，@ivan/core RunCard）：策略、区间、成交假设、引擎、数据与输入指纹、结果指纹 */
    card: json<Record<string, unknown>>("card"),
    cardHash: text("card_hash"),
    inputHash: text("input_hash"),
    /** 最近一次复核（复核数据 / 完整重跑）的结果，写在原运行上 */
    verify: json<Record<string, unknown>>("verify"),
    /** 成交诊断（D64，@ivan/core SimDiagnostics）：拒单统计与样例、参与率、容量估计；更早的回测没有 */
    diagnostics: json<Record<string, unknown>>("diagnostics"),
    /** 可信度（D65，@ivan/core Confidence）：各项 95% 区间、跑赢基准的把握、方法与种子；只有指标第 2 版的新回测有 */
    validation: json<Record<string, unknown>>("validation"),
    /** 未来一年的净值扇形（@ivan/core Fan，deflate 压缩的 JSON） */
    validationZ: blob("validation_z", { mode: "buffer" }),
    createdAt: integer("created_at").notNull().default(now),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    index("runs_user").on(t.userId),
    index("runs_strategy").on(t.strategyId),
    index("runs_card_hash").on(t.cardHash),
  ],
);

export const runTrades = sqliteTable(
  "run_trades",
  {
    runId: text("run_id").notNull(),
    seq: integer("seq").notNull(),
    date: text("date").notNull(),
    code: text("code").notNull(),
    side: text("side").notNull(),
    price: real("price").notNull(),
    shares: real("shares").notNull(),
    amount: real("amount").notNull(),
    fee: real("fee").notNull(),
    reason: text("reason").notNull(),
    pnl: real("pnl"),
    holdDays: integer("hold_days"),
    /** 按流动性成交（D64）才有：参考价（开盘）、价差与冲击金额、成交金额 ÷ 决策日日均成交额 */
    ref: real("ref"),
    slip: real("slip"),
    part: real("part"),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] }), index("run_trades_code").on(t.runId, t.code)],
);

export const trackings = sqliteTable(
  "trackings",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    strategyId: text("strategy_id").notNull(),
    versionId: text("version_id").notNull(),
    market: text("market").notNull(),
    startDate: text("start_date").notNull(),
    capital: real("capital").notNull(),
    /** active | stopped */
    status: text("status").notNull().default("active"),
    /** 上线前最近一次回测，用来算「偏离百分位」 */
    baselineRunId: text("baseline_run_id"),
    lastDate: text("last_date"),
    lastNav: real("last_nav"),
    lastBench: real("last_bench"),
    /** 跟踪期超额在回测同长度窗口里的百分位 */
    deviationPct: real("deviation_pct"),
    summary: json<Record<string, unknown>>("summary"),
    /** 锁定的成交假设（D55）：上线时抄基准回测的 exec；迁移默认旧口径，现有跟踪全部是旧口径 */
    execConfig: json<Record<string, unknown>>("exec_config").notNull().default({ v: 1 }),
    createdAt: integer("created_at").notNull().default(now),
    stoppedAt: integer("stopped_at"),
  },
  (t) => [index("trackings_user").on(t.userId)],
);

export const trackingDays = sqliteTable(
  "tracking_days",
  {
    trackingId: text("tracking_id").notNull(),
    date: text("date").notNull(),
    nav: real("nav").notNull(),
    bench: real("bench").notNull(),
    cash: real("cash").notNull(),
    positions: integer("positions").notNull(),
  },
  (t) => [primaryKey({ columns: [t.trackingId, t.date] })],
);

/** 下一个交易日的计划买卖（每次结算整体替换） */
export const trackingOrders = sqliteTable(
  "tracking_orders",
  {
    trackingId: text("tracking_id").notNull(),
    planDate: text("plan_date").notNull(),
    code: text("code").notNull(),
    name: text("name"),
    side: text("side").notNull(),
    reason: text("reason").notNull(),
    /** 这条计划所在的快照（D68）；早于账本的行为空 */
    snapshotId: text("snapshot_id"),
  },
  (t) => [index("tracking_orders_t").on(t.trackingId)],
);

/**
 * 跟踪重放的成交与拒单（D68「重放成交留底」）：和 tracking_days 一样每晚整体重写，不是只追加。
 * 回溯页用它回答「这条计划按现在的数据重放执行得怎样」。
 */
export const trackingTrades = sqliteTable(
  "tracking_trades",
  {
    trackingId: text("tracking_id").notNull(),
    date: text("date").notNull(),
    seq: integer("seq").notNull(),
    code: text("code").notNull(),
    name: text("name"),
    side: text("side").notNull(),
    /** fill 成交 | reject 拒单（S05 的最近样例） */
    kind: text("kind").notNull(),
    price: real("price"),
    shares: real("shares"),
    /** 成交金额；拒单为没成交的金额 */
    amount: real("amount"),
    fee: real("fee"),
    /** 成交原因（entry、rebalance…）；拒单为空 */
    reason: text("reason"),
    /** 拒单原因（suspended、limit_up…） */
    rejectReason: text("reject_reason"),
  },
  (t) => [primaryKey({ columns: [t.trackingId, t.date, t.seq] })],
);

/**
 * 决策账本（D68）：每个用户一条只追加的哈希链。
 * hash = sha256Canonical({seq, prevHash, kind, subjectType, subjectId, asOf, payloadHash, createdAt})，
 * 第一条的 prevHash 是 64 个 0。三张只追加的表（本表、plan_snapshots、plan_items）有 BEFORE UPDATE / DELETE 触发器。
 */
export const ledgerEntries = sqliteTable(
  "ledger_entries",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    seq: integer("seq").notNull(),
    /** plan | replay_drift | tracking_start | tracking_stop | health_transition | brief */
    kind: text("kind").notNull(),
    /** tracking | user */
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    asOf: text("as_of"),
    /** plan_snapshots | brief_editions | inline */
    payloadTable: text("payload_table").notNull(),
    payloadId: text("payload_id"),
    /** inline 的内容（deflate 压缩的 JSON） */
    payloadZ: blob("payload_z", { mode: "buffer" }),
    payloadHash: text("payload_hash").notNull(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("ledger_user_seq").on(t.userId, t.seq),
    index("ledger_subject").on(t.subjectType, t.subjectId, t.asOf),
  ],
);

/**
 * 计划快照（D68）：每晚每个跟踪的明日计划与依据，按（跟踪, 决策日）分版次只追加；第 1 版是当晚用户看到的，永不改写。
 * 各维度的指纹都存下，任何人都能重算版次原因。
 */
export const planSnapshots = sqliteTable(
  "plan_snapshots",
  {
    id: text("id").primaryKey(),
    trackingId: text("tracking_id").notNull(),
    userId: text("user_id").notNull(),
    decisionDate: text("decision_date").notNull(),
    planDate: text("plan_date").notNull(),
    /** holiday_table | weekday */
    planDateBasis: text("plan_date_basis").notNull(),
    edition: integer("edition").notNull(),
    /** initial | data_revision | engine_change | upgrade | exec_change | rerun_same_inputs */
    cause: text("cause").notNull(),
    versionId: text("version_id").notNull(),
    specHash: text("spec_hash").notNull(),
    dataVersion: integer("data_version"),
    dataAsOf: text("data_as_of"),
    engineVersion: text("engine_version").notNull(),
    execHash: text("exec_hash").notNull(),
    /** 输入指纹（上线前的首日计划不跑模拟，为空） */
    inputHash: text("input_hash"),
    hashVersion: integer("hash_version").notNull(),
    /** 解释指纹：sha256Canonical({regime, candidates, codes})；信号模式没有选股解释，为空 */
    explainHash: text("explain_hash"),
    explainVersion: integer("explain_version"),
    factorRegistryVersion: integer("factor_registry_version"),
    regime: text("regime"),
    exposureCurrent: real("exposure_current"),
    exposureNext: real("exposure_next"),
    equity: real("equity"),
    cash: real("cash"),
    /** 持有名次线（前 top × buffer 名），「掉出前 N 名」用；信号模式为空 */
    band: integer("band"),
    benchSym: text("bench_sym"),
    /** 决策日的基准收盘（D79：计划结果回看的基准从这里起算） */
    benchClose: real("bench_close"),
    positionsZ: blob("positions_z", { mode: "buffer" }),
    candidatesZ: blob("candidates_z", { mode: "buffer" }),
    contentHash: text("content_hash").notNull(),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("plan_snapshots_edition").on(t.trackingId, t.decisionDate, t.edition),
    index("plan_snapshots_user").on(t.userId),
  ],
);

export const planItems = sqliteTable(
  "plan_items",
  {
    snapshotId: text("snapshot_id").notNull(),
    seq: integer("seq").notNull(),
    code: text("code").notNull(),
    name: text("name"),
    side: text("side").notNull(),
    reason: text("reason").notNull(),
    /** ranked_out | failed_filter | take_profit | stop_loss | max_hold | delisted | exposure | entry | signal */
    reasonDetail: text("reason_detail"),
    rank: integer("rank"),
    score: real("score"),
    estPrice: real("est_price"),
    estShares: real("est_shares"),
    estWeight: real("est_weight"),
    refClose: real("ref_close"),
    curWeight: real("cur_weight"),
    failedConditions: json<string[]>("failed_conditions"),
    /** 当时的因子值本身（不是引用，D68） */
    factors: json<Record<string, number | string | boolean | null>>("factors"),
    termPct: json<Record<string, number>>("term_pct"),
  },
  (t) => [primaryKey({ columns: [t.snapshotId, t.seq] })],
);

/**
 * 跟踪健康度读数（D70）：每个跟踪每个结算日一行，只追加（触发器见 0008）。同一晚重跑沿用已有的那一行，
 * 不重复计入历史；改阈值加 version，不改写历史读数。上线第一晚按已存的逐日净值补算的行 inputs.backfilled = true。
 */
export const trackingHealth = sqliteTable(
  "tracking_health",
  {
    trackingId: text("tracking_id").notNull(),
    date: text("date").notNull(),
    /** healthy | warning | decayed | critical | insufficient_data */
    signal: text("signal").notNull(),
    /** warming_up | active | monitoring | decayed */
    state: text("state").notNull(),
    /** 各指标的值与分级：{ beatBacktestPct?: {value, signal}, ddRatio?: {value, signal} } */
    perMetric: json<Record<string, unknown>>("per_metric").notNull(),
    /** 读数的输入：{ days, beatBacktestPct, trackingMaxDD, baselineMaxDD, backfilled? } */
    inputs: json<Record<string, unknown>>("inputs").notNull(),
    version: integer("version").notNull(),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.trackingId, t.date] })],
);

export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    title: text("title"),
    context: json<Record<string, unknown>>("context"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [index("threads_user").on(t.userId)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id").notNull(),
    role: text("role").notNull(),
    /** AI SDK UI message parts */
    parts: json<unknown[]>("parts").notNull(),
    /** 助手消息：{ inputTokens, outputTokens, model, grounding: { version, checked, unverified } }（D69）；用户消息为空 */
    usage: json<Record<string, unknown>>("usage"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("messages_thread").on(t.threadId, t.createdAt)],
);

export const briefs = sqliteTable(
  "briefs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    date: text("date").notNull(),
    facts: json<Record<string, unknown>>("facts").notNull(),
    content: text("content"),
    model: text("model"),
    /** 数字核对结果（D69，GROUNDING_VERSION 版）；没调 LLM 的简报为空 */
    grounding: json<Record<string, unknown>>("grounding"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("briefs_user_date").on(t.userId, t.date)],
);

/**
 * 简报版次（D70）：每次生成都加一版，只追加（触发器见 0008），并记一条账本 brief 指向它；
 * briefs 仍是看板读的「当前版」。「当时告诉了我什么」从这里原样拿出来。
 */
export const briefEditions = sqliteTable(
  "brief_editions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    date: text("date").notNull(),
    edition: integer("edition").notNull(),
    facts: json<Record<string, unknown>>("facts").notNull(),
    content: text("content"),
    model: text("model"),
    grounding: json<Record<string, unknown>>("grounding"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("brief_editions_edition").on(t.userId, t.date, t.edition)],
);

/** 后台任务（worker 执行，server 读进度推给前端） */
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    /** backtest | sweep | verify | etl | settle | brief | check | backfill */
    kind: text("kind").notNull(),
    userId: text("user_id"),
    payload: json<Record<string, unknown>>("payload").notNull(),
    /** queued | running | done | failed */
    status: text("status").notNull().default("queued"),
    progress: real("progress").notNull().default(0),
    note: text("note"),
    result: json<Record<string, unknown>>("result"),
    error: text("error"),
    createdAt: integer("created_at").notNull().default(now),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    /** 不早于这个时间（毫秒）才认领：自动重跑的夜间更新（D73）；空 = 随时 */
    notBefore: integer("not_before"),
    /** 第几次自动重跑（0 = 原任务，最多 2） */
    attempt: integer("attempt").notNull().default(0),
  },
  (t) => [index("jobs_status").on(t.status, t.createdAt), index("jobs_user").on(t.userId)],
);

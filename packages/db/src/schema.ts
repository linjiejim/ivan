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
});

export const usageDaily = sqliteTable(
  "usage_daily",
  {
    userId: text("user_id").notNull(),
    day: text("day").notNull(),
    chatMessages: integer("chat_messages").notNull().default(0),
    backtests: integer("backtests").notNull().default(0),
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
    /** strategy | tracking */
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
    /** backtest | sweep（参数扫描的子回测） */
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
    createdAt: integer("created_at").notNull().default(now),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("runs_user").on(t.userId), index("runs_strategy").on(t.strategyId)],
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
  },
  (t) => [index("tracking_orders_t").on(t.trackingId)],
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
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("briefs_user_date").on(t.userId, t.date)],
);

/** 后台任务（worker 执行，server 读进度推给前端） */
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    /** backtest | sweep | etl | settle | brief | backfill */
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
  },
  (t) => [index("jobs_status").on(t.status, t.createdAt), index("jobs_user").on(t.userId)],
);

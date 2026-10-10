/**
 * 决策回溯（D71）：跟踪页「回溯」分页的数据。
 *
 * - 时间线：本跟踪的账本条目（计划、重放差异、状态变化、上线、停止）加上跟踪存续期间这个用户的简报条目，按日期倒序；
 * - 那天看到的计划：第 1 版（当晚看到的）对最新版（diffPlans），第 1 版每项按现在的数据重放执行得怎样（tracking_trades），
 *   之后的数据修订有没有波及这晚（replay_drift 的首个漂移日 ≤ 计划日），5 / 20 天后怎么样（只用提交过的数据，D79）；
 * - 链校验：重算这个用户的整条链；
 * - 导出：自描述的 JSON（packages/db 的 buildTraceBundle），别的跟踪与简报只给哈希。
 * 归属一律按跟踪的 user_id 校验，不是自己的 404。
 */
import {
  EVENT_FACTOR_VERSION,
  EVIDENCE_VERSION,
  EXPLAIN_VERSION,
  FACTOR_CORE_VERSION,
  FACTOR_REGISTRY_VERSION,
  HASH_VERSION,
  HEALTH_STATE_TEXT,
  HEALTH_VERSION,
  type HealthState,
  isDateStr,
  type Market,
  nextTradingDay,
  PLAN_CAUSE_TEXT,
  type PlanCause,
  type RejectReason,
  resolveExec,
  todayCN,
} from "@ivan/core";
import { GROUNDING_VERSION } from "@ivan/ai";
import {
  briefEditions,
  buildTraceBundle,
  type BundleManifest,
  ledgerEntries,
  planSnapshots,
  runs,
  strategyVersions,
  type TraceBundle,
  trackingTrades,
  unpackJson,
  verifyUserChain,
} from "@ivan/db";
import { diffPlans, ENGINE_VERSION, VALIDATION_VERSION } from "@ivan/engine";
import { and, desc, eq, gt, gte, inArray, lte, or } from "drizzle-orm";
import { env } from "../env.ts";
import { AppError } from "../lib/errors.ts";
import {
  cachedPlanOutcomes,
  findSnapshot,
  type PlanOutcome,
  type PlanSnapshotView,
} from "./plans.ts";
import { cachedDataStatus } from "./runs.ts";
import { own } from "./trackings.ts";

export type LedgerKindView =
  "plan" | "replay_drift" | "tracking_start" | "tracking_stop" | "health_transition" | "brief";

export interface LedgerEntryView {
  seq: number;
  kind: LedgerKindView;
  asOf: string | null;
  hash8: string;
  summary: string;
  /** 计划快照 id、简报版次 id；inline 条目为空 */
  refId: string | null;
  /** 计划与简报的版次（时间线上第 2 版起的计划显示「修订」） */
  edition: number | null;
}

const DRIFT_CAUSE_TEXT: Record<string, string> = {
  data: "数据修订",
  engine: "引擎变更",
  exec: "成交假设变更",
  unrecorded: "早于记录（分不清数据还是引擎）",
  unexplained: "原因不明",
};

const DAY = 86_400_000;
const MAX_LIMIT = 200;

/**
 * 时间线：本跟踪的条目 + 跟踪存续期间（上线确认到停止后一天）的简报条目；按日期倒序，同一天按序号倒序。
 * from / to 按条目日期（as_of）筛；hasMore 表示这一段还没取完（再取时把 to 设成最早一条的日期，前端按 seq 去重）。
 */
export function listEntries(
  userId: string,
  trackingId: string,
  o: { from?: string; to?: string; limit?: number } = {},
): { entries: LedgerEntryView[]; hasMore: boolean } {
  const { t } = own(userId, trackingId);
  for (const d of [o.from, o.to]) {
    if (d && !isDateStr(d)) throw new AppError(400, "日期格式要是 YYYY-MM-DD");
  }
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(o.limit ?? 100)));
  const { db } = env().app;
  const briefWindow = and(
    eq(ledgerEntries.kind, "brief"),
    eq(ledgerEntries.subjectType, "user"),
    eq(ledgerEntries.subjectId, userId),
    gte(ledgerEntries.createdAt, t.createdAt),
    t.stoppedAt ? lte(ledgerEntries.createdAt, t.stoppedAt + DAY) : undefined,
  );
  const rows = db
    .select()
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.userId, userId),
        or(
          and(eq(ledgerEntries.subjectType, "tracking"), eq(ledgerEntries.subjectId, trackingId)),
          briefWindow,
        ),
        o.from ? gte(ledgerEntries.asOf, o.from) : undefined,
        o.to ? lte(ledgerEntries.asOf, o.to) : undefined,
      ),
    )
    .orderBy(desc(ledgerEntries.asOf), desc(ledgerEntries.seq))
    .limit(limit + 1)
    .all();
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const ids = (table: string) =>
    page.filter((r) => r.payloadTable === table && r.payloadId).map((r) => r.payloadId!);
  const planIds = ids("plan_snapshots");
  const plans = new Map(
    planIds.length
      ? db
          .select({
            id: planSnapshots.id,
            edition: planSnapshots.edition,
            cause: planSnapshots.cause,
          })
          .from(planSnapshots)
          .where(inArray(planSnapshots.id, planIds))
          .all()
          .map((p) => [p.id, p])
      : [],
  );
  const briefIds = ids("brief_editions");
  const briefs = new Map(
    briefIds.length
      ? db
          .select({ id: briefEditions.id, edition: briefEditions.edition })
          .from(briefEditions)
          .where(inArray(briefEditions.id, briefIds))
          .all()
          .map((b) => [b.id, b.edition])
      : [],
  );
  const entries = page.map((r): LedgerEntryView => {
    const payload = (
      r.payloadZ ? (unpackJson<Record<string, unknown>>(r.payloadZ) ?? {}) : {}
    ) as Record<string, unknown>;
    let summary: string;
    let edition: number | null = null;
    switch (r.kind) {
      case "plan": {
        const p = plans.get(r.payloadId ?? "");
        edition = p?.edition ?? null;
        summary = p
          ? `计划 第 ${p.edition} 版（${PLAN_CAUSE_TEXT[p.cause as PlanCause] ?? p.cause}）`
          : "计划";
        break;
      }
      case "replay_drift": {
        const cause = String(payload.cause ?? "");
        summary = `重放差异：${DRIFT_CAUSE_TEXT[cause] ?? (cause || "原因未记录")}`;
        if (typeof payload.firstDrift === "string") summary += `，最早影响 ${payload.firstDrift}`;
        break;
      }
      case "health_transition": {
        const text = (s: unknown) => HEALTH_STATE_TEXT[s as HealthState] ?? String(s ?? "--");
        const reason =
          typeof payload.reason === "string" && payload.reason ? `（${payload.reason}）` : "";
        summary = `状态 ${text(payload.from)} → ${text(payload.to)}${reason}`;
        break;
      }
      case "brief": {
        edition = briefs.get(r.payloadId ?? "") ?? null;
        summary = edition ? `简报 第 ${edition} 版` : "简报";
        break;
      }
      case "tracking_start":
        summary = "上线";
        break;
      case "tracking_stop":
        summary =
          typeof payload.reason === "string" && payload.reason ? `停止：${payload.reason}` : "停止";
        break;
      default:
        summary = r.kind;
    }
    return {
      seq: r.seq,
      kind: r.kind as LedgerKindView,
      asOf: r.asOf,
      hash8: r.hash.slice(0, 8),
      summary,
      refId: r.payloadId,
      edition,
    };
  });
  return { entries, hasMore };
}

/** 重算的结果按（链头、条数）缓存 1 分钟：不计额度的按钮，反复点不让整条链在请求线程里一遍遍重算 */
const VERIFY_TTL_MS = 60_000;
const verifyCache = new Map<
  string,
  { key: string; at: number; value: { ok: boolean; checked: number; firstBreak: unknown } }
>();

/** 重算当前用户的整条链 */
export function verifyUser(userId: string) {
  const { app } = env();
  const head = app.sqlite
    .prepare(`SELECT max(seq) AS s, count(*) AS n FROM ledger_entries WHERE user_id = ?`)
    .get(userId) as { s: number | null; n: number };
  const key = `${head.s}:${head.n}`;
  const hit = verifyCache.get(userId);
  if (hit && hit.key === key && Date.now() - hit.at < VERIFY_TTL_MS) return hit.value;
  const v = verifyUserChain(app, userId);
  const value = { ok: v.ok, checked: v.checked, firstBreak: v.firstBreak ?? null };
  verifyCache.set(userId, { key, at: Date.now(), value });
  return value;
}

export type ReplayOutcome = "filled" | "rejected" | "not_executed";

export interface ReplayView {
  code: string;
  side: string;
  outcome: ReplayOutcome;
  price: number | null;
  rejectReason: RejectReason | null;
}

/** 计划日之后第 n 个交易日（按休市日表，没有那一年时按工作日） */
function tradingDaysAfter(market: Market, d: string, n: number): string {
  let x = d;
  for (let i = 0; i < n; i++) x = nextTradingDay(market, x).date;
  return x;
}

/**
 * 那天看到的计划：date 是决策日（或计划日；没有那晚取之前最近的一晚）；不给取最近一晚。没有快照时 null。
 * - replay：按现在的数据重放，第 1 版每项在计划日成交 / 拒单 / 没有执行；计划日还没结算（晚于跟踪的最后结算日）时为 null；
 * - revisedAfter：有一条之后某晚（asOf 晚于决策日）结算记下的 replay_drift，首个漂移日 ≤ 计划日；
 *   当晚的结算先写当晚计划再记重放差异（asOf = 决策日），那时第 1 版已经按修订后的数据算过，不算；
 * - outcomes：决策日之后满 5 个交易日（按提交过的数据日）才去 worker 算，否则 null；与第 1 版的计划项按顺序对应。
 */
export async function planOn(userId: string, trackingId: string, date?: string) {
  const { t } = own(userId, trackingId);
  if (date && !isDateStr(date)) throw new AppError(400, "日期格式要是 YYYY-MM-DD");
  const edition1 = findSnapshot(userId, trackingId, { date, edition: 1 });
  if (!edition1) return null;
  const latest = findSnapshot(userId, trackingId, { date: edition1.decisionDate })!;
  const lite = (s: PlanSnapshotView) =>
    s.items.map((i) => ({
      code: i.code,
      name: i.name,
      side: i.side,
      rank: i.rank,
      estWeight: i.estWeight,
      reasonDetail: i.reasonDetail,
    }));
  const { db } = env().app;
  let replay: ReplayView[] | null = null;
  if (t.lastDate && edition1.planDate <= t.lastDate) {
    const trades = db
      .select()
      .from(trackingTrades)
      .where(
        and(eq(trackingTrades.trackingId, trackingId), eq(trackingTrades.date, edition1.planDate)),
      )
      .all();
    replay = edition1.items.map((i) => {
      const mine = trades.filter((x) => x.code === i.code && x.side === i.side);
      const fill = mine.find((x) => x.kind === "fill");
      const reject = mine.find((x) => x.kind === "reject");
      return {
        code: i.code,
        side: i.side,
        outcome: fill ? "filled" : reject ? "rejected" : "not_executed",
        price: fill?.price ?? null,
        rejectReason: (reject?.rejectReason as RejectReason | null | undefined) ?? null,
      };
    });
  }
  const drifts = db
    .select({ z: ledgerEntries.payloadZ, createdAt: ledgerEntries.createdAt })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.userId, userId),
        eq(ledgerEntries.kind, "replay_drift"),
        eq(ledgerEntries.subjectType, "tracking"),
        eq(ledgerEntries.subjectId, trackingId),
        gte(ledgerEntries.createdAt, edition1.createdAt),
        gt(ledgerEntries.asOf, edition1.decisionDate),
      ),
    )
    .all();
  const revisedAfter = drifts.some((d) => {
    const p = d.z ? unpackJson<{ firstDrift?: unknown }>(d.z) : null;
    return typeof p?.firstDrift === "string" && p.firstDrift <= edition1.planDate;
  });
  return {
    decisionDate: edition1.decisionDate,
    planDate: edition1.planDate,
    edition1,
    latest,
    diff: diffPlans(lite(edition1), lite(latest)),
    cause: latest.cause,
    causeText: latest.causeText,
    replay,
    revisedAfter,
    outcomes: await outcomesFor(t.market as Market, edition1),
  };
}

export type PlanOnView = NonNullable<Awaited<ReturnType<typeof planOn>>>;

async function outcomesFor(market: Market, s: PlanSnapshotView): Promise<PlanOutcome[] | null> {
  if (!s.benchSym || !s.items.length) return null;
  // 数据状态与结果都走缓存（不计额度的页面，反复打开不让 worker 一遍遍查行情仓）
  const asOf = (await cachedDataStatus())?.markets?.find((m) => m.market === market)?.asOf ?? null;
  if (!asOf || tradingDaysAfter(market, s.decisionDate, 5) > asOf) return null;
  try {
    return (await cachedPlanOutcomes(s, market)).outcomes;
  } catch {
    // worker 不在或算不出：这一列显示「--」，不让整块报错
    return null;
  }
}

/** 各算法的版本清单（导出文件的 manifest；不含时间戳） */
export function manifest(): BundleManifest {
  return {
    engineVersion: ENGINE_VERSION,
    factorRegistryVersion: FACTOR_REGISTRY_VERSION,
    explainVersion: EXPLAIN_VERSION,
    groundingVersion: GROUNDING_VERSION,
    healthVersion: HEALTH_VERSION,
    validationVersion: VALIDATION_VERSION,
    hashVersion: HASH_VERSION,
    factorCoreVersion: FACTOR_CORE_VERSION,
    eventFactorVersion: EVENT_FACTOR_VERSION,
    evidenceVersion: EVIDENCE_VERSION,
  };
}

/** 导出一个跟踪的决策记录（D71）：文件名 ivan-trace-<id>-<date>.json */
export function exportTracking(
  userId: string,
  trackingId: string,
): { filename: string; bundle: TraceBundle } {
  const { t, name } = own(userId, trackingId);
  const { db } = env().app;
  const v = db
    .select({ spec: strategyVersions.spec, specHash: strategyVersions.specHash })
    .from(strategyVersions)
    .where(eq(strategyVersions.id, t.versionId))
    .get();
  const run = t.baselineRunId
    ? db
        .select({ id: runs.id, params: runs.params, card: runs.card, userId: runs.userId })
        .from(runs)
        .where(eq(runs.id, t.baselineRunId))
        .get()
    : undefined;
  let exec: unknown = t.execConfig;
  try {
    exec = resolveExec(t.execConfig);
  } catch {
    // 读不懂的成交假设原样导出
  }
  const bundle = buildTraceBundle(env().app, {
    userId,
    trackingId,
    tracking: {
      id: t.id,
      strategyName: name,
      versionId: t.versionId,
      specHash: v?.specHash ?? "",
      spec: v?.spec ?? null,
      startDate: t.startDate,
      capital: t.capital,
      exec,
    },
    baselineRun:
      run && run.userId === userId
        ? { id: run.id, params: run.params, card: run.card ?? null }
        : null,
    manifest: manifest(),
  });
  return { filename: `ivan-trace-${t.id}-${todayCN()}.json`, bundle };
}

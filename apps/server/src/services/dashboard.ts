/**
 * 首页看板（spec §11）：全部从库里确定性渲染，LLM 只写简报那一段。
 */
import { describeSpec, PRESETS, validateSpec } from "@ivan/core";
import { briefs, COMPUTE_PAUSED_TEXT, trackingDays } from "@ivan/db";
import { asc, desc, eq, sql } from "drizzle-orm";
import { env } from "../env.ts";
import { worker } from "../lib/worker-client.ts";
import { listRuns } from "./runs.ts";
import { baselineHeadline, listTrackings, todaySignals, verdictView } from "./trackings.ts";

export interface DataStatus {
  markets: Array<{
    market: string;
    asOf: string | null;
    dataVersion: number | null;
    /**
     * 最近一次 etl 任务。排着队等自动重跑时（D73）：status = queued，retryAt 是重跑时间，attempt 是第几次，
     * error 是上一次失败的原因
     */
    lastEtl: {
      status: string;
      finishedAt: number | null;
      error: string | null;
      attempt?: number;
      retryAt?: number | null;
    } | null;
    /** 今天的状态（D78）：已更新 / 休市 / 没更新 / 进行中 */
    day?: "traded" | "closed" | "stale" | "pending";
    /** 正在写的数据版本（D60）；startedAt 是毫秒时间戳 */
    openVersion?: { id: number; startedAt: number | null } | null;
    /** 上一个结束的版本：ok | incomplete | failed | skipped */
    lastVersionStatus?: string | null;
    /** 各基准（index_bars 的 sym）的首个数据日，一行都没有为 null（D75）：提交回测前校验 */
    benchFirstDates?: Record<string, string | null>;
    /** 港股通名单（D77，只有港股）：取并集的属性与首次记录日；一行都没有为 null */
    hkConnect?: { attrs: string[]; firstDate: string } | null;
    /** 点时数据的采集情况（D61） */
    capture?: {
      attrs: Array<{
        attr: string;
        firstDate: string | null;
        openRows: number;
        changes7d: number;
        lastSkipped: { date: string; pct: number } | null;
      }>;
      financialsSeen: { rows: number; new7d: number };
    };
    /** 最近一晚的取数来源（D72）：served 的键是行级来源代码 em / tx / txq / csi */
    sources?: {
      versionId: number;
      status: string;
      date: string | null;
      served: Record<string, number>;
      fallbacks: number;
      failed: number;
      empty: number;
      index: Record<string, string>;
      /** 夜间的点时事件数据集（S15）：由谁给的、几次请求、写了几行 */
      datasets?: Record<string, { servedBy: string | null; requests: number; rows: number }>;
    } | null;
    /** 辅助数据（汇率、证券表、简称、财报）最近成功的日子与连续失败的晚数（D73） */
    soft?: Array<{
      step: string;
      lastOkDate: string | null;
      failingNights: number;
      firstFailDate: string | null;
    }>;
  }>;
  /** 行情仓维护中（还没升级，D76）：非空时 worker 不排任务、不认领 */
  maintenance?: string | null;
  /** 夜间更新写库期间回测暂停（D60）：reason = etl | check */
  computePaused?: { reason: string; since: number } | null;
  /** 点时事件数据（S15，只有 A 股）：各数据集的同步状态与金丝雀、后台回填进度 */
  events?: EventsStatus;
  /** 事件因子（S15b）各自的数据起点与是否补算完成（提交回测前校验；编辑器、list_factors 显示） */
  factorCoverage?: Record<string, { from: string | null; ready: boolean }>;
  /** 事件因子列的补算进度（管理页「事件因子：补算中（x / y 年）」） */
  eventFactors?: EventFactorsStatus;
  workerUp: boolean;
  /** 这个用户的跟踪最近一次结算失败的（D70；看板才有，按用户算） */
  settleFailures?: Array<{ trackingId: string; name: string; date: string; message: string }>;
}

/** 一个点时事件数据集的同步状态（worker pit_sync + 软步骤连续失败晚数） */
export interface EventDatasetStatus {
  label: string;
  backfillFrom: string | null;
  /** 回填全部完成后才有：数据自哪天起 */
  coveredFrom: string | null;
  /** 两融、大宗：最后一个完整的数据日 */
  windowThrough: string | null;
  /** 最近一次成功同步的日子 */
  syncedAt: string | null;
  nightlySince: string | null;
  lastOkAt: string | null;
  /** ok | partial | canary_failed | failed | blocked */
  lastStatus: string | null;
  lastDetail: string | null;
  canary: { status: string; source: string; at: string; detail: string } | null;
  rows: number;
  failingNights: number;
}

export interface EventFactorsStatus {
  v: number;
  sig: string;
  complete: boolean;
  doneYears: number;
  totalYears: number;
  /** S15 的历史回填完成了（四个数据集都有覆盖起点） */
  backfillComplete?: boolean;
}

export interface EventsStatus {
  datasets: Record<string, EventDatasetStatus>;
  backfill: {
    /** idle | queued | running */
    status: string;
    notBefore: number | null;
    progress: Record<string, { done: number; total: number }>;
    lastBatch: {
      id: number;
      startedAt: string | null;
      finishedAt: string | null;
      status: string | null;
      note: string | null;
      rows: number | null;
      requests: number | null;
    } | null;
  };
}

/** 管理页「数据质量」卡（D74，worker /internal/data-quality） */
export interface DataQuality {
  days: number;
  byRule: Array<{ rule: string; severity: string; n: number; open: number }>;
  topCodes: Array<{ code: string; name: string | null; n: number }>;
  open: Array<{
    id: number;
    code: string;
    name: string | null;
    date: string;
    rule: string;
    severity: string;
    detail: string | null;
  }>;
  lastVersions: Array<{
    id: number;
    market: string;
    status: string;
    date: string | null;
    expected: number | null;
    updated: number | null;
    noTrade: number | null;
    missing: number;
    missingCritical: number;
    accepted: number;
    reasons: string[];
  }>;
}

export async function dataStatus(): Promise<DataStatus> {
  try {
    return {
      ...(await worker.get<Omit<DataStatus, "workerUp">>("/internal/data-status")),
      workerUp: true,
    };
  } catch {
    return { markets: [], workerUp: false };
  }
}

/**
 * 看板概览（对话工具 get_overview 用）：各运行中跟踪的现状、明日计划、最新简报、数据截至。
 * 和首页看板同一份数据，只是更紧凑，数字全部来自库。
 */
export async function overview(userId: string) {
  const { db } = env().app;
  const data = await dataStatus();
  const brief = db
    .select({ date: briefs.date, content: briefs.content })
    .from(briefs)
    .where(eq(briefs.userId, userId))
    .orderBy(desc(briefs.date))
    .get();
  const trackings = listTrackings(userId, { activeOnly: true }).map((t) => ({
    id: t.id,
    strategyName: t.strategyName,
    ...verdictView(t, data),
    market: t.market,
    startDate: t.startDate,
    days:
      db
        .select({ n: sql<number>`count(*)` })
        .from(trackingDays)
        .where(eq(trackingDays.trackingId, t.id))
        .get()?.n ?? 0,
    lastDate: t.lastDate,
    excess: t.excess,
    deviationPct: t.deviationPct,
    baseline: baselineHeadline(t.baselineRunId),
  }));
  const plans = todaySignals(userId).map((s) => ({
    trackingId: s.trackingId,
    strategyName: s.strategyName,
    planDate: s.orders[0]?.planDate ?? "",
    buys: s.orders.filter((o) => o.side === "buy").map((o) => o.name ?? o.code),
    sells: s.orders.filter((o) => o.side === "sell").map((o) => o.name ?? o.code),
  }));
  return {
    dataAsOf: Object.fromEntries(data.markets.map((m) => [m.market, m.asOf])) as Record<
      string,
      string | null
    >,
    // 最近一次更新失败，或排着队等自动重跑（D73）
    failedMarkets: data.markets
      .filter((m) => m.lastEtl?.status === "failed" || m.lastEtl?.retryAt)
      .map((m) => m.market),
    workerUp: data.workerUp,
    // 行情仓维护中（D76）、夜间更新写库期间回测暂停（D60）：模型据此解释为什么回测还在排队
    maintenance: data.maintenance ?? null,
    computePaused: data.computePaused ? COMPUTE_PAUSED_TEXT : null,
    brief: brief ?? null,
    trackings,
    plans,
  };
}

/**
 * 看板给的数据状态：只留横幅用得到的（市场、截至日、数据版本、今天的状态、更新失败或等重跑、维护中、回测暂停）。
 * 来源占比、金丝雀、软步骤、采集情况、回填批次这类诊断只给管理页（/api/admin/data）；
 * 失败原因与维护说明的原文只给管理员（普通用户看到「失败」「维护中」）。
 */
export function dashboardDataStatus(d: DataStatus, admin: boolean): DataStatus {
  return {
    markets: d.markets.map((m) => ({
      market: m.market,
      asOf: m.asOf,
      dataVersion: m.dataVersion,
      lastEtl: m.lastEtl
        ? {
            status: m.lastEtl.status,
            finishedAt: m.lastEtl.finishedAt,
            error: admin ? m.lastEtl.error : null,
            ...(m.lastEtl.attempt !== undefined ? { attempt: m.lastEtl.attempt } : {}),
            ...(m.lastEtl.retryAt !== undefined ? { retryAt: m.lastEtl.retryAt } : {}),
          }
        : null,
      ...(m.day ? { day: m.day } : {}),
    })),
    maintenance: d.maintenance ? (admin ? d.maintenance : "行情仓维护中") : null,
    computePaused: d.computePaused
      ? { reason: d.computePaused.reason, since: d.computePaused.since }
      : null,
    workerUp: d.workerUp,
  };
}

export async function dashboard(userId: string, o: { admin?: boolean } = {}) {
  const { db } = env().app;
  const data = await dataStatus();
  const brief = db
    .select()
    .from(briefs)
    .where(eq(briefs.userId, userId))
    .orderBy(desc(briefs.date))
    .get();
  const trackings = listTrackings(userId, { activeOnly: true }).map((t) => {
    const days = db
      .select({ date: trackingDays.date, nav: trackingDays.nav, bench: trackingDays.bench })
      .from(trackingDays)
      .where(eq(trackingDays.trackingId, t.id))
      .orderBy(asc(trackingDays.date))
      .all();
    return {
      ...t,
      ...verdictView(t, data),
      days: days.length,
      spark: days.slice(-60).map((d) => d.nav / d.bench),
      baseline: baselineHeadline(t.baselineRunId),
    };
  });
  // 结算失败不只进日志（D70）：数据横幅按跟踪列出来
  const settleFailures = trackings.flatMap((t) =>
    t.lastError
      ? [
          {
            trackingId: t.id,
            name: t.strategyName,
            date: t.lastError.date,
            message: t.lastError.message,
          },
        ]
      : [],
  );
  return {
    brief: brief ? { date: brief.date, content: brief.content, facts: brief.facts } : null,
    trackings,
    signals: todaySignals(userId),
    recentRuns: listRuns(userId, { limit: 5 }),
    data: { ...dashboardDataStatus(data, o.admin ?? false), settleFailures },
    presets: PRESETS.map((p) => ({
      id: p.id,
      market: p.market,
      title: p.title,
      blurb: p.blurb,
      describe: describeSpec(validateSpec(p.spec).spec!),
    })),
  };
}

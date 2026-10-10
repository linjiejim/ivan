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
    lastEtl: { status: string; finishedAt: number | null; error: string | null } | null;
    /** 今天的状态（D78）：已更新 / 休市 / 没更新 / 进行中 */
    day?: "traded" | "closed" | "stale" | "pending";
    /** 正在写的数据版本（D60）；startedAt 是毫秒时间戳 */
    openVersion?: { id: number; startedAt: number | null } | null;
    /** 上一个结束的版本：ok | incomplete | failed | skipped */
    lastVersionStatus?: string | null;
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
  }>;
  /** 行情仓维护中（还没升级，D76）：非空时 worker 不排任务、不认领 */
  maintenance?: string | null;
  /** 夜间更新写库期间回测暂停（D60）：reason = etl | check */
  computePaused?: { reason: string; since: number } | null;
  workerUp: boolean;
  /** 这个用户的跟踪最近一次结算失败的（D70；看板才有，按用户算） */
  settleFailures?: Array<{ trackingId: string; name: string; date: string; message: string }>;
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
    failedMarkets: data.markets.filter((m) => m.lastEtl?.status === "failed").map((m) => m.market),
    workerUp: data.workerUp,
    // 行情仓维护中（D76）、夜间更新写库期间回测暂停（D60）：模型据此解释为什么回测还在排队
    maintenance: data.maintenance ?? null,
    computePaused: data.computePaused ? COMPUTE_PAUSED_TEXT : null,
    brief: brief ?? null,
    trackings,
    plans,
  };
}

export async function dashboard(userId: string) {
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
    data: { ...data, settleFailures },
    presets: PRESETS.map((p) => ({
      id: p.id,
      market: p.market,
      title: p.title,
      blurb: p.blurb,
      describe: describeSpec(validateSpec(p.spec).spec!),
    })),
  };
}

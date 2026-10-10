/**
 * 向前跟踪结算（spec §7，D13）：每个运行中的跟踪都从上线日重放到最新交易日——和回测同一个 simulate，
 * 规则只在一处实现；每天整体重写 tracking_days 与明日计划，数据修订（如全收益基准晚到）会自动被修正。
 *
 * 跟踪锁定上线时的成交假设（D55）；重放与上一晚不一致时用前缀指纹归因（D57）：按上一晚的最后结算日、
 * 「执行日 ≤ cut」重算前缀，和上一晚存的比。整窗指纹每晚都会变（窗口变长），不能拿来比。
 */
import {
  type Market,
  resolveExec,
  type SeriesPoint,
  type StrategySpec,
  validateSpec,
} from "@ivan/core";
import { sha256Canonical } from "@ivan/core/node";
import { buildSimInput, committedAsOf, HASH_VERSION, hashSimInput, screenOn } from "@ivan/data";
import {
  attributeDrift,
  BACKTEST_ONLY_CHECKS,
  compareReplay,
  deviationPercentile,
} from "@ivan/engine";
import {
  runs,
  strategyVersions,
  trackingDays,
  trackingOrders,
  trackings,
  unpackJson,
} from "@ivan/db";
import { and, eq } from "drizzle-orm";
import { env } from "../env.ts";
import type { JobContext } from "../runner.ts";
import { runSimulation } from "../sim-pool.ts";

type TrackingRow = typeof trackings.$inferSelect;

async function settleOne(t: TrackingRow, latest: string, ctx: JobContext): Promise<void> {
  const { db, sqlite } = env().app;
  const { wh } = env();
  const raw = db
    .select()
    .from(strategyVersions)
    .where(eq(strategyVersions.id, t.versionId))
    .get()?.spec;
  const v = validateSpec(raw);
  if (!v.spec) throw new Error(`跟踪 ${t.id} 的策略版本不合法`);
  const spec: StrategySpec = v.spec;

  // 刚上线、还没到第一个交易日：只给出首日建仓计划
  if (t.startDate > latest) {
    const top = spec.rank?.top ?? 10;
    const picks = spec.mode === "rules" ? await screenOn(wh, spec, latest, top) : [];
    sqlite.transaction(() => {
      db.delete(trackingOrders).where(eq(trackingOrders.trackingId, t.id)).run();
      for (const p of picks) {
        db.insert(trackingOrders)
          .values({
            trackingId: t.id,
            planDate: t.startDate,
            code: p.code,
            name: p.name,
            side: "buy",
            reason: "entry",
          })
          .run();
      }
      db.update(trackings)
        .set({ summary: { waitingForStart: true, planFor: t.startDate } })
        .where(eq(trackings.id, t.id))
        .run();
    })();
    return;
  }

  const exec = resolveExec(t.execConfig);
  const built = await buildSimInput(
    wh,
    spec,
    { start: t.startDate, end: latest, capital: t.capital, oosMonths: 0, exec },
    { appendNextDay: true },
  );
  const planDate = built.input.calendar.at(-1)!;
  // 上一晚存下的指纹；今晚的指纹都要在转交线程之前算
  const prev = (t.summary ?? {}) as {
    engineVersion?: string;
    execHash?: string;
    prefixHash?: string;
    hashVersion?: number;
    lastDate?: string;
  };
  // 今晚的最后结算日：日历上最后一个 ≤ latest 的交易日（就是重放序列的最后一天）。前缀指纹的 cut 与
  // 存下的 lastDate 必须是同一个字符串，下一晚才能按它原样重算（日历缺 latest 时两者会不同）
  const settleDate = built.input.calendar.findLast((d) => d <= latest) ?? latest;
  const full = hashSimInput(built.input, { cut: latest });
  const prefixTonight = hashSimInput(built.input, { cut: settleDate, rule: "executed" }).inputHash;
  const prefixPrev = prev.lastDate
    ? hashSimInput(built.input, { cut: prev.lastDate, rule: "executed" }).inputHash
    : null;
  const execHash = sha256Canonical(exec);
  const result = await runSimulation(built.input);
  const series = result.series;
  const last = series.at(-1)!;

  // 与回测对照的偏离百分位
  let deviationPct: number | null = null;
  if (t.baselineRunId) {
    const baseRun = db
      .select({ seriesZ: runs.seriesZ })
      .from(runs)
      .where(eq(runs.id, t.baselineRunId))
      .get();
    const baseline = unpackJson<SeriesPoint[]>(baseRun?.seriesZ) ?? [];
    const k = series.length - 1;
    deviationPct = deviationPercentile(baseline, last.nav / last.bench - 1, k);
  }

  const stored = db
    .select({ date: trackingDays.date, nav: trackingDays.nav, bench: trackingDays.bench })
    .from(trackingDays)
    .where(eq(trackingDays.trackingId, t.id))
    .all();
  const replay = compareReplay(stored, series);
  const drift = attributeDrift(
    {
      engineVersion: prev.engineVersion,
      execHash: prev.execHash,
      prefixHash: prev.prefixHash,
      hashVersion: prev.hashVersion,
    },
    {
      engineVersion: result.engineVersion,
      execHash,
      prefixHash: prefixPrev,
      hashVersion: HASH_VERSION,
    },
    replay,
  );
  if (drift.cause !== "none") {
    ctx.log(
      `跟踪 ${t.id} 重放与上次不一致：净值 ${replay.navDrift} 天、基准 ${replay.benchDrift} 天，` +
        `最早 ${replay.firstDrift}（${drift.text}，已按最新数据改写）`,
    );
  }

  sqlite.transaction(() => {
    db.delete(trackingDays).where(eq(trackingDays.trackingId, t.id)).run();
    for (const p of series) {
      db.insert(trackingDays)
        .values({
          trackingId: t.id,
          date: p.date,
          nav: p.nav,
          bench: p.bench,
          cash: p.cash,
          positions: p.positions,
        })
        .run();
    }
    db.delete(trackingOrders).where(eq(trackingOrders.trackingId, t.id)).run();
    for (const o of result.final.pending) {
      db.insert(trackingOrders)
        .values({
          trackingId: t.id,
          planDate,
          code: o.code,
          name: o.name,
          side: o.side,
          reason: o.reason,
        })
        .run();
    }
    db.update(trackings)
      .set({
        lastDate: last.date,
        lastNav: last.nav,
        lastBench: last.bench,
        deviationPct,
        summary: {
          dataAsOf: built.dataVersion.asOf,
          equity: result.final.equity,
          cash: result.final.cash,
          positions: result.final.positions,
          exposure: result.final.exposure ?? null,
          metrics: {
            totalReturn: result.metrics.totalReturn,
            excessTotal: result.metrics.excessTotal,
            maxDrawdown: result.metrics.maxDrawdown,
            buys: result.metrics.buys,
          },
          checks: result.checks.filter((c) => !BACKTEST_ONLY_CHECKS.has(c.id)),
          // 指纹（下一晚归因用）：前缀按今晚的最后结算日、「执行日 ≤ cut」算
          engineVersion: result.engineVersion,
          dataVersion: built.dataVersion.id,
          execHash,
          inputHash: full.inputHash,
          prefixHash: prefixTonight,
          hashVersion: HASH_VERSION,
          lastDate: settleDate,
          replay: { ...replay, at: latest, cause: drift.cause, causeText: drift.text },
        },
      })
      .where(eq(trackings.id, t.id))
      .run();
  })();
}

export async function settleMarket(
  market: Market,
  ctx: JobContext,
): Promise<{ settled: number; failed: number }> {
  const { db } = env().app;
  // 只结算到最新的已提交版本（D60）：失败那晚写进来的数据不用
  const latest = await committedAsOf(env().wh, market);
  if (!latest) return { settled: 0, failed: 0 };
  const active = db
    .select()
    .from(trackings)
    .where(and(eq(trackings.status, "active"), eq(trackings.market, market)))
    .all();
  let settled = 0;
  let failed = 0;
  for (let i = 0; i < active.length; i++) {
    const t = active[i]!;
    ctx.progress(i / Math.max(1, active.length), `结算 ${i + 1}/${active.length}`);
    try {
      await settleOne(t, latest, ctx);
      settled++;
    } catch (e) {
      failed++;
      ctx.log(`跟踪 ${t.id} 结算失败：${e instanceof Error ? e.message : e}`);
    }
  }
  return { settled, failed };
}

export async function settleJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const market = (ctx.job.payload.market === "HK" ? "HK" : "A") as Market;
  return settleMarket(market, ctx);
}

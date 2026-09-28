/**
 * 回测与参数扫描任务：组装输入（DuckDB）→ 线程里模拟 → 结果写应用库。
 */
import {
  type BacktestParams,
  type Check,
  type Signal,
  type SimResult,
  type StrategySpec,
  validateSpec,
} from "@ivan/core";
import { buildSimInput } from "@ivan/data";
import { newId, packJson, runs, runTrades, signalDatasets, strategyVersions } from "@ivan/db";
import { and, eq } from "drizzle-orm";
import { env } from "../env.ts";
import type { JobContext } from "../runner.ts";
import { runSimulation } from "../sim-pool.ts";

type RunRow = typeof runs.$inferSelect;

function loadSpec(run: RunRow): StrategySpec {
  const { db } = env().app;
  const p = run.params as { specOverride?: unknown };
  const raw =
    p.specOverride ??
    db.select().from(strategyVersions).where(eq(strategyVersions.id, run.versionId)).get()?.spec;
  if (!raw) throw new Error("找不到策略版本");
  const v = validateSpec(raw);
  if (!v.spec) throw new Error(`策略不合法：${v.errors.join("；")}`);
  return v.spec;
}

function loadSignals(userId: string, spec: StrategySpec): Signal[] | undefined {
  if (spec.mode !== "signals" || !spec.signals) return undefined;
  const { db } = env().app;
  const ds = db
    .select()
    .from(signalDatasets)
    .where(and(eq(signalDatasets.id, spec.signals.datasetId), eq(signalDatasets.userId, userId)))
    .get();
  if (!ds) throw new Error("找不到信号集（或不属于你）");
  if (ds.market !== spec.market) throw new Error("信号集的市场和策略不一致");
  return ds.rows;
}

/** 跑一个 run 并写回结果（回测与扫描子回测共用） */
async function execute(
  run: RunRow,
  spec: StrategySpec,
  ctx: JobContext,
  weight = 1,
  base = 0,
): Promise<SimResult> {
  const { wh, app } = env();
  const p = run.params as unknown as BacktestParams & { priorVersions?: number };
  app.db
    .update(runs)
    .set({ status: "running", startedAt: Date.now() })
    .where(eq(runs.id, run.id))
    .run();
  ctx.progress(base + 0.1 * weight, "读取行情与选股");
  const built = await buildSimInput(
    wh,
    spec,
    { start: p.start, end: p.end, capital: p.capital, oosMonths: p.oosMonths },
    { signals: loadSignals(run.userId, spec), priorVersionsOnPeriod: p.priorVersions ?? 0 },
  );
  ctx.progress(base + 0.5 * weight, `模拟 ${built.stats.codes} 只股票`);
  const result = await runSimulation(built.input);
  ctx.progress(base + 0.9 * weight, "写入结果");
  const insert = app.sqlite.prepare(
    `INSERT INTO run_trades (run_id, seq, date, code, side, price, shares, amount, fee, reason, pnl, hold_days)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  app.sqlite.transaction(() => {
    app.db.delete(runTrades).where(eq(runTrades.runId, run.id)).run();
    result.trades.forEach((t, i) =>
      insert.run(
        run.id,
        i,
        t.date,
        t.code,
        t.side,
        t.price,
        t.shares,
        t.amount,
        t.fee,
        t.reason,
        t.pnl ?? null,
        t.holdDays ?? null,
      ),
    );
    app.db
      .update(runs)
      .set({
        status: "done",
        error: null,
        params: { ...(run.params as object), end: built.params.end } as Record<string, unknown>,
        dataVersion: built.dataVersion.id,
        dataAsOf: built.dataVersion.asOf,
        engineVersion: result.engineVersion,
        metrics: result.metrics as unknown as Record<string, unknown>,
        segments: result.segments as unknown as Record<string, unknown>,
        checks: result.checks,
        attribution: result.attribution as unknown as Record<string, unknown>,
        final: result.final as unknown as Record<string, unknown>,
        seriesZ: packJson(result.series),
        holdingsZ: packJson(result.holdings),
        finishedAt: Date.now(),
      })
      .where(eq(runs.id, run.id))
      .run();
  })();
  return result;
}

function failRun(runId: string, e: unknown): void {
  env()
    .app.db.update(runs)
    .set({
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
      finishedAt: Date.now(),
    })
    .where(eq(runs.id, runId))
    .run();
}

export async function backtestJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const runId = String(ctx.job.payload.runId);
  const run = env().app.db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run) throw new Error(`回测 ${runId} 不存在`);
  try {
    const r = await execute(run, loadSpec(run), ctx);
    return { runId, excessCagr: r.metrics.excessCagr };
  } catch (e) {
    failRun(runId, e);
    throw e;
  }
}

/** 参数扫描（spec §6）：逐个取值回测，相邻取值年化超额跳动过大 → 参数脆弱。 */
export const FRAGILITY_JUMP = 0.05;

export async function sweepJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const { db } = env().app;
  const parentId = String(ctx.job.payload.runId);
  const variants = ctx.job.payload.variants as Array<{ label: string; spec: StrategySpec }>;
  const parent = db.select().from(runs).where(eq(runs.id, parentId)).get();
  if (!parent) throw new Error(`扫描 ${parentId} 不存在`);
  db.update(runs)
    .set({ status: "running", startedAt: Date.now() })
    .where(eq(runs.id, parentId))
    .run();
  const results: Array<{
    label: string;
    runId: string;
    excessCagr: number | null;
    error?: string;
  }> = [];
  try {
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i]!;
      const childId = newId("r_");
      db.insert(runs)
        .values({
          id: childId,
          userId: parent.userId,
          strategyId: parent.strategyId,
          versionId: parent.versionId,
          kind: "sweep_child",
          parentId,
          label: v.label,
          params: { ...(parent.params as object), specOverride: v.spec } as Record<string, unknown>,
        })
        .run();
      const child = db.select().from(runs).where(eq(runs.id, childId)).get()!;
      try {
        const r = await execute(child, v.spec, ctx, 1 / variants.length, i / variants.length);
        results.push({ label: v.label, runId: childId, excessCagr: r.metrics.excessCagr });
      } catch (e) {
        failRun(childId, e);
        results.push({ label: v.label, runId: childId, excessCagr: null, error: String(e) });
      }
    }
    const checks: Check[] = [];
    const ok = results.filter((r) => r.excessCagr !== null);
    let maxJump = 0;
    for (let i = 1; i < ok.length; i++) {
      maxJump = Math.max(maxJump, Math.abs(ok[i]!.excessCagr! - ok[i - 1]!.excessCagr!));
    }
    if (maxJump > FRAGILITY_JUMP) {
      checks.push({
        id: "param_fragile",
        level: "warn",
        title: "参数脆弱",
        detail: `相邻取值之间年化超额最多相差 ${(maxJump * 100).toFixed(1)} 个百分点：结果对这个参数很敏感，别只挑最好的那个值。`,
      });
    }
    db.update(runs)
      .set({
        status: "done",
        checks,
        final: { variants: results } as unknown as Record<string, unknown>,
        finishedAt: Date.now(),
      })
      .where(eq(runs.id, parentId))
      .run();
    return { runId: parentId, variants: results.length };
  } catch (e) {
    failRun(parentId, e);
    throw e;
  }
}

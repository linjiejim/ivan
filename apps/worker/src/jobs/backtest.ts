/**
 * 回测与参数扫描任务：组装输入（DuckDB）→ 算输入指纹 → 线程里模拟（指标第 2 版再算可信度，D65）→
 * 结果与运行卡写应用库（D57）。可信度的种子来自输入指纹：同样的输入第二天重跑也是同样的区间，完整重跑能逐笔一致。
 * 完整重跑（kind = reproduce）也走这里，跑完和原运行比结果指纹，写回原运行的 verify。
 */
import {
  type BacktestParams,
  buildRunCard,
  type Check,
  canonicalJson,
  FACTOR_REGISTRY_VERSION,
  type RunCard,
  type RunCardKind,
  resolveExec,
  resultHashes,
  type Signal,
  type SimResult,
  type StrategySpec,
  validateSpec,
} from "@ivan/core";
import { sha256Canonical, specHashOf } from "@ivan/core/node";
import {
  type BuiltInput,
  buildSimInput,
  HASH_VERSION,
  hashSimInput,
  SCHEMA_VERSION,
} from "@ivan/data";
import { changeCause } from "@ivan/engine";
import {
  newId,
  packJson,
  runs,
  runTrades,
  signalDatasets,
  strategyVersions,
  unpackJson,
} from "@ivan/db";
import { and, asc, eq } from "drizzle-orm";
import { env } from "../env.ts";
import type { JobContext } from "../runner.ts";
import { runSimulation } from "../sim-pool.ts";
import { validationSeed } from "../sim-tasks.ts";

type RunRow = typeof runs.$inferSelect;

/** runs.params 里存的东西：回测参数 + 试错次数 + 扫描子回测的策略内容 + 重跑指向的原运行 */
export type StoredRunParams = BacktestParams & {
  priorVersions?: number;
  specOverride?: unknown;
  reproOf?: string;
};

export function loadSpec(run: RunRow): StrategySpec {
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

export function loadSignals(userId: string, spec: StrategySpec): Signal[] | undefined {
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

/**
 * 按存下的参数重新组装输入（回测、复核、重跑共用）：区间、资金、样本外、成交假设、信号、扫描的策略内容、试错次数。
 * 复核传入运行卡记下的终点（截到数据截至日后的），之后新增的交易日不进窗口。
 * 成交假设一定显式传给引擎（缺省字段按旧口径补齐），不能让引擎悄悄按默认跑。
 */
export async function rebuildInput(
  run: RunRow,
  spec = loadSpec(run),
  end?: string,
): Promise<BuiltInput> {
  const p = run.params as unknown as StoredRunParams;
  return buildSimInput(
    env().wh,
    spec,
    {
      start: p.start,
      end: end ?? p.end,
      capital: p.capital,
      oosMonths: p.oosMonths,
      exec: resolveExec(p.exec),
    },
    { signals: loadSignals(run.userId, spec), priorVersionsOnPeriod: p.priorVersions ?? 0 },
  );
}

/** 策略内容指纹：扫描子回测（及它的重跑）按自己的策略内容算，其余取版本上存的 spec_hash */
function specHashFor(run: RunRow): string {
  const p = run.params as unknown as StoredRunParams;
  if (p.specOverride) return specHashOf(p.specOverride);
  const v = env()
    .app.db.select({ specHash: strategyVersions.specHash })
    .from(strategyVersions)
    .where(eq(strategyVersions.id, run.versionId))
    .get();
  if (!v) throw new Error("找不到策略版本");
  return v.specHash;
}

/**
 * 从存档里算结果指纹（原运行早于运行卡时，完整重跑用它比）：两边都经过同一套存储再算，口径一致。
 */
export function storedResultHashes(runId: string): { coreHash: string; reportHash: string } {
  const { db } = env().app;
  const r = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!r) throw new Error(`回测 ${runId} 不存在`);
  const trades = db
    .select()
    .from(runTrades)
    .where(eq(runTrades.runId, runId))
    .orderBy(asc(runTrades.seq))
    .all()
    .map((t) => ({
      date: t.date,
      code: t.code,
      side: t.side,
      price: t.price,
      shares: t.shares,
      amount: t.amount,
      fee: t.fee,
      reason: t.reason,
      pnl: t.pnl ?? undefined,
      holdDays: t.holdDays ?? undefined,
      ref: t.ref ?? undefined,
      slip: t.slip ?? undefined,
      part: t.part ?? undefined,
    }));
  return {
    coreHash: sha256Canonical({
      series: unpackJson(r.seriesZ),
      trades,
      holdings: unpackJson(r.holdingsZ),
      metrics: r.metrics,
      segments: r.segments,
      attribution: r.attribution,
      final: r.final,
    }),
    reportHash: sha256Canonical(r.checks ?? []),
  };
}

/** 跑一个 run 并写回结果与运行卡（回测、扫描子回测、完整重跑共用） */
async function execute(
  run: RunRow,
  spec: StrategySpec,
  ctx: JobContext,
  weight = 1,
  base = 0,
): Promise<{ result: SimResult; card: RunCard; built: BuiltInput }> {
  const { app } = env();
  const p = run.params as unknown as StoredRunParams;
  app.db
    .update(runs)
    .set({ status: "running", startedAt: Date.now() })
    .where(eq(runs.id, run.id))
    .run();
  ctx.progress(base + 0.1 * weight, "读取行情与选股");
  const exec = resolveExec(p.exec);
  const specHash = specHashFor(run);
  const built = await rebuildInput(run, spec);
  // 指纹必须在转交线程之前算（转交后 TypedArray 失效）
  const hashes = hashSimInput(built.input);
  const caveatsHash = sha256Canonical(built.input.dataCaveats ?? []);
  // 可信度只对指标第 2 版做（旧口径要和当初逐字节一致）；种子来自输入指纹，不来自每晚都涨的数据版本号
  const seed = exec.metrics === 2 ? validationSeed(hashes.inputHash) : null;
  ctx.progress(base + 0.5 * weight, `模拟 ${built.stats.codes} 只股票`);
  const { result, validation } = await runSimulation(
    built.input,
    seed === null ? {} : { tasks: ["validation"], seed },
  );
  if (canonicalJson(result.exec) !== canonicalJson(exec)) throw new Error("成交假设没有传到引擎");
  ctx.progress(base + 0.9 * weight, "写入结果");
  const card = buildRunCard(
    {
      schema: 1,
      kind: (run.kind === "sweep_child" || run.kind === "reproduce"
        ? run.kind
        : "backtest") as RunCardKind,
      spec: { versionId: run.versionId, specHash },
      params: {
        start: p.start,
        end: built.params.end,
        capital: p.capital,
        oosMonths: p.oosMonths,
      },
      exec: result.exec,
      engine: {
        version: result.engineVersion,
        rulesVersion: result.exec.rules,
        metricsVersion: result.exec.metrics,
      },
      data: {
        market: spec.market,
        versionId: built.dataVersion.id,
        asOf: built.dataVersion.asOf,
        factorRegistry: FACTOR_REGISTRY_VERSION,
        warehouseSchema: SCHEMA_VERSION,
        hashVersion: hashes.hashVersion,
        inputHash: hashes.inputHash,
        selectionHash: hashes.selectionHash,
        priceHash: hashes.priceHash,
        benchHash: hashes.benchHash,
        caveatsHash,
        // 行情来源占比、缺失与数据问题（S13）：只是报告，不进输入指纹
        provenance: built.provenance,
      },
      seeds: { validation: seed },
      outputs: resultHashes({ ...result, validation }, sha256Canonical),
    },
    sha256Canonical,
  );
  const insert = app.sqlite.prepare(
    `INSERT INTO run_trades (run_id, seq, date, code, side, price, shares, amount, fee, reason, pnl, hold_days,
                             ref, slip, part)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        t.ref ?? null,
        t.slip ?? null,
        t.part ?? null,
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
        diagnostics: (result.diagnostics ?? null) as unknown as Record<string, unknown> | null,
        validation: (validation?.confidence ?? null) as unknown as Record<string, unknown> | null,
        validationZ: validation?.fan ? packJson(validation.fan) : null,
        seriesZ: packJson(result.series),
        holdingsZ: packJson(result.holdings),
        card: card as unknown as Record<string, unknown>,
        cardHash: card.cardHash,
        inputHash: card.data.inputHash,
        finishedAt: Date.now(),
      })
      .where(eq(runs.id, run.id))
      .run();
  })();
  return { result, card, built };
}

/**
 * 完整重跑跑完：和原运行比。逐笔一致只看 coreHash（D57）；原运行早于运行卡时从存档两边同口径地算。
 * 结果不同的原因用和跟踪漂移同一个 changeCause 判断。结果写回原运行的 verify。
 */
function recordReproduction(repro: RunRow, card: RunCard, built: BuiltInput): void {
  const { db } = env().app;
  const origId = (repro.params as unknown as StoredRunParams).reproOf;
  const orig = origId ? db.select().from(runs).where(eq(runs.id, origId)).get() : undefined;
  if (!orig) {
    // 比不了也要给重跑页一个终态，不然页面会一直显示「正在和原回测比对」
    setFullVerifyFailed([repro.id], "原回测不存在，没法比对");
    return;
  }
  const origCard = orig.card as unknown as RunCard | null;
  const [then, now] = origCard
    ? [origCard.outputs, card.outputs]
    : [storedResultHashes(orig.id), storedResultHashes(repro.id)];
  const sameResult = then.coreHash === now.coreHash;
  const sameInput = origCard ? origCard.data.inputHash === card.data.inputHash : null;
  const cause = sameResult
    ? "none"
    : changeCause(
        {
          engineVersion: orig.engineVersion,
          hashVersion: origCard?.data.hashVersion ?? null,
          // 按补齐后的成交假设比：S04 之前的运行卡记的是 {v:1}，与现在的旧口径同义
          execHash: origCard ? execHashOf(origCard.exec) : null,
          data: origCard ? [origCard.data.inputHash] : null,
        },
        {
          engineVersion: card.engine.version,
          hashVersion: card.data.hashVersion,
          execHash: execHashOf(card.exec),
          data: [card.data.inputHash],
        },
      );
  const verify = {
    status: "done",
    kind: "full",
    at: Date.now(),
    reproRunId: repro.id,
    sameInput,
    sameResult,
    reportSame: then.reportHash === now.reportHash,
    engineSame: orig.engineVersion === card.engine.version,
    hashVersionSame: origCard ? origCard.data.hashVersion === HASH_VERSION : false,
    // 结果不同、指纹各项却都相同：原因不明（属于程序问题）
    cause: sameResult ? "none" : cause === "none" ? "unexplained" : cause,
    dataVersionThen: orig.dataVersion,
    dataVersionNow: built.dataVersion.id,
  };
  // 原运行与重跑各记一份：原运行的 verify 之后可能被新的复核覆盖，重跑页仍要能说清这次比的结果
  for (const id of [orig.id, repro.id]) {
    db.update(runs).set({ verify }).where(eq(runs.id, id)).run();
  }
}

/** 成交假设指纹（补齐缺省字段后算；读不懂时退回原样，让比较如实报「成交假设不同」） */
function execHashOf(e: unknown): string {
  try {
    return sha256Canonical(resolveExec(e));
  } catch {
    return sha256Canonical(e ?? null);
  }
}

/** 完整重跑的比对出错：记成比对失败（重跑本身已经跑完存好，不能因此判成失败） */
function setFullVerifyFailed(ids: string[], error: string): void {
  const { db } = env().app;
  const verify = { status: "failed", kind: "full", at: Date.now(), error };
  for (const id of ids) db.update(runs).set({ verify }).where(eq(runs.id, id)).run();
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
    const { result, card, built } = await execute(run, loadSpec(run), ctx);
    if (run.kind === "reproduce") {
      try {
        recordReproduction(run, card, built);
      } catch (e) {
        const origId = (run.params as unknown as StoredRunParams).reproOf;
        const error = `比对失败：${e instanceof Error ? e.message : String(e)}`;
        setFullVerifyFailed(origId ? [origId, run.id] : [run.id], error);
        ctx.log(`重跑 ${runId} ${error}`);
      }
    }
    return { runId, excessCagr: result.metrics.excessCagr };
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
  // priorVersions：服务端排队时按每个取值的策略内容算好的试错次数（D66）；更早排的任务没有，沿用父记录的
  const variants = ctx.job.payload.variants as Array<{
    label: string;
    spec: StrategySpec;
    priorVersions?: number;
  }>;
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
          params: {
            ...(parent.params as object),
            specOverride: v.spec,
            ...(v.priorVersions !== undefined ? { priorVersions: v.priorVersions } : {}),
          } as Record<string, unknown>,
        })
        .run();
      const child = db.select().from(runs).where(eq(runs.id, childId)).get()!;
      try {
        const { result: r } = await execute(
          child,
          v.spec,
          ctx,
          1 / variants.length,
          i / variants.length,
        );
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

/**
 * 回测：排队（worker 执行）、结果读取、下钻、对比、参数扫描。
 * 回测不破坏任何数据，可以直接执行，但受额度与队列限制（spec §9）。
 */
import {
  addDays,
  type Attribution,
  type BacktestParams,
  BENCHMARKS,
  benchmarkOf,
  benchUnavailableText,
  type Check,
  type Confidence,
  canonicalJson,
  DEFAULT_PARAMS,
  describeExec,
  diffDays,
  eventNotReadyText,
  eventStartTooEarlyText,
  ExecConfigError,
  FACTOR_MAP,
  factorsUsedBySpec,
  type Fan,
  type Market,
  parseExecOverrides,
  resolveExec,
  isDateStr,
  isLegacyFill,
  HK_CONNECT_MISSING_TEXT,
  type HoldingSnapshot,
  type Metrics,
  type PeriodMetrics,
  type SeriesPoint,
  type SimDiagnostics,
  type StrategySpec,
  todayCN,
  validateSpec,
} from "@ivan/core";
import { specHashOf } from "@ivan/core/node";
import { periodMetrics } from "@ivan/engine";
import {
  computeBlocked,
  jobs,
  newId,
  runs,
  runTrades,
  strategies,
  strategyVersions,
  unpackJson,
} from "@ivan/db";
import { and, asc, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { env } from "../env.ts";
import { AppError, notFound } from "../lib/errors.ts";
import { applyPatch, isSafePatchPath } from "../lib/jsonpatch.ts";
import { consume } from "../lib/quota.ts";
import { worker } from "../lib/worker-client.ts";
import type { DataStatus } from "./dashboard.ts";
import { getVersion, versionNOf } from "./strategies.ts";

export const MAX_ACTIVE_JOBS = 3;

export interface RunParamsInput {
  start?: string;
  end?: string;
  capital?: number;
  oosMonths?: number;
  /** 成交假设的覆盖项（D55），合并到 defaultExec(market)；不认识的键报错 */
  exec?: unknown;
}

/** 存进 runs.params 的回测参数：exec 永远是完整对象 */
export function normalizeParams(
  p: RunParamsInput = {},
  market: Market = "A",
): BacktestParams & { exec: NonNullable<BacktestParams["exec"]> } {
  const start = p.start ?? DEFAULT_PARAMS.start;
  const end = p.end ?? todayCN();
  if (!isDateStr(start) || !isDateStr(end)) throw new AppError(400, "日期格式要是 YYYY-MM-DD");
  if (start < "2014-01-01")
    throw new AppError(400, "回测起点不能早于 2014-01-01（行情仓从 2013 年开始）");
  if (diffDays(end, start) < 90) throw new AppError(400, "回测区间至少要 3 个月");
  const capital = p.capital ?? DEFAULT_PARAMS.capital;
  if (!(capital >= 10_000 && capital <= 1e10))
    throw new AppError(400, "初始资金要在 1 万到 100 亿之间");
  const oosMonths = p.oosMonths ?? DEFAULT_PARAMS.oosMonths;
  if (!(oosMonths >= 0 && oosMonths <= 60)) throw new AppError(400, "样本外月数要在 0–60 之间");
  let exec;
  try {
    exec = parseExecOverrides(market, p.exec);
  } catch (e) {
    if (e instanceof ExecConfigError) throw new AppError(400, e.message);
    throw e;
  }
  return { start, end, capital, oosMonths, exec };
}

/** 提交前校验用的 /internal/data-status（缓存 60 秒）；worker 不在时为 null */
const DATA_STATUS_TTL_MS = 60_000;
let statusCache: { at: number; value: DataStatus } | null = null;

/** 测试与新版本提交后用：清掉 data-status 缓存 */
export function clearDataStatusCache(): void {
  statusCache = null;
}

export async function cachedDataStatus(): Promise<DataStatus | null> {
  if (statusCache && Date.now() - statusCache.at < DATA_STATUS_TTL_MS) return statusCache.value;
  try {
    const value = await worker.get<DataStatus>("/internal/data-status");
    statusCache = { at: Date.now(), value };
    return value;
  } catch {
    return null;
  }
}

/** 事件因子各自的数据起点与补算进度（编辑器、list_factors 用；worker 不在时为 null） */
export async function eventFactorCoverage(): Promise<Pick<
  DataStatus,
  "factorCoverage" | "eventFactors"
> | null> {
  const status = await cachedDataStatus();
  return status
    ? { factorCoverage: status.factorCoverage, eventFactors: status.eventFactors }
    : null;
}

/**
 * 提交前校验数据（D75、D77、D83）：起点前一个交易日没有基准数据、港股通股票池没有名单、
 * 用到的事件因子还没补算完或起点早于它的数据起点时直接 400，不排任务、不扣额度。
 * worker 不在或接口没给这些字段时跳过，worker 建输入时还会再查一次（缓存过期前最多放过一次，由 buildSimInput 拦下）。
 */
export async function checkDataReady(specs: readonly StrategySpec[], start: string): Promise<void> {
  const status = await cachedDataStatus();
  if (!status) return;
  for (const spec of specs) {
    // 两融与筹码类因子（S15b）：补算完成才能回测；起点不能早于数据起点（覆盖起点 + 预热）
    const used = factorsUsedBySpec(spec).filter((k) => FACTOR_MAP.get(k)?.dataset);
    if (used.length && status.factorCoverage) {
      if (used.some((k) => !status.factorCoverage![k]?.ready)) {
        throw new AppError(
          400,
          eventNotReadyText(
            status.eventFactors?.doneYears ?? 0,
            status.eventFactors?.totalYears ?? 0,
          ),
        );
      }
      for (const k of used) {
        const from = status.factorCoverage[k]?.from;
        if (from && start < from)
          throw new AppError(400, eventStartTooEarlyText(FACTOR_MAP.get(k)!.label, from));
      }
    }
    const m = status.markets?.find((x) => x.market === spec.market);
    if (!m) continue;
    if (spec.universe.hkConnect && m.hkConnect === null)
      throw new AppError(400, HK_CONNECT_MISSING_TEXT);
    const key = benchmarkOf(spec);
    const sym = BENCHMARKS[key].sym;
    if (!m.benchFirstDates || !(sym in m.benchFirstDates)) continue;
    // 没有交易日历：首个数据日 ≥ 起点就说明起点前一个交易日没有基准（指数日期都是交易日）
    const why = benchUnavailableText(key, m.benchFirstDates[sym] ?? null, addDays(start, -1));
    if (why) throw new AppError(400, why);
  }
}

/** 排队中 / 运行中的任务数（复核不算：它另有「一人同时一个」的限制） */
function activeJobs(userId: string, kind?: string): number {
  const { db } = env().app;
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(jobs)
      .where(
        and(
          eq(jobs.userId, userId),
          inArray(jobs.status, ["queued", "running"]),
          kind ? eq(jobs.kind, kind) : sql`${jobs.kind} != 'verify'`,
        ),
      )
      .get()?.n ?? 0
  );
}

/** 和本次区间重叠至少这个比例（按本次区间的自然日）才算「同一段历史上的又一次尝试」 */
export const TRIAL_OVERLAP_MIN = 0.5;

/**
 * 试错次数（D66）：同一策略里、区间与本次重叠 ≥ 50% 的已完成回测与扫描子回测，按实际用的策略内容去重
 * （版本取 spec_hash，扫描子回测取 specHashOf(specOverride)，同一个 16 位函数，所以和某个版本相同的扫描取值只算一次），
 * 不含本次自己的策略内容。完整重跑（kind = reproduce）不算；挪一天起点不会清零。新建一个策略会从零算。
 */
export function countTrials(
  strategyId: string,
  params: Pick<BacktestParams, "start" | "end">,
  exceptSpecHash: string,
): number {
  const { db } = env().app;
  const rows = db
    .select({ versionId: runs.versionId, params: runs.params })
    .from(runs)
    .where(
      and(
        eq(runs.strategyId, strategyId),
        inArray(runs.kind, ["backtest", "sweep_child"]),
        eq(runs.status, "done"),
      ),
    )
    .all();
  const versionHash = new Map(
    db
      .select({ id: strategyVersions.id, specHash: strategyVersions.specHash })
      .from(strategyVersions)
      .where(eq(strategyVersions.strategyId, strategyId))
      .all()
      .map((v) => [v.id, v.specHash]),
  );
  const span = diffDays(params.end, params.start);
  if (!(span > 0)) return 0;
  const keys = new Set<string>();
  for (const r of rows) {
    const p = r.params as Partial<BacktestParams> & { specOverride?: unknown };
    if (!p.start || !p.end) continue;
    const lo = p.start > params.start ? p.start : params.start;
    const hi = p.end < params.end ? p.end : params.end;
    const overlap = Math.max(0, diffDays(hi, lo));
    if (overlap / span < TRIAL_OVERLAP_MIN) continue;
    const key = p.specOverride ? specHashOf(p.specOverride) : versionHash.get(r.versionId);
    if (key) keys.add(key);
  }
  keys.delete(exceptSpecHash);
  return keys.size;
}

export async function enqueueBacktest(
  userId: string,
  versionId: string,
  input: RunParamsInput = {},
): Promise<{ runId: string; jobId: string }> {
  const { db } = env().app;
  const { strategy, version } = getVersion(userId, versionId);
  const params = normalizeParams(input, version.spec.market);
  await checkDataReady([version.spec], params.start);
  if (activeJobs(userId) >= MAX_ACTIVE_JOBS) {
    throw new AppError(429, `同时排队的任务最多 ${MAX_ACTIVE_JOBS} 个，等前面的跑完再来`);
  }
  consume(userId, "backtests");
  const runId = newId("r_");
  const jobId = newId("j_");
  db.transaction((tx) => {
    tx.insert(runs)
      .values({
        id: runId,
        userId,
        strategyId: strategy.id,
        versionId,
        kind: "backtest",
        params: {
          ...params,
          priorVersions: countTrials(strategy.id, params, version.specHash),
        } as unknown as Record<string, unknown>,
      })
      .run();
    tx.insert(jobs).values({ id: jobId, kind: "backtest", userId, payload: { runId } }).run();
  });
  void worker.kick();
  return { runId, jobId };
}

/** 参数扫描：一个参数取 2–8 个值，各跑一次（不产生新版本），子回测挂在一个父记录下。 */
export async function enqueueSweep(
  userId: string,
  versionId: string,
  sweep: { path: string; values: unknown[]; label?: string },
  input: RunParamsInput = {},
): Promise<{ runId: string; jobId: string; variants: number }> {
  const { db } = env().app;
  const { strategy, version } = getVersion(userId, versionId);
  if (!/^\/[\w/-]+$/.test(sweep.path) || !isSafePatchPath(sweep.path))
    throw new AppError(400, "参数路径要是 JSON Pointer，如 /exits/stopLoss");
  if (sweep.values.length < 2 || sweep.values.length > 8)
    throw new AppError(400, "扫描取值要 2–8 个");
  const params = normalizeParams(input, version.spec.market);
  const variants: Array<{ label: string; spec: StrategySpec; priorVersions: number }> = [];
  for (const value of sweep.values) {
    let candidate: unknown;
    try {
      candidate = applyPatch(version.spec, [{ op: "add", path: sweep.path, value }]);
    } catch (e) {
      throw new AppError(400, e instanceof Error ? e.message : String(e));
    }
    const v = validateSpec(candidate);
    if (!v.spec)
      throw new AppError(400, `取值 ${JSON.stringify(value)} 让策略不合法：${v.errors.join("；")}`);
    variants.push({
      label: `${sweep.label ?? sweep.path} = ${JSON.stringify(value)}`,
      spec: v.spec,
      // 每个取值按自己的策略内容算试错次数（D66）；同一次扫描里的兄弟取值还没跑完，不算
      priorVersions: countTrials(strategy.id, params, specHashOf(v.spec)),
    });
  }
  await checkDataReady(
    variants.map((v) => v.spec),
    params.start,
  );
  if (activeJobs(userId) >= MAX_ACTIVE_JOBS) {
    throw new AppError(429, `同时排队的任务最多 ${MAX_ACTIVE_JOBS} 个，等前面的跑完再来`);
  }
  consume(userId, "backtests", variants.length);
  const runId = newId("r_");
  const jobId = newId("j_");
  db.transaction((tx) => {
    tx.insert(runs)
      .values({
        id: runId,
        userId,
        strategyId: strategy.id,
        versionId,
        kind: "sweep",
        label: sweep.label ?? sweep.path,
        params: { ...params, sweep } as unknown as Record<string, unknown>,
      })
      .run();
    tx.insert(jobs)
      .values({
        id: jobId,
        kind: "sweep",
        userId,
        payload: { runId, variants: variants as unknown as Record<string, unknown>[] } as Record<
          string,
          unknown
        >,
      })
      .run();
  });
  void worker.kick();
  return { runId, jobId, variants: variants.length };
}

type RunRow = typeof runs.$inferSelect;

function ownRun(userId: string, runId: string): RunRow {
  const { db } = env().app;
  const r = db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.userId, userId)))
    .get();
  if (!r) throw notFound("回测");
  return r;
}

export function runSummary(r: RunRow) {
  const m = r.metrics as Metrics | null;
  return {
    id: r.id,
    strategyId: r.strategyId,
    versionId: r.versionId,
    kind: r.kind,
    label: r.label,
    parentId: r.parentId,
    status: r.status,
    error: r.error,
    params: r.params,
    dataAsOf: r.dataAsOf,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
    checks: (r.checks ?? []) as Check[],
    headline: m
      ? {
          totalReturn: m.totalReturn,
          cagr: m.cagr,
          benchCagr: m.benchCagr,
          excessCagr: m.excessCagr,
          maxDrawdown: m.maxDrawdown,
          sharpe: m.sharpe,
          winRate: m.winRate,
          buys: m.buys,
          // 指标第 2 版才有（D63）；旧口径的回测为 null
          ir: m.risk?.infoRatio ?? null,
          sortino: m.risk?.sortino ?? null,
        }
      : null,
  };
}

/** 给回测摘要补上策略名与版本号（看板「最近回测」、报告标题用） */
function withNames<T extends { strategyId: string; versionId: string }>(
  rows: T[],
): Array<T & { strategyName: string | null; versionN: number | null }> {
  if (!rows.length) return [];
  const { db } = env().app;
  const sIds = [...new Set(rows.map((r) => r.strategyId))];
  const vIds = [...new Set(rows.map((r) => r.versionId))];
  const names = new Map(
    db
      .select({ id: strategies.id, name: strategies.name })
      .from(strategies)
      .where(inArray(strategies.id, sIds))
      .all()
      .map((x) => [x.id, x.name]),
  );
  const ns = new Map(
    db
      .select({ id: strategyVersions.id, n: strategyVersions.n })
      .from(strategyVersions)
      .where(inArray(strategyVersions.id, vIds))
      .all()
      .map((x) => [x.id, x.n]),
  );
  return rows.map((r) => ({
    ...r,
    strategyName: names.get(r.strategyId) ?? null,
    versionN: ns.get(r.versionId) ?? null,
  }));
}

export function getRun(userId: string, runId: string) {
  const r = ownRun(userId, runId);
  const { db } = env().app;
  const job = db
    .select({ status: jobs.status, progress: jobs.progress, note: jobs.note })
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, r.kind === "sweep" ? "sweep" : "backtest"),
        like(jobs.payload, `%${runId}%`),
      ),
    )
    .orderBy(desc(jobs.createdAt))
    .get();
  const children =
    r.kind === "sweep"
      ? db
          .select()
          .from(runs)
          .where(eq(runs.parentId, r.id))
          .orderBy(asc(runs.createdAt))
          .all()
          .map(runSummary)
      : [];
  const market =
    db
      .select({ market: strategies.market })
      .from(strategies)
      .where(eq(strategies.id, r.strategyId))
      .get()?.market ?? null;
  // 夜间更新写库期间回测与复核暂停（D60）：排队中的要告诉用户在等什么
  const waiting = r.status === "queued" || r.verify?.status === "queued";
  const blocked = waiting ? computeBlocked(env().app.sqlite) : null;
  return {
    ...withNames([runSummary(r)])[0]!,
    market: market as Market | null,
    engineVersion: r.engineVersion,
    dataVersion: r.dataVersion,
    card: r.card,
    cardHash: r.cardHash,
    inputHash: r.inputHash,
    verify: r.verify,
    exec: safeExec(r.params.exec),
    /** 成交诊断（D64）；早于 S05 的回测没有 */
    diagnostics: (r.diagnostics ?? null) as SimDiagnostics | null,
    /** 可信度（D65）：区间摘要与一年净值扇形；只有指标第 2 版的新回测有 */
    validation: (r.validation ?? null) as Confidence | null,
    fan: unpackJson<Fan>(r.validationZ),
    metrics: r.metrics as Metrics | null,
    segments: r.segments as { inSample: PeriodMetrics; outOfSample: PeriodMetrics | null } | null,
    attribution: r.attribution,
    final: r.final,
    series: unpackJson<SeriesPoint[]>(r.seriesZ) ?? [],
    job: job ?? null,
    children,
    computePaused: blocked ? { reason: blocked.kind, since: blocked.since } : null,
  };
}

/**
 * 解释一次回测里的选股要用的策略内容（D67）：扫描子回测用它自己的 specOverride，其余用版本的策略；
 * 带上运行卡记下的数据版本（没有运行卡 = 早于数据版本记录）。
 */
export function runSpecContext(userId: string, runId: string) {
  const r = ownRun(userId, runId);
  const { strategy, version } = getVersion(userId, r.versionId);
  const override = (r.params as { specOverride?: unknown }).specOverride;
  const spec = override ? validateSpec(override).spec : version.spec;
  if (!spec) throw new AppError(409, "这次回测记下的策略内容读不懂");
  const card = r.card as { data?: { versionId?: number | null } } | null;
  return {
    runId: r.id,
    versionId: r.versionId,
    name: override && r.label ? `${strategy.name}（${r.label}）` : strategy.name,
    spec,
    hasCard: !!card,
    cardDataVersionId: card?.data?.versionId ?? null,
  };
}

/** 存下的成交假设（旧运行没有这个字段，按旧口径解析）；读不懂时给 null，不让整页报错 */
function safeExec(stored: unknown) {
  try {
    return resolveExec(stored);
  } catch {
    return null;
  }
}

/** 下载运行卡（早于运行卡记录的回测没有） */
export function runCard(userId: string, runId: string): Record<string, unknown> {
  const r = ownRun(userId, runId);
  if (!r.card) throw new AppError(404, "这次回测没有运行卡（早于运行卡记录）");
  return r.card;
}

/**
 * 复核数据（D57）：计入 analyses 额度，在 compute 道排一个 verify 任务，立即返回「排队中」。
 * 同一用户同时只能有一个复核；复核不占 MAX_ACTIVE_JOBS。
 */
export function verifyRun(userId: string, runId: string): { status: "queued"; jobId: string } {
  const r = ownRun(userId, runId);
  if (r.kind === "sweep") throw new AppError(400, "参数扫描请到各个子回测上复核");
  // 重跑页上的 verify 是「和原回测比」的结果，复核会把它盖掉
  if (r.kind === "reproduce") throw new AppError(400, "重跑的结果请到原回测上复核");
  if (r.status !== "done") throw new AppError(409, "这次回测还没跑完");
  if (activeJobs(userId, "verify") > 0) throw new AppError(409, "上一次复核还没结束");
  // 复核与完整重跑都写这次回测的 verify：重跑还没比完时复核会把结果盖掉
  if (reproInFlight(runId)) throw new AppError(409, "这次回测的完整重跑还没结束，等它比完再复核");
  consume(userId, "analyses");
  const { db } = env().app;
  const jobId = newId("j_");
  db.transaction((tx) => {
    tx.insert(jobs).values({ id: jobId, kind: "verify", userId, payload: { runId } }).run();
    tx.update(runs)
      .set({ verify: { status: "queued", kind: "input", requestedAt: Date.now() } })
      .where(eq(runs.id, runId))
      .run();
  });
  void worker.kick();
  return { status: "queued", jobId };
}

/** 这次回测有没有还没跑完的完整重跑 */
function reproInFlight(runId: string): boolean {
  return !!env()
    .app.db.select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.kind, "reproduce"),
        inArray(runs.status, ["queued", "running"]),
        sql`json_extract(${runs.params}, '$.reproOf') = ${runId}`,
      ),
    )
    .get();
}

/** 原运行实际用到的终点：运行卡记下的（截到数据截至日后的）终点；早于运行卡的取存下的参数 */
function origEffectiveEnd(orig: RunRow): string {
  const card = orig.card as { params?: { end?: string } } | null;
  return card?.params?.end ?? (orig.params as { end: string }).end;
}

/**
 * 完整重跑（D57）：参数完全照抄（含试错次数，让检查项也可比；终点取原运行截到的那天），新建一次 kind = reproduce 的运行，计入回测额度。
 * 跑完由 worker 比结果指纹并写回原运行的 verify；重跑不计入试错次数（countTrials 只数回测与扫描子回测）。
 */
export async function reproduceRun(
  userId: string,
  runId: string,
): Promise<{ runId: string; jobId: string }> {
  const orig = ownRun(userId, runId);
  if (orig.kind !== "backtest" && orig.kind !== "sweep_child")
    throw new AppError(400, "只能重跑一次回测或扫描里的子回测");
  if (orig.status !== "done") throw new AppError(409, "这次回测还没跑完");
  // 看任务表而不是 verify 列：任务异常结束时 verify 可能停在「复核中」，不能因此永远不让重跑
  const verifying = env()
    .app.db.select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, "verify"),
        inArray(jobs.status, ["queued", "running"]),
        sql`json_extract(${jobs.payload}, '$.runId') = ${orig.id}`,
      ),
    )
    .get();
  if (verifying) throw new AppError(409, "这次回测的复核还没结束，等它跑完再重跑");
  if (reproInFlight(orig.id)) throw new AppError(409, "这次回测已经在完整重跑了");
  if (activeJobs(userId) >= MAX_ACTIVE_JOBS) {
    throw new AppError(429, `同时排队的任务最多 ${MAX_ACTIVE_JOBS} 个，等前面的跑完再来`);
  }
  // 与新回测同一道检查：用到的事件因子还在补算等情况先拒绝，不扣额度
  const op = orig.params as { start: string; specOverride?: StrategySpec };
  await checkDataReady(
    [op.specOverride ?? getVersion(userId, orig.versionId).version.spec],
    op.start,
  );
  consume(userId, "backtests");
  const { db } = env().app;
  const newRunId = newId("r_");
  const jobId = newId("j_");
  db.transaction((tx) => {
    tx.insert(runs)
      .values({
        id: newRunId,
        userId,
        strategyId: orig.strategyId,
        versionId: orig.versionId,
        kind: "reproduce",
        label: orig.label,
        // 终点钉在原运行实际用到的那天（截到数据截至日之后的），之后多出来的交易日不进重跑
        params: { ...orig.params, end: origEffectiveEnd(orig), reproOf: orig.id },
      })
      .run();
    tx.insert(jobs)
      .values({ id: jobId, kind: "backtest", userId, payload: { runId: newRunId } })
      .run();
  });
  void worker.kick();
  return { runId: newRunId, jobId };
}

export function listRuns(userId: string, opts: { strategyId?: string; limit?: number } = {}) {
  const { db } = env().app;
  const where = opts.strategyId
    ? and(
        eq(runs.userId, userId),
        eq(runs.strategyId, opts.strategyId),
        or(eq(runs.kind, "backtest"), eq(runs.kind, "sweep")),
      )
    : and(eq(runs.userId, userId), or(eq(runs.kind, "backtest"), eq(runs.kind, "sweep")));
  const rows = db
    .select()
    .from(runs)
    .where(where)
    .orderBy(desc(runs.createdAt))
    .limit(opts.limit ?? 20)
    .all()
    .map(runSummary);
  return withNames(rows);
}

export function getTrades(
  userId: string,
  runId: string,
  opts: { code?: string; from?: string; to?: string; limit?: number; offset?: number } = {},
) {
  const run = ownRun(userId, runId);
  // 成交表不存名字，名字取自同一次回测的归因（每只交易过的股票都在里面）
  const names = new Map(
    ((run.attribution as Attribution | null)?.byStock ?? []).map((s) => [s.code, s.name]),
  );
  const { db } = env().app;
  const conds = [eq(runTrades.runId, runId)];
  if (opts.code) conds.push(eq(runTrades.code, opts.code));
  let rows = db
    .select()
    .from(runTrades)
    .where(and(...conds))
    .orderBy(asc(runTrades.seq))
    .all();
  if (opts.from) rows = rows.filter((t) => t.date >= opts.from!);
  if (opts.to) rows = rows.filter((t) => t.date <= opts.to!);
  const total = rows.length;
  const offset = opts.offset ?? 0;
  return {
    total,
    trades: rows
      .slice(offset, offset + (opts.limit ?? 200))
      .map((t) => ({ ...t, name: names.get(t.code) ?? null })),
  };
}

/** 净值序列降采样（图表与对比用），保留首尾与每段极值附近的点 */
export function downsample(series: SeriesPoint[], maxPoints = 400): SeriesPoint[] {
  if (series.length <= maxPoints) return series;
  const step = series.length / maxPoints;
  const out: SeriesPoint[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(series[Math.floor(i * step)]!);
  out.push(series.at(-1)!);
  return out;
}

/**
 * 对比 2–4 个回测。口径不同不直接比（D64）：每次带成交假设与指标口径，`comparable` = 补齐后的成交假设
 * 逐项相同且指标版本相同；读不懂的成交假设算不可比。
 */
export function compareRuns(userId: string, runIds: string[]) {
  if (runIds.length < 2 || runIds.length > 4) throw new AppError(400, "对比要 2–4 个回测");
  const rows = runIds.map((id) => {
    const r = getRun(userId, id);
    const versionN = versionNOf(userId, r.versionId);
    return {
      ...runSummary(ownRun(userId, id)),
      versionN,
      segments: r.segments,
      series: downsample(r.series, 300),
      execText: r.exec ? describeExec(r.exec) : "成交假设读不懂",
      rulesVersion: r.exec?.rules ?? null,
      // 指标口径看结果里实际的版本（缺省 = 第 1 版）
      metricsVersion: r.metrics ? (r.metrics.metricsVersion ?? 1) : (r.exec?.metrics ?? null),
      execKey: r.exec ? canonicalJson(r.exec) : null,
    };
  });
  const comparable =
    rows.every((r) => r.execKey !== null && r.execKey === rows[0]!.execKey) &&
    rows.every((r) => r.metricsVersion === rows[0]!.metricsVersion);
  return { runs: rows.map(({ execKey: _, ...r }) => r), comparable };
}

export type RunQuery =
  | { what: "drawdowns"; top?: number }
  | { what: "period"; from: string; to: string }
  | { what: "holdings_on"; date: string }
  | { what: "trades"; code?: string; from?: string; to?: string; limit?: number }
  | { what: "contributors"; top?: number }
  | { what: "industry" }
  | { what: "monthly" }
  | { what: "execution" };

/** 下钻（对话工具 query_run 与报告页共用）。返回数据小而准，数字全部来自存档结果。 */
export function queryRun(userId: string, runId: string, q: RunQuery) {
  const r = getRun(userId, runId);
  if (r.status !== "done") throw new AppError(409, "回测还没跑完");
  const series = r.series;
  switch (q.what) {
    case "drawdowns": {
      // 找不重叠的最大几次回撤
      const out: Array<{ peak: string; trough: string; recovery: string | null; depth: number }> =
        [];
      const used = new Set<number>();
      for (let n = 0; n < (q.top ?? 3); n++) {
        let best = { depth: 0, peak: -1, trough: -1 };
        let peak = -1;
        for (let i = 0; i < series.length; i++) {
          if (used.has(i)) {
            peak = -1;
            continue;
          }
          if (peak < 0 || series[i]!.nav > series[peak]!.nav) peak = i;
          const dd = series[i]!.nav / series[peak]!.nav - 1;
          if (dd < best.depth) best = { depth: dd, peak, trough: i };
        }
        if (best.trough < 0) break;
        let rec = -1;
        for (let i = best.trough + 1; i < series.length; i++) {
          if (series[i]!.nav >= series[best.peak]!.nav) {
            rec = i;
            break;
          }
        }
        for (let i = best.peak; i <= (rec < 0 ? series.length - 1 : rec); i++) used.add(i);
        out.push({
          peak: series[best.peak]!.date,
          trough: series[best.trough]!.date,
          recovery: rec < 0 ? null : series[rec]!.date,
          depth: best.depth,
        });
      }
      return { what: q.what, drawdowns: out };
    }
    case "period": {
      const seg = series.filter((p) => p.date >= q.from && p.date <= q.to);
      if (seg.length < 2) throw new AppError(400, "这段区间没有足够的交易日");
      const trades = getTrades(userId, runId, { from: q.from, to: q.to, limit: 1000 }).trades;
      const byCode = new Map<string, number>();
      for (const t of trades)
        if (t.side === "sell") byCode.set(t.code, (byCode.get(t.code) ?? 0) + (t.pnl ?? 0));
      const sorted = [...byCode.entries()].sort((a, b) => a[1] - b[1]);
      return {
        what: q.what,
        metrics: periodMetrics(seg),
        trades: trades.length,
        worstClosed: sorted.slice(0, 5).map(([code, pnl]) => ({ code, pnl })),
        bestClosed: sorted
          .slice(-5)
          .reverse()
          .map(([code, pnl]) => ({ code, pnl })),
      };
    }
    case "holdings_on": {
      const holdings = unpackJson<HoldingSnapshot[]>(ownRun(userId, runId).holdingsZ) ?? [];
      const snap = [...holdings].reverse().find((h) => h.date <= q.date) ?? null;
      return { what: q.what, snapshot: snap };
    }
    case "trades":
      return {
        what: q.what,
        ...getTrades(userId, runId, { ...q, limit: Math.min(q.limit ?? 50, 200) }),
      };
    case "contributors": {
      const attr = r.attribution as {
        byStock: Array<{ code: string; name: string; pnl: number }>;
      } | null;
      const all = attr?.byStock ?? [];
      const n = q.top ?? 10;
      return { what: q.what, best: all.slice(0, n), worst: all.slice(-n).reverse() };
    }
    case "industry":
      return {
        what: q.what,
        byIndustry: (r.attribution as { byIndustry: unknown[] } | null)?.byIndustry ?? [],
      };
    case "monthly":
      return { what: q.what, monthly: r.metrics?.monthly ?? [], yearly: r.metrics?.yearly ?? [] };
    case "execution":
      return { what: q.what, ...executionView(r) };
  }
}

const REJECT_TEXT: Record<string, string> = {
  suspended: "停牌",
  limit_up: "涨停开盘",
  limit_down: "跌停开盘",
  capacity: "超过成交额上限",
  lot_zero: "不够一手",
  cash: "现金不足",
  no_liquidity: "没有成交额数据",
};

/**
 * 成交与容量（query_run what = execution，D64）：成交假设、拒单统计、参与率、容量估计、滑点与费用。
 * 数字全部来自存档的诊断；早于 S05 的回测没有诊断，如实说没有。
 */
function executionView(r: ReturnType<typeof getRun>) {
  const d = r.diagnostics;
  const legacyFill = r.exec ? isLegacyFill(r.exec) : true;
  return {
    exec: r.exec ? describeExec(r.exec) : null,
    legacyFill,
    note: !d
      ? "这次回测早于成交诊断，没有拒单与容量数据"
      : legacyFill
        ? "旧成交假设（开盘价成交、不计滑点），结果偏乐观；只有拒单统计"
        : null,
    rejections: d
      ? Object.entries(d.rejections).map(([key, v]) => {
          const [side, reason] = key.split(":") as [string, string];
          return {
            side: side === "buy" ? "买" : "卖",
            reason: REJECT_TEXT[reason] ?? reason,
            count: v.count,
            value: Math.round(v.value),
          };
        })
      : [],
    recentSamples: (d?.samples ?? []).slice(-10).map((s) => ({
      date: s.date,
      code: s.code,
      side: s.side === "buy" ? "买" : "卖",
      reason: REJECT_TEXT[s.reason] ?? s.reason,
      wantValue: Math.round(s.wantValue),
      filledValue: Math.round(s.filledValue),
    })),
    participation: d?.participation ?? null,
    cappedBuyShare: d?.cappedBuyShare ?? null,
    advUnknownBuys: d?.advUnknownBuys ?? null,
    sigmaFallbacks: d?.sigmaFallbacks ?? null,
    capacityEstimate: d?.capacityEstimate ?? null,
    slippageCost: r.metrics?.slippageCost ?? null,
    fees: r.metrics?.fees ?? null,
    feeDrag: r.metrics?.feeDrag ?? r.metrics?.costDrag ?? null,
    slipDrag: r.metrics?.slipDrag ?? null,
  };
}

/** 某个版本上线日前最近一次跑完的回测（跟踪的对照基线） */
export function latestDoneRun(userId: string, versionId: string): RunRow | undefined {
  const { db } = env().app;
  return db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.userId, userId),
        eq(runs.versionId, versionId),
        eq(runs.kind, "backtest"),
        eq(runs.status, "done"),
      ),
    )
    .orderBy(desc(runs.finishedAt))
    .get();
}

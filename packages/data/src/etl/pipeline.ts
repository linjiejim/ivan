/**
 * ETL 编排：回填、夜间增量、每周抽检。数据版本先开后提交（D60）：开始写之前打开一个 open 版本，
 * 写入方给每行盖上版本号；成功提交 ok（截至日 = 因子表最新日期），休市提交 skipped，出错提交 failed，
 * 完整性闸门没过提交 incomplete（D73）。
 */
import {
  addDays,
  CLOSE_FINAL_HM,
  type DateStr,
  FACTOR_CORE_VERSION,
  FACTOR_REGISTRY_VERSION,
  MARKET_LABEL,
  type Market,
  nowHmCN,
  PIT_DATASET_IDS,
  type PitDatasetId,
  todayCN,
} from "@ivan/core";
import type { HttpLike } from "../http.ts";
import { backfillBars, fetchBars, recordHygiene, updateBars, writeBars } from "./bars.ts";
import type { Issue } from "../compute/hygiene.ts";
import {
  assessCompleteness,
  type Completeness,
  type DatasetCompleteness,
  IncompleteDataError,
  RetryableEtlError,
  type SoftOutcome,
  type SoftStep,
  SOFT_STEP_LABEL,
} from "./completeness.ts";
import { emQuery } from "../sources/eastmoney.ts";
import { type EtlContext, filledCodes, loadSecurities } from "./context.ts";
import { computeFactors } from "./factors.ts";
import {
  finishPitBatch,
  openPitBatch,
  PIT_DEFAULT_SINCE,
  type PitMode,
  type PitSyncResult,
  syncPitDataset,
} from "./pit-runner.ts";
import { buildAvailEnv } from "./trading-days.ts";
import { PIT_DATASET_SPECS } from "./datasets.ts";
import { backfillFundamentals, updateFundamentals } from "./fundamentals.ts";
import {
  DEFAULT_SINCE,
  latestTradeDates,
  updateEmDailyNames,
  updateFx,
  updateIndexes,
  updateSzseNames,
} from "./reference.ts";
import { refreshSecuritiesA, refreshSecuritiesHK } from "./securities.ts";
import { committedAsOf } from "../query/backtest.ts";
import { FetchLedger } from "../sources/chain.ts";
import { indexQuoteDate } from "../sources/tencent.ts";

export { DEFAULT_SINCE };

/** 今天的收盘价还没定稿（见 CLOSE_FINAL_HM）；命令行用 --today 指定了别的日期时不管 */
function beforeCloseFinal(ctx: EtlContext, market: Market): boolean {
  return ctx.today === todayCN() && nowHmCN() < CLOSE_FINAL_HM[market];
}

export type BackfillStep =
  | "securities"
  | "reference"
  | "names"
  | "bars"
  | "fundamentals"
  | "events"
  | "factors";
export const BACKFILL_STEPS: BackfillStep[] = [
  "securities",
  "reference",
  "names",
  "bars",
  "fundamentals",
  // 点时事件数据（S15，只有 A 股）：两融、户数、解禁、大宗的历史
  "events",
  "factors",
];

export interface BackfillOptions {
  since?: DateStr;
  steps?: BackfillStep[];
  limit?: number;
  force?: boolean;
  /** 只处理这些代码（调试用） */
  codes?: string[];
  /** 只处理市值最大的 N 只（开发用的小数据集） */
  top?: number;
}

/** 当前市值最大的 N 只（A 股取东财估值表，港股取最近一期主要指标里的总市值）。 */
async function largestByMcap(ctx: EtlContext, market: Market, n: number): Promise<Set<string>> {
  if (market === "A") {
    const latest = await emQuery(ctx.http, {
      report: "RPT_VALUEANALYSIS_DET",
      columns: "TRADE_DATE",
      sort: "TRADE_DATE",
      pageSize: 1,
      maxRows: 1,
    });
    const d = String(latest[0]?.TRADE_DATE ?? "").slice(0, 10);
    const rows = await emQuery(ctx.http, {
      report: "RPT_VALUEANALYSIS_DET",
      filter: `(TRADE_DATE='${d}')`,
      columns: "SECUCODE,TOTAL_MARKET_CAP",
      sort: "TOTAL_MARKET_CAP",
      pageSize: n,
      maxRows: n,
    });
    return new Set(rows.map((r) => String(r.SECUCODE)));
  }
  const rows = await emQuery(ctx.http, {
    report: "RPT_HKF10_FN_MAININDICATOR",
    host: "sec",
    filter: `(REPORT_DATE>='${addDays(ctx.today, -200)}')`,
    columns: "SECUCODE,TOTAL_MARKET_CAP",
    sort: "TOTAL_MARKET_CAP",
    pageSize: 5000,
  });
  const out = new Set<string>();
  for (const r of rows) {
    out.add(String(r.SECUCODE));
    if (out.size >= n) break;
  }
  return out;
}

async function refreshSecurities(ctx: EtlContext, market: Market) {
  return market === "A" ? refreshSecuritiesA(ctx) : refreshSecuritiesHK(ctx);
}

export type DataVersionKind = "backfill" | "daily" | "check";
export type DataVersionStatus = "ok" | "incomplete" | "failed" | "skipped";

/**
 * 打开一个数据版本（D60）：在写任何东西之前调用。先把这个市场残留的 open 行（上次写到一半进程没了）
 * 关成 failed，再写一行 open，返回版本号；写入方用 ctx.ver 给每行盖章。
 */
export async function beginDataVersion(
  ctx: EtlContext,
  market: Market,
  kind: DataVersionKind,
): Promise<number> {
  return ctx.wh.exclusive(async () => {
    await ctx.wh.run(
      `UPDATE data_versions SET status = 'failed', note = trim(coalesce(note, '') || ' 中断'),
         finished_at = current_timestamp
       WHERE market = $m AND status = 'open'`,
      { m: market },
    );
    const id = Number(await ctx.wh.scalar(`SELECT nextval('data_version_seq')`));
    await ctx.wh.run(
      `INSERT INTO data_versions (id, market, as_of, kind, status, started_at, registry_version, finished_at)
       VALUES ($id, $m, NULL, $k, 'open', current_timestamp, $r, NULL)`,
      { id, m: market, k: kind, r: FACTOR_REGISTRY_VERSION },
    );
    return id;
  });
}

/**
 * 提交数据版本：ok / incomplete 的截至日 = 这个市场因子表的最新日期；skipped（休市）、failed 不给截至日，
 * 也永远不会被引用（latestDataVersion 只认 ok）。
 * maxAsOf：截至日的上限。不新增交易日的写入（每周抽检、按代码回填）传开版本前的 committedAsOf，
 * 截至日不超过它——某晚写了一半因子后失败，这类提交也不会把那天「提交」出去（D60）；传 null 表示不给截至日。
 */
export async function commitDataVersion(
  ctx: EtlContext,
  id: number,
  r: {
    status: DataVersionStatus;
    completeness?: object;
    sources?: object;
    note?: string;
    revisedRows?: number;
    maxAsOf?: DateStr | null;
  },
): Promise<{ id: number; asOf: DateStr | null }> {
  return ctx.wh.exclusive(async () => {
    const row = await ctx.wh.one<{ market: string }>(
      `SELECT market FROM data_versions WHERE id = $id`,
      { id },
    );
    if (!row) throw new Error(`数据版本 #${id} 不存在`);
    const withAsOf = r.status === "ok" || r.status === "incomplete";
    let asOf = withAsOf
      ? ((await ctx.wh.scalar<string>(
          `SELECT max(date)::VARCHAR FROM factors_daily WHERE market = $m`,
          { m: row.market },
        )) ?? null)
      : null;
    if (r.maxAsOf !== undefined && asOf !== null && (r.maxAsOf === null || asOf > r.maxAsOf)) {
      asOf = r.maxAsOf;
    }
    await ctx.wh.run(
      `UPDATE data_versions SET status = $s, as_of = $a::DATE, finished_at = current_timestamp,
         completeness = $c, sources = $src, note = $n, revised_rows = $rv
       WHERE id = $id`,
      {
        id,
        s: r.status,
        a: asOf,
        c: r.completeness ? JSON.stringify(r.completeness) : null,
        src: r.sources ? JSON.stringify(r.sources) : null,
        n: r.note ?? null,
        rv: r.revisedRows ?? 0,
      },
    );
    return { id, asOf };
  });
}

/** 出错时把版本记成 failed（尽力而为：记不上也不能盖住原来的错误） */
async function failDataVersion(ctx: EtlContext, id: number, e: unknown): Promise<void> {
  try {
    await commitDataVersion(ctx, id, {
      status: "failed",
      note: (e instanceof Error ? e.message : String(e)).slice(0, 300),
      sources: ctx.ledger?.toJSON(),
    });
  } catch (e2) {
    ctx.log(`数据版本 #${id} 记成失败时出错：${e2 instanceof Error ? e2.message : e2}`);
  }
}

export async function backfill(ctx: EtlContext, market: Market, opts: BackfillOptions = {}) {
  if (beforeCloseFinal(ctx, market)) {
    ctx = { ...ctx, today: addDays(ctx.today, -1) };
    ctx.log(`北京时间 ${nowHmCN()}，${MARKET_LABEL[market]}今天的收盘价还没定稿，只回填到 ${ctx.today}`);
  }
  // 只回填指定代码时其余股票的因子没重算，截至日不超过已提交的那天（还没提交过就当首次建库，不设上限）
  const held = opts.codes ? ((await committedAsOf(ctx.wh, market)) ?? undefined) : undefined;
  const ver = await beginDataVersion(ctx, market, "backfill");
  // 取数台账（D72）：各来源服务了多少只、回退几次、失败明细，提交时写进 data_versions.sources
  ctx = { ...ctx, ver, ledger: new FetchLedger() };
  try {
    await backfillSteps(ctx, market, opts, ver, held);
  } catch (e) {
    await failDataVersion(ctx, ver, e);
    throw e;
  }
}

async function backfillSteps(
  ctx: EtlContext,
  market: Market,
  opts: BackfillOptions,
  ver: number,
  maxAsOf: DateStr | undefined,
) {
  const since = opts.since ?? DEFAULT_SINCE;
  const steps = new Set(opts.steps ?? BACKFILL_STEPS);
  const t0 = Date.now();
  if (steps.has("securities")) await refreshSecurities(ctx, market);
  if (steps.has("reference")) {
    await updateIndexes(ctx, market, since);
    if (market === "HK") await updateFx(ctx, since);
  }
  if (steps.has("names") && market === "A") {
    await updateSzseNames(ctx);
    await updateEmDailyNames(ctx, { from: "2018-01-02" });
  }
  let securities = await loadSecurities(ctx.wh, market, since);
  if (opts.codes) securities = securities.filter((s) => opts.codes!.includes(s.code));
  if (opts.top) {
    const ranked = await largestByMcap(ctx, market, opts.top);
    securities = securities.filter((s) => ranked.has(s.code));
    opts = { ...opts, codes: securities.map((s) => s.code) };
    ctx.log(`只回填市值最大的 ${securities.length} 只`);
  }
  if (steps.has("bars") || steps.has("fundamentals")) {
    // 日线（腾讯）与财报/股本（东财）走不同域名，并行跑
    const jobs: Promise<unknown>[] = [];
    if (steps.has("bars")) {
      jobs.push(
        backfillBars(ctx, securities, { since, limit: opts.limit, force: opts.force }).then((r) =>
          ctx.log(`日线回填：完成 ${r.done}，失败 ${r.failed}，跳过 ${r.skipped}`),
        ),
      );
    }
    if (steps.has("fundamentals")) {
      jobs.push(
        backfillFundamentals(ctx, securities, { since, limit: opts.limit, force: opts.force }).then(
          (r) => ctx.log(`财报/股本回填：完成 ${r.done}，失败 ${r.failed}`),
        ),
      );
    }
    await Promise.all(jobs);
    // 日线回来后补上「换代码」股票的退市日与缺失的上市日；只是补充，失败不影响后面算因子
    if (steps.has("bars") && steps.has("securities")) {
      await refreshSecurities(ctx, market).catch((e: unknown) =>
        ctx.log(`证券表二次刷新失败，先跳过：${e instanceof Error ? e.message : e}`),
      );
    }
  }
  if (steps.has("events") && market === "A" && !opts.codes) {
    // 不设预算、不开新的数据版本（行上 ver 为空，批次记在 pit_batches）
    const r = await runPitSyncs(ctx, "backfill", PIT_DATASET_IDS, ver, {
      from: opts.since ?? PIT_DEFAULT_SINCE,
      force: opts.force,
    });
    ctx.log(
      `事件数据回填：${r.results.map((x) => `${x.id} ${x.done + x.partial.length}/${x.chunks}`).join("，")}`,
    );
  }
  if (steps.has("factors")) {
    await computeFactors(ctx, market, since, { codes: opts.codes });
    await commitDataVersion(ctx, ver, {
      status: "ok",
      note: `since ${since}`,
      maxAsOf,
      sources: ctx.ledger?.toJSON(),
    });
  } else {
    // 没重算因子：写进去的数据还没反映到因子上，记成不完整（不会被引用；skipped 只留给休市）
    await commitDataVersion(ctx, ver, {
      status: "incomplete",
      note: `since ${since}，没有重算因子`,
      maxAsOf,
      sources: ctx.ledger?.toJSON(),
    });
  }
  ctx.log(`${market} 回填结束，用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
}

/**
 * 指数日 K 里没有今天时，确认今天确实休市：只有指数实时报价的日期明确早于今天才算休市。
 * 报价日期是今天（开市了、只是日 K 还没更新），或报价请求失败、解析不出日期（确认不了），都抛错——
 * 开市日宁可报「数据没更新」，也不能说成休市（D78、验收 6）。
 */
export async function confirmNonTradingDay(
  http: HttpLike,
  market: Market,
  today: DateStr,
): Promise<void> {
  const label = MARKET_LABEL[market];
  let quoted: DateStr | null;
  try {
    quoted = await indexQuoteDate(http, market === "A" ? "sh000001" : "hkHSI");
  } catch (e) {
    throw new Error(
      `${label}指数日 K 还没有今天的数据，指数报价也没查到（${e instanceof Error ? e.message : e}），确认不了今天是否休市，稍后在管理页重跑`,
      { cause: e },
    );
  }
  if (quoted === null) {
    throw new Error(
      `${label}指数日 K 还没有今天的数据，指数报价里也读不出日期，确认不了今天是否休市，稍后在管理页重跑`,
    );
  }
  if (quoted >= today) {
    // 开市了、只是日 K 还没更新：45 分钟后自动重跑（D73）
    throw new RetryableEtlError(`${label}今天开市了，但指数日 K 还没有今天的数据，稍后自动重跑`);
  }
}

export interface DailyOptions {
  since?: DateStr;
  /** 运行中跟踪的持仓与明日计划里的代码：缺了不让整晚失败，只让相关跟踪显示「数据未更新」 */
  critical?: Iterable<string>;
  /** 应急放行的代码（ETL_ACCEPT_MISSING） */
  acceptMissing?: Iterable<string>;
}

export interface DailyResult {
  market: Market;
  tradingDay: boolean;
  latest: DateStr | null;
  dataVersion?: number;
  /** 今晚的完整性（交易日才有） */
  completeness?: Completeness;
}

/**
 * 夜间增量：开版本 → 指数与日历 → 今天休市就结束 → 汇率 / 证券表（软）→ 日线 → 完整性闸门（D73）→
 * 简称 / 财报与股本（软）→ 因子（近 15 天重算）→ 提交。闸门在财报与因子之前：拿不全就提交 incomplete、抛
 * IncompleteDataError，今天的因子不算（读的人停在上一个提交过的版本上）。
 */
export async function daily(ctx: EtlContext, market: Market, opts: DailyOptions = {}): Promise<DailyResult> {
  if (beforeCloseFinal(ctx, market)) {
    throw new Error(
      `${MARKET_LABEL[market]}今天的收盘价还没定稿，北京时间 ${CLOSE_FINAL_HM[market]} 之后再更新（以免把盘中价当成收盘价）`,
    );
  }
  // 先开版本再写任何东西（D60）：今天的指数与日历也盖上这个版本号
  const ver = await beginDataVersion(ctx, market, "daily");
  ctx = { ...ctx, ver, ledger: new FetchLedger() };
  try {
    return await dailySteps(ctx, market, opts, ver);
  } catch (e) {
    // 闸门没过时版本已经提交成 incomplete，不再改成 failed
    if (!(e instanceof IncompleteDataError)) await failDataVersion(ctx, ver, e);
    throw e;
  }
}

/**
 * 按顺序同步几个点时事件数据集（同一批 pit_batches）。每个数据集自己失败就关，不抛错；each 拿到每个数据集的 run
 * （夜间把它包进软步骤）。给了 budgetMs 时各数据集分剩下的预算，用完了后面的数据集这次不跑（记进 skipped）。
 * 出错（比如行情仓写失败）时也把批次收尾。
 */
export async function runPitSyncs(
  ctx: EtlContext,
  mode: PitMode,
  ids: readonly PitDatasetId[],
  dataVersion: number | null,
  o: {
    from?: DateStr;
    to?: DateStr;
    force?: boolean;
    budgetMs?: number;
    note?: (results: PitSyncResult[]) => string | Promise<string>;
    each?: (id: PitDatasetId, run: () => Promise<PitSyncResult>) => Promise<void>;
    /** 计时（测试注入） */
    now?: () => number;
  } = {},
): Promise<{ batch: number; results: PitSyncResult[]; skipped: PitDatasetId[] }> {
  const env = await buildAvailEnv(ctx.wh, ctx.today);
  // 周检里没有要补扫的段（两融的 check 是空的）：不跑，不花一次金丝雀请求，也不把夜间记下的「只拿到沪市」改写成 ok
  if (mode === "check") ids = ids.filter((id) => PIT_DATASET_SPECS[id].check(env).length > 0);
  const batch = await openPitBatch(ctx, mode, ids, dataVersion);
  const results: PitSyncResult[] = [];
  const skipped: PitDatasetId[] = [];
  const now = o.now ?? Date.now;
  const t0 = now();
  try {
    for (const id of ids) {
      const budgetMs = o.budgetMs === undefined ? undefined : o.budgetMs - (now() - t0);
      if (budgetMs !== undefined && budgetMs <= 0) {
        skipped.push(id);
        continue;
      }
      const run = async () => {
        const r = await syncPitDataset(ctx, id, {
          mode,
          batch,
          env,
          from: o.from,
          to: o.to,
          force: o.force,
          budgetMs,
          now: o.now,
        });
        results.push(r);
        return r;
      };
      if (o.each) await o.each(id, run);
      else await run();
    }
  } finally {
    let note: string | undefined;
    try {
      note = await o.note?.(results);
    } catch {
      note = undefined;
    }
    await finishPitBatch(ctx, batch, results, note);
  }
  return { batch, results, skipped };
}

const datasetCompleteness = (r: PitSyncResult): DatasetCompleteness => ({
  ok: r.ok,
  canary: r.canary?.status ?? null,
  rows: r.rows,
  requests: r.requests,
  partial: r.partial,
  ...(r.lateRows !== undefined ? { lateRows: r.lateRows } : {}),
});

/** 近 20 个版本（ok / incomplete）里记下的无成交数，最新的在前 */
async function noTradeHistory(ctx: EtlContext, market: Market, ver: number): Promise<number[]> {
  const rows = await ctx.wh.all<{ c: string }>(
    `SELECT completeness AS c FROM data_versions
     WHERE market = $m AND id < $v AND status IN ('ok', 'incomplete') AND completeness IS NOT NULL
       AND coalesce(kind, '') <> 'check'
     ORDER BY id DESC LIMIT 20`,
    { m: market, v: ver },
  );
  const out: number[] = [];
  for (const r of rows) {
    try {
      const n = (JSON.parse(r.c) as Partial<Completeness>).noTrade;
      if (typeof n === "number") out.push(n);
    } catch {
      // 读不懂的旧行跳过
    }
  }
  return out;
}

async function dailySteps(
  ctx: EtlContext,
  market: Market,
  opts: DailyOptions,
  ver: number,
): Promise<DailyResult> {
  const since = opts.since ?? DEFAULT_SINCE;
  const lastIndex = await ctx.wh.scalar<string>(
    `SELECT max(date)::VARCHAR FROM trade_calendar WHERE market = $m`,
    { m: market },
  );
  await updateIndexes(ctx, market, addDays(lastIndex ?? since, -20));
  const { latest, prev } = await latestTradeDates(ctx, market);
  if (latest !== ctx.today) {
    // 日 K 里没有今天：用指数实时报价交叉验证，确认不了是休市就让任务失败（看板出横幅，稍后重跑）
    if (ctx.today === todayCN()) await confirmNonTradingDay(ctx.http, market, ctx.today);
    ctx.log(`${market} 今天（${ctx.today}）休市，最近交易日 ${latest}`);
    await commitDataVersion(ctx, ver, { status: "skipped", note: "休市", sources: ctx.ledger?.toJSON() });
    return { market, tradingDay: false, latest };
  }
  // 辅助数据失败沿用旧数据、不让整晚失败；结果留痕进 completeness.soft，连续失败管理页看得到（D73）
  const softOutcomes: SoftOutcome[] = [];
  const soft = async (step: SoftStep, fn: () => Promise<unknown>) => {
    try {
      const r = await fn();
      const rows =
        typeof r === "number"
          ? r
          : r && typeof r === "object"
            ? Object.values(r).reduce<number>((a, v) => a + (typeof v === "number" ? v : 0), 0)
            : undefined;
      softOutcomes.push({ step, ok: true, ...(rows !== undefined ? { rows } : {}) });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      ctx.log(`${SOFT_STEP_LABEL[step]}更新失败，沿用旧数据：${error}`);
      softOutcomes.push({ step, ok: false, error: error.slice(0, 200) });
    }
  };
  if (market === "HK") await soft("fx", () => updateFx(ctx, addDays(ctx.today, -20)));
  await soft("securities", () => refreshSecurities(ctx, market));
  const securities = await loadSecurities(ctx.wh, market, since);
  const bars = await updateBars(ctx, market, securities, latest, prev ?? latest);

  // 完整性闸门（D73）：在简称、财报与因子之前判断
  const completeness: Completeness = {
    ...assessCompleteness({
      market,
      expected: bars.expected,
      updated: bars.updated,
      noTrade: bars.noTrade,
      missing: bars.missing,
      critical: new Set(opts.critical ?? []),
      accepted: new Set(opts.acceptMissing ?? []),
      noTradeHistory: await noTradeHistory(ctx, market, ver),
    }),
    date: ctx.today,
    soft: softOutcomes,
  };
  if (completeness.missingCritical.length) {
    ctx.log(`持仓或计划里的 ${completeness.missingCritical.length} 只没拿到今天的日线：${completeness.missingCritical.join(",")}`);
  }
  if (!completeness.ok) {
    const msg = completeness.reasons.join("；");
    await commitDataVersion(ctx, ver, {
      status: "incomplete",
      completeness,
      note: msg.slice(0, 300),
      sources: ctx.ledger?.toJSON(),
    });
    throw new IncompleteDataError(msg);
  }

  if (market === "A") {
    await soft("names_szse", () => updateSzseNames(ctx, 3));
    await soft("names_em", () => updateEmDailyNames(ctx));
  }
  await soft("fundamentals", () => updateFundamentals(ctx, market, securities, since));

  // 点时事件数据（S15，只有 A 股）：四个软步骤，失败就关（不删不写），不让整晚失败；行盖今晚的版本号
  if (market === "A") {
    const datasets: NonNullable<Completeness["datasets"]> = {};
    try {
      await runPitSyncs(ctx, "nightly", PIT_DATASET_IDS, ver, {
        each: (id, run) =>
          soft(id, async () => {
            const r = await run();
            datasets[id] = datasetCompleteness(r);
            if (!r.ok) throw new Error(r.detail);
            return r.rows;
          }),
      });
    } catch (e) {
      ctx.log(`事件数据同步出错，先跳过：${e instanceof Error ? e.message : e}`);
    }
    completeness.datasets = datasets;
  }

  // 核心因子版本变了就全量重算，否则只重算近 15 天（覆盖晚到的股本变动与数据修订）。
  // 行情仓里的键沿用 factor_registry_version:<市场>，记的是核心版本（D83）：注册表第 3 版只加事件列，不触发重算
  const reg = await ctx.wh.meta(`factor_registry_version:${market}`);
  const from = reg === String(FACTOR_CORE_VERSION) ? addDays(ctx.today, -15) : since;
  const fr = await computeFactors(ctx, market, from);
  // 事件因子是软步骤（S15b）：失败时保留已有的值，记进 completeness.soft，整晚照常提交
  if (fr.events) softOutcomes.push(fr.events);
  await commitDataVersion(ctx, ver, { status: "ok", completeness, sources: ctx.ledger?.toJSON() });
  return { market, tradingDay: true, latest, dataVersion: ver, completeness };
}

/**
 * 每周抽检（spec §8、D74）：抽 50 只在市股票重拉最近一年日线，和库里比收盘价，差异 > 0.5% 算一行被修订；
 * 被修订的股票整段重写并重算因子，结果记一条 data_versions（kind = check）。
 * 收盘价一致时再比归一后的复权因子（差 > 0.1% → check_adj）与成交量（差 > 1% → check_volume）：只标记、不自动修
 * （不知道哪家对）；比对一致的股票关掉它之前的 check_* 问题（resolved_by = check）。
 */
export async function weeklyCheck(
  ctx: EtlContext,
  market: Market,
  sample = 50,
): Promise<{ checked: number; revisedRows: number; repaired: string[]; flagged: number }> {
  // 抽检不新增交易日：截至日沿用开版本前已提交的那天，不把失败夜写了一半的因子提交出去（D60）
  const held = await committedAsOf(ctx.wh, market);
  const ver = await beginDataVersion(ctx, market, "check");
  ctx = { ...ctx, ver };
  try {
    return await weeklyCheckSteps(ctx, market, sample, ver, held);
  } catch (e) {
    await failDataVersion(ctx, ver, e);
    throw e;
  }
}

/** 抽检比对的阈值 */
const CHECK_CLOSE_DIFF = 0.005;
const CHECK_ADJ_DIFF = 0.001;
const CHECK_VOLUME_DIFF = 0.01;

/**
 * 一只股票的复权因子与成交量比对（收盘价已经一致时）：各规则只在第一处不一致的日子记一条，详情写共几天。
 */
export function compareAdjVolume(
  stored: ReadonlyMap<string, { adj: number; volume: number }>,
  fresh: ReadonlyArray<{ date: DateStr; adj: number; volume: number }>,
): Issue[] {
  const common = fresh.filter((r) => stored.has(r.date));
  if (!common.length) return [];
  // 两边的因子基准不同（库里接过锚），按第一个共同日归一
  const base = stored.get(common[0]!.date)!.adj / common[0]!.adj;
  let adjFirst: DateStr | null = null;
  let adjN = 0;
  let volFirst: DateStr | null = null;
  let volN = 0;
  for (const r of common) {
    const old = stored.get(r.date)!;
    if (Math.abs(old.adj / (r.adj * base) - 1) > CHECK_ADJ_DIFF) {
      adjFirst ??= r.date;
      adjN++;
    }
    const denom = Math.max(Math.abs(r.volume), 1);
    if (Math.abs(old.volume - r.volume) / denom > CHECK_VOLUME_DIFF) {
      volFirst ??= r.date;
      volN++;
    }
  }
  const out: Issue[] = [];
  if (adjFirst) {
    out.push({
      rule: "check_adj",
      severity: "flag",
      date: adjFirst,
      detail: `重拉的复权因子和库里不一致，共 ${adjN} 天（差超过 ${CHECK_ADJ_DIFF * 100}%）`,
    });
  }
  if (volFirst) {
    out.push({
      rule: "check_volume",
      severity: "flag",
      date: volFirst,
      detail: `重拉的成交量和库里不一致，共 ${volN} 天（差超过 ${CHECK_VOLUME_DIFF * 100}%）`,
    });
  }
  return out;
}

async function weeklyCheckSteps(
  ctx: EtlContext,
  market: Market,
  sample: number,
  ver: number,
  maxAsOf: DateStr | null,
): Promise<{ checked: number; revisedRows: number; repaired: string[]; flagged: number }> {
  const filled = await filledCodes(ctx.wh, market);
  const securities = (await loadSecurities(ctx.wh, market)).filter(
    (s) => !s.delist_date && filled.has(s.code),
  );
  // 按周轮换抽样，保证几周内覆盖更多股票
  const week = Math.floor(Date.parse(ctx.today) / (7 * 86_400_000));
  const picked = securities.filter((_, i) => (i + week) % Math.max(1, Math.floor(securities.length / sample)) === 0).slice(0, sample);
  const from = addDays(ctx.today, -365);
  let revisedRows = 0;
  let flagged = 0;
  const repaired: string[] = [];
  for (const s of picked) {
    const stored = new Map(
      (
        await ctx.wh.all<{ d: string; close: number; adj: number; volume: number }>(
          `SELECT date::VARCHAR AS d, close, adj, volume FROM bars_daily WHERE code = $c AND date >= $f::DATE`,
          { c: s.code, f: from },
        )
      ).map((r) => [r.d, r]),
    );
    let fresh;
    try {
      fresh = await fetchBars(ctx, s.code, from, ctx.today);
    } catch (e) {
      ctx.log(`抽检 ${s.code} 拉取失败：${e instanceof Error ? e.message : e}`);
      continue;
    }
    let diff = 0;
    for (const r of fresh.rows) {
      const old = stored.get(r[1]);
      if (old !== undefined && Math.abs(old.close - r[5]) / r[5] > CHECK_CLOSE_DIFF) diff++;
    }
    if (diff) {
      revisedRows += diff;
      repaired.push(s.code);
      await refetchWhole(ctx, s.code, s.list_date);
      continue;
    }
    const issues = compareAdjVolume(
      stored,
      fresh.rows.map((r) => ({ date: r[1], adj: r[8], volume: r[6] })),
    );
    flagged += issues.length;
    await ctx.wh.exclusive(async () => {
      if (issues.length) await recordHygiene(ctx, [{ code: s.code, src: fresh.source, written: [], issues }]);
      // 这次没再不一致的规则：之前的 check_* 问题记为已解决
      const still = issues.length
        ? `AND rule NOT IN (${issues.map((x) => `'${x.rule}'`).join(",")})`
        : "";
      await ctx.wh.run(
        `UPDATE data_issues SET resolved_ver = $v, resolved_by = 'check'
         WHERE code = $c AND dataset = 'bars' AND resolved_by IS NULL AND rule IN ('check_adj', 'check_volume')
           AND ver < $v ${still}`,
        { v: ver, c: s.code },
      );
    });
  }
  if (repaired.length) await computeFactors(ctx, market, DEFAULT_SINCE, { codes: repaired });
  // 点时事件数据的更宽补扫（S15，只有 A 股）：补上东财晚入库的行，新找到的行数记进 lateRows；失败不让抽检失败
  let datasets: Completeness["datasets"];
  if (market === "A") {
    datasets = {};
    try {
      const { results } = await runPitSyncs(ctx, "check", PIT_DATASET_IDS, ver);
      for (const r of results) datasets[r.id] = datasetCompleteness(r);
    } catch (e) {
      ctx.log(`事件数据补扫出错，先跳过：${e instanceof Error ? e.message : e}`);
    }
  }
  await commitDataVersion(ctx, ver, {
    status: "ok",
    revisedRows,
    maxAsOf,
    note: `抽检 ${picked.length} 只，修复 ${repaired.join(",") || "无"}，标记 ${flagged} 处`,
    ...(datasets ? { completeness: { date: ctx.today, datasets } } : {}),
  });
  ctx.log(
    `${market} 每周抽检：${picked.length} 只，${revisedRows} 行被修订，修复 ${repaired.length} 只，标记 ${flagged} 处`,
  );
  return { checked: picked.length, revisedRows, repaired, flagged };
}

/** 整段重写一只股票（抽检发现收盘价被修订）：同样过体检（D74） */
async function refetchWhole(ctx: EtlContext, code: string, listDate: string | null): Promise<void> {
  const from = listDate && listDate > DEFAULT_SINCE ? listDate : DEFAULT_SINCE;
  const fetched = await fetchBars(ctx, code, from, ctx.today);
  await writeBars(ctx, code, from, fetched, { wholeHistory: true });
}

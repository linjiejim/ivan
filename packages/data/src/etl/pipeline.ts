/**
 * ETL 编排：回填、夜间增量、每周抽检。数据版本先开后提交（D60）：开始写之前打开一个 open 版本，
 * 写入方给每行盖上版本号；成功提交 ok（截至日 = 因子表最新日期），休市提交 skipped，出错提交 failed。
 */
import {
  addDays,
  CLOSE_FINAL_HM,
  type DateStr,
  FACTOR_REGISTRY_VERSION,
  MARKET_LABEL,
  type Market,
  nowHmCN,
  todayCN,
} from "@ivan/core";
import type { HttpLike } from "../http.ts";
import { backfillBars, fetchBars, updateBars } from "./bars.ts";
import { emQuery } from "../sources/eastmoney.ts";
import { type EtlContext, filledCodes, loadSecurities } from "./context.ts";
import { computeFactors } from "./factors.ts";
import { backfillFundamentals, updateFundamentals } from "./fundamentals.ts";
import {
  latestTradeDates,
  updateEmDailyNames,
  updateFx,
  updateIndexes,
  updateSzseNames,
} from "./reference.ts";
import { refreshSecuritiesA, refreshSecuritiesHK } from "./securities.ts";
import { committedAsOf } from "../query/backtest.ts";
import { indexQuoteDate } from "../sources/tencent.ts";

export const DEFAULT_SINCE = "2013-01-01";

/** 今天的收盘价还没定稿（见 CLOSE_FINAL_HM）；命令行用 --today 指定了别的日期时不管 */
function beforeCloseFinal(ctx: EtlContext, market: Market): boolean {
  return ctx.today === todayCN() && nowHmCN() < CLOSE_FINAL_HM[market];
}

export type BackfillStep = "securities" | "reference" | "names" | "bars" | "fundamentals" | "factors";
export const BACKFILL_STEPS: BackfillStep[] = [
  "securities",
  "reference",
  "names",
  "bars",
  "fundamentals",
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
  ctx = { ...ctx, ver };
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
  if (steps.has("factors")) {
    await computeFactors(ctx, market, since, { codes: opts.codes });
    await commitDataVersion(ctx, ver, { status: "ok", note: `since ${since}`, maxAsOf });
  } else {
    // 没重算因子：写进去的数据还没反映到因子上，记成不完整（不会被引用；skipped 只留给休市）
    await commitDataVersion(ctx, ver, {
      status: "incomplete",
      note: `since ${since}，没有重算因子`,
      maxAsOf,
    });
  }
  ctx.log(`${market} 回填结束，用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
}

export interface DailyResult {
  market: Market;
  tradingDay: boolean;
  latest: DateStr | null;
  dataVersion?: number;
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
  if (quoted === null || quoted >= today) {
    throw new Error(
      quoted === null
        ? `${label}指数日 K 还没有今天的数据，指数报价里也读不出日期，确认不了今天是否休市，稍后在管理页重跑`
        : `${label}今天开市了，但指数日 K 还没有今天的数据，稍后在管理页重跑`,
    );
  }
}

/**
 * 夜间增量：日历 → 今天休市就结束 → 证券表 → 日线 → 简称 → 财报/股本 → 因子（近 15 天重算）→ 数据版本。
 */
export async function daily(ctx: EtlContext, market: Market, since = DEFAULT_SINCE): Promise<DailyResult> {
  if (beforeCloseFinal(ctx, market)) {
    throw new Error(
      `${MARKET_LABEL[market]}今天的收盘价还没定稿，北京时间 ${CLOSE_FINAL_HM[market]} 之后再更新（以免把盘中价当成收盘价）`,
    );
  }
  // 先开版本再写任何东西（D60）：今天的指数与日历也盖上这个版本号
  const ver = await beginDataVersion(ctx, market, "daily");
  ctx = { ...ctx, ver };
  try {
    return await dailySteps(ctx, market, since, ver);
  } catch (e) {
    await failDataVersion(ctx, ver, e);
    throw e;
  }
}

async function dailySteps(
  ctx: EtlContext,
  market: Market,
  since: DateStr,
  ver: number,
): Promise<DailyResult> {
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
    await commitDataVersion(ctx, ver, { status: "skipped", note: "休市" });
    return { market, tradingDay: false, latest };
  }
  // 辅助数据失败只记日志、沿用旧数据；核心的日历与日线失败才让任务失败（spec §8）
  const soft = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      ctx.log(`${what}失败，沿用旧数据：${e instanceof Error ? e.message : e}`);
    }
  };
  if (market === "HK") await soft("汇率更新", () => updateFx(ctx, addDays(ctx.today, -20)));
  await soft("证券表刷新", () => refreshSecurities(ctx, market));
  const securities = await loadSecurities(ctx.wh, market, since);
  await updateBars(ctx, market, securities, latest, prev ?? latest);
  if (market === "A") {
    await soft("深交所简称变更", () => updateSzseNames(ctx, 3));
    await soft("沪市每日简称", () => updateEmDailyNames(ctx));
  }
  await soft("财报/股本增量", () => updateFundamentals(ctx, market, securities, since));

  // 注册表版本变了就全量重算，否则只重算近 15 天（覆盖晚到的股本变动与数据修订）
  const reg = await ctx.wh.meta(`factor_registry_version:${market}`);
  const from = reg === String(FACTOR_REGISTRY_VERSION) ? addDays(ctx.today, -15) : since;
  await computeFactors(ctx, market, from);
  await commitDataVersion(ctx, ver, { status: "ok" });
  return { market, tradingDay: true, latest, dataVersion: ver };
}

/**
 * 每周抽检（spec §8）：抽 50 只在市股票重拉最近一年日线，和库里比收盘价，差异 > 0.5% 算一行被修订；
 * 被修订的股票整段重写并重算因子，结果记一条 data_versions（kind = check）。
 */
export async function weeklyCheck(
  ctx: EtlContext,
  market: Market,
  sample = 50,
): Promise<{ checked: number; revisedRows: number; repaired: string[] }> {
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

async function weeklyCheckSteps(
  ctx: EtlContext,
  market: Market,
  sample: number,
  ver: number,
  maxAsOf: DateStr | null,
): Promise<{ checked: number; revisedRows: number; repaired: string[] }> {
  const filled = await filledCodes(ctx.wh, market);
  const securities = (await loadSecurities(ctx.wh, market)).filter(
    (s) => !s.delist_date && filled.has(s.code),
  );
  // 按周轮换抽样，保证几周内覆盖更多股票
  const week = Math.floor(Date.parse(ctx.today) / (7 * 86_400_000));
  const picked = securities.filter((_, i) => (i + week) % Math.max(1, Math.floor(securities.length / sample)) === 0).slice(0, sample);
  const from = addDays(ctx.today, -365);
  let revisedRows = 0;
  const repaired: string[] = [];
  for (const s of picked) {
    const stored = new Map(
      (
        await ctx.wh.all<{ d: string; close: number }>(
          `SELECT date::VARCHAR AS d, close FROM bars_daily WHERE code = $c AND date >= $f::DATE`,
          { c: s.code, f: from },
        )
      ).map((r) => [r.d, r.close]),
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
      if (old !== undefined && Math.abs(old - r[5]) / r[5] > 0.005) diff++;
    }
    if (diff) {
      revisedRows += diff;
      repaired.push(s.code);
      await refetchWhole(ctx, s.code, s.list_date);
    }
  }
  if (repaired.length) await computeFactors(ctx, market, DEFAULT_SINCE, { codes: repaired });
  await commitDataVersion(ctx, ver, {
    status: "ok",
    revisedRows,
    maxAsOf,
    note: `抽检 ${picked.length} 只，修复 ${repaired.join(",") || "无"}`,
  });
  ctx.log(`${market} 每周抽检：${picked.length} 只，${revisedRows} 行被修订，修复 ${repaired.length} 只`);
  return { checked: picked.length, revisedRows, repaired };
}

async function refetchWhole(ctx: EtlContext, code: string, listDate: string | null): Promise<void> {
  const from = listDate && listDate > DEFAULT_SINCE ? listDate : DEFAULT_SINCE;
  const fetched = await fetchBars(ctx, code, from, ctx.today);
  await ctx.wh.exclusive(async () => {
    await ctx.wh.run(`DELETE FROM bars_daily WHERE code = $c`, { c: code });
    await ctx.wh.append("bars_daily", fetched.rows);
    await ctx.wh.run(`DELETE FROM corp_actions WHERE code = $c`, { c: code });
    await ctx.wh.append(
      "corp_actions",
      fetched.actions.map((a) => [
        code,
        a.date,
        a.prevClose,
        a.refPrice,
        a.cash,
        a.split,
        fetched.source,
        ctx.ver ?? null,
      ]),
    );
  });
}

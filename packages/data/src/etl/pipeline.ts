/**
 * ETL 编排：回填与夜间增量。每次成功结束写一条 data_versions（数据版本 = 截至交易日）。
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

export async function recordDataVersion(
  ctx: EtlContext,
  market: Market,
  kind: "backfill" | "daily",
  note = "",
): Promise<{ id: number; asOf: DateStr | null }> {
  const asOf = await ctx.wh.scalar<string>(
    `SELECT max(date)::VARCHAR FROM factors_daily WHERE market = $m`,
    { m: market },
  );
  const id = Number(await ctx.wh.scalar(`SELECT nextval('data_version_seq')`));
  await ctx.wh.run(
    `INSERT INTO data_versions (id, market, as_of, kind, note) VALUES ($id, $m, $a::DATE, $k, $n)`,
    { id, m: market, a: asOf ?? null, k: kind, n: note },
  );
  return { id, asOf: asOf ?? null };
}

export async function backfill(ctx: EtlContext, market: Market, opts: BackfillOptions = {}) {
  if (beforeCloseFinal(ctx, market)) {
    ctx = { ...ctx, today: addDays(ctx.today, -1) };
    ctx.log(`北京时间 ${nowHmCN()}，${MARKET_LABEL[market]}今天的收盘价还没定稿，只回填到 ${ctx.today}`);
  }
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
    await recordDataVersion(ctx, market, "backfill", `since ${since}`);
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
 * 夜间增量：日历 → 今天休市就结束 → 证券表 → 日线 → 简称 → 财报/股本 → 因子（近 15 天重算）→ 数据版本。
 */
export async function daily(ctx: EtlContext, market: Market, since = DEFAULT_SINCE): Promise<DailyResult> {
  if (beforeCloseFinal(ctx, market)) {
    throw new Error(
      `${MARKET_LABEL[market]}今天的收盘价还没定稿，北京时间 ${CLOSE_FINAL_HM[market]} 之后再更新（以免把盘中价当成收盘价）`,
    );
  }
  const lastIndex = await ctx.wh.scalar<string>(
    `SELECT max(date)::VARCHAR FROM trade_calendar WHERE market = $m`,
    { m: market },
  );
  await updateIndexes(ctx, market, addDays(lastIndex ?? since, -20));
  const { latest, prev } = await latestTradeDates(ctx, market);
  if (latest !== ctx.today) {
    // 日 K 里没有今天：用指数实时报价交叉验证。报价日期是今天，说明开市了、只是日 K 还没更新——
    // 这时让任务失败（看板出横幅，稍后重跑），不能当成休市悄悄跳过
    if (ctx.today === todayCN()) {
      const quoted = await indexQuoteDate(ctx.http, market === "A" ? "sh000001" : "hkHSI").catch(() => null);
      if (quoted === ctx.today) {
        throw new Error(`${MARKET_LABEL[market]}今天开市了，但指数日 K 还没有今天的数据，稍后在管理页重跑`);
      }
    }
    ctx.log(`${market} 今天（${ctx.today}）休市，最近交易日 ${latest}`);
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
  const ver = await ctx.wh.meta(`factor_registry_version:${market}`);
  const from = ver === String(FACTOR_REGISTRY_VERSION) ? addDays(ctx.today, -15) : since;
  await computeFactors(ctx, market, from);
  const v = await recordDataVersion(ctx, market, "daily");
  return { market, tradingDay: true, latest, dataVersion: v.id };
}

/**
 * 每周抽检（spec §8）：抽 50 只在市股票重拉最近一年日线，和库里比收盘价，差异 > 0.5% 算一行被修订；
 * 被修订的股票整段重写并重算因子，结果记一条 data_versions（kind = check）。
 */
export async function weeklyCheck(ctx: EtlContext, market: Market, sample = 50): Promise<{ checked: number; revisedRows: number; repaired: string[] }> {
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
  const id = Number(await ctx.wh.scalar(`SELECT nextval('data_version_seq')`));
  await ctx.wh.run(
    `INSERT INTO data_versions (id, market, as_of, kind, revised_rows, note)
     VALUES ($id, $m, (SELECT max(date) FROM factors_daily WHERE market = $m), 'check', $n, $note)`,
    { id, m: market, n: revisedRows, note: `抽检 ${picked.length} 只，修复 ${repaired.join(",") || "无"}` },
  );
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
      fetched.actions.map((a) => [code, a.date, a.prevClose, a.refPrice, a.cash, a.split]),
    );
  });
}

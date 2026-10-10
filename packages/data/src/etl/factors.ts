/**
 * 因子物化（D8）：逐股算时间序列因子写入暂存表，再用 SQL 补横截面因子（行业内比较、全市场市值排名），
 * 替换 factors_daily 里 fromDate 之后的行。全量重建与夜间增量走同一条路（增量只是 fromDate 近一些）。
 */
import { addDays, addYears, type DateStr, FACTOR_CORE_VERSION, type Market } from "@ivan/core";
import { resolveActions } from "../compute/adjust.ts";
import { deriveFinancials, type FinRow } from "../compute/financials.ts";
import { type NameChange, stResolver } from "../compute/names.ts";
import { type ShareChange, SPLIT_REASON_RE } from "../compute/series.ts";
import { computeStockFactors, type StockBars } from "../compute/stock-factors.ts";
import {
  clearNewEventColumns,
  fillEventColumns,
  loadEventSyncState,
  restoreEventColumns,
} from "../compute/event-factors.ts";
import { FACTOR_COLUMNS } from "../warehouse/schema.ts";
import type { SoftOutcome } from "./completeness.ts";
import { type EtlContext, errMsg, loadSecurities } from "./context.ts";
import { EVENT_FACTORS_OK_META, reopenEventYears } from "./event-columns.ts";

/** 港股汇率查询：同一币种按日期二分，取当日或之前最近的汇率。 */
async function fxLookup(ctx: EtlContext): Promise<(ccy: string, date: DateStr) => number | null> {
  const rows = await ctx.wh.all<{ ccy: string; date: string; rate: number }>(
    `SELECT ccy, date::VARCHAR AS date, rate FROM fx_hkd ORDER BY ccy, date`,
  );
  const byCcy = new Map<string, { dates: string[]; rates: number[] }>();
  for (const r of rows) {
    let s = byCcy.get(r.ccy);
    if (!s) byCcy.set(r.ccy, (s = { dates: [], rates: [] }));
    s.dates.push(r.date);
    s.rates.push(r.rate);
  }
  return (ccy, date) => {
    const s = byCcy.get(ccy);
    if (!s) return null;
    let lo = 0;
    let hi = s.dates.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s.dates[mid]! <= date) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    // 早于汇率数据起点时用最早的汇率（极少数币种中间价开始得晚）
    return ans >= 0 ? s.rates[ans]! : (s.rates[0] ?? null);
  };
}

async function loadBars(ctx: EtlContext, code: string, from: DateStr): Promise<StockBars> {
  const c = await ctx.wh.columns(
    `SELECT date::VARCHAR AS date, open, high, low, close, volume, amount, adj
     FROM bars_daily WHERE code = $c AND date >= $f::DATE ORDER BY date`,
    { c: code, f: from },
  );
  const f64 = (k: string) => Float64Array.from((c[k] ?? []) as number[], (x) => x ?? NaN);
  return {
    date: (c.date ?? []) as string[],
    open: f64("open"),
    high: f64("high"),
    low: f64("low"),
    close: f64("close"),
    volume: f64("volume"),
    amount: f64("amount"),
    adj: f64("adj"),
  };
}

/**
 * 从暂存表 s 取出 factors_daily 全部列：时间序列因子与事件因子（S15b，已填进暂存表）原样带过来，横截面因子在这里补算
 * （PE / 行业中位数、行业市值排名、全市场市值排名 D49）。列顺序 = 表的列顺序。
 */
export function crossSectionSelect(): string {
  const cols = ["code", "date", "market", "close", ...FACTOR_COLUMNS];
  return cols
    .map((c) => {
      if (c === "pe_rel_industry")
        return `CASE WHEN s.pe_ttm > 0 AND s.industry IS NOT NULL
                  THEN s.pe_ttm / median(s.pe_ttm) FILTER (WHERE s.pe_ttm > 0)
                       OVER (PARTITION BY s.date, s.industry) END AS pe_rel_industry`;
      if (c === "industry_mcap_rank")
        return `CASE WHEN s.mcap IS NOT NULL AND s.industry IS NOT NULL
                  THEN rank() OVER (PARTITION BY s.date, s.industry ORDER BY s.mcap DESC NULLS LAST) END
                  AS industry_mcap_rank`;
      if (c === "mcap_rank")
        return `CASE WHEN s.mcap IS NOT NULL
                  THEN rank() OVER (PARTITION BY s.date, s.market ORDER BY s.mcap DESC NULLS LAST) END
                  AS mcap_rank`;
      return `s.${c}`;
    })
    .join(",\n  ");
}

/**
 * 暂存表的事件列（S15b，只有 A 股）：按自然年分段跑事件 SQL（全量重算时每段一年，夜间就是近 15 天这一段）。
 * 软步骤（D83）：出错（事件表缺失、内存不够、字面量异常）就把这段日期的事件列从正式表原样拷回来，
 * 今天的新行留空，返回 ok: false 由夜间记进 completeness.soft，整晚照常提交。在 computeFactors 的写库段里调用。
 */
async function fillStageEvents(ctx: EtlContext, fromDate: DateStr): Promise<SoftOutcome> {
  try {
    const state = await loadEventSyncState(ctx.wh);
    const last = await ctx.wh.scalar<string>(
      `SELECT max(date)::VARCHAR FROM factors_stage WHERE market = 'A'`,
    );
    let rows = 0;
    if (last) {
      for (let y = Number(fromDate.slice(0, 4)); y <= Number(last.slice(0, 4)); y++) {
        const from = y === Number(fromDate.slice(0, 4)) ? fromDate : `${y}-01-01`;
        rows += await fillEventColumns(ctx.wh, "factors_stage", state, from, `${y}-12-31`);
      }
      // 之前连续失败的晚上留空的日子已经滑出这次重算的范围：重开那几年的按年补算，免得永久留空
      const prev = await ctx.wh.meta(EVENT_FACTORS_OK_META);
      if (prev && addDays(prev, 1) < fromDate) {
        const years = await reopenEventYears(ctx.wh, addDays(prev, 1), addDays(fromDate, -1));
        ctx.log(`事件因子在 ${prev} 之后、${fromDate} 之前的日子之前没算成功，重新按年补算 ${years.join("、")} 年`);
      }
      await ctx.wh.setMeta(EVENT_FACTORS_OK_META, last);
    }
    return { step: "event_factors", ok: true, rows };
  } catch (e) {
    const error = errMsg(e);
    ctx.log(`事件因子计算失败，沿用已有的值（今天的新行留空）：${error}`);
    try {
      await restoreEventColumns(ctx.wh, fromDate);
    } catch (e2) {
      // 拷回也失败（多半同样是内存不够）：已经补完的年份是同一条 SQL 算的、照样有效；正式表之后的新日子置空，
      // 仍然不让整晚失败（D83）
      ctx.log(`事件因子拷回也失败，正式表之后的新日子留空：${errMsg(e2)}`);
      await clearNewEventColumns(ctx.wh).catch((e3) => ctx.log(`事件因子置空也失败：${errMsg(e3)}`));
    }
    return { step: "event_factors", ok: false, error: error.slice(0, 200) };
  }
}

export async function computeFactors(
  ctx: EtlContext,
  market: Market,
  fromDate: DateStr,
  opts: { codes?: string[] } = {},
): Promise<{ stocks: number; rows: number; events?: SoftOutcome }> {
  let securities = await loadSecurities(ctx.wh, market, fromDate);
  if (opts.codes) securities = securities.filter((s) => opts.codes!.includes(s.code));
  const fx = market === "HK" ? await fxLookup(ctx) : undefined;
  const names = new Map<string, NameChange[]>();
  if (market === "A") {
    const rows = await ctx.wh.all<NameChange & { code: string }>(
      `SELECT code, date::VARCHAR AS date, before, after, source FROM name_changes`,
    );
    for (const r of rows) {
      let l = names.get(r.code);
      if (!l) names.set(r.code, (l = []));
      l.push(r);
    }
  }
  // 滚动窗口需要往前看：5 年分位 + 250 日指标，多装 6 年
  const loadFrom = addYears(fromDate, -6);

  await ctx.wh.exclusive(async () => {
    await ctx.wh.run(`DROP TABLE IF EXISTS factors_stage`);
    await ctx.wh.run(`CREATE TABLE factors_stage AS SELECT * FROM factors_daily LIMIT 0`);
  });

  let batch: unknown[][] = [];
  let total = 0;
  const flush = async () => {
    if (!batch.length) return;
    const b = batch;
    batch = [];
    await ctx.wh.exclusive(() => ctx.wh.append("factors_stage", b));
  };

  for (let k = 0; k < securities.length; k++) {
    const s = securities[k]!;
    const bars = await loadBars(ctx, s.code, loadFrom);
    if (!bars.date.length || bars.date[bars.date.length - 1]! < fromDate) continue;
    const fin = await ctx.wh.all<FinRow>(
      `SELECT code, report_date::VARCHAR AS report_date, period, fy_start::VARCHAR AS fy_start,
              notice_date::VARCHAR AS notice_date, eff_date::VARCHAR AS eff_date, currency,
              revenue, np, deducted_np, revenue_yoy, np_yoy, deducted_np_yoy, roe, gross_margin,
              debt_ratio, ocf, equity, shares
       FROM financials WHERE code = $c`,
      { c: s.code },
    );
    const shares = await ctx.wh.all<ShareChange>(
      `SELECT eff_date::VARCHAR AS eff_date, total_shares, reason
       FROM share_changes WHERE code = $c ORDER BY eff_date, total_shares`,
      { c: s.code },
    );
    const facts = await ctx.wh.all<{
      date: string;
      prev_close: number;
      ref_price: number;
      cash: number | null;
      split: number | null;
    }>(
      `SELECT date::VARCHAR AS date, prev_close, ref_price, cash, split
       FROM corp_actions WHERE code = $c ORDER BY date`,
      { c: s.code },
    );
    const actions = resolveActions(
      facts.map((f) => ({
        date: f.date,
        prevClose: f.prev_close,
        refPrice: f.ref_price,
        cash: f.cash,
        split: f.split,
      })),
      shares,
      SPLIT_REASON_RE,
    );
    const rows = computeStockFactors({
      meta: {
        code: s.code,
        market,
        board: s.board,
        list_date: s.list_date,
        industry: s.industry,
        industry_l1: s.industry_l1,
      },
      bars,
      shares,
      actions,
      fin: deriveFinancials(fin),
      fx,
      st: market === "A" ? stResolver(s.code, names.get(s.code) ?? [], s.name) : undefined,
      fromDate,
    });
    total += rows.length;
    for (const r of rows) batch.push(r);
    if (batch.length >= 100_000) await flush();
    if ((k + 1) % 500 === 0 || k + 1 === securities.length) {
      ctx.log(`因子 ${market} ${k + 1}/${securities.length}（${total} 行）`);
      ctx.progress?.((k + 1) / securities.length, `因子 ${k + 1}/${securities.length}`);
    }
  }
  await flush();

  // 事件因子（S15b，只有 A 股）→ 横截面因子（行业内比较、全市场市值排名），然后替换正式表
  const select = crossSectionSelect();
  let events: SoftOutcome | undefined;
  await ctx.wh.exclusive(async () => {
    // 在并入别的股票、删正式表之前：失败时要从正式表把旧的事件列拷回来
    if (market === "A") events = await fillStageEvents(ctx, fromDate);
    const codeFilter = opts.codes
      ? `AND code IN (${opts.codes.map((c) => `'${c.replace(/'/g, "")}'`).join(",")})`
      : "";
    await ctx.wh.run(
      `DELETE FROM factors_daily WHERE market = $m AND date >= $f::DATE ${codeFilter}`,
      { m: market, f: fromDate },
    );
    if (opts.codes) {
      // 只重算部分股票时，行业横截面要拿全市场同日数据一起算：先把别的股票同期行业数据并进来
      await ctx.wh.run(
        `INSERT INTO factors_stage SELECT * FROM factors_daily WHERE market = $m AND date >= $f::DATE`,
        { m: market, f: fromDate },
      );
      await ctx.wh.run(
        `DELETE FROM factors_daily WHERE market = $m AND date >= $f::DATE`,
        { m: market, f: fromDate },
      );
    }
    await ctx.wh.run(`INSERT INTO factors_daily SELECT\n  ${select}\nFROM factors_stage s`);
    await ctx.wh.run(`DROP TABLE factors_stage`);
    // 记的是核心因子版本（D83）：键名沿用，回滚到 R4 的代码读到 '2' 不会触发全量重算
    await ctx.wh.setMeta(`factor_registry_version:${market}`, String(FACTOR_CORE_VERSION));
    await ctx.wh.checkpoint();
  });
  ctx.log(`因子 ${market}：${securities.length} 只，写入 ${total} 行（${fromDate} 起）`);
  return { stocks: securities.length, rows: total, ...(events ? { events } : {}) };
}

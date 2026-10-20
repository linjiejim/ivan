import { periodLabel } from "@ivan/core";
/**
 * 个股 / 指数走势与多只对比（spec 20261020 D99、D100）。
 */
import type { ChartPoint, CompareItem, CompareResult, Instrument, PeriodInput, PriceHistory, StockInstrument } from "@ivan/core";
import { addDays, addMonths, BENCHMARKS, type BenchmarkKey, DEFAULT_BENCHMARK, type DateStr, diffDays, type Market } from "@ivan/core";
import { downsample, indexOnOrBefore, rangeStats, relativeStats, vsMovingAverage, windowReturns } from "../../compute/price-stats.ts";
import { INDEXES } from "../../etl/reference.ts";
import { type Warehouse } from "../../warehouse/db.ts";

import { latestDataVersion } from "../versions.ts";

import { AnalyticsError, asOfOf, endOf, fromOf, dataNote, latestFactors, loadSeries, loadIndexSeries, resolveInstrument, instrumentName, instrumentId, type PriceSeries } from "./common.ts";

// ── 1. 个股 / 指数走势 ──

/** 价格指数或全收益指数 → 默认对照的基准键；个股用市场默认基准（全收益） */
function benchKeyOf(market: Market, key?: string | null): BenchmarkKey | null {
  if (!key) return null;
  if (!(key in BENCHMARKS)) {
    throw new AnalyticsError(
      400,
      `不认识的基准「${key}」，可选：${Object.keys(BENCHMARKS).join("、")}`,
    );
  }
  const k = key as BenchmarkKey;
  if (BENCHMARKS[k].market !== market)
    throw new AnalyticsError(400, `基准「${BENCHMARKS[k].label}」和这个标的不在同一个市场`);
  return k;
}

const CHART_POINTS = 240;

export async function priceHistory(
  wh: Warehouse,
  q: {
    query: string;
    period?: PeriodInput | null;
    from?: string | null;
    to?: string | null;
    benchmark?: string | null;
  },
): Promise<PriceHistory> {
  const inst = await resolveInstrument(wh, q.query);
  const market = inst.market;
  const end = await endOf(wh, market, q.to);
  const from = fromOf(end, q, "1y");
  // 多读 5 年零一个月：多窗口涨跌与 250 日均线要用
  const loadFrom = (() => {
    const w = addMonths(end, -61);
    return from === null ? null : from < w ? from : w;
  })();
  const s = await loadSeries(wh, inst, loadFrom ? addDays(loadFrom, -10) : null, end);
  if (!s.dates.length) {
    throw new AnalyticsError(
      404,
      `${instrumentName(inst)}在 ${end} 之前没有行情${inst.kind === "stock" && inst.listDate && inst.listDate > end ? `（${inst.listDate} 才上市）` : ""}`,
    );
  }
  const r = rangeStats(s.dates, s.adj, from);
  if (!r) throw new AnalyticsError(404, `${instrumentName(inst)}在这个区间没有行情`);
  const { stats, startIndex } = r;
  const d = s.dates.slice(startIndex);
  const raw = s.close.slice(startIndex);
  let hi = 0;
  let lo = 0;
  for (let i = 1; i < raw.length; i++) {
    if (raw[i]! > raw[hi]!) hi = i;
    if (raw[i]! < raw[lo]!) lo = i;
  }
  const notes: string[] = [dataNote(market, (await asOfOf(wh, market)) as DateStr)];
  if (inst.kind === "stock") notes.push("收益、回撤、波动按复权价（分红再投入）；股价按不复权收盘。");
  if (stats.startClamped)
    notes.push(`区间起点早于数据起点，从第一根 K 线 ${stats.start} 算起。`);

  // 指数的全收益孪生
  let totalReturn: PriceHistory["totalReturn"] = null;
  if (inst.kind === "index" && inst.trSym) {
    const tr = await loadIndexSeries(wh, inst.trSym, addDays(stats.start, -10), end);
    const i0 = indexOnOrBefore(tr.dates, stats.start);
    if (i0 >= 0 && tr.dates.at(-1) === end) {
      totalReturn = {
        sym: inst.trSym,
        label: INDEXES[inst.trSym]!.label,
        ret: tr.close.at(-1)! / tr.close[i0]! - 1,
      };
      if (tr.provisional) notes.push("全收益序列最近几天是按价格指数临时补齐的。");
    }
  }

  // 基准：个股默认市场默认基准（全收益）；指数只在指定时比
  const bk =
    benchKeyOf(market, q.benchmark) ?? (inst.kind === "stock" ? DEFAULT_BENCHMARK[market] : null);
  let benchmark: PriceHistory["benchmark"] = null;
  let benchSeries: PriceSeries | null = null;
  if (bk) {
    const def = BENCHMARKS[bk];
    benchSeries = await loadIndexSeries(wh, def.sym, addDays(stats.start, -10), end);
    const i0 = indexOnOrBefore(benchSeries.dates, stats.start);
    const i1 = indexOnOrBefore(benchSeries.dates, end);
    if (i0 >= 0 && i1 > i0) {
      const bret = benchSeries.close[i1]! / benchSeries.close[i0]! - 1;
      const rel = relativeStats(
        { dates: d, values: s.adj.slice(startIndex) },
        { dates: benchSeries.dates, values: benchSeries.close },
      );
      benchmark = {
        key: bk,
        label: def.label,
        ret: bret,
        excess: stats.ret - bret,
        beta: rel.beta,
        correlation: rel.correlation,
      };
    } else {
      benchSeries = null;
    }
  }

  // 图：归一到区间起点
  const base = s.adj[startIndex]!;
  const bmap = new Map<string, number>();
  let bbase: number | null = null;
  if (benchSeries) {
    benchSeries.dates.forEach((x, i) => bmap.set(x, benchSeries!.close[i]!));
    const i0 = indexOnOrBefore(benchSeries.dates, stats.start);
    bbase = i0 >= 0 ? benchSeries.close[i0]! : null;
  }
  let lastB: number | null = null;
  const points: ChartPoint[] = d.map((x, i) => {
    const bv = bmap.get(x);
    if (bv !== undefined && bbase) lastB = bv / bbase;
    return { d: x, v: s.adj[startIndex + i]! / base, b: benchSeries ? lastB : null };
  });

  // 个股：上市信息、停牌天数、成交额
  let listing: PriceHistory["listing"] = null;
  let suspendedDays: number | null = null;
  let avgDailyAmount20d: number | null = null;
  if (inst.kind === "stock") {
    const firstBar = await wh.one<{ d: string; open: number | null; close: number; adj: number | null }>(
      `SELECT date::VARCHAR AS d, open, close, adj FROM bars_daily
       WHERE code = $c AND close > 0 ORDER BY date LIMIT 1`,
      { c: inst.code },
    );
    if (firstBar && (from === null || stats.startClamped || q.period === "since_listing")) {
      const firstAdj = firstBar.close * (firstBar.adj ?? 1);
      const lastAdj = s.adj.at(-1)!;
      const openAdj = firstBar.open ? firstBar.open * (firstBar.adj ?? 1) : null;
      const firstIsListingDay =
        inst.listDate !== null && diffDays(firstBar.d, inst.listDate) <= 7;
      listing = {
        listDate: inst.listDate,
        firstIsListingDay,
        firstDate: firstBar.d,
        firstOpen: firstBar.open,
        firstClose: firstBar.close,
        retFromFirstClose: lastAdj / firstAdj - 1,
        retFromFirstOpen: openAdj ? lastAdj / openAdj - 1 : null,
      };
      notes.push(
        firstIsListingDay
          ? "行情仓里没有发行价，「上市以来」从上市首日的开盘或收盘算起（打新的收益要从发行价算，会更高或更低）。"
          : `行情仓的数据从 ${firstBar.d} 开始（${inst.listDate ? `${inst.listDate} 上市` : "上市日不详"}），「上市以来」只能从这天算起。`,
      );
    }
    const cal = await wh.scalar<number>(
      `SELECT count(*)::INTEGER FROM trade_calendar WHERE market = $m AND date >= $a::DATE AND date <= $b::DATE`,
      { m: market, a: stats.start, b: stats.end },
    );
    suspendedDays = cal !== undefined ? Math.max(0, cal - stats.tradingDays) : null;
    const amts = s.amount.slice(-20).filter((x): x is number => x !== null && Number.isFinite(x));
    avgDailyAmount20d = amts.length ? amts.reduce((a, b) => a + b, 0) / amts.length : null;
    if (inst.delistDate && inst.delistDate <= end) notes.push(`已于 ${inst.delistDate} 退市。`);
  }
  if (s.provisional) notes.push("最近几天是按价格指数临时补齐的全收益点。");

  const dv = await latestDataVersion(wh, market);
  return {
    instrument: inst,
    market,
    currency: inst.kind === "stock" ? (market === "HK" ? "HKD" : "CNY") : null,
    dataAsOf: (await asOfOf(wh, market)) as DateStr,
    dataVersion: dv.id,
    period: {
      from,
      to: end,
      label: q.from ? `${q.from} ~ ${end}` : periodLabel(q.period ?? "1y"),
    },
    stats,
    levels: {
      startClose: raw[0]!,
      endClose: raw.at(-1)!,
      highClose: raw[hi]!,
      highDate: d[hi]!,
      lowClose: raw[lo]!,
      lowDate: d[lo]!,
    },
    windows: windowReturns(s.dates, s.adj),
    trend: {
      vsMa20: vsMovingAverage(s.adj, 20),
      vsMa60: vsMovingAverage(s.adj, 60),
      vsMa250: vsMovingAverage(s.adj, 250),
    },
    totalReturn,
    benchmark,
    listing,
    suspendedDays,
    avgDailyAmount20d,
    series: downsample(points, CHART_POINTS),
    notes,
  };
}

// ── 2. 多只对比 ──

/** 对比与个股卡用的关键因子 */
export const KEY_FACTORS = [
  "pe_ttm",
  "pb",
  "pe_pct_5y",
  "dividend_yield_ttm",
  "roe_ttm",
  "rev_yoy",
  "np_yoy",
  "gross_margin",
  "debt_ratio",
  "mcap",
  "turnover_20d",
] as const;

export async function compareSecurities(
  wh: Warehouse,
  q: { queries: string[]; period?: PeriodInput | null; from?: string | null; to?: string | null },
): Promise<CompareResult> {
  const uniq = [...new Set(q.queries.map((x) => x.trim()).filter(Boolean))];
  if (uniq.length < 2 || uniq.length > 6) throw new AnalyticsError(400, "对比要 2–6 只股票或指数");
  const insts: Instrument[] = [];
  for (const x of uniq) {
    const i = await resolveInstrument(wh, x);
    if (!insts.some((y) => instrumentId(y) === instrumentId(i))) insts.push(i);
  }
  if (insts.length < 2) throw new AnalyticsError(400, "这几个其实是同一只，换几只再比");
  const markets = [...new Set(insts.map((i) => i.market))];
  // 共同终点：各市场已提交截至日里最早的一个，免得一边多算几天
  const ends = await Promise.all(markets.map((m) => endOf(wh, m, q.to)));
  const end = ends.sort()[0]!;
  const from = fromOf(end, q, "1y");
  const notes: string[] = [];
  if (markets.length > 1)
    notes.push("A 股与港股混在一起比：各自按本币（人民币 / 港元）算收益，没有换汇；两地交易日不同，相关系数只用共同交易日。");
  const loadFrom = (() => {
    const w = addMonths(end, -61);
    return from === null ? null : from < w ? from : w;
  })();
  const series = await Promise.all(
    insts.map((i) => loadSeries(wh, i, loadFrom ? addDays(loadFrom, -10) : null, end)),
  );
  const stockCodes = insts.filter((i): i is StockInstrument => i.kind === "stock").map((i) => i.code);
  const facts = await latestFactors(wh, stockCodes, end, KEY_FACTORS);
  const items: CompareItem[] = insts.map((inst, n) => {
    const s = series[n]!;
    const r = rangeStats(s.dates, s.adj, from);
    const f = inst.kind === "stock" ? facts.get(inst.code) : undefined;
    const pts = r
      ? s.dates.slice(r.startIndex).map((d, i) => ({ d, v: s.adj[r.startIndex + i]! / s.adj[r.startIndex]! }))
      : [];
    if (r?.stats.startClamped)
      notes.push(`${instrumentName(inst)}的数据从 ${r.stats.start} 才开始，区间收益从那天算起。`);
    return {
      instrument: inst,
      market: inst.market,
      stats: r?.stats ?? null,
      windows: windowReturns(s.dates, s.adj),
      factors: f?.values ?? null,
      factorDate: f?.date ?? null,
      series: downsample(pts, 160),
    };
  });
  const correlation: CompareResult["correlation"] = [];
  for (let a = 0; a < insts.length; a++) {
    for (let b = a + 1; b < insts.length; b++) {
      const ra = items[a]!.stats;
      const rb = items[b]!.stats;
      if (!ra || !rb) continue;
      const sa = series[a]!;
      const sb = series[b]!;
      const ia = indexOnOrBefore(sa.dates, ra.start);
      const ib = indexOnOrBefore(sb.dates, rb.start);
      const rel = relativeStats(
        { dates: sa.dates.slice(Math.max(0, ia)), values: sa.adj.slice(Math.max(0, ia)) },
        { dates: sb.dates.slice(Math.max(0, ib)), values: sb.adj.slice(Math.max(0, ib)) },
      );
      correlation.push({
        a: instrumentId(insts[a]!),
        b: instrumentId(insts[b]!),
        value: rel.correlation,
        commonDays: rel.commonDays,
      });
    }
  }
  return {
    end,
    period: { from, label: q.from ? `${q.from} ~ ${end}` : periodLabel(q.period ?? "1y") },
    items,
    correlation,
    notes,
  };
}


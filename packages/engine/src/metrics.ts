/**
 * 指标与归因（纯函数）。年化按自然日：年数 = (末日 − 首日) / 365.25；夏普无风险利率取 0。
 *
 * 指标版本（D63，成交假设 `exec.metrics`）：第 1 版原样保留给旧运行（金标准守着）；第 2 版从投入第一笔资金算起
 * （序列前虚拟加一个锚点，只在指标里加、不单独成桶）、交易统计去掉仓位控制的增减、按完整持仓算胜率、补风险指标。
 */
import {
  addMonths,
  type Attribution,
  type DateStr,
  diffDays,
  type HoldingSnapshot,
  type Metrics,
  type OpenPosition,
  type PeriodMetrics,
  type RiskMetrics,
  type SecurityInfo,
  type SeriesPoint,
  type Trade,
} from "@ivan/core";
import { windowExcesses } from "./deviation.ts";
import { kurtosis, mean, quantile7, sampleCov, sampleSd, skewness } from "./stats/moments.ts";

const ann = (total: number, years: number) =>
  years > 0 && total > -1 ? (1 + total) ** (1 / years) - 1 : 0;

/**
 * 区间指标。totalReturn 给定时用它代替「末点净值 ÷ 首点净值 − 1」（指标第 2 版：期末资产 ÷ 初始资金 − 1，
 * 让总收益与期末资产逐位对得上）；年化与超额都从它算。
 */
export function periodMetrics(
  series: readonly SeriesPoint[],
  totalReturnOverride?: number,
): PeriodMetrics {
  if (series.length < 2) {
    const d = series[0]?.date ?? "";
    return {
      start: d,
      end: d,
      days: series.length,
      totalReturn: 0,
      benchReturn: 0,
      cagr: 0,
      benchCagr: 0,
      excessCagr: 0,
      excessTotal: 0,
      maxDrawdown: 0,
      volatility: 0,
      sharpe: 0,
    };
  }
  const first = series[0]!;
  const last = series.at(-1)!;
  const years = diffDays(last.date, first.date) / 365.25;
  const totalReturn = totalReturnOverride ?? last.nav / first.nav - 1;
  const benchReturn = last.bench / first.bench - 1;
  const cagr = ann(totalReturn, years);
  const benchCagr = ann(benchReturn, years);
  let peak = first.nav;
  let mdd = 0;
  const rets: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const p = series[i]!;
    peak = Math.max(peak, p.nav);
    mdd = Math.min(mdd, p.nav / peak - 1);
    rets.push(p.nav / series[i - 1]!.nav - 1);
  }
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const sd = Math.sqrt(
    rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1),
  );
  // 每年交易日数按样本估计（A 股约 243、港股约 247）
  const perYear = years > 0 ? rets.length / years : 245;
  return {
    start: first.date,
    end: last.date,
    days: series.length,
    totalReturn,
    benchReturn,
    cagr,
    benchCagr,
    excessCagr: (1 + cagr) / (1 + benchCagr) - 1,
    excessTotal: (1 + totalReturn) / (1 + benchReturn) - 1,
    maxDrawdown: mdd,
    volatility: sd * Math.sqrt(perYear),
    sharpe: sd > 0 ? (mean * perYear) / (sd * Math.sqrt(perYear)) : 0,
  };
}

export function computeMetrics(
  series: readonly SeriesPoint[],
  trades: readonly Trade[],
  capital: number,
  o: { version?: 1 | 2; anchor?: SeriesPoint } = {},
): Metrics {
  if ((o.version ?? 1) === 2) return computeMetricsV2(series, trades, capital, o.anchor);
  const base = periodMetrics(series);
  // 最大回撤的峰、谷、修复日
  let peakIdx = 0;
  let worst = 0;
  let ddPeak = -1;
  let ddTrough = -1;
  for (let i = 1; i < series.length; i++) {
    if (series[i]!.nav > series[peakIdx]!.nav) peakIdx = i;
    const dd = series[i]!.nav / series[peakIdx]!.nav - 1;
    if (dd < worst) {
      worst = dd;
      ddPeak = peakIdx;
      ddTrough = i;
    }
  }
  let recovery: string | null = null;
  if (ddTrough >= 0) {
    for (let i = ddTrough + 1; i < series.length; i++) {
      if (series[i]!.nav >= series[ddPeak]!.nav) {
        recovery = series[i]!.date;
        break;
      }
    }
  }
  const sells = trades.filter((t) => t.side === "sell");
  const buys = trades.filter((t) => t.side === "buy");
  const wins = sells.filter((t) => (t.pnl ?? 0) > 0).length;
  const fees = trades.reduce((s, t) => s + t.fee, 0);
  const years = series.length > 1 ? diffDays(series.at(-1)!.date, series[0]!.date) / 365.25 : 0;
  const avgEquity = series.reduce((s, p) => s + p.nav * capital, 0) / Math.max(1, series.length);
  const traded = trades.reduce((s, t) => s + t.amount, 0);

  // 月度与年度收益（月末净值对月末净值）
  const monthly: Metrics["monthly"] = [];
  const yearly: Metrics["yearly"] = [];
  const bucket = (
    key: (d: string) => string,
    out: Array<{ ret: number; bench: number }> & unknown[],
    label: string,
  ) => {
    let prev: SeriesPoint | undefined = series[0];
    for (let i = 0; i < series.length; i++) {
      const p = series[i]!;
      const next = series[i + 1];
      if (!next || key(next.date) !== key(p.date)) {
        (out as Array<Record<string, unknown>>).push({
          [label]: key(p.date),
          ret: prev ? p.nav / prev.nav - 1 : 0,
          bench: prev ? p.bench / prev.bench - 1 : 0,
        });
        prev = p;
      }
    }
  };
  bucket((d) => d.slice(0, 7), monthly as never, "month");
  bucket((d) => d.slice(0, 4), yearly as never, "year");

  return {
    ...base,
    drawdownPeak: ddPeak >= 0 ? series[ddPeak]!.date : null,
    drawdownTrough: ddTrough >= 0 ? series[ddTrough]!.date : null,
    drawdownRecovery: recovery,
    calmar: base.maxDrawdown < 0 ? base.cagr / -base.maxDrawdown : 0,
    winRate: sells.length ? wins / sells.length : null,
    avgHoldDays: sells.length
      ? sells.reduce((s, t) => s + (t.holdDays ?? 0), 0) / sells.length
      : null,
    turnover: years > 0 && avgEquity > 0 ? traded / 2 / avgEquity / years : 0,
    fees,
    costDrag: years > 0 && avgEquity > 0 ? fees / avgEquity / years : 0,
    buys: buys.length,
    sells: sells.length,
    monthly,
    yearly,
    finalEquity: (series.at(-1)?.nav ?? 1) * capital,
    avgExposure: avgExposure(series, capital),
  };
}

/** 平均股票仓位：每天 1 − 现金 ÷ 总资产 的均值 */
/**
 * 一笔金额按区间平均资产年化后的拖累（和 costDrag 同一口径）：按流动性成交（D64）时把滑点与冲击单列。
 */
export function annualDrag(
  series: readonly SeriesPoint[],
  capital: number,
  amount: number,
): number {
  const years = series.length > 1 ? diffDays(series.at(-1)!.date, series[0]!.date) / 365.25 : 0;
  const avgEquity = series.reduce((s, p) => s + p.nav * capital, 0) / Math.max(1, series.length);
  return years > 0 && avgEquity > 0 ? amount / avgEquity / years : 0;
}

function avgExposure(series: readonly SeriesPoint[], capital: number): number {
  if (!series.length) return 0;
  let s = 0;
  for (const p of series) {
    const eq = p.nav * capital;
    s += eq > 0 ? Math.max(0, Math.min(1, 1 - p.cash / eq)) : 0;
  }
  return s / series.length;
}

export function attribution(
  trades: readonly Trade[],
  open: readonly OpenPosition[],
  holdings: readonly HoldingSnapshot[],
  securities: ReadonlyMap<string, SecurityInfo>,
): Attribution {
  const byCode = new Map<string, { pnl: number; trades: number }>();
  const buyCost = new Map<string, number>();
  for (const t of trades) {
    const e = byCode.get(t.code) ?? { pnl: 0, trades: 0 };
    if (t.side === "sell") {
      e.pnl += t.pnl ?? 0;
      e.trades++;
    } else {
      buyCost.set(t.code, t.amount + t.fee);
    }
    byCode.set(t.code, e);
  }
  // 未平仓：按市值减去持仓成本（仓位控制加减过的按剩余成本；没有就用最近一次买入成本）计浮动盈亏
  for (const p of open) {
    const e = byCode.get(p.code) ?? { pnl: 0, trades: 0 };
    e.pnl += p.value - (p.cost ?? buyCost.get(p.code) ?? p.value);
    byCode.set(p.code, e);
  }
  const byStock = [...byCode.entries()]
    .map(([code, e]) => ({
      code,
      name: securities.get(code)?.name ?? code,
      industry: securities.get(code)?.industry ?? null,
      pnl: e.pnl,
      trades: e.trades,
    }))
    .sort((a, b) => b.pnl - a.pnl);

  const ind = new Map<string, { pnl: number; weight: number }>();
  for (const s of byStock) {
    const k = s.industry ?? "未分类";
    const e = ind.get(k) ?? { pnl: 0, weight: 0 };
    e.pnl += s.pnl;
    ind.set(k, e);
  }
  for (const h of holdings) {
    for (const it of h.items) {
      const k = securities.get(it.code)?.industry ?? "未分类";
      const e = ind.get(k) ?? { pnl: 0, weight: 0 };
      e.weight += it.weight;
      ind.set(k, e);
    }
  }
  const snaps = Math.max(1, holdings.length);
  const byIndustry = [...ind.entries()]
    .map(([industry, e]) => ({ industry, pnl: e.pnl, avgWeight: e.weight / snaps }))
    .sort((a, b) => b.pnl - a.pnl);
  return { byStock, byIndustry };
}

// ── 指标第 2 版（D63） ──

const fin = (x: number): number | null => (Number.isFinite(x) ? x : null);

/** 最大回撤的峰、谷、修复日（下标） */
function drawdownSpan(series: readonly SeriesPoint[]) {
  let peakIdx = 0;
  let worst = 0;
  let ddPeak = -1;
  let ddTrough = -1;
  for (let i = 1; i < series.length; i++) {
    if (series[i]!.nav > series[peakIdx]!.nav) peakIdx = i;
    const dd = series[i]!.nav / series[peakIdx]!.nav - 1;
    if (dd < worst) {
      worst = dd;
      ddPeak = peakIdx;
      ddTrough = i;
    }
  }
  let recovery: string | null = null;
  if (ddTrough >= 0) {
    for (let i = ddTrough + 1; i < series.length; i++) {
      if (series[i]!.nav >= series[ddPeak]!.nav) {
        recovery = series[i]!.date;
        break;
      }
    }
  }
  return {
    peak: ddPeak >= 0 ? series[ddPeak]!.date : null,
    trough: ddTrough >= 0 ? series[ddTrough]!.date : null,
    recovery,
  };
}

/**
 * 按月 / 按年分桶：只对 series 里的日子分桶，start（锚点）只作第一个桶的起点，不单独成桶
 * （否则锚点所在的月、年会多出一行 0%）。
 */
function anchoredBuckets(
  series: readonly SeriesPoint[],
  start: SeriesPoint | undefined,
  key: (d: string) => string,
): Array<{ key: string; ret: number; bench: number }> {
  const out: Array<{ key: string; ret: number; bench: number }> = [];
  let prev = start ?? series[0];
  for (let i = 0; i < series.length; i++) {
    const p = series[i]!;
    const next = series[i + 1];
    if (!next || key(next.date) !== key(p.date)) {
      out.push({
        key: key(p.date),
        ret: prev ? p.nav / prev.nav - 1 : 0,
        bench: prev ? p.bench / prev.bench - 1 : 0,
      });
      prev = p;
    }
  }
  return out;
}

export interface RoundTrip {
  code: string;
  entryDate: DateStr;
  exitDate: DateStr;
  /** 这笔完整持仓里所有卖出的盈亏合计（扣费） */
  pnl: number;
  /** 最后一笔卖出时的持有交易日数 */
  holdDays: number;
}

/**
 * 完整持仓：同一只股票从建仓（非仓位控制的买入）到最后一笔卖出（非仓位控制的卖出）合成一笔，
 * 中间仓位控制的增减（reason = exposure）都算在里面。持仓没卖完时又出现建仓买入（仓位控制把它减到 0 之后），
 * 先按它最后一笔卖出结掉。到区间末还拿着的不算。
 */
export function roundTrips(trades: readonly Trade[]): RoundTrip[] {
  const open = new Map<
    string,
    { entryDate: DateStr; pnl: number; sells: number; lastSell: Trade | null }
  >();
  const out: RoundTrip[] = [];
  const close = (code: string, last: Trade) => {
    const o = open.get(code)!;
    out.push({
      code,
      entryDate: o.entryDate,
      exitDate: last.date,
      pnl: o.pnl,
      holdDays: last.holdDays ?? 0,
    });
    open.delete(code);
  };
  for (const t of trades) {
    const o = open.get(t.code);
    if (t.side === "buy") {
      if (t.reason === "exposure") continue;
      if (o) {
        if (o.lastSell) close(t.code, o.lastSell);
        else open.delete(t.code);
      }
      open.set(t.code, { entryDate: t.date, pnl: 0, sells: 0, lastSell: null });
      continue;
    }
    const cur = o ?? { entryDate: t.date, pnl: 0, sells: 0, lastSell: null };
    cur.pnl += t.pnl ?? 0;
    cur.sells++;
    cur.lastSell = t;
    open.set(t.code, cur);
    if (t.reason !== "exposure") close(t.code, t);
  }
  return out;
}

/**
 * 风险指标（D63）：anchored 是（第 2 版）带锚点的序列，monthly / yearly 是分好的桶。
 * 收益分布类在日收益观测少于 minObs（默认 30）个时为 null。
 */
export function riskMetrics(
  anchored: readonly SeriesPoint[],
  monthly: Metrics["monthly"],
  yearly: Metrics["yearly"],
  o: { minObs?: number } = {},
): RiskMetrics {
  const r: number[] = [];
  const rb: number[] = [];
  for (let i = 1; i < anchored.length; i++) {
    r.push(anchored[i]!.nav / anchored[i - 1]!.nav - 1);
    rb.push(anchored[i]!.bench / anchored[i - 1]!.bench - 1);
  }
  const n = r.length;
  const years =
    anchored.length > 1 ? diffDays(anchored.at(-1)!.date, anchored[0]!.date) / 365.25 : 0;
  const perYear = years > 0 ? n / years : 245;
  const enough = n >= Math.max(2, o.minObs ?? 30);

  let dist: Pick<
    RiskMetrics,
    | "sortino"
    | "trackingError"
    | "infoRatio"
    | "beta"
    | "alpha"
    | "var95"
    | "es95"
    | "var99"
    | "es99"
    | "skew"
    | "kurtosis"
  > = {
    sortino: null,
    trackingError: null,
    infoRatio: null,
    beta: null,
    alpha: null,
    var95: null,
    es95: null,
    var99: null,
    es99: null,
    skew: null,
    kurtosis: null,
  };
  if (enough) {
    const mr = mean(r);
    const downside = Math.sqrt(r.reduce((s, x) => s + Math.min(x, 0) ** 2, 0) / (n - 1));
    const a = r.map((x, i) => x - rb[i]!);
    const te = sampleSd(a) * Math.sqrt(perYear);
    const varB = sampleCov(rb, rb);
    const beta = varB > 0 ? sampleCov(r, rb) / varB : NaN;
    const sorted = [...r].sort((x, y) => x - y);
    const tail = (p: number) => {
      const v = -quantile7(sorted, p);
      return { v, es: -mean(r.filter((x) => x <= -v)) };
    };
    const t95 = tail(0.05);
    const t99 = tail(0.01);
    dist = {
      sortino: downside > 0 ? fin((mr * perYear) / (downside * Math.sqrt(perYear))) : null,
      trackingError: fin(te),
      infoRatio: te > 0 ? fin((mean(a) * perYear) / te) : null,
      beta: fin(beta),
      alpha: Number.isFinite(beta) ? fin((mr - beta * mean(rb)) * perYear) : null,
      var95: fin(t95.v),
      es95: fin(t95.es),
      var99: fin(t99.v),
      es99: fin(t99.es),
      skew: fin(skewness(r)),
      kurtosis: fin(kurtosis(r)),
    };
  }

  // 回撤路径：溃疡指数与水下天数
  let peak = anchored[0]?.nav ?? 1;
  let sq = 0;
  let run = 0;
  let maxRun = 0;
  for (const p of anchored) {
    peak = Math.max(peak, p.nav);
    const dd = p.nav / peak - 1;
    sq += dd * dd;
    run = p.nav < peak ? run + 1 : 0;
    maxRun = Math.max(maxRun, run);
  }

  const windows = windowExcesses(anchored, 243);
  const ws = [...windows].sort((x, y) => x - y);
  const excessOf = (y: { ret: number; bench: number }) => (1 + y.ret) / (1 + y.bench) - 1;
  let worstYear: { year: string; excess: number } | null = null;
  for (const y of yearly) {
    const e = excessOf(y);
    if (!worstYear || e < worstYear.excess) worstYear = { year: y.year, excess: e };
  }

  return {
    ...dist,
    ulcer: anchored.length ? Math.sqrt(sq / anchored.length) : 0,
    maxUnderwaterDays: maxRun,
    currentUnderwaterDays: run,
    monthlyHitRate: monthly.length
      ? monthly.filter((m) => m.ret > m.bench).length / monthly.length
      : null,
    rolling12m: ws.length
      ? {
          min: ws[0]!,
          median: quantile7(ws, 0.5),
          max: ws.at(-1)!,
          positiveShare: ws.filter((x) => x > 0).length / ws.length,
        }
      : null,
    consistency: {
      years: yearly.length,
      positiveYears: yearly.filter((y) => excessOf(y) > 0).length,
      worstYear,
    },
  };
}

function computeMetricsV2(
  series: readonly SeriesPoint[],
  trades: readonly Trade[],
  capital: number,
  anchor: SeriesPoint | undefined,
): Metrics {
  // 从投入第一笔资金算起：锚点（决策日，净值 1）只在指标里加
  const anchored = anchor ? [anchor, ...series] : series;
  const finalEquity = (series.at(-1)?.nav ?? 1) * capital;
  const base = periodMetrics(anchored, anchor ? finalEquity / capital - 1 : undefined);
  const dd = drawdownSpan(anchored);

  // 交易统计去掉仓位控制的增减
  const buys = trades.filter((t) => t.side === "buy" && t.reason !== "exposure").length;
  const sells = trades.filter((t) => t.side === "sell" && t.reason !== "exposure").length;
  const trips = roundTrips(trades);
  const winPnl = trips.filter((t) => t.pnl > 0).map((t) => t.pnl);
  const lossPnl = trips.filter((t) => t.pnl < 0).map((t) => t.pnl);
  const sumWin = winPnl.reduce((s, x) => s + x, 0);
  const sumLoss = lossPnl.reduce((s, x) => s + x, 0);
  const avgWin = winPnl.length ? sumWin / winPnl.length : null;
  const avgLoss = lossPnl.length ? sumLoss / lossPnl.length : null;

  const fees = trades.reduce((s, t) => s + t.fee, 0);
  const years = series.length > 1 ? diffDays(series.at(-1)!.date, series[0]!.date) / 365.25 : 0;
  const avgEquity = series.reduce((s, p) => s + p.nav * capital, 0) / Math.max(1, series.length);
  const traded = trades.reduce((s, t) => s + t.amount, 0);

  const monthly = anchoredBuckets(series, anchor, (d) => d.slice(0, 7)).map((b) => ({
    month: b.key,
    ret: b.ret,
    bench: b.bench,
  }));
  const yearly = anchoredBuckets(series, anchor, (d) => d.slice(0, 4)).map((b) => ({
    year: b.key,
    ret: b.ret,
    bench: b.bench,
  }));

  return {
    ...base,
    drawdownPeak: dd.peak,
    drawdownTrough: dd.trough,
    drawdownRecovery: dd.recovery,
    calmar: base.maxDrawdown < 0 ? base.cagr / -base.maxDrawdown : 0,
    winRate: trips.length ? winPnl.length / trips.length : null,
    avgHoldDays: trips.length ? trips.reduce((s, t) => s + t.holdDays, 0) / trips.length : null,
    turnover: years > 0 && avgEquity > 0 ? traded / 2 / avgEquity / years : 0,
    fees,
    costDrag: years > 0 && avgEquity > 0 ? fees / avgEquity / years : 0,
    buys,
    sells,
    monthly,
    yearly,
    finalEquity,
    avgExposure: avgExposure(series, capital),
    metricsVersion: 2,
    roundTrips: trips.length,
    profitFactor: lossPnl.length ? sumWin / Math.abs(sumLoss) : null,
    avgWin,
    avgLoss,
    payoff: avgWin !== null && avgLoss !== null && avgLoss < 0 ? avgWin / -avgLoss : null,
    risk: riskMetrics(anchored, monthly, yearly),
  };
}

/** 样本外起点（指标第 1 版，原样保留）：区间最后 N 个月；区间不到 2N 个月时不分段。 */
function oosStartV1(series: readonly SeriesPoint[], months: number): DateStr | null {
  if (series.length < 2) return null;
  const first = series[0]!.date;
  const last = series.at(-1)!.date;
  const y = Number(last.slice(0, 4));
  const m = Number(last.slice(5, 7)) - months;
  const d = new Date(Date.UTC(y, m - 1, Number(last.slice(8, 10))));
  const cut = d.toISOString().slice(0, 10);
  const spanMonths =
    (Number(last.slice(0, 4)) - Number(first.slice(0, 4))) * 12 +
    (Number(last.slice(5, 7)) - Number(first.slice(5, 7)));
  if (spanMonths < months * 2) return null;
  return cut;
}

/**
 * 样本外起点：区间最后 N 个月；区间不到 2N 个月时不分段。
 * 第 2 版用 addMonths（月末自动截断：3 月 31 日减 1 个月是 2 月 29 日 / 28 日）；第 1 版原样保留
 * （按 Date 溢出，3 月 31 日减 1 个月会算到 3 月 2 日）。
 */
export function oosStart(
  series: readonly SeriesPoint[],
  months: number,
  version: 1 | 2 = 1,
): DateStr | null {
  if (version === 1) return oosStartV1(series, months);
  if (series.length < 2) return null;
  const first = series[0]!.date;
  const last = series.at(-1)!.date;
  const spanMonths =
    (Number(last.slice(0, 4)) - Number(first.slice(0, 4))) * 12 +
    (Number(last.slice(5, 7)) - Number(first.slice(5, 7)));
  if (spanMonths < months * 2) return null;
  return addMonths(last, -months);
}

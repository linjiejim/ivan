/**
 * 指标与归因（纯函数）。年化按自然日：年数 = (末日 − 首日) / 365.25；夏普无风险利率取 0。
 */
import {
  type Attribution,
  diffDays,
  type HoldingSnapshot,
  type Metrics,
  type OpenPosition,
  type PeriodMetrics,
  type SecurityInfo,
  type SeriesPoint,
  type Trade,
} from "@ivan/core";

const ann = (total: number, years: number) =>
  years > 0 && total > -1 ? (1 + total) ** (1 / years) - 1 : 0;

export function periodMetrics(series: readonly SeriesPoint[]): PeriodMetrics {
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
  const totalReturn = last.nav / first.nav - 1;
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
): Metrics {
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
  };
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
  // 未平仓：按市值减去最近一次买入成本计浮动盈亏
  for (const p of open) {
    const e = byCode.get(p.code) ?? { pnl: 0, trades: 0 };
    e.pnl += p.value - (buyCost.get(p.code) ?? p.value);
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

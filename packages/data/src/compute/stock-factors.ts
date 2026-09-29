/**
 * 单只股票的时间序列因子（纯函数）。行业内横截面因子（PE/行业中位数、行业市值排名）
 * 由 SQL 在全市场结果上补算，这里留空。
 */
import {
  type DateStr,
  diffDays,
  FACTORS,
  FINANCIAL_INDUSTRY_RE,
  type FactorKey,
  type Market,
} from "@ivan/core";
import type { CorpAction } from "./adjust.ts";
import { type FinDerived, FinCursor } from "./financials.ts";
import {
  rollingMax,
  rollingPercentile,
  rollingStd,
  type ShareChange,
  sma,
  SPLIT_REASON_RE,
} from "./series.ts";

export interface StockMeta {
  code: string;
  market: Market;
  board: string | null;
  list_date: DateStr | null;
  industry: string | null;
  industry_l1: string | null;
}

export interface StockBars {
  date: DateStr[];
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  /** 股 */
  volume: Float64Array;
  /** 成交额（本币）；来源没有时为空，用 收盘 × 成交量 估算 */
  amount?: Float64Array;
  adj: Float64Array;
}

export interface StockInput {
  meta: StockMeta;
  bars: StockBars;
  shares: ShareChange[];
  /** 公司行动（现金分红、送转），来自复权价反推 */
  actions: CorpAction[];
  fin: FinDerived[];
  /** 港股：1 单位记账币种 = 多少港币；拿不到返回 null */
  fx?: (ccy: string, date: DateStr) => number | null;
  /** A 股：按简称历史判定的 ST；不知道时返回 null（回退到年报连亏近似） */
  st?: (date: DateStr) => boolean | null;
  /** 只输出这天及以后的行（更早的数据只用来算滚动窗口） */
  fromDate: DateStr;
}

/** factors_daily 的列顺序：code, date, market, close, 然后是注册表里的因子。 */
export const KEY_COLUMNS = ["code", "date", "market", "close"] as const;
const IDX = new Map<string, number>(FACTORS.map((f, i) => [f.key, i + KEY_COLUMNS.length]));
const WIDTH = KEY_COLUMNS.length + FACTORS.length;
const idx = (k: FactorKey) => IDX.get(k)!;

/** 5 年 ≈ 1250 个交易日；分位至少要 3 年（750 天）样本 */
const PCT_WINDOW = 1250;
const PCT_MIN = 750;

const finite = (x: number) => (Number.isFinite(x) ? x : null);

/** 把送转/拆并股的生效日对齐到最近的送转除权日，避免市值在错位的几天里腰斩或翻倍。 */
export function alignShareChanges(
  shares: readonly ShareChange[],
  splitDates: readonly DateStr[],
): ShareChange[] {
  const out = shares.map((s) => {
    if (!s.reason || !SPLIT_REASON_RE.test(s.reason)) return s;
    let best: DateStr | null = null;
    let bestGap = 8;
    for (const d of splitDates) {
      const gap = Math.abs(diffDays(d, s.eff_date));
      if (gap < bestGap) {
        bestGap = gap;
        best = d;
      }
    }
    return best ? { ...s, eff_date: best } : s;
  });
  return out.sort((a, b) => (a.eff_date < b.eff_date ? -1 : a.eff_date > b.eff_date ? 1 : 0));
}

export function computeStockFactors(input: StockInput): unknown[][] {
  const { meta, bars, fin, fromDate } = input;
  const n = bars.date.length;
  if (!n) return [];
  const { date, close, high, volume, adj } = bars;
  const amountIn = bars.amount;

  // ── 价格派生 ──
  const hfq = new Float64Array(n);
  const hfqHigh = new Float64Array(n);
  const logret = new Float64Array(n);
  const amount = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    hfq[i] = close[i]! * adj[i]!;
    hfqHigh[i] = Math.max(high[i]!, close[i]!) * adj[i]!;
    logret[i] = i ? Math.log(hfq[i]! / hfq[i - 1]!) : 0;
    const a = amountIn?.[i];
    amount[i] = a !== undefined && Number.isFinite(a) && a > 0 ? a : close[i]! * volume[i]!;
  }
  const ma20 = sma(hfq, 20);
  const ma60 = sma(hfq, 60);
  const max60 = rollingMax(hfqHigh, 60);
  const max250 = rollingMax(hfqHigh, 250);
  const vol60 = rollingStd(logret, 60);
  const v5 = sma(volume, 5);
  const v20 = sma(volume, 20);
  const amt20 = sma(amount, 20);

  // ── 股本、财报、估值 ──
  const splitEvents = input.actions.filter((a) => a.split !== 0);
  const shares = alignShareChanges(
    input.shares,
    splitEvents.map((a) => a.date),
  );
  const cursor = new FinCursor(fin);
  const finAt: Array<FinDerived | undefined> = new Array(n);
  const mcap = new Float64Array(n).fill(NaN);
  const pe = new Float64Array(n).fill(NaN);
  const pb = new Float64Array(n).fill(NaN);
  let si = -1;
  for (let i = 0; i < n; i++) {
    const d = date[i]!;
    while (si + 1 < shares.length && shares[si + 1]!.eff_date <= d) si++;
    const f = cursor.at(d);
    finAt[i] = f;
    const sh = si >= 0 ? shares[si]!.total_shares : (f?.shares ?? NaN);
    if (!(sh > 0)) continue;
    const m = close[i]! * sh;
    mcap[i] = m;
    if (!f) continue;
    let fx = 1;
    if (meta.market === "HK" && f.currency && f.currency !== "HKD") {
      const r = input.fx?.(f.currency, d);
      if (!r) continue;
      fx = r;
    }
    if (f.ttm_np !== null && f.ttm_np > 0) pe[i] = m / (f.ttm_np * fx);
    if (f.equity !== null && f.equity > 0) pb[i] = m / (f.equity * fx);
  }
  const pePct = rollingPercentile(pe, PCT_WINDOW, PCT_MIN);
  const pbPct = rollingPercentile(pb, PCT_WINDOW, PCT_MIN);

  // ── 分红（股息率）：每股现金分红按之后（含当天）的送转折算到当前股本口径 ──
  const dividends = input.actions.filter((a) => a.cash > 0);
  const isFinancial = FINANCIAL_INDUSTRY_RE.test(`${meta.industry_l1 ?? ""}${meta.industry ?? ""}`);

  const rows: unknown[][] = [];
  for (let i = 0; i < n; i++) {
    const d = date[i]!;
    if (d < fromDate) continue;
    const row = new Array(WIDTH).fill(null);
    row[0] = meta.code;
    row[1] = d;
    row[2] = meta.market;
    row[3] = close[i];
    const f = finAt[i];

    // 估值
    row[idx("pe_ttm")] = finite(pe[i]!);
    row[idx("pb")] = finite(pb[i]!);
    row[idx("mcap")] = Number.isFinite(mcap[i]!) ? mcap[i]! / 1e8 : null;
    row[idx("pe_pct_5y")] = finite(pePct[i]!);
    row[idx("pb_pct_5y")] = finite(pbPct[i]!);
    row[idx("turnover_20d")] = Number.isFinite(amt20[i]!) ? amt20[i]! / 1e8 : null;

    if (dividends.length) {
      let sum = 0;
      for (const dv of dividends) {
        if (dv.date > d) break;
        if (diffDays(d, dv.date) >= 365) continue;
        let mult = 1;
        for (const sp of splitEvents) if (sp.date >= dv.date && sp.date <= d) mult *= 1 + sp.split;
        sum += dv.cash / mult;
      }
      row[idx("dividend_yield_ttm")] = (sum / close[i]!) * 100;
    }
    if (row[idx("dividend_yield_ttm")] === null && i >= 250) row[idx("dividend_yield_ttm")] = 0;

    // 质量与成长
    if (f) {
      row[idx("roe_ttm")] = f.roe_ttm;
      row[idx("gross_margin")] = f.gross_margin;
      row[idx("debt_ratio")] = f.debt_ratio;
      row[idx("ocf_to_profit")] =
        f.np !== null && f.np > 0 && f.ocf !== null ? f.ocf / f.np : null;
      row[idx("rev_yoy")] = f.revenue_yoy;
      row[idx("np_yoy")] = f.np_yoy;
      if (meta.market === "A") row[idx("deducted_np_yoy")] = f.deducted_np_yoy;
      row[idx("rev_cagr_2y")] = f.rev_cagr_2y;
      row[idx("np_cagr_2y")] = f.np_cagr_2y;
    }

    // 技术
    const chg = (k: number) => (i >= k ? (hfq[i]! / hfq[i - k]! - 1) * 100 : null);
    const chg20 = chg(20);
    row[idx("chg_20d")] = chg20;
    row[idx("chg_60d")] = chg(60);
    row[idx("chg_250d")] = chg(250);
    row[idx("dist_high_60d")] = Number.isFinite(max60[i]!) ? (hfq[i]! / max60[i]! - 1) * 100 : null;
    row[idx("dist_high_250d")] = Number.isFinite(max250[i]!)
      ? (hfq[i]! / max250[i]! - 1) * 100
      : null;
    const slope = (ma: Float64Array) =>
      i >= 5 && Number.isFinite(ma[i]!) && Number.isFinite(ma[i - 5]!)
        ? (ma[i]! / ma[i - 5]! - 1) * 100
        : null;
    const s60 = slope(ma60);
    row[idx("ma20_slope")] = slope(ma20);
    row[idx("ma60_slope")] = s60;
    row[idx("above_ma60")] = Number.isFinite(ma60[i]!) ? hfq[i]! > ma60[i]! : null;
    row[idx("vol_ratio_20d")] =
      Number.isFinite(v5[i]!) && v20[i]! > 0 ? v5[i]! / v20[i]! : null;
    row[idx("volatility_60d")] = i >= 60 ? finite(vol60[i]! * Math.sqrt(250) * 100) : null;

    // 分类
    row[idx("industry")] = meta.industry;
    row[idx("industry_l1")] = meta.industry_l1 ?? meta.industry;
    row[idx("board")] = meta.board;

    // 标记
    row[idx("flag_new_listing")] = meta.list_date ? diffDays(d, meta.list_date) < 365 : false;
    const npBase = f ? (f.ttm_np ?? f.np) : null;
    row[idx("flag_loss")] = npBase === null ? null : npBase <= 0;
    if (meta.market === "A") {
      const named = input.st?.(d);
      row[idx("flag_st")] = named ?? (f ? f.annual_loss_2 : false);
      row[idx("flag_deducted_decline")] = f ? f.deducted_decline_2 : null;
    }
    const pct = finite(pePct[i]!);
    const declining = f ? (meta.market === "A" ? f.deducted_decline_2 : f.np_decline_2) : false;
    row[idx("flag_value_trap")] = pct !== null && pct < 30 && declining;
    row[idx("flag_low_base")] = f
      ? (f.np_yoy ?? 0) > 100 && (f.np_cagr_2y === null || f.np_cagr_2y < 20)
      : null;
    row[idx("flag_high_debt")] = f?.debt_ratio != null ? f.debt_ratio > 70 && !isFinancial : null;
    row[idx("flag_chasing")] = chg20 === null ? null : chg20 > 15;
    row[idx("flag_downtrend")] =
      Number.isFinite(ma60[i]!) && s60 !== null ? hfq[i]! < ma60[i]! && s60 < 0 : null;

    rows.push(row);
  }
  return rows;
}

import { periodLabel } from "@ivan/core";
/**
 * 因子历史与横截面位置、财报与分红历史（spec 20261020 D103）。
 */
import type { DividendRow, FactorHistory, FactorHistoryRow, FinancialHistory, FinancialRow, PeriodInput } from "@ivan/core";
import { type DateStr, diffDays, FACTOR_MAP, type FactorDef } from "@ivan/core";
import { downsample, median, percentileOf } from "../../compute/price-stats.ts";

import { type Warehouse } from "../../warehouse/db.ts";

import { AnalyticsError, asOfOf, endOf, fromOf, dataNote, latestFactors, resolveInstrument } from "./common.ts";

// ── 5. 因子历史与横截面位置 ──

/** 只算正值的因子：亏损时 PE 为空、净资产为负时 PB 为空，但老数据里可能有负值 */
const POSITIVE_ONLY = new Set(["pe_ttm", "pb", "peg"]);

export const DEFAULT_HISTORY_FACTORS = ["pe_ttm", "pb", "dividend_yield_ttm", "roe_ttm"];

export async function factorHistory(
  wh: Warehouse,
  q: { query: string; factors?: string[] | null; period?: PeriodInput | null; from?: string | null; to?: string | null },
): Promise<FactorHistory> {
  const inst = await resolveInstrument(wh, q.query);
  if (inst.kind !== "stock") throw new AnalyticsError(400, "因子历史只能查个股；指数请用走势");
  const keys = [...new Set(q.factors?.length ? q.factors : DEFAULT_HISTORY_FACTORS)];
  if (keys.length > 6) throw new AnalyticsError(400, "一次最多查 6 个因子");
  const defs: FactorDef[] = [];
  for (const k of keys) {
    const f = FACTOR_MAP.get(k);
    if (!f) throw new AnalyticsError(400, `没有「${k}」这个因子，可用 list_factors 查`);
    if (f.kind !== "number") throw new AnalyticsError(400, `「${f.label}」不是数值因子，没有历史分位`);
    if (!f.markets.includes(inst.market))
      throw new AnalyticsError(400, `「${f.label}」只适用于 ${f.markets.join("、")}`);
    defs.push(f);
  }
  const end = await endOf(wh, inst.market, q.to);
  const from = fromOf(end, q, "5y");
  const cols = defs.map((f) => f.key);
  const hist = await wh.columns(
    `SELECT date::VARCHAR AS d, industry_l1, ${cols.join(", ")} FROM factors_daily
     WHERE code = $c AND date >= $a::DATE AND date <= $b::DATE ORDER BY date`,
    { c: inst.code, a: from ?? "1990-01-01", b: end },
  );
  const dates = (hist.d ?? []) as string[];
  if (!dates.length) throw new AnalyticsError(404, `${inst.name}在这个区间没有因子数据`);
  const lastDate = dates.at(-1)!;
  const industry = ((hist.industry_l1 ?? []) as Array<string | null>).at(-1) ?? inst.industryL1;
  const cross = await wh.all<Record<string, unknown>>(
    `SELECT code, industry_l1, ${cols.join(", ")} FROM factors_daily WHERE market = $m AND date = $d::DATE`,
    { m: inst.market, d: lastDate },
  );
  const out: FactorHistoryRow[] = defs.map((f) => {
    const pos = POSITIVE_ONLY.has(f.key);
    const raw = (hist[f.key] ?? []) as Array<number | null>;
    const pts: Array<{ d: DateStr; v: number }> = [];
    raw.forEach((v, i) => {
      if (v !== null && Number.isFinite(v) && (!pos || v > 0)) pts.push({ d: dates[i]!, v });
    });
    const vals = pts.map((p) => p.v);
    let mn = -1;
    let mx = -1;
    pts.forEach((p, i) => {
      if (mn < 0 || p.v < pts[mn]!.v) mn = i;
      if (mx < 0 || p.v > pts[mx]!.v) mx = i;
    });
    const lastRaw = raw.at(-1);
    const current = lastRaw !== null && lastRaw !== undefined && Number.isFinite(lastRaw) ? lastRaw : null;
    const curOk = current !== null && (!pos || current > 0);
    const valid = (v: unknown): v is number =>
      typeof v === "number" && Number.isFinite(v) && (!pos || v > 0);
    const mk = cross.map((r) => r[f.key]).filter(valid);
    const ind = cross.filter((r) => r.industry_l1 === industry).map((r) => r[f.key]).filter(valid);
    return {
      key: f.key,
      label: f.label,
      unit: f.unit ?? null,
      current,
      currentDate: current !== null ? lastDate : null,
      startValue: pts[0]?.v ?? null,
      min: mn >= 0 ? pts[mn]!.v : null,
      minDate: mn >= 0 ? pts[mn]!.d : null,
      max: mx >= 0 ? pts[mx]!.v : null,
      maxDate: mx >= 0 ? pts[mx]!.d : null,
      median: median(vals),
      percentile: curOk ? percentileOf(vals, current) : null,
      observations: vals.length,
      crossSection: curOk
        ? {
            marketPercentile: percentileOf(mk, current),
            marketMedian: median(mk),
            marketCount: mk.length,
            industry: industry ?? null,
            industryPercentile: industry && ind.length >= 3 ? percentileOf(ind, current) : null,
            industryMedian: industry && ind.length >= 3 ? median(ind) : null,
            industryCount: ind.length,
          }
        : null,
      series: downsample(pts, 160),
    };
  });
  const notes = [
    dataNote(inst.market, await asOfOf(wh, inst.market)),
    "分位 = 当前值在区间历史里排第几（0 = 最低，100 = 最高）；PE、PB 只算为正的日子。估值类低分位表示比自己的历史便宜，ROE、股息率类则相反。",
    "每天的因子只用当天已经公布的财报算（点时口径）。",
  ];
  if (from && diffDays(dates[0]!, from) > 15) notes.push(`因子数据从 ${dates[0]} 才开始。`);
  return {
    instrument: inst,
    period: { from, to: end, label: q.from ? `${q.from} ~ ${end}` : periodLabel(q.period ?? "5y") },
    factors: out,
    notes,
  };
}

// ── 6. 财报与分红 ──

const PERIOD_ORDER: Record<string, number> = { Q1: 1, H1: 2, Q3: 3, FY: 4 };

export async function financialHistory(
  wh: Warehouse,
  q: { query: string; periods?: number | null; annualOnly?: boolean | null },
): Promise<FinancialHistory> {
  const inst = await resolveInstrument(wh, q.query);
  if (inst.kind !== "stock") throw new AnalyticsError(400, "财报只能查个股");
  type Row = {
    rd: string;
    period: string | null;
    fy: string | null;
    nd: string | null;
    ed: string;
    currency: string | null;
    revenue: number | null;
    np: number | null;
    deducted_np: number | null;
    revenue_yoy: number | null;
    np_yoy: number | null;
    deducted_np_yoy: number | null;
    roe: number | null;
    gross_margin: number | null;
    debt_ratio: number | null;
    ocf: number | null;
  };
  const all = await wh.all<Row>(
    `SELECT report_date::VARCHAR AS rd, period, fy_start::VARCHAR AS fy, notice_date::VARCHAR AS nd,
            eff_date::VARCHAR AS ed, currency, revenue, np, deducted_np, revenue_yoy, np_yoy, deducted_np_yoy,
            roe, gross_margin, debt_ratio, ocf
     FROM financials WHERE code = $c
     QUALIFY row_number() OVER (PARTITION BY report_date ORDER BY eff_date DESC) = 1
     ORDER BY report_date DESC LIMIT 60`,
    { c: inst.code },
  );
  if (!all.length) throw new AnalyticsError(404, `行情仓里没有${inst.name}的财报`);
  const byKey = new Map<string, Row>();
  for (const r of all) byKey.set(`${r.fy}|${r.period}`, r);
  const prevFy = (fy: string | null) => (fy ? `${Number(fy.slice(0, 4)) - 1}${fy.slice(4)}` : null);
  /** 同一财年里这一期之前那一期的累计数（单季 = 本期累计 − 前一期累计） */
  const priorInYear = (r: Row): Row | null => {
    const o = PERIOD_ORDER[r.period ?? ""] ?? 0;
    let best: Row | null = null;
    for (const [p, n] of Object.entries(PERIOD_ORDER)) {
      if (n >= o) continue;
      const x = byKey.get(`${r.fy}|${p}`);
      if (x && (!best || (PERIOD_ORDER[best.period ?? ""] ?? 0) < n)) best = x;
    }
    return best;
  };
  const singleOf = (r: Row) => {
    if (!r.period || !(r.period in PERIOD_ORDER)) return null;
    const p = priorInYear(r);
    // 一年里的第一期（一季报；港股的半年报）就是它自己
    if (!p) {
      return r.period === "Q1" || r.period === "H1"
        ? { label: r.period, revenue: r.revenue, np: r.np }
        : null;
    }
    // 单季 / 半年的名字由「本期 − 上一期」决定；中间缺了一期（比如有年报和一季报、没有三季报）就不拆
    const pair = `${p.period}>${r.period}`;
    const label =
      pair === "Q1>H1" ? "Q2" : pair === "H1>Q3" ? "Q3" : pair === "Q3>FY" ? "Q4" : pair === "H1>FY" ? "H2" : null;
    if (!label) return null;
    const diff = (a: number | null, b: number | null) => (a !== null && b !== null ? a - b : null);
    return { label, revenue: diff(r.revenue, p.revenue), np: diff(r.np, p.np) };
  };
  const ttm = (r: Row, k: "revenue" | "np") => {
    if (r.period === "FY") return r[k];
    const fy = byKey.get(`${prevFy(r.fy)}|FY`);
    const same = byKey.get(`${prevFy(r.fy)}|${r.period}`);
    const a = r[k];
    return a !== null && fy?.[k] != null && same?.[k] != null ? a + fy[k]! - same[k]! : null;
  };
  const yoyPct = (a: number | null, b: number | null) =>
    a !== null && b !== null && b > 0 ? (a / b - 1) * 100 : null;
  const singles = new Map<string, ReturnType<typeof singleOf>>();
  for (const r of all) singles.set(`${r.fy}|${r.period}`, singleOf(r));
  const n = Math.min(Math.max(q.periods ?? 8, 1), 20);
  const rows: FinancialRow[] = all
    .filter((r) => !q.annualOnly || r.period === "FY")
    .slice(0, n)
    .map((r) => {
      const s = singles.get(`${r.fy}|${r.period}`) ?? null;
      const ly = singles.get(`${prevFy(r.fy)}|${r.period}`) ?? null;
      return {
        reportDate: r.rd,
        period: r.period,
        noticeDate: r.nd,
        effDate: r.ed,
        currency: r.currency,
        revenue: r.revenue,
        np: r.np,
        deducted_np: r.deducted_np,
        revenue_yoy: r.revenue_yoy,
        np_yoy: r.np_yoy,
        deducted_np_yoy: r.deducted_np_yoy,
        roe: r.roe,
        gross_margin: r.gross_margin,
        debt_ratio: r.debt_ratio,
        ocf: r.ocf,
        single: s
          ? {
              label: s.label,
              revenue: s.revenue,
              np: s.np,
              revenueYoyPct: ly && ly.label === s.label ? yoyPct(s.revenue, ly.revenue) : null,
              npYoyPct: ly && ly.label === s.label ? yoyPct(s.np, ly.np) : null,
            }
          : null,
        revenueTtm: ttm(r, "revenue"),
        npTtm: ttm(r, "np"),
      };
    });

  const divs = await wh.all<{ d: string; cash: number | null; split: number | null; prev_close: number | null }>(
    `SELECT date::VARCHAR AS d, cash, split, prev_close FROM corp_actions
     WHERE code = $c AND (coalesce(cash, 0) > 0 OR coalesce(split, 1) <> 1)
     ORDER BY date DESC LIMIT 30`,
    { c: inst.code },
  );
  const dividends: DividendRow[] = divs.map((d) => ({
    date: d.d,
    cash: d.cash,
    split: d.split,
    yieldPct: d.cash && d.prev_close ? (d.cash / d.prev_close) * 100 : null,
  }));
  const years = new Map<string, { cash: number; count: number }>();
  for (const d of dividends) {
    if (!d.cash) continue;
    const y = d.date.slice(0, 4);
    const v = years.get(y) ?? { cash: 0, count: 0 };
    v.cash += d.cash;
    v.count++;
    years.set(y, v);
  }
  const end = await asOfOf(wh, inst.market);
  const f = await latestFactors(wh, [inst.code], end, ["dividend_yield_ttm"]);
  const notes = [
    "财报是报告期累计口径（一季报、半年报、三季报、年报）；单季 = 本期累计 − 同年上一期累计，TTM = 本期累计 + 上年年报 − 上年同期。金额单位：元（港股按报表币种）。",
  ];
  if (inst.market === "HK")
    notes.push("港股只有半年报和年报；回测里财报的可用日按法定披露期限推算（不是实际公告日）。");
  if (!dividends.length) notes.push("行情仓里没有这只股票的分红送转记录。");
  return {
    instrument: inst,
    rows,
    dividends: dividends.slice(0, 12),
    dividendsByYear: [...years]
      .map(([year, v]) => ({ year, cash: v.cash, count: v.count }))
      .sort((a, b) => b.year.localeCompare(a.year))
      .slice(0, 10),
    dividend_yield_ttm: f.get(inst.code)?.values.dividend_yield_ttm ?? null,
    notes,
  };
}

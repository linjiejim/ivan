/**
 * 财报派生指标（纯函数）。输入是一只股票的全部报告期（报告期累计口径），输出每期的 TTM、
 * 两年复合、连续下滑等派生值。每一期的派生值只用「该期生效日当天已经生效」的报告算，保证点时正确。
 */
import { addDays, addYears, type DateStr, diffDays } from "@ivan/core";

export type Period = "Q1" | "H1" | "Q3" | "FY";

export interface FinRow {
  code: string;
  report_date: DateStr;
  period: Period;
  fy_start: DateStr | null;
  notice_date: DateStr | null;
  eff_date: DateStr;
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
  equity: number | null;
  shares: number | null;
}

export interface FinDerived extends FinRow {
  ttm_np: number | null;
  ttm_revenue: number | null;
  roe_ttm: number | null;
  rev_cagr_2y: number | null;
  np_cagr_2y: number | null;
  /** 最近两期（本期与上一期）归母净利同比都 < 0 */
  np_decline_2: boolean;
  /** 最近两期扣非净利同比都 < 0 */
  deducted_decline_2: boolean;
  /** 已生效的最近两期年报归母净利都 < 0（ST 近似判定用） */
  annual_loss_2: boolean;
}

/** 生效日排序：先按生效日，同日按报告期。 */
export function sortByEffective(rows: readonly FinRow[]): FinRow[] {
  return [...rows].sort((a, b) =>
    a.eff_date === b.eff_date
      ? a.report_date < b.report_date
        ? -1
        : 1
      : a.eff_date < b.eff_date
        ? -1
        : 1,
  );
}

function near(a: DateStr, b: DateStr, days = 10): boolean {
  return Math.abs(diffDays(a, b)) <= days;
}

function cagr2(cur: number | null, old: number | null): number | null {
  if (cur === null || old === null || cur <= 0 || old <= 0) return null;
  return (Math.sqrt(cur / old) - 1) * 100;
}

/** TTM = 本期累计 + 上一财年全年 − 上年同期累计（年报直接取年报）。 */
function ttm(
  row: FinRow,
  prevFy: FinRow | undefined,
  sameLy: FinRow | undefined,
  pick: (r: FinRow) => number | null,
): number | null {
  const cur = pick(row);
  if (cur === null) return null;
  if (row.period === "FY") return cur;
  if (!prevFy || !sameLy) return null;
  const a = pick(prevFy);
  const b = pick(sameLy);
  return a === null || b === null ? null : cur + a - b;
}

export function deriveFinancials(rows: readonly FinRow[]): FinDerived[] {
  const sorted = sortByEffective(rows);
  const out: FinDerived[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i]!;
    // 该期生效当天已知的报告（含同一天生效的）
    const known = sorted.filter((r) => r.eff_date <= row.eff_date);
    const byReport = (d: DateStr, period?: Period) =>
      known.find((r) => near(r.report_date, d) && (!period || r.period === period));

    // 上一财年年报：财年起始日前一天；拿不到财年起始日时取一年内最近的年报
    let prevFy: FinRow | undefined;
    if (row.fy_start) prevFy = byReport(addDays(row.fy_start, -1), "FY");
    if (!prevFy) {
      prevFy = known
        .filter(
          (r) =>
            r.period === "FY" &&
            r.report_date < row.report_date &&
            diffDays(row.report_date, r.report_date) <= 370,
        )
        .sort((a, b) => (a.report_date < b.report_date ? 1 : -1))[0];
    }
    const sameLy = byReport(addYears(row.report_date, -1), row.period);
    const twoYearsAgo = byReport(addYears(row.report_date, -2), row.period);

    // 上一期：已知报告里报告期早于本期的最近一期
    const prev = known
      .filter((r) => r.report_date < row.report_date)
      .sort((a, b) => (a.report_date < b.report_date ? 1 : -1))[0];

    const annuals = known
      .filter((r) => r.period === "FY" && r.report_date <= row.report_date)
      .sort((a, b) => (a.report_date < b.report_date ? 1 : -1));

    out.push({
      ...row,
      ttm_np: ttm(row, prevFy, sameLy, (r) => r.np),
      ttm_revenue: ttm(row, prevFy, sameLy, (r) => r.revenue),
      roe_ttm: ttm(row, prevFy, sameLy, (r) => r.roe),
      rev_cagr_2y: cagr2(row.revenue, twoYearsAgo?.revenue ?? null),
      np_cagr_2y: cagr2(row.np, twoYearsAgo?.np ?? null),
      np_decline_2: (row.np_yoy ?? 0) < 0 && (prev?.np_yoy ?? 0) < 0,
      deducted_decline_2: (row.deducted_np_yoy ?? 0) < 0 && (prev?.deducted_np_yoy ?? 0) < 0,
      annual_loss_2:
        annuals.length >= 2 && (annuals[0]!.np ?? 0) < 0 && (annuals[1]!.np ?? 0) < 0,
    });
  }
  return out;
}

/**
 * 点时游标：按交易日顺序推进，返回「截至当日已生效、报告期最新」的那一期派生值。
 */
export class FinCursor {
  private i = 0;
  private current: FinDerived | undefined;

  constructor(private readonly rows: readonly FinDerived[]) {}

  at(date: DateStr): FinDerived | undefined {
    while (this.i < this.rows.length && this.rows[this.i]!.eff_date <= date) {
      const r = this.rows[this.i]!;
      if (!this.current || r.report_date >= this.current.report_date) this.current = r;
      this.i++;
    }
    return this.current;
  }
}

/** 港股财报生效日（D22）：年报 +90 天，其余 +60 天。 */
export function hkEffectiveDate(reportDate: DateStr, period: Period): DateStr {
  return addDays(reportDate, period === "FY" ? 90 : 60);
}

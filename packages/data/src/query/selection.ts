/**
 * 选股：把策略编译成对 factors_daily 的一条 SQL（spec §4）。
 * 因子名只来自注册表白名单，数值经 zod 校验后内联，字符串转义单引号，没有注入面。
 * 排序：每个排序项取当日横截面百分位（越好越接近 1；「行业内比较」的项只在同一一级行业里排），按权重加权；
 * 设了「同一行业最多 N 只」时，每个一级行业只留得分最高的 N 只。
 */
import { type Condition, type DateStr, FACTOR_MAP, type StrategySpec } from "@ivan/core";
import { sqlDateList, type Warehouse } from "../warehouse/db.ts";

function col(key: string): string {
  if (!FACTOR_MAP.has(key)) throw new Error(`未知因子 ${key}`);
  return key;
}

function lit(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`非法数值 ${v}`);
  return String(v);
}

function str(v: string): string {
  return `'${v.replaceAll("'", "''")}'`;
}

export function conditionSql(c: Condition): string {
  const f = col(c.factor);
  switch (c.op) {
    case "between":
      return `${f} BETWEEN ${lit(c.value[0])} AND ${lit(c.value[1])}`;
    case "is":
      return `coalesce(${f}, false) = true`;
    case "not":
      return `coalesce(${f}, false) = false`;
    case "in":
      return `${f} IN (${c.value.map(str).join(", ")})`;
    case "not_in":
      return `(${f} IS NULL OR ${f} NOT IN (${c.value.map(str).join(", ")}))`;
    default:
      return `${f} ${c.op} ${lit(c.value)}`;
  }
}

/** 股票池 + 条件（不含排序），给选股与「今日选股」共用。 */
export function whereSql(spec: StrategySpec): string[] {
  const w: string[] = [`market = ${str(spec.market)}`];
  const u = spec.universe;
  if (u.boards?.length) w.push(`board IN (${u.boards.map(str).join(", ")})`);
  if (u.exclude.includes("st")) w.push("coalesce(flag_st, false) = false");
  if (u.exclude.includes("new_listing")) w.push("coalesce(flag_new_listing, false) = false");
  if (u.exclude.includes("loss")) w.push("coalesce(flag_loss, false) = false");
  if (u.minMcap) w.push(`mcap >= ${lit(u.minMcap)}`);
  if (u.industries?.include?.length) w.push(`industry IN (${u.industries.include.map(str).join(", ")})`);
  if (u.industries?.exclude?.length) {
    w.push(`(industry IS NULL OR industry NOT IN (${u.industries.exclude.map(str).join(", ")}))`);
  }
  for (const c of spec.filters) w.push(conditionSql(c));
  return w;
}

export function compileSelection(spec: StrategySpec, dates: readonly DateStr[], limit: number): string {
  if (!spec.rank) throw new Error("规则策略需要排序");
  const terms = spec.rank.terms;
  const where = [...whereSql(spec), `date IN (${sqlDateList(dates)})`];
  for (const t of terms) where.push(`${col(t.factor)} IS NOT NULL`);
  const totalW = terms.reduce((s, t) => s + t.weight, 0);
  // 行业内比较（D48）：百分位在同日同一一级行业里算
  const score = terms
    .map(
      (t) =>
        `${lit(t.weight)} * percent_rank() OVER (PARTITION BY date${t.neutral ? ", industry_l1" : ""} ORDER BY ${col(
          t.factor,
        )} ${t.better === "high" ? "ASC" : "DESC"})`,
    )
    .join(" + ");
  // 同一行业最多 N 只（D48）：先在行业内按得分截断，再取全市场前 limit 名
  const cap = spec.rank.maxPerIndustry;
  const capped = cap
    ? `, capped AS (
  SELECT * FROM scored
  QUALIFY row_number() OVER (PARTITION BY date, coalesce(industry_l1, code) ORDER BY score DESC, code) <= ${Math.trunc(cap)}
)`
    : "";
  return `WITH base AS (
  SELECT date, code, industry_l1, ${[...new Set(terms.map((t) => col(t.factor)))].join(", ")}
  FROM factors_daily
  WHERE ${where.join("\n    AND ")}
), scored AS (
  SELECT date, code, industry_l1, (${score}) / ${lit(totalW)} AS score FROM base
)${capped}
SELECT date::VARCHAR AS date, code, score FROM ${cap ? "capped" : "scored"}
QUALIFY row_number() OVER (PARTITION BY date ORDER BY score DESC, code) <= ${Math.trunc(limit)}
ORDER BY date, score DESC, code`;
}

/** 大盘状态用的指数（不含分红的价格指数）：A 股沪深300、港股恒指（D53） */
export const REGIME_INDEX = { A: { sym: "csi300", label: "沪深300" }, HK: { sym: "hsi", label: "恒指" } } as const;

/**
 * 哪些日子大盘在均线下方（D53）：指数收盘 < 最近 ma 个交易日收盘的均值（含当天，只用当天及以前的数据）。
 * 某天指数没有数据时，用那天之前最近的一个交易日；均线样本不足时算强势。
 */
export async function weakRegimeDates(
  wh: Warehouse,
  market: "A" | "HK",
  dates: readonly DateStr[],
  ma: number,
): Promise<Set<DateStr>> {
  const out = new Set<DateStr>();
  if (!dates.length) return out;
  const last = [...dates].sort().at(-1)!;
  const rows = await wh.all<{ d: string; close: number }>(
    `SELECT date::VARCHAR AS d, close FROM index_bars WHERE sym = $s AND date <= $e::DATE AND close > 0 ORDER BY date`,
    { s: REGIME_INDEX[market].sym, e: last },
  );
  const weak = new Map<string, boolean>();
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    sum += rows[i]!.close;
    if (i >= ma) sum -= rows[i - ma]!.close;
    weak.set(rows[i]!.d, i >= ma - 1 && rows[i]!.close < sum / ma);
  }
  const days = rows.map((r) => r.d);
  for (const d of dates) {
    // 最近一个 ≤ d 的指数交易日
    let lo = 0;
    let hi = days.length - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (days[mid]! <= d) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (k >= 0 && weak.get(days[k]!)) out.add(d);
  }
  return out;
}

/** 大盘状态对应的排序：弱势时换成 regime.weak.terms，其余不变 */
export function specForRegime(spec: StrategySpec, weak: boolean): StrategySpec {
  if (!weak || !spec.rank?.regime) return spec;
  return { ...spec, rank: { ...spec.rank, terms: spec.rank.regime.weak.terms } };
}

/** 各决策日的排名（只取前 limit 名）；设了按大盘状态切换排序时，强势日和弱势日分开排。 */
export async function runRegimeSelection(
  wh: Warehouse,
  spec: StrategySpec,
  dates: readonly DateStr[],
  limit: number,
): Promise<{ selections: Map<DateStr, string[]>; weak: Set<DateStr> }> {
  const regime = spec.rank?.regime;
  if (!regime) return { selections: await runSelection(wh, spec, dates, limit), weak: new Set() };
  const weak = await weakRegimeDates(wh, spec.market, dates, regime.ma);
  const selections = await runSelection(wh, spec, dates.filter((d) => !weak.has(d)), limit);
  const weakSel = await runSelection(wh, specForRegime(spec, true), dates.filter((d) => weak.has(d)), limit);
  for (const [d, l] of weakSel) selections.set(d, l);
  return { selections, weak };
}

/** 各决策日的排名（只取前 limit 名）。 */
export async function runSelection(
  wh: Warehouse,
  spec: StrategySpec,
  dates: readonly DateStr[],
  limit: number,
): Promise<Map<DateStr, string[]>> {
  const out = new Map<DateStr, string[]>();
  if (!dates.length) return out;
  const rows = await wh.all<{ date: string; code: string }>(compileSelection(spec, dates, limit));
  for (const r of rows) {
    let l = out.get(r.date);
    if (!l) out.set(r.date, (l = []));
    l.push(r.code);
  }
  return out;
}

export interface ScreenRow {
  rank: number;
  code: string;
  name: string | null;
  score: number;
  close: number | null;
  factors: Record<string, unknown>;
}

/** 某一天按策略选股（「今日选股」与个股对照），带上策略用到的因子与常用估值。 */
export async function screenOn(
  wh: Warehouse,
  specIn: StrategySpec,
  date: DateStr,
  limit: number,
): Promise<ScreenRow[]> {
  const weak = specIn.rank?.regime
    ? (await weakRegimeDates(wh, specIn.market, [date], specIn.rank.regime.ma)).has(date)
    : false;
  const spec = specForRegime(specIn, weak);
  const used = new Set<string>(["pe_ttm", "pb", "mcap", "roe_ttm", "dividend_yield_ttm", "industry"]);
  for (const c of spec.filters) used.add(c.factor);
  for (const t of spec.rank?.terms ?? []) used.add(t.factor);
  const cols = [...used].map(col);
  const sel = compileSelection(spec, [date], limit);
  const rows = await wh.all<Record<string, unknown>>(
    `WITH picked AS (${sel})
     SELECT p.code, p.score, s.name, f.close, ${cols.map((c) => `f.${c}`).join(", ")}
     FROM picked p
     JOIN factors_daily f ON f.code = p.code AND f.date = p.date::DATE
     LEFT JOIN securities s ON s.code = p.code
     ORDER BY p.score DESC, p.code`,
  );
  return rows.map((r, i) => ({
    rank: i + 1,
    code: String(r.code),
    name: (r.name as string) ?? null,
    score: Number(r.score),
    close: (r.close as number) ?? null,
    factors: Object.fromEntries(cols.map((c) => [c, r[c]])),
  }));
}

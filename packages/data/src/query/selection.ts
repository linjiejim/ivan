/**
 * 选股：把策略编译成对 factors_daily 的一条 SQL（spec §4）。
 * 因子名只来自注册表白名单，数值经 zod 校验后内联，字符串转义单引号，没有注入面。
 * 排序：每个排序项取当日横截面百分位（越好越接近 1），按权重加权。
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
  const score = terms
    .map(
      (t) =>
        `${lit(t.weight)} * percent_rank() OVER (PARTITION BY date ORDER BY ${col(t.factor)} ${
          t.better === "high" ? "ASC" : "DESC"
        })`,
    )
    .join(" + ");
  return `WITH base AS (
  SELECT date, code, ${[...new Set(terms.map((t) => col(t.factor)))].join(", ")}
  FROM factors_daily
  WHERE ${where.join("\n    AND ")}
), scored AS (
  SELECT date, code, (${score}) / ${lit(totalW)} AS score FROM base
)
SELECT date::VARCHAR AS date, code, score FROM scored
QUALIFY row_number() OVER (PARTITION BY date ORDER BY score DESC, code) <= ${Math.trunc(limit)}
ORDER BY date, score DESC, code`;
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
  spec: StrategySpec,
  date: DateStr,
  limit: number,
): Promise<ScreenRow[]> {
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

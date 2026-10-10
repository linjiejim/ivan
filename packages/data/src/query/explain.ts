/**
 * 选股解释（D67）：「为什么是它、为什么那天」只用和回测同一条 SQL（selectionSql 的 trace 模式）回答。
 *
 * - 候选名单：名次、得分、各排序项的分位（t0…tn，与得分求和里的表达式同一段文本）、用到的因子值；
 * - 指定代码的逐条判定：股票池与每条筛选算成布尔列，列出没满足的（中文）；排序因子缺值、同行业上限截掉、
 *   当天没数据都给出原因；通过的给出全体合格股里的名次。
 * - 今日选股（screenOn）也取这里的候选名单，只剩一条路径。
 */
import {
  type DateStr,
  EXPLAIN_VERSION,
  FACTOR_MAP,
  type RankTerm,
  type StrategySpec,
} from "@ivan/core";
import { sqlCodeList, type Warehouse } from "../warehouse/db.ts";
import { col, selectionSql, specForRegime, weakRegimeDates, whereParts } from "./selection.ts";

/** 选股解释的版本：定义在 @ivan/core 的 versions.ts，这里原样再导出 */
export { EXPLAIN_VERSION };

export type FactorValue = number | string | boolean | null;

export interface CandidateTrace {
  code: string;
  name: string | null;
  rank: number;
  score: number;
  /** 各排序项的分位（0–1，越好越接近 1），键 = 因子名（同一因子出现两次时第二个起带 #序号） */
  termPct: Record<string, number>;
  factors: Record<string, FactorValue>;
  /** 当天不复权收盘价（今日选股卡用） */
  close: number | null;
}

export interface CodeExplain {
  code: string;
  name: string | null;
  hasData: boolean;
  /** 进了排名（通过股票池与筛选、排序因子都有值、没被同行业上限截掉） */
  passed: boolean;
  failed: string[];
  /** 全体合格股里的名次（可能大于 limit） */
  rank: number | null;
  cappedOut: boolean;
  score: number | null;
  termPct: Record<string, number> | null;
  factors: Record<string, FactorValue>;
}

export interface SelectionExplain {
  version: typeof EXPLAIN_VERSION;
  date: DateStr;
  /** 按大盘状态切换排序的策略（D53）这天用的是哪套；没设为 null */
  regime: "strong" | "weak" | null;
  limit: number;
  candidates: CandidateTrace[];
  codes: CodeExplain[];
}

/** 候选名单带出的常用估值（和原来的今日选股一致） */
const COMMON_FACTORS = ["pe_ttm", "pb", "mcap", "roe_ttm", "dividend_yield_ttm", "industry"];

/** 取值的因子列：常用估值 + 筛选 + 排序（顺序与原来的今日选股一致） */
function factorCols(spec: StrategySpec): string[] {
  const used = new Set<string>(COMMON_FACTORS);
  for (const c of spec.filters) used.add(c.factor);
  for (const t of spec.rank?.terms ?? []) used.add(t.factor);
  return [...used].map(col);
}

/** termPct 的键：因子名；同一因子出现两次（如全市场比与行业内比）时第二个起带 #序号 */
function termKeys(terms: readonly RankTerm[]): string[] {
  const seen = new Set<string>();
  return terms.map((t, i) => {
    const k = seen.has(t.factor) ? `${t.factor}#${i}` : t.factor;
    seen.add(t.factor);
    return k;
  });
}

function factorValue(v: unknown): FactorValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "bigint") return Number(v);
  return String(v);
}

const fAlias = (c: string) => `"f_${c}"`;

function pickFactors(r: Record<string, unknown>, cols: readonly string[]): Record<string, FactorValue> {
  return Object.fromEntries(cols.map((c) => [c, factorValue(r[`f_${c}`])]));
}

function pickTerms(r: Record<string, unknown>, keys: readonly string[]): Record<string, number> {
  return Object.fromEntries(keys.map((k, i) => [k, Number(r[`t${i}`])]));
}

export async function explainSelection(
  wh: Warehouse,
  specIn: StrategySpec,
  date: DateStr,
  o: { limit: number; codes?: readonly string[] },
): Promise<SelectionExplain> {
  if (!specIn.rank) throw new Error("规则策略需要排序");
  const regimeOn = specIn.rank.regime;
  const weak = regimeOn
    ? (await weakRegimeDates(wh, specIn.market, [date], regimeOn.ma)).has(date)
    : false;
  const spec = specForRegime(specIn, weak);
  const terms = spec.rank!.terms;
  const keys = termKeys(terms);
  const cols = factorCols(spec);
  const sel = selectionSql(spec, [date], o.limit, { trace: true });
  const rows = await wh.all<Record<string, unknown>>(
    `WITH picked AS (${sel})
     SELECT p.code, p.score, ${terms.map((_, i) => `p.t${i}`).join(", ")}, s.name AS sec_name,
            f.close AS bar_close, ${cols.map((c) => `f.${c} AS ${fAlias(c)}`).join(", ")}
     FROM picked p
     JOIN factors_daily f ON f.code = p.code AND f.date = p.date::DATE
     LEFT JOIN securities s ON s.code = p.code
     ORDER BY p.score DESC, p.code`,
  );
  const candidates: CandidateTrace[] = rows.map((r, i) => ({
    code: String(r.code),
    name: (r.sec_name as string | null) ?? null,
    rank: i + 1,
    score: Number(r.score),
    termPct: pickTerms(r, keys),
    factors: pickFactors(r, cols),
    close: (r.bar_close as number | null) ?? null,
  }));
  const codes = o.codes?.length ? await explainCodes(wh, spec, date, o.codes, keys, cols) : [];
  return {
    version: EXPLAIN_VERSION,
    date,
    regime: regimeOn ? (weak ? "weak" : "strong") : null,
    limit: o.limit,
    candidates,
    codes,
  };
}

/** 指定代码的逐条判定：一次查询把每条条件算成布尔列 */
async function explainCodes(
  wh: Warehouse,
  spec: StrategySpec,
  date: DateStr,
  codesIn: readonly string[],
  keys: readonly string[],
  cols: readonly string[],
): Promise<CodeExplain[]> {
  const codes = [...new Set(codesIn)];
  const parts = whereParts(spec);
  const rankFactors = [...new Set(spec.rank!.terms.map((t) => col(t.factor)))];
  const names = new Map(
    (
      await wh.all<{ code: string; name: string | null }>(
        `SELECT code, name FROM securities WHERE code IN (${sqlCodeList(codes)})`,
      )
    ).map((r) => [r.code, r.name ?? null]),
  );
  // 条件里的列名不带表名：先在 factors_daily 里算完，再和别的表连
  const rows = await wh.all<Record<string, unknown>>(
    `SELECT code,
            ${parts.map((p, i) => `coalesce((${p.sql}), false) AS w${i}`).join(",\n            ")},
            ${rankFactors.map((k, i) => `(${k} IS NOT NULL) AS r${i}`).join(", ")},
            ${cols.map((c) => `${c} AS ${fAlias(c)}`).join(", ")}
     FROM factors_daily
     WHERE date = $d::DATE AND code IN (${sqlCodeList(codes)})`,
    { d: date },
  );
  const byCode = new Map(rows.map((r) => [String(r.code), r]));

  // 名次：同一条 SQL 不截前 limit 名；同行业上限截掉的，再按不设上限算一次得分
  let ranked: Map<string, { rank: number; row: Record<string, unknown> }> | null = null;
  let uncapped: Map<string, Record<string, unknown>> | null = null;
  const rankedAll = async () =>
    (ranked ??= new Map(
      (await wh.all<Record<string, unknown>>(selectionSql(spec, [date], 0, { trace: true, noLimit: true }))).map(
        (r, i) => [String(r.code), { rank: i + 1, row: r }],
      ),
    ));
  const uncappedAll = async () =>
    (uncapped ??= new Map(
      (
        await wh.all<Record<string, unknown>>(
          selectionSql({ ...spec, rank: { ...spec.rank!, maxPerIndustry: undefined } }, [date], 0, {
            trace: true,
            noLimit: true,
          }),
        )
      ).map((r) => [String(r.code), r]),
    ));

  const out: CodeExplain[] = [];
  for (const code of codes) {
    const r = byCode.get(code);
    const base = { code, name: names.get(code) ?? null };
    if (!r) {
      out.push({
        ...base,
        hasData: false,
        passed: false,
        failed: ["当天没有数据（停牌或未上市）"],
        rank: null,
        cappedOut: false,
        score: null,
        termPct: null,
        factors: {},
      });
      continue;
    }
    const failed: string[] = [];
    parts.forEach((p, i) => {
      if (r[`w${i}`] !== true) failed.push(p.label ?? "不在策略的市场里");
    });
    rankFactors.forEach((k, i) => {
      if (r[`r${i}`] !== true) failed.push(`排序因子「${FACTOR_MAP.get(k)?.label ?? k}」没有数据`);
    });
    const factors = pickFactors(r, cols);
    if (failed.length) {
      out.push({ ...base, hasData: true, passed: false, failed, rank: null, cappedOut: false, score: null, termPct: null, factors });
      continue;
    }
    const hit = (await rankedAll()).get(code);
    if (hit) {
      out.push({
        ...base,
        hasData: true,
        passed: true,
        failed: [],
        rank: hit.rank,
        cappedOut: false,
        score: Number(hit.row.score),
        termPct: pickTerms(hit.row, keys),
        factors,
      });
      continue;
    }
    const cap = spec.rank!.maxPerIndustry;
    const u = (await uncappedAll()).get(code);
    out.push({
      ...base,
      hasData: true,
      passed: false,
      failed: [cap ? `同行业已满 ${cap} 只` : "没进排名"],
      rank: null,
      cappedOut: !!cap,
      score: u ? Number(u.score) : null,
      termPct: u ? pickTerms(u, keys) : null,
      factors,
    });
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

/**
 * 某一天按策略选股（「今日选股」与个股对照），带上策略用到的因子与常用估值。
 * 取的是选股解释的候选名单，与回测同一条 SQL（D67）。
 */
export async function screenOn(
  wh: Warehouse,
  spec: StrategySpec,
  date: DateStr,
  limit: number,
): Promise<ScreenRow[]> {
  const { candidates } = await explainSelection(wh, spec, date, { limit });
  return candidates.map((c) => ({
    rank: c.rank,
    code: c.code,
    name: c.name,
    score: c.score,
    close: c.close,
    factors: c.factors,
  }));
}

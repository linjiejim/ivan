/**
 * 选股：把策略编译成对 factors_daily 的一条 SQL（spec §4）。
 * 因子名只来自注册表白名单，数值经 zod 校验后内联，字符串转义单引号，没有注入面。
 * 排序：每个排序项取当日横截面百分位（越好越接近 1；「行业内比较」的项只在同一一级行业里排），按权重加权；
 * 设了「同一行业最多 N 只」时，每个一级行业只留得分最高的 N 只。
 */
import {
  type Condition,
  type DateStr,
  describeCondition,
  FACTOR_MAP,
  HK_CONNECT_MISSING_TEXT,
  type RankTerm,
  type StrategySpec,
} from "@ivan/core";
import { sqlDateList, type Warehouse } from "../warehouse/db.ts";

/** 因子名 → 列名：只认注册表里的因子（白名单） */
export function col(key: string): string {
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

export interface WherePart {
  sql: string;
  /** 没满足时给用户看的中文原因；null = 不单独解释（市场） */
  label: string | null;
}

const BOARD_TEXT: Record<string, string> = {
  main: "主板",
  gem: "创业板",
  star: "科创板",
  hk_main: "港股主板",
  hk_gem: "港股创业板",
};

/** 港股通名单（D77）：用哪几个属性（深港通，核实后加沪港通）取并集，首次记录日（之前的日子用这天的名单） */
export interface HkConnectList {
  attrs: string[];
  first: DateStr;
}

/** 选股读行情仓以外的数据（港股通名单）：调用方先用 selectionContext 读好，SQL 构造保持纯函数 */
export interface SelectionContext {
  hkConnect?: HkConnectList;
}

/** 选股要的数据还没有（港股通名单没有记录）：worker 接口给 400 与中文原因 */
export class SelectionDataError extends Error {
  readonly status = 400 as const;
}

const HK_CONNECT_ATTRS = ["hk_connect_sz", "hk_connect_sh"] as const;

/** 港股通名单的属性与首次记录日；一行快照都没有时为 null */
export async function loadHkConnect(wh: Warehouse): Promise<HkConnectList | null> {
  const rows = await wh.all<{ attr: string; first: string }>(
    `SELECT attr, min(valid_from)::VARCHAR AS first FROM attr_history
     WHERE attr IN (${HK_CONNECT_ATTRS.map(str).join(", ")}) AND code LIKE '%.HK'
     GROUP BY attr ORDER BY attr DESC`,
  );
  if (!rows.length) return null;
  return {
    attrs: rows.map((r) => r.attr),
    first: rows.reduce((m, r) => (r.first < m ? r.first : m), rows[0]!.first),
  };
}

/** 策略选股要的额外数据：设了 universe.hkConnect 而没有名单时抛 SelectionDataError */
export async function selectionContext(wh: Warehouse, spec: StrategySpec): Promise<SelectionContext> {
  if (!spec.universe.hkConnect) return {};
  const hkConnect = await loadHkConnect(wh);
  if (!hkConnect) throw new SelectionDataError(HK_CONNECT_MISSING_TEXT);
  return { hkConnect };
}

/**
 * 港股通条件（D77）：决策日在名单里（值 Y 的区间覆盖这天）；早于首次记录日的日子用首次记录的名单。
 * 条件里的列不带别名（选股与解释都直接读 factors_daily），所以用表名限定。
 */
function hkConnectSql(l: HkConnectList): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(l.first)) throw new Error(`非法日期 ${l.first}`);
  const attrs = l.attrs.map((a) => {
    if (!(HK_CONNECT_ATTRS as readonly string[]).includes(a)) throw new Error(`未知属性 ${a}`);
    return str(a);
  });
  return `EXISTS (SELECT 1 FROM attr_history h WHERE h.code = factors_daily.code AND h.attr IN (${attrs.join(", ")}) AND h.value = 'Y' AND ((h.valid_from <= factors_daily.date AND coalesce(h.valid_to, DATE '9999-12-31') > factors_daily.date) OR (factors_daily.date < DATE '${l.first}' AND h.valid_from = DATE '${l.first}')))`;
}

/**
 * 股票池 + 条件（不含排序）拆成带中文标签的条件（D67）：选股、今日选股与选股解释共用，
 * 解释时把每条算成一个布尔列，列出没满足的。
 */
export function whereParts(spec: StrategySpec, sctx: SelectionContext = {}): WherePart[] {
  const w: WherePart[] = [{ sql: `market = ${str(spec.market)}`, label: null }];
  const u = spec.universe;
  if (u.boards?.length) {
    w.push({
      sql: `board IN (${u.boards.map(str).join(", ")})`,
      label: `板块不在范围（${u.boards.map((b) => BOARD_TEXT[b] ?? b).join("、")}）`,
    });
  }
  if (u.exclude.includes("st")) w.push({ sql: "coalesce(flag_st, false) = false", label: "是 ST" });
  if (u.exclude.includes("new_listing")) {
    w.push({ sql: "coalesce(flag_new_listing, false) = false", label: "是次新股" });
  }
  if (u.exclude.includes("loss")) w.push({ sql: "coalesce(flag_loss, false) = false", label: "亏损" });
  if (u.minMcap) w.push({ sql: `mcap >= ${lit(u.minMcap)}`, label: `市值低于 ${u.minMcap} 亿` });
  if (u.industries?.include?.length) {
    w.push({
      sql: `industry IN (${u.industries.include.map(str).join(", ")})`,
      label: "行业不在范围",
    });
  }
  if (u.industries?.exclude?.length) {
    w.push({
      sql: `(industry IS NULL OR industry NOT IN (${u.industries.exclude.map(str).join(", ")}))`,
      label: "行业被排除",
    });
  }
  if (u.hkConnect) {
    if (!sctx.hkConnect) throw new SelectionDataError(HK_CONNECT_MISSING_TEXT);
    w.push({ sql: hkConnectSql(sctx.hkConnect), label: "不是港股通标的" });
  }
  for (const c of spec.filters) w.push({ sql: conditionSql(c), label: `没满足：${describeCondition(c)}` });
  return w;
}

/** 股票池 + 条件（不含排序），给选股与「今日选股」共用。 */
export function whereSql(spec: StrategySpec, sctx: SelectionContext = {}): string[] {
  return whereParts(spec, sctx).map((p) => p.sql);
}

/** 排序项的分位表达式：得分求和与解释的 t 列用同一段文本（D67） */
function termSql(t: RankTerm): string {
  return `percent_rank() OVER (PARTITION BY date${t.neutral ? ", industry_l1" : ""} ORDER BY ${col(
    t.factor,
  )} ${t.better === "high" ? "ASC" : "DESC"})`;
}

export interface SelectionSqlOptions extends SelectionContext {
  /** 解释模式：在同一组 CTE 里多输出每个排序项的分位 t0…tn 与一级行业 */
  trace?: boolean;
  /** 不截前 limit 名（解释时给出全体合格股里的名次） */
  noLimit?: boolean;
}

/**
 * 选股 SQL 的唯一构造器（D67）：base（股票池与条件）→ scored（加权分位）→ 可选 capped（同行业上限）→ 取前 limit 名。
 * 回测、今日选股与选股解释都从这里出 SQL；trace 只多带几列，不改任何一步的写法。
 */
export function selectionSql(
  spec: StrategySpec,
  dates: readonly DateStr[],
  limit: number,
  opts: SelectionSqlOptions = {},
): string {
  if (!spec.rank) throw new Error("规则策略需要排序");
  const terms = spec.rank.terms;
  const where = [...whereSql(spec, opts), `date IN (${sqlDateList(dates)})`];
  for (const t of terms) where.push(`${col(t.factor)} IS NOT NULL`);
  const totalW = terms.reduce((s, t) => s + t.weight, 0);
  // 行业内比较（D48）：百分位在同日同一一级行业里算
  const exprs = terms.map(termSql);
  const score = terms.map((t, i) => `${lit(t.weight)} * ${exprs[i]}`).join(" + ");
  const trace = opts.trace ? `, ${exprs.map((e, i) => `${e} AS t${i}`).join(", ")}` : "";
  const traceOut = opts.trace ? `, industry_l1, ${terms.map((_, i) => `t${i}`).join(", ")}` : "";
  // 同一行业最多 N 只（D48）：先在行业内按得分截断，再取全市场前 limit 名
  const cap = spec.rank.maxPerIndustry;
  const capped = cap
    ? `, capped AS (
  SELECT * FROM scored
  QUALIFY row_number() OVER (PARTITION BY date, coalesce(industry_l1, code) ORDER BY score DESC, code) <= ${Math.trunc(cap)}
)`
    : "";
  const top = opts.noLimit
    ? ""
    : `\nQUALIFY row_number() OVER (PARTITION BY date ORDER BY score DESC, code) <= ${Math.trunc(limit)}`;
  return `WITH base AS (
  SELECT date, code, industry_l1, ${[...new Set(terms.map((t) => col(t.factor)))].join(", ")}
  FROM factors_daily
  WHERE ${where.join("\n    AND ")}
), scored AS (
  SELECT date, code, industry_l1, (${score}) / ${lit(totalW)} AS score${trace} FROM base
)${capped}
SELECT date::VARCHAR AS date, code, score${traceOut} FROM ${cap ? "capped" : "scored"}${top}
ORDER BY date, score DESC, code`;
}

export function compileSelection(
  spec: StrategySpec,
  dates: readonly DateStr[],
  limit: number,
  sctx: SelectionContext = {},
): string {
  return selectionSql(spec, dates, limit, { hkConnect: sctx.hkConnect });
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
  sctxIn?: SelectionContext,
): Promise<{ selections: Map<DateStr, string[]>; weak: Set<DateStr> }> {
  const sctx = sctxIn ?? (await selectionContext(wh, spec));
  const regime = spec.rank?.regime;
  if (!regime) return { selections: await runSelection(wh, spec, dates, limit, sctx), weak: new Set() };
  const weak = await weakRegimeDates(wh, spec.market, dates, regime.ma);
  const selections = await runSelection(wh, spec, dates.filter((d) => !weak.has(d)), limit, sctx);
  const weakSel = await runSelection(
    wh,
    specForRegime(spec, true),
    dates.filter((d) => weak.has(d)),
    limit,
    sctx,
  );
  for (const [d, l] of weakSel) selections.set(d, l);
  return { selections, weak };
}

/** 各决策日的排名与得分（只取前 limit 名，按得分从高到低、同分按代码）。 */
export async function runSelectionScored(
  wh: Warehouse,
  spec: StrategySpec,
  dates: readonly DateStr[],
  limit: number,
  sctxIn?: SelectionContext,
): Promise<Map<DateStr, Array<{ code: string; score: number }>>> {
  const out = new Map<DateStr, Array<{ code: string; score: number }>>();
  if (!dates.length) return out;
  const sctx = sctxIn ?? (await selectionContext(wh, spec));
  const rows = await wh.all<{ date: string; code: string; score: number }>(
    compileSelection(spec, dates, limit, sctx),
  );
  for (const r of rows) {
    let l = out.get(r.date);
    if (!l) out.set(r.date, (l = []));
    l.push({ code: r.code, score: Number(r.score) });
  }
  return out;
}

/** 各决策日的排名（只取前 limit 名）。 */
export async function runSelection(
  wh: Warehouse,
  spec: StrategySpec,
  dates: readonly DateStr[],
  limit: number,
  sctx?: SelectionContext,
): Promise<Map<DateStr, string[]>> {
  const out = new Map<DateStr, string[]>();
  for (const [d, l] of await runSelectionScored(wh, spec, dates, limit, sctx)) {
    out.set(d, l.map((x) => x.code));
  }
  return out;
}

/**
 * 个股证据（D67）：唯一的点时读取器，今天与历史同一套代码。所有读取都限定「当时可得」（≤ asOf）：
 *
 * - 不晚于 asOf 的最后一个交易日的因子与日线（引用这天日线的 src、ver）；
 * - eff_date ≤ asOf 的最新一期财报，数值优先用 financials_seen 里 first_seen ≤ asOf 的那一版（当时首次见到的值，D61）；
 * - 近 365 天的分红送转、ST 判定的精确度档位、近 20 个交易日的停牌 / 无成交 / 缺数据、未解决的数据问题、行业属性快照。
 *
 * 每项带出处（表、键、来源、版本）与数据日；整份的校验值 hash = sha256Canonical(items)（证据第 1 版，D97），可复核。
 * asOf 是决策日（成交日的前一个交易日），不是成交日：用成交日当天的收盘价就是偷看一天。
 */
import {
  addDays,
  canonicalJson,
  type DateStr,
  FACTOR_MAP,
  FACTORS,
  type FactorDef,
  isDateStr,
  type Market,
} from "@ivan/core";
import { sha256Canonical } from "@ivan/core/node";
import { FIN_FIELDS, finRowHash } from "../etl/fundamentals.ts";
import { attrAsOf } from "../etl/snapshots.ts";
import type { Warehouse } from "../warehouse/db.ts";
import { type DataVersionInfo, lastTradingDay, latestDataVersion } from "./backtest.ts";

/** 证据条目的版本（D97）：第 1 版 = 本切片的条目，校验值只覆盖 items */
export const EVIDENCE_VERSION = 1;

export type EvidenceGroup = "price" | "valuation" | "financial" | "status" | "quality";

export interface EvidenceItem {
  group: EvidenceGroup;
  key: string;
  label: string;
  value: number | string | boolean | null;
  unit?: string;
  /** 数据本身的日期（因子与日线 = 数据日；财报 = 报告期） */
  asOf: DateStr;
  /** 什么时候起可得（≤ 证据的 asOf） */
  availDate: DateStr;
  ref: { table: string; key: Record<string, string | number>; src: string | null; ver: number | null };
  note?: string;
}

export interface EvidenceCaveat {
  id: string;
  level: "info" | "warn";
  title: string;
}

export interface SecurityDossier {
  evidenceVersion: typeof EVIDENCE_VERSION;
  code: string;
  name: string | null;
  market: Market;
  /** 决策日（截到已提交的数据截至日） */
  asOf: DateStr;
  /** 不晚于 asOf 的最后一个有因子的交易日 */
  dataDate: DateStr;
  dataVersion: DataVersionInfo;
  items: EvidenceItem[];
  caveats: EvidenceCaveat[];
  hash: string;
}

/** 证据读不到时的错误（worker 按 status 返回） */
export class EvidenceError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

/** 没带策略时的默认因子：常用估值、质量、成长、技术 */
export const DEFAULT_EVIDENCE_FACTORS = [
  "pe_ttm",
  "pb",
  "pe_pct_5y",
  "dividend_yield_ttm",
  "roe_ttm",
  "roe_min_3y",
  "ocf_to_profit",
  "np_yoy",
  "rev_yoy",
  "debt_ratio",
  "mcap",
  "mcap_rank",
  "turnover_20d",
  "chg_20d",
  "dist_high_250d",
  "mom_12_1",
  "volatility_60d",
] as const;

const GROUP_OF: Record<FactorDef["group"], EvidenceGroup> = {
  valuation: "valuation",
  size: "valuation",
  technical: "price",
  quality: "quality",
  growth: "quality",
  category: "status",
  flag: "status",
};

/** 财报数值项：列、标签、单位（金额按亿显示） */
const FIN_ITEMS: Array<{ key: string; label: string; unit: "亿" | "%"; aOnly?: boolean }> = [
  { key: "revenue", label: "营业收入", unit: "亿" },
  { key: "np", label: "归母净利润", unit: "亿" },
  { key: "deducted_np", label: "扣非净利润", unit: "亿", aOnly: true },
  { key: "revenue_yoy", label: "营收同比", unit: "%" },
  { key: "np_yoy", label: "净利同比", unit: "%" },
  { key: "roe", label: "ROE（报告期）", unit: "%" },
  { key: "gross_margin", label: "毛利率", unit: "%" },
  { key: "debt_ratio", label: "资产负债率", unit: "%" },
  { key: "ocf", label: "经营现金流", unit: "亿" },
];

const BAR_STATUS_TEXT: Record<string, string> = {
  suspended: "停牌",
  no_trade: "无成交",
  missing: "缺数据",
};

const ST_TIER_TEXT = {
  szse: "深交所官方简称记录",
  em_daily: "东财每日简称（沪市 2018 起）",
  approx: "近似：最近两期年报都亏损算 ST",
} as const;

const max = (a: DateStr, b: DateStr) => (a > b ? a : b);
const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : typeof v === "number" ? v : Number(v);

function itemValue(v: unknown): EvidenceItem["value"] {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "bigint") return Number(v);
  return String(v);
}

export async function securityDossier(
  wh: Warehouse,
  code: string,
  asOfIn?: DateStr | null,
  o: { factorKeys?: readonly string[] } = {},
): Promise<SecurityDossier> {
  if (asOfIn && !isDateStr(asOfIn)) throw new EvidenceError(400, "日期格式要是 YYYY-MM-DD");
  const sec = await wh.one<{ name: string | null; market: string; industry_l1: string | null }>(
    `SELECT name, market, industry_l1 FROM securities WHERE code = $c`,
    { c: code },
  );
  if (!sec) throw new EvidenceError(404, `找不到 ${code}`);
  const market: Market = sec.market === "HK" ? "HK" : "A";
  // 只读已提交的数据（D60）：asOf 默认并截到 committedAsOf；再落到交易日（周末、节假日退到前一个交易日），
  // 这样拿 asOf 去做选股解释时和回测在同一天决策
  const dataVersion = await latestDataVersion(wh, market);
  const committed = dataVersion.asOf;
  if (!committed) throw new EvidenceError(404, "行情仓还没有提交过的数据");
  const asOf = await lastTradingDay(wh, market, asOfIn && asOfIn < committed ? asOfIn : committed);

  const row = await wh.one<Record<string, unknown>>(
    `SELECT date::VARCHAR AS data_date, * EXCLUDE (date) FROM factors_daily
     WHERE code = $c AND date <= $a::DATE ORDER BY date DESC LIMIT 1`,
    { c: code, a: asOf },
  );
  if (!row) throw new EvidenceError(404, "这只股票那天还没有数据");
  const dataDate = String(row.data_date);
  const items: EvidenceItem[] = [];
  const caveats: EvidenceCaveat[] = [];

  // ── 价格：这天的日线（出处 = 日线的 src、ver） ──
  const bar = await wh.one<{ close: number | null; adj: number | null; src: string | null; ver: number | null }>(
    `SELECT close, adj, src, ver FROM bars_daily WHERE code = $c AND date = $d::DATE LIMIT 1`,
    { c: code, d: dataDate },
  );
  const barRef = {
    table: "bars_daily",
    key: { code, date: dataDate },
    src: bar?.src ?? null,
    ver: num(bar?.ver),
  };
  const ccy = market === "HK" ? "港元" : "元";
  items.push(
    { group: "price", key: "close", label: "收盘价（不复权）", value: itemValue(bar?.close), unit: ccy, asOf: dataDate, availDate: dataDate, ref: barRef },
    { group: "price", key: "adj", label: "复权因子", value: itemValue(bar?.adj), asOf: dataDate, availDate: dataDate, ref: barRef },
  );

  // ── 因子：默认一组常用的，带策略时用策略的筛选与排序因子；外加为真的风险标记（group === 'flag'，D97） ──
  const wanted = (o.factorKeys?.length ? o.factorKeys : DEFAULT_EVIDENCE_FACTORS).filter((k) =>
    FACTOR_MAP.get(k)?.markets.includes(market),
  );
  const keys = [...new Set(wanted)];
  for (const f of FACTORS as readonly FactorDef[]) {
    if (f.group === "flag" && f.markets.includes(market) && row[f.key] === true && !keys.includes(f.key)) {
      keys.push(f.key);
    }
  }
  const factorRef = { table: "factors_daily", key: { code, date: dataDate }, src: barRef.src, ver: barRef.ver };
  for (const k of keys) {
    const f = FACTOR_MAP.get(k)!;
    items.push({
      group: GROUP_OF[f.group],
      key: k,
      label: f.label,
      value: itemValue(row[k]),
      ...(f.unit ? { unit: f.unit } : {}),
      asOf: dataDate,
      availDate: dataDate,
      ref: factorRef,
    });
  }

  // ── 财报：eff_date ≤ asOf 的最新一期；数值优先用当时首次见到的那一版 ──
  items.push(...(await financialItems(wh, code, market, asOf, dataDate, caveats)));

  // ── 数据状态 ──
  items.push(...(await statusItems(wh, code, market, asOf, dataDate, sec.industry_l1, caveats)));

  return {
    evidenceVersion: EVIDENCE_VERSION,
    code,
    name: sec.name ?? null,
    market,
    asOf,
    dataDate,
    dataVersion,
    items,
    caveats,
    hash: sha256Canonical(items),
  };
}

async function financialItems(
  wh: Warehouse,
  code: string,
  market: Market,
  asOf: DateStr,
  dataDate: DateStr,
  caveats: EvidenceCaveat[],
): Promise<EvidenceItem[]> {
  const dateCols = new Set(["report_date", "fy_start", "notice_date", "eff_date"]);
  const cur = await wh.one<Record<string, unknown>>(
    `SELECT ${FIN_FIELDS.map((k) => (dateCols.has(k) ? `${k}::VARCHAR AS ${k}` : k)).join(", ")}, src, ver
     FROM financials WHERE code = $c AND eff_date <= $a::DATE
     ORDER BY report_date DESC LIMIT 1`,
    { c: code, a: asOf },
  );
  if (!cur) {
    return [
      {
        group: "financial",
        key: "fin_report_date",
        label: "最新一期财报",
        value: null,
        asOf: dataDate,
        availDate: dataDate,
        ref: { table: "financials", key: { code }, src: null, ver: null },
        note: "当时还没有生效的财报",
      },
    ];
  }
  const reportDate = String(cur.report_date);
  const effDate = String(cur.eff_date);
  const seen = await wh.one<{ row_hash: string; first_seen: string; ver: number | null; row_json: string | null }>(
    `SELECT row_hash, first_seen::VARCHAR AS first_seen, ver, row_json FROM financials_seen
     WHERE code = $c AND report_date = $r::DATE AND first_seen <= $a::DATE
     ORDER BY first_seen DESC LIMIT 1`,
    { c: code, r: reportDate, a: asOf },
  );
  let vals: Record<string, unknown> = cur;
  let ref: EvidenceItem["ref"];
  let availDate = effDate;
  let corrected = false;
  const parsed = parseRow(seen?.row_json ?? null);
  if (seen && parsed) {
    vals = parsed;
    // financials_seen 只由东财财报写入（writeFundamentals）
    ref = {
      table: "financials_seen",
      key: { code, report_date: reportDate, first_seen: seen.first_seen },
      src: "em",
      ver: num(seen.ver),
    };
    availDate = max(effDate, seen.first_seen);
    corrected = seen.row_hash !== finRowHash([code, ...FIN_FIELDS.map((k) => cur[k] ?? null)]);
  } else {
    ref = {
      table: "financials",
      key: { code, report_date: reportDate },
      src: (cur.src as string | null) ?? null,
      ver: num(cur.ver),
    };
    caveats.push({ id: "restated_possible", level: "info", title: "财报数值为最新版本，可能含事后更正" });
  }
  const note = corrected ? "（之后被更正过）" : undefined;
  const base = { group: "financial" as const, asOf: reportDate, availDate, ref };
  const out: EvidenceItem[] = [
    {
      ...base,
      key: "fin_report_date",
      label: market === "HK" ? "报告期（生效日按法定期限推算）" : "报告期",
      value: reportDate,
      ...(cur.period ? { note: String(cur.period) } : {}),
    },
  ];
  if (cur.notice_date) out.push({ ...base, key: "fin_notice_date", label: "公告日", value: String(cur.notice_date) });
  out.push({ ...base, key: "fin_eff_date", label: "生效日", value: effDate });
  const currency = (vals.currency as string | null) ?? null;
  const homeCcy = market === "HK" ? "HKD" : "CNY";
  for (const it of FIN_ITEMS) {
    if (it.aOnly && market !== "A") continue;
    const raw = num(vals[it.key]);
    const value = raw === null || !Number.isFinite(raw) ? null : it.unit === "亿" ? raw / 1e8 : raw;
    const notes = [
      it.unit === "亿" && currency && currency !== homeCcy ? `币种 ${currency}` : null,
      note ?? null,
    ].filter(Boolean);
    out.push({
      ...base,
      // 和同名因子（np_yoy、debt_ratio）区分：财报项的键带 fin_ 前缀，整份里每个键唯一
      key: `fin_${it.key}`,
      label: it.label,
      value,
      unit: it.unit,
      ...(notes.length ? { note: notes.join(" ") } : {}),
    });
  }
  return out;
}

async function statusItems(
  wh: Warehouse,
  code: string,
  market: Market,
  asOf: DateStr,
  dataDate: DateStr,
  currentIndustry: string | null,
  caveats: EvidenceCaveat[],
): Promise<EvidenceItem[]> {
  const out: EvidenceItem[] = [];
  const base = { group: "status" as const };

  // 近 365 天的分红送转（除权除息日 ≤ asOf）
  const from = addDays(asOf, -365);
  const actions = await wh.all<{
    date: string;
    prev_close: number | null;
    ref_price: number | null;
    cash: number | null;
    split: number | null;
    src: string | null;
    ver: number | null;
  }>(
    `SELECT date::VARCHAR AS date, prev_close, ref_price, cash, split, src, ver FROM corp_actions
     WHERE code = $c AND date > $f::DATE AND date <= $a::DATE ORDER BY date`,
    { c: code, f: from, a: asOf },
  );
  if (!actions.length) {
    out.push({
      ...base,
      key: "corp_actions_365d",
      label: "近一年分红送转",
      value: "无",
      asOf,
      availDate: dataDate,
      ref: { table: "corp_actions", key: { code, from, to: asOf }, src: null, ver: null },
    });
  }
  for (const a of actions) {
    const parts: string[] = [];
    if (a.cash !== null && a.cash > 0) parts.push(`每股派现 ${round(a.cash, 4)}`);
    if (a.split !== null && a.split > 0) parts.push(`每股送转 ${round(a.split, 4)}`);
    if (!parts.length && a.prev_close !== null && a.ref_price !== null) {
      parts.push(`前收 ${round(a.prev_close, 4)} → 参考价 ${round(a.ref_price, 4)}`);
    }
    out.push({
      ...base,
      key: `corp_action:${a.date}`,
      label: "分红送转（除权除息日）",
      value: parts.join("，") || "除权除息",
      asOf: a.date,
      availDate: a.date,
      ref: { table: "corp_actions", key: { code, date: a.date }, src: a.src ?? null, ver: num(a.ver) },
    });
  }

  // ST 判定的精确度档位（D21）：深市官方 / 沪市 2018 起每日简称 / 近似
  if (market === "A") {
    const tier = code.endsWith(".SZ")
      ? "szse"
      : code.endsWith(".SH") && dataDate >= "2018-01-02"
        ? "em_daily"
        : "approx";
    out.push({
      ...base,
      key: "st_tier",
      label: "ST 判定依据",
      value: ST_TIER_TEXT[tier],
      asOf: dataDate,
      availDate: dataDate,
      ref: {
        table: "name_changes",
        key: { code, tier },
        src: tier === "szse" ? "szse" : tier === "em_daily" ? "em" : null,
        ver: null,
      },
    });
  }

  // 近 20 个交易日的停牌 / 无成交 / 缺数据（逐日记录开始以前没有数据）
  const days = await wh.all<{ d: string }>(
    `SELECT date::VARCHAR AS d FROM trade_calendar WHERE market = $m AND date <= $a::DATE ORDER BY date DESC LIMIT 20`,
    { m: market, a: asOf },
  );
  const first = days.at(-1)?.d ?? asOf;
  const recorded = Number(
    (await wh.scalar(
      `SELECT count(*) FROM bar_status WHERE ${market === "HK" ? "code LIKE '%.HK'" : "code NOT LIKE '%.HK'"} AND date <= $a::DATE`,
      { a: asOf },
    )) ?? 0,
  );
  const st = await wh.all<{ status: string; n: number }>(
    `SELECT status, count(*) AS n FROM bar_status
     WHERE code = $c AND date >= $f::DATE AND date <= $a::DATE GROUP BY status ORDER BY status`,
    { c: code, f: first, a: asOf },
  );
  const total = st.reduce((s, r) => s + Number(r.n), 0);
  out.push({
    ...base,
    key: "bar_status_20d",
    label: "近 20 个交易日停牌 / 无成交 / 缺数据",
    value: recorded ? total : null,
    unit: "天",
    asOf,
    availDate: dataDate,
    ref: { table: "bar_status", key: { code, from: first, to: asOf }, src: null, ver: null },
    ...(recorded
      ? total
        ? { note: st.map((r) => `${BAR_STATUS_TEXT[r.status] ?? r.status} ${Number(r.n)} 天`).join("，") }
        : {}
      : { note: "那时还没有逐日记录" }),
  });

  // 未解决的数据问题
  const issues = Number(
    (await wh.scalar(
      `SELECT count(*) FROM data_issues
       WHERE code = $c AND coalesce(date, created_at::DATE) <= $a::DATE AND resolved_ver IS NULL`,
      { c: code, a: asOf },
    )) ?? 0,
  );
  out.push({
    ...base,
    key: "data_issues",
    label: "未解决的数据问题",
    value: issues,
    unit: "条",
    asOf,
    availDate: dataDate,
    ref: { table: "data_issues", key: { code }, src: null, ver: null },
  });

  // 行业：属性快照（D61）；首次快照之前用首次名单，没有快照用当前分类
  const ind = await attrAsOf(wh, "industry_l1", code, asOf);
  if (ind) {
    const meta = await wh.one<{ src: string | null; ver: number | null }>(
      `SELECT src, ver FROM attr_history WHERE attr = 'industry_l1' AND code = $c AND valid_from = $f::DATE LIMIT 1`,
      { c: code, f: ind.from },
    );
    if (ind.preSnapshot) {
      caveats.push({ id: "industry_pre_snapshot", level: "info", title: "行业用的是首次记录时的分类，当时可能不同" });
    }
    out.push({
      ...base,
      key: "industry_l1",
      label: ind.preSnapshot ? `行业（用的是 ${ind.from} 的分类）` : `行业（${ind.from} 起记录）`,
      value: ind.value,
      asOf: ind.preSnapshot ? asOf : ind.from,
      availDate: ind.preSnapshot ? dataDate : ind.from,
      ref: {
        table: "attr_history",
        key: { code, attr: "industry_l1", valid_from: ind.from },
        src: meta?.src ?? null,
        ver: num(meta?.ver),
      },
    });
  } else {
    caveats.push({ id: "industry_current", level: "info", title: "行业用的是当前分类，当时可能不同" });
    out.push({
      ...base,
      key: "industry_l1",
      label: "行业（当前分类）",
      value: currentIndustry,
      asOf,
      availDate: dataDate,
      ref: { table: "securities", key: { code }, src: null, ver: null },
    });
  }
  return out;
}

/** financials_seen.row_json（按列名的原始行）；读不懂当作没有留底 */
function parseRow(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function round(x: number, d: number): number {
  return Math.round(x * 10 ** d) / 10 ** d;
}

/**
 * 复核一份证据：按同样的代码、决策日与因子集重新生成，比校验值。带上原来的条目时逐项比出变了哪些
 * （新增、删掉的也算；删掉的给原来那一项）。
 */
export async function verifyDossier(
  wh: Warehouse,
  code: string,
  asOf: DateStr,
  hash: string,
  o: { factorKeys?: readonly string[]; items?: readonly EvidenceItem[] } = {},
): Promise<{ same: boolean; hash: string; changed: EvidenceItem[] }> {
  const cur = await securityDossier(wh, code, asOf, { factorKeys: o.factorKeys });
  if (cur.hash === hash) return { same: true, hash: cur.hash, changed: [] };
  const changed: EvidenceItem[] = [];
  if (o.items) {
    const before = new Map(o.items.map((it) => [it.key, canonicalJson(it)]));
    const now = new Set(cur.items.map((it) => it.key));
    for (const it of cur.items) if (before.get(it.key) !== canonicalJson(it)) changed.push(it);
    for (const it of o.items) if (!now.has(it.key)) changed.push(it);
  }
  return { same: false, hash: cur.hash, changed };
}

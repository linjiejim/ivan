/**
 * 个股证据（D67）：唯一的点时读取器，今天与历史同一套代码。所有读取都限定「当时可得」（≤ asOf）：
 *
 * - 不晚于 asOf 的最后一个交易日的因子与日线（引用这天日线的 src、ver）；
 * - eff_date ≤ asOf 的最新一期财报，数值优先用 financials_seen 里 first_seen ≤ asOf 的那一版（当时首次见到的值，D61）；
 * - 近 365 天的分红送转、ST 判定的精确度档位、近 20 个交易日的停牌 / 无成交 / 缺数据、未解决的数据问题、行业属性快照。
 *
 * 每项带出处（表、键、来源、版本）与数据日，可复核。证据带版本（D97）：
 * - 第 1 版 = S07 的条目，校验值 hash = sha256Canonical(items)（旧值照样能复核）；
 * - 第 2 版 = S15b 给 A 股加「两融与筹码」组（7 个事件因子 + 最近一条两融、最近一期户数、下一次已知解禁、近 20 个交易日大宗），
 *   校验值 = sha256Canonical({evidenceVersion, factorKeys, options, items})。
 * securityDossier(..., {version}) 能按任一版本的条目集合重新生成；新生成的用当前版本。
 * asOf 是决策日（成交日的前一个交易日），不是成交日：用成交日当天的收盘价就是偷看一天。
 */
import {
  addDays,
  canonicalJson,
  type DateStr,
  EVIDENCE_VERSION,
  EVIDENCE_VERSIONS,
  FACTOR_MAP,
  FACTORS,
  type FactorDef,
  isDateStr,
  LOCKUP_NOTICE_LEAD_TD,
  type Market,
  PIT_DATASET_IDS,
  PIT_DATASETS,
  SOFT_FAILING_ALERT,
} from "@ivan/core";
import { sha256Canonical } from "@ivan/core/node";
import { FIN_FIELDS, finRowHash } from "../etl/fundamentals.ts";
import { attrAsOf } from "../etl/snapshots.ts";
import type { Warehouse } from "../warehouse/db.ts";
import { type DataVersionInfo, lastTradingDay, latestDataVersion } from "./backtest.ts";
import { softStepStatus } from "./data-health.ts";

/** 证据的版本（D97）定义在 @ivan/core（决策回溯的导出清单要写出它），这里原样再导出 */
export { EVIDENCE_VERSION, EVIDENCE_VERSIONS };

export type EvidenceGroup = "price" | "valuation" | "financial" | "status" | "quality" | "events";

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
  /** 出处；事件表（S15）的行还带写它的批次 batch（pit_batches.id） */
  ref: {
    table: string;
    key: Record<string, string | number>;
    src: string | null;
    ver: number | null;
    batch?: number | null;
  };
  note?: string;
}

export interface EvidenceCaveat {
  id: string;
  level: "info" | "warn";
  title: string;
}

/** 证据的可选项（S17c 的趋势、多期财报、同业分位在这里加；第 2 版还没有，恒为 {}） */
export type EvidenceOptions = Record<string, unknown>;

export interface SecurityDossier {
  evidenceVersion: number;
  /** 生成时实际用的因子集（默认一组或策略的因子，按市场过滤、去重；不含随后补上的风险标记与事件因子） */
  factorKeys: string[];
  options: EvidenceOptions;
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
  event: "events",
};

/** 校验值：第 1 版只覆盖条目；第 2 版起连同版本、因子集与选项一起 */
export function dossierHash(
  version: number,
  factorKeys: readonly string[],
  options: EvidenceOptions,
  items: readonly EvidenceItem[],
): string {
  return version === 1
    ? sha256Canonical(items)
    : sha256Canonical({ evidenceVersion: version, factorKeys, options, items });
}

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
  o: { factorKeys?: readonly string[]; version?: number; options?: EvidenceOptions } = {},
): Promise<SecurityDossier> {
  if (asOfIn && !isDateStr(asOfIn)) throw new EvidenceError(400, "日期格式要是 YYYY-MM-DD");
  const version = o.version ?? EVIDENCE_VERSION;
  if (!(EVIDENCE_VERSIONS as readonly number[]).includes(version)) {
    throw new EvidenceError(400, `证据版本只能是 ${EVIDENCE_VERSIONS.join("、")}`);
  }
  const options: EvidenceOptions = o.options ?? {};
  if (Object.keys(options).length) throw new EvidenceError(400, "这个版本的证据没有可选项");
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
  // 事件因子不在这里：第 1 版没有它们，第 2 版起统一放进「两融与筹码」组
  const wanted = (o.factorKeys?.length ? o.factorKeys : DEFAULT_EVIDENCE_FACTORS).filter((k) => {
    const f = FACTOR_MAP.get(k);
    return !!f && f.markets.includes(market) && !f.dataset;
  });
  const factorKeys = [...new Set(wanted)];
  const keys = [...factorKeys];
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

  // ── 两融与筹码（第 2 版起，只有 A 股） ──
  if (version >= 2 && market === "A") {
    items.push(...(await eventItems(wh, code, asOf, dataDate, row, factorRef, caveats)));
  }

  return {
    evidenceVersion: version,
    factorKeys,
    options,
    code,
    name: sec.name ?? null,
    market,
    asOf,
    dataDate,
    dataVersion,
    items,
    caveats,
    hash: dossierHash(version, factorKeys, options, items),
  };
}

const LOCKUP_RULE_NOTE = (rule: string, firstSeen: string): string =>
  rule === "ipo_terms"
    ? "首发限售，上市时已知"
    : rule === "first_seen"
      ? `${firstSeen} 首次记录`
      : `按解禁前 ${LOCKUP_NOTICE_LEAD_TD} 个交易日的提示性公告推算可得日`;

/**
 * 「两融与筹码」组（证据第 2 版，D85）：7 个事件因子（引用 factors_daily）、最近一条两融、最近一期户数、
 * 下一次已知解禁、近 20 个交易日大宗。每项的可得日 ≤ 决策日，只看 asOf 时可得且没撤下的行；引用带 src、ver、batch。
 */
async function eventItems(
  wh: Warehouse,
  code: string,
  asOf: DateStr,
  dataDate: DateStr,
  row: Record<string, unknown>,
  factorRef: EvidenceItem["ref"],
  caveats: EvidenceCaveat[],
): Promise<EvidenceItem[]> {
  const out: EvidenceItem[] = [];
  const base = { group: "events" as const };
  for (const f of FACTORS as readonly FactorDef[]) {
    if (!f.dataset) continue;
    out.push({
      ...base,
      key: f.key,
      label: f.label,
      value: itemValue(row[f.key]),
      ...(f.unit ? { unit: f.unit } : {}),
      asOf: dataDate,
      availDate: dataDate,
      ref: factorRef,
    });
  }

  const m = await wh.one<{
    date: string;
    avail: string;
    rzye: number | null;
    src: string | null;
    ver: number | null;
    batch: number | null;
  }>(
    `SELECT date::VARCHAR AS date, avail_date::VARCHAR AS avail, rzye, src, ver, batch FROM margin_daily
     WHERE code = $c AND avail_date <= $a::DATE ORDER BY date DESC LIMIT 1`,
    { c: code, a: asOf },
  );
  out.push(
    m
      ? {
          ...base,
          key: "margin.latest",
          label: `融资余额（${m.date}）`,
          value: m.rzye === null ? null : m.rzye / 1e8,
          unit: "亿",
          asOf: m.date,
          availDate: m.avail,
          ref: { table: "margin_daily", key: { code, date: m.date }, src: m.src, ver: num(m.ver), batch: num(m.batch) },
        }
      : {
          ...base,
          key: "margin.latest",
          label: "融资余额",
          value: null,
          unit: "亿",
          asOf,
          availDate: dataDate,
          ref: { table: "margin_daily", key: { code }, src: null, ver: null, batch: null },
          note: "当时没有两融记录（不是两融标的，或两融数据还没覆盖到）",
        },
  );

  const h = await wh.one<{
    end: string;
    notice: string;
    avail: string;
    n: number | null;
    src: string | null;
    ver: number | null;
    batch: number | null;
  }>(
    `SELECT end_date::VARCHAR AS "end", notice_date::VARCHAR AS notice, avail_date::VARCHAR AS avail,
            holder_num AS n, src, ver, batch FROM holder_counts
     WHERE code = $c AND avail_date <= $a::DATE AND (gone_from IS NULL OR gone_from > $a::DATE)
     ORDER BY end_date DESC, notice_date DESC LIMIT 1`,
    { c: code, a: asOf },
  );
  out.push(
    h
      ? {
          ...base,
          key: "holders.latest",
          label: `股东户数（截至 ${h.end}，${h.notice} 公告）`,
          value: itemValue(h.n),
          unit: "户",
          asOf: h.end,
          availDate: h.avail,
          ref: {
            table: "holder_counts",
            key: { code, end_date: h.end, notice_date: h.notice },
            src: h.src,
            ver: num(h.ver),
            batch: num(h.batch),
          },
        }
      : {
          ...base,
          key: "holders.latest",
          label: "股东户数",
          value: null,
          unit: "户",
          asOf,
          availDate: dataDate,
          ref: { table: "holder_counts", key: { code }, src: null, ver: null, batch: null },
          note: "当时还没有公告过的户数",
        },
  );

  const l = await wh.one<{
    free: string;
    type: string;
    shares: number | null;
    avail: string;
    rule: string;
    first: string;
    src: string | null;
    ver: number | null;
    batch: number | null;
  }>(
    `SELECT free_date::VARCHAR AS free, type, unlock_shares AS shares, avail_date::VARCHAR AS avail,
            avail_rule AS rule, first_seen::VARCHAR AS first, src, ver, batch FROM lockups
     WHERE code = $c AND avail_date <= $a::DATE AND (gone_from IS NULL OR gone_from > $a::DATE)
       AND free_date > $a::DATE
     ORDER BY free_date, type LIMIT 1`,
    { c: code, a: asOf },
  );
  out.push(
    l
      ? {
          ...base,
          key: "lockup.next",
          label: `下一次已知解禁（${l.free}，${l.type}）`,
          value: l.shares === null ? null : l.shares / 1e4,
          unit: "万股",
          asOf: l.free,
          availDate: l.avail,
          ref: {
            table: "lockups",
            key: { code, free_date: l.free, type: l.type },
            src: l.src,
            ver: num(l.ver),
            batch: num(l.batch),
          },
          note: LOCKUP_RULE_NOTE(l.rule, l.first),
        }
      : {
          ...base,
          key: "lockup.next",
          label: "下一次已知解禁",
          value: null,
          unit: "万股",
          asOf,
          availDate: dataDate,
          ref: { table: "lockups", key: { code }, src: null, ver: null, batch: null },
          note: "当时已知的解禁里没有",
        },
  );

  // 近 20 个交易日（按可得日）的大宗交易：笔数、成交额、按成交额加权的折溢价
  const days = await wh.all<{ d: string }>(
    `SELECT DISTINCT date::VARCHAR AS d FROM trade_calendar WHERE market = 'A' AND date <= $a::DATE
     ORDER BY d DESC LIMIT 20`,
    { a: asOf },
  );
  const from = days.at(-1)?.d ?? asOf;
  const b = await wh.one<{ n: number; amt: number | null; prem: number | null }>(
    `SELECT count(*) AS n, sum(deal_amount) AS amt,
            sum(premium * deal_amount) / nullif(sum(deal_amount), 0) AS prem
     FROM block_trades WHERE code = $c AND avail_date >= $f::DATE AND avail_date <= $a::DATE`,
    { c: code, f: from, a: asOf },
  );
  const bref = { table: "block_trades", key: { code, from, to: asOf }, src: null, ver: null, batch: null };
  const bbase = { ...base, asOf, availDate: dataDate, ref: bref };
  const n = Number(b?.n ?? 0);
  out.push(
    { ...bbase, key: "blocks.20d.count", label: "近 20 个交易日大宗交易", value: n, unit: "笔" },
    {
      ...bbase,
      key: "blocks.20d.amount",
      label: "近 20 个交易日大宗成交额",
      value: n && b?.amt !== null && b?.amt !== undefined ? b.amt / 1e8 : null,
      unit: "亿",
    },
    {
      ...bbase,
      key: "blocks.20d.premium",
      label: "近 20 个交易日大宗折溢价（按成交额加权）",
      value: n && b?.prem !== null && b?.prem !== undefined ? b.prem * 100 : null,
      unit: "%",
    },
  );

  // 数据集连续 3 晚没更新成功：提示（不进校验值）
  const soft = await softStepStatus(wh, "A");
  for (const id of PIT_DATASET_IDS) {
    const st = soft.find((x) => x.step === id);
    if (st && st.failingNights >= SOFT_FAILING_ALERT) {
      caveats.push({
        id: "event_stale",
        level: "warn",
        title: `「${PIT_DATASETS[id].label}」已经 ${st.failingNights} 晚没更新成功，两融与筹码数据可能是旧的`,
      });
    }
  }
  const calc = soft.find((x) => x.step === "event_factors")?.failingNights ?? 0;
  if (calc >= SOFT_FAILING_ALERT) {
    caveats.push({
      id: "event_stale",
      level: "warn",
      title: `两融与筹码类因子已经 ${calc} 晚没算成功，这几天的因子值为空`,
    });
  }
  return out;
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
      // 只数日线的问题：点时事件数据（S15）的撤下、公告日变动属于事件组（S15b），不改第 1 版证据的值
      `SELECT count(*) FROM data_issues
       WHERE code = $c AND dataset = 'bars' AND coalesce(date, created_at::DATE) <= $a::DATE
         AND resolved_by IS NULL`,
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
 * 复核一份证据（D97）：按同样的代码、决策日、版本、因子集与选项重新生成，比校验值。给了版本就按那一版；
 * 没给（S07 时代存下的旧值）就先按第 1 版、再按当前版本试。matchedVersion = 对上的那一版（没对上为 null）。
 * 带上原来的条目时逐项比出变了哪些（新增、删掉的也算；删掉的给原来那一项；没给版本时和第 1 版比）。
 */
export async function verifyDossier(
  wh: Warehouse,
  code: string,
  asOf: DateStr,
  hash: string,
  o: {
    factorKeys?: readonly string[];
    items?: readonly EvidenceItem[];
    evidenceVersion?: number;
    options?: EvidenceOptions;
  } = {},
): Promise<{ same: boolean; hash: string; matchedVersion: number | null; changed: EvidenceItem[] }> {
  const versions =
    o.evidenceVersion !== undefined ? [o.evidenceVersion] : [...new Set([1, EVIDENCE_VERSION])];
  const tried: SecurityDossier[] = [];
  for (const version of versions) {
    const d = await securityDossier(wh, code, asOf, {
      factorKeys: o.factorKeys,
      version,
      ...(o.options ? { options: o.options } : {}),
    });
    if (d.hash === hash) return { same: true, hash: d.hash, matchedVersion: version, changed: [] };
    tried.push(d);
  }
  // 没对上：带了条目时和最接近的那一版逐项比；没带时给最后试的版本（当前版本）的校验值
  let cur = tried.at(-1)!;
  let changed: EvidenceItem[] = [];
  if (o.items) {
    const diffs = tried.map((d) => ({ d, c: diffItems(o.items!, d.items) }));
    const best = diffs.reduce((a, b) => (b.c.length < a.c.length ? b : a));
    cur = best.d;
    changed = best.c;
  }
  return { same: false, hash: cur.hash, matchedVersion: null, changed };
}

/** 逐项比：变了的与新增的给现在的那一项，删掉的给原来那一项 */
function diffItems(before: readonly EvidenceItem[], now: readonly EvidenceItem[]): EvidenceItem[] {
  const prev = new Map(before.map((it) => [it.key, canonicalJson(it)]));
  const keys = new Set(now.map((it) => it.key));
  const out: EvidenceItem[] = [];
  for (const it of now) if (prev.get(it.key) !== canonicalJson(it)) out.push(it);
  for (const it of before) if (!keys.has(it.key)) out.push(it);
  return out;
}

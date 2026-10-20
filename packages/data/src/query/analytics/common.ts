/**
 * 对话分析工具的公共部分（spec 20261020）：标的解析（个股或指数）、序列读取、已提交截至日与区间起点。
 */
import { PERIOD_INPUTS } from "@ivan/core";
import type { IndexInstrument, Instrument, PeriodInput, PeriodKey, StockInstrument } from "@ivan/core";
import {
  addDays,
  type DateStr,
  isDateStr,
  type Market,
  toCode,
} from "@ivan/core";
import {
  periodStart,
} from "../../compute/price-stats.ts";
import { INDEXES, PROVISIONAL_PAIRS } from "../../etl/reference.ts";
import { sqlCodeList, type Warehouse } from "../../warehouse/db.ts";
import { lastTradingDay } from "../backtest.ts";
import { committedAsOf } from "../versions.ts";

/** 查询参数不对、对象找不到或数据还没有：给调用方中文原因与 4xx */
export class AnalyticsError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

// ── 标的：个股或指数 ──

/** 价格指数 → 全收益孪生（反查 PROVISIONAL_PAIRS） */
const TR_OF: Record<string, string> = Object.fromEntries(
  Object.values(PROVISIONAL_PAIRS)
    .flat()
    .map(([tr, price]) => [price, tr]),
);

/** 指数的中文叫法与常见缩写 → 行情仓代号（价格指数；要全收益用 *_tr 代号） */
const INDEX_ALIASES: Record<string, string> = {
  上证: "sse",
  上证指数: "sse",
  上证综指: "sse",
  沪指: "sse",
  大盘: "sse",
  沪深300: "csi300",
  沪深三百: "csi300",
  中证500: "csi500",
  中证1000: "csi1000",
  创业板: "chinext",
  创业板指: "chinext",
  创业板指数: "chinext",
  中证红利: "csi_div",
  红利指数: "csi_div",
  恒指: "hsi",
  恒生: "hsi",
  恒生指数: "hsi",
  国企指数: "hscei",
  恒生国企: "hscei",
  恒生国企指数: "hscei",
  h股指数: "hscei",
  盈富基金: "hsi_tr",
};

/** 可以直接查的指数（给模型的说明与报错用） */
export const INDEX_CHOICES: ReadonlyArray<{ sym: string; label: string; market: Market }> =
  Object.entries(INDEXES).map(([sym, d]) => ({ sym, label: d.label, market: d.market }));

export function indexInstrument(sym: string): IndexInstrument {
  const d = INDEXES[sym]!;
  const isTotalReturn = Object.values(PROVISIONAL_PAIRS)
    .flat()
    .some(([tr]) => tr === sym);
  return {
    kind: "index",
    sym,
    label: d.label,
    market: d.market,
    trSym: isTotalReturn ? null : (TR_OF[sym] ?? null),
    isTotalReturn,
  };
}

/** 名称、代码或指数叫法 → 唯一的标的；对不上或有多只时 400 并列出候选 */
export async function resolveInstrument(wh: Warehouse, query: string): Promise<Instrument> {
  const q = query.trim();
  if (!q) throw new AnalyticsError(400, "要查哪只股票或哪个指数？");
  const key = q.replace(/\s+/g, "").toLowerCase();
  const alias = INDEX_ALIASES[key] ?? (INDEXES[key] ? key : null);
  if (alias) return indexInstrument(alias);

  type Row = {
    code: string;
    name: string | null;
    market: Market;
    board: string | null;
    industry_l1: string | null;
    industry: string | null;
    list_date: string | null;
    delist_date: string | null;
  };
  const cols = `code, name, market, board, industry_l1, industry,
    list_date::VARCHAR AS list_date, delist_date::VARCHAR AS delist_date`;
  // 纯代码（600519、700、00700.HK）：先按规范化的代码精确找
  if (/^(?:(?:SH|SZ|BJ|HK)?\d{1,6}|\d{1,6}\.(?:SH|SZ|BJ|HK))$/i.test(q)) {
    const candidates = new Set<string>();
    try {
      candidates.add(toCode(q));
    } catch {
      // 不是合法代码，按名称找
    }
    // 4–5 位数字也可能是港股（00700 / 700）；6 位只能是 A 股
    if (/^\d{1,5}$/.test(q)) candidates.add(toCode(q, "HK"));
    const hit = await wh.all<Row>(
      `SELECT ${cols} FROM securities WHERE code IN (${sqlCodeList([...candidates])})`,
    );
    if (hit.length === 1) return stockOf(hit[0]!);
  }
  const hits = await wh.all<Row>(
    `SELECT ${cols} FROM securities WHERE code ILIKE $q OR name ILIKE $q
     ORDER BY delist_date IS NOT NULL, code LIMIT 20`,
    { q: `%${q}%` },
  );
  const exact = hits.filter(
    (h) => h.code === q.toUpperCase() || h.code.split(".")[0] === q || h.name === q,
  );
  if (exact.length === 1) return stockOf(exact[0]!);
  if (hits.length === 1) return stockOf(hits[0]!);
  // 同名的只有一只还在交易：取它（退市的同名老股票排在后面）
  const live = (exact.length ? exact : hits).filter((h) => !h.delist_date);
  if (exact.length > 1 && live.length === 1) return stockOf(live[0]!);
  if (!hits.length) {
    throw new AnalyticsError(
      404,
      `没找到「${q}」。指数可以用：${INDEX_CHOICES.filter((c) => !c.sym.endsWith("_tr"))
        .map((c) => c.label)
        .join("、")}`,
    );
  }
  const list = (exact.length > 1 ? exact : hits)
    .slice(0, 8)
    .map((h) => `${h.name ?? h.code}（${h.code}${h.delist_date ? "，已退市" : ""}）`)
    .join("、");
  throw new AnalyticsError(400, `「${q}」对应多只股票：${list}。请用具体代码再查`);
}

export function stockOf(r: {
  code: string;
  name: string | null;
  market: Market;
  board: string | null;
  industry_l1: string | null;
  industry: string | null;
  list_date: string | null;
  delist_date: string | null;
}): StockInstrument {
  return {
    kind: "stock",
    code: r.code,
    name: r.name ?? r.code,
    market: r.market,
    board: r.board,
    industryL1: r.industry_l1,
    industry: r.industry,
    listDate: r.list_date,
    delistDate: r.delist_date,
  };
}

export function instrumentName(i: Instrument): string {
  return i.kind === "stock" ? i.name : i.label;
}
export function instrumentId(i: Instrument): string {
  return i.kind === "stock" ? i.code : i.sym;
}

// ── 序列 ──

export interface PriceSeries {
  dates: DateStr[];
  /** 不复权收盘（指数是点位） */
  close: number[];
  /** 复权收盘（个股 = 收盘 × 等比复权因子，分红再投入；指数 = 点位） */
  adj: number[];
  /** 成交额（元；指数为空）。腾讯日 K 来源的日子没有成交额，用 收盘 × 成交量 估算 */
  amount: Array<number | null>;
  open: Array<number | null>;
  /** 有临时补齐的全收益点（D24） */
  provisional: boolean;
}

/** 读一条序列（[from, to]，from 为 null 时从头读） */
export async function loadSeries(
  wh: Warehouse,
  inst: Instrument,
  from: DateStr | null,
  to: DateStr,
): Promise<PriceSeries> {
  const a = from ?? "1990-01-01";
  if (inst.kind === "index") return loadIndexSeries(wh, inst.sym, a, to);
  const cols = await wh.columns(
    `SELECT date::VARCHAR AS d, open, close, adj, coalesce(amount, close * volume) AS amt
     FROM bars_daily WHERE code = $c AND date >= $a::DATE AND date <= $b::DATE AND close > 0
     ORDER BY date`,
    { c: inst.code, a, b: to },
  );
  const dates = (cols.d ?? []) as string[];
  const close = (cols.close ?? []) as number[];
  const adjRaw = (cols.adj ?? []) as Array<number | null>;
  // 缺复权因子的日子沿用前值（和回测同口径），开头缺的用第一个有的
  const first = adjRaw.find((x) => x !== null && Number.isFinite(x)) ?? 1;
  let last = first;
  const adj = close.map((c, i) => {
    const f = adjRaw[i];
    if (f !== null && f !== undefined && Number.isFinite(f)) last = f;
    return c * last;
  });
  return {
    dates,
    close,
    adj,
    amount: (cols.amt ?? []) as Array<number | null>,
    open: (cols.open ?? []) as Array<number | null>,
    provisional: false,
  };
}

export async function loadIndexSeries(
  wh: Warehouse,
  sym: string,
  from: DateStr,
  to: DateStr,
): Promise<PriceSeries> {
  const cols = await wh.columns(
    `SELECT date::VARCHAR AS d, close, coalesce(provisional, false) AS p FROM index_bars
     WHERE sym = $s AND date >= $a::DATE AND date <= $b::DATE AND close > 0 ORDER BY date`,
    { s: sym, a: from, b: to },
  );
  const dates = (cols.d ?? []) as string[];
  const close = (cols.close ?? []) as number[];
  return {
    dates,
    close,
    adj: close,
    amount: dates.map(() => null),
    open: dates.map(() => null),
    provisional: ((cols.p ?? []) as boolean[]).some(Boolean),
  };
}

/** 某个市场能读到哪天（D60）；还没有提交过的版本时 400 */
export async function asOfOf(wh: Warehouse, market: Market): Promise<DateStr> {
  const d = await committedAsOf(wh, market);
  if (!d) throw new AnalyticsError(400, `行情仓还没有${market === "HK" ? "港股" : " A 股"}数据`);
  return d;
}

/** 终点：给了就截到已提交的截至日，再落到交易日 */
export async function endOf(wh: Warehouse, market: Market, to?: string | null): Promise<DateStr> {
  const asOf = await asOfOf(wh, market);
  if (to !== undefined && to !== null && to !== "" && !isDateStr(to))
    throw new AnalyticsError(400, "日期格式要是 YYYY-MM-DD");
  const d = to && to < asOf ? to : asOf;
  return lastTradingDay(wh, market, d);
}

/** 区间起点日：显式的 from 优先；since_listing / max = 从头；都没给按 dflt */
export function fromOf(
  end: DateStr,
  q: { period?: PeriodInput | null; from?: string | null },
  dflt: PeriodKey,
): DateStr | null {
  if (q.from) {
    if (!isDateStr(q.from)) throw new AnalyticsError(400, "日期格式要是 YYYY-MM-DD");
    if (q.from >= end) throw new AnalyticsError(400, `起点 ${q.from} 不早于终点 ${end}`);
    return q.from;
  }
  const p = q.period ?? dflt;
  if (p === "since_listing" || p === "max") return null;
  if (!PERIOD_INPUTS.includes(p)) throw new AnalyticsError(400, `不认识的区间「${String(p)}」`);
  return periodStart(end, p);
}

export const dataNote = (market: Market, asOf: DateStr) =>
  `${market === "HK" ? "港股" : "A 股"}数据截至 ${asOf}（已提交的最新数据日）`;

/** 一批股票在 end 当天（或之前 30 天内最近一天）的因子 */
export async function latestFactors(
  wh: Warehouse,
  codes: string[],
  end: DateStr,
  keys: readonly string[],
): Promise<Map<string, { date: DateStr; values: Record<string, number | null> }>> {
  const out = new Map<string, { date: DateStr; values: Record<string, number | null> }>();
  if (!codes.length) return out;
  const rows = await wh.all<Record<string, unknown>>(
    `SELECT code, date::VARCHAR AS date, ${keys.join(", ")} FROM factors_daily
     WHERE code IN (${sqlCodeList(codes)}) AND date <= $e::DATE AND date >= $s::DATE
     QUALIFY row_number() OVER (PARTITION BY code ORDER BY date DESC) = 1`,
    { e: end, s: addDays(end, -30) },
  );
  for (const r of rows) {
    out.set(String(r.code), {
      date: String(r.date),
      values: Object.fromEntries(
        keys.map((k) => [k, typeof r[k] === "number" && Number.isFinite(r[k]) ? (r[k] as number) : null]),
      ),
    });
  }
  return out;
}

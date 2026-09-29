/**
 * 腾讯行情：日 K（不复权 / 后复权）与批量实时报价。
 *
 * 口径（2026-09 探针实测）：
 * - A 股 `fqkline`：param=代码,day,起,止,条数,复权；一次最多 640 条，返回区间内**最后** 640 条。
 *   复权参数：'' = 不复权（键 day），hfq = 后复权（键 hfqday）。
 * - 港股不复权也走 `fqkline`；港股复权必须走 `hkfqkline`，它**忽略起始日**，返回截止日往前的 640 条。
 * - 行字段：日期, 开, 收, 高, 低, 量（A 股单位是手，港股是股）, …
 * - 退市股（如 000418 小天鹅A、600087 长航油运）的历史日 K 仍可取到。
 */
import { addDays, type DateStr, marketOf, tencentSymbol } from "@ivan/core";
import type { Http } from "../http.ts";

export type Fq = "raw" | "hfq";

export interface KBar {
  date: DateStr;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

const KLINE = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";
const HK_FQ_KLINE = "https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get";
const MAX_BARS = 640;
/** 800 个自然日 ≈ 540 个交易日，稳稳低于单次 640 条上限 */
const WINDOW_DAYS = 800;

function parseRows(raw: unknown[]): KBar[] {
  const out: KBar[] = [];
  for (const r of raw) {
    if (!Array.isArray(r)) continue;
    const bar = {
      date: String(r[0]),
      open: Number(r[1]),
      close: Number(r[2]),
      high: Number(r[3]),
      low: Number(r[4]),
      volume: Number(r[5]),
    };
    if (Number.isFinite(bar.close) && bar.close > 0) out.push(bar);
  }
  return out;
}

interface KlineResp {
  code: number;
  msg: string;
  data: Record<string, Record<string, unknown>> | unknown[];
}

async function klineCall(http: Http, url: string, sym: string): Promise<KBar[]> {
  const res = await http.json<KlineResp>(url);
  if (res.code !== 0 || Array.isArray(res.data)) return [];
  const node = res.data[sym];
  if (!node) return [];
  const key = Object.keys(node).find((k) => k.endsWith("day"));
  return key ? parseRows(node[key] as unknown[]) : [];
}

/** 单次请求：区间内最后 ≤640 条（港股复权忽略 from）。 */
export async function klineOnce(
  http: Http,
  code: string,
  fq: Fq,
  from: DateStr,
  to: DateStr,
): Promise<KBar[]> {
  const sym = tencentSymbol(code);
  const hkFq = marketOf(code) === "HK" && fq === "hfq";
  const base = hkFq ? HK_FQ_KLINE : KLINE;
  const param = `${sym},day,${hkFq ? "" : from},${to},${MAX_BARS},${fq === "hfq" ? "hfq" : ""}`;
  const bars = await klineCall(http, `${base}?param=${param}`, sym);
  return bars.filter((b) => b.date >= from && b.date <= to);
}

/** 取整段区间：A 股与港股不复权按窗口向前推进；港股复权从截止日往回翻。 */
export async function klineRange(
  http: Http,
  code: string,
  fq: Fq,
  from: DateStr,
  to: DateStr,
): Promise<KBar[]> {
  const byDate = new Map<DateStr, KBar>();
  if (marketOf(code) === "HK" && fq === "hfq") {
    let end = to;
    for (let guard = 0; guard < 40; guard++) {
      const sym = tencentSymbol(code);
      const bars = await klineCall(
        http,
        `${HK_FQ_KLINE}?param=${sym},day,,${end},${MAX_BARS},hfq`,
        sym,
      );
      if (!bars.length) break;
      for (const b of bars) if (b.date >= from && b.date <= to) byDate.set(b.date, b);
      const first = bars[0]!.date;
      if (first <= from || bars.length < MAX_BARS) break;
      end = addDays(first, -1);
    }
  } else {
    for (let start = from; start <= to; start = addDays(start, WINDOW_DAYS)) {
      const end = addDays(start, WINDOW_DAYS - 1);
      const bars = await klineOnce(http, code, fq, start, end < to ? end : to);
      for (const b of bars) byDate.set(b.date, b);
    }
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** 指数日 K（腾讯原始代码：sh000300 沪深300、sh000001 上证、hkHSI 恒指、hkHSCEI 国企）。 */
export async function indexKline(
  http: Http,
  sym: string,
  from: DateStr,
  to: DateStr,
): Promise<KBar[]> {
  const byDate = new Map<DateStr, KBar>();
  for (let start = from; start <= to; start = addDays(start, WINDOW_DAYS)) {
    const endCand = addDays(start, WINDOW_DAYS - 1);
    const end = endCand < to ? endCand : to;
    const bars = await klineCall(http, `${KLINE}?param=${sym},day,${start},${end},${MAX_BARS},`, sym);
    for (const b of bars) if (b.date >= from && b.date <= to) byDate.set(b.date, b);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

export interface Quote {
  code: string;
  name: string;
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  /** A 股单位：手；港股：股 */
  volume: number;
  /** 成交额，本币元；拿不到为 NaN */
  amount: number;
  /** 行情时间，A 股 `20260928161451`，港股 `2026/09/28 16:08:34` */
  time: string;
}

/** 批量实时报价（一次最多约 60 个代码）。 */
/**
 * 指数实时报价的日期（`sh000001`、`hkHSI`）。夜间增量用它交叉验证「今天是否开市」：
 * 休市日报价停在上一个交易日。
 */
export async function indexQuoteDate(http: Http, sym: string): Promise<DateStr | null> {
  const text = await http.text(`https://qt.gtimg.cn/q=${sym}`, { encoding: "gbk" });
  const t = (text.split("~")[30] ?? "").replace(/\D/g, "").slice(0, 8);
  return t.length === 8 ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : null;
}

/**
 * 成交额（本币元）：A 股第 35 段是「价/手/元」，取第三项（缺了用第 37 段的万元）；港股第 37 段直接是港元。
 * 拿不到返回 NaN，入库为空，算因子时用收盘 × 成交量近似。
 */
function quoteAmount(code: string, f: string[]): number {
  if (marketOf(code) === "HK") return Number(f[37]);
  const a = Number((f[35] ?? "").split("/")[2]);
  return Number.isFinite(a) && a > 0 ? a : Number(f[37]) * 10_000;
}

export async function quotes(http: Http, codes: string[]): Promise<Quote[]> {
  if (!codes.length) return [];
  const syms = codes.map(tencentSymbol);
  const text = await http.text(`https://qt.gtimg.cn/q=${syms.join(",")}`, { encoding: "gbk" });
  const out: Quote[] = [];
  for (const line of text.split(";")) {
    const m = line.match(/v_(\w+)="([^"]*)"/);
    if (!m) continue;
    const f = m[2]!.split("~");
    if (f.length < 35) continue;
    const idx = syms.indexOf(m[1]!);
    if (idx < 0) continue;
    out.push({
      code: codes[idx]!,
      name: f[1] ?? "",
      price: Number(f[3]),
      prevClose: Number(f[4]),
      open: Number(f[5]),
      high: Number(f[33]),
      low: Number(f[34]),
      volume: Number(f[6]),
      amount: quoteAmount(codes[idx]!, f),
      time: f[30] ?? "",
    });
  }
  return out;
}

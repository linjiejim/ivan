/**
 * 证券代码约定：全系统统一用「代码.交易所」形式（600519.SH / 000001.SZ / 830799.BJ / 00700.HK），
 * 避免 000001 既是平安银行又是上证指数这类歧义。
 */
export type Market = "A" | "HK";
export type Exchange = "SH" | "SZ" | "BJ" | "HK";
/** 板块：A 股主板/创业板/科创板/北交所；港股主板/创业板。 */
export type Board = "main" | "gem" | "star" | "bse" | "hk_main" | "hk_gem";

export const MARKETS: Market[] = ["A", "HK"];

export interface ParsedCode {
  symbol: string;
  exchange: Exchange;
  market: Market;
}

/** 规范化：接受 600519 / sh600519 / 600519.SH / 700 / 00700.HK / hk00700。 */
export function toCode(input: string, hint?: Market): string {
  let s = input.trim().toUpperCase();
  const suffix = s.match(/\.(SH|SZ|BJ|HK)$/);
  if (suffix) {
    const sym = s.slice(0, -3);
    return suffix[1] === "HK" ? `${sym.padStart(5, "0")}.HK` : `${sym}.${suffix[1]}`;
  }
  const prefix = s.match(/^(SH|SZ|BJ|HK)(\d+)$/);
  if (prefix) {
    const [, ex, sym] = prefix;
    return ex === "HK" ? `${sym!.padStart(5, "0")}.HK` : `${sym}.${ex}`;
  }
  s = s.replace(/\D/g, "");
  if (hint === "HK" || (s.length <= 5 && hint !== "A")) return `${s.padStart(5, "0")}.HK`;
  return `${s}.${exchangeOfASymbol(s)}`;
}

export function exchangeOfASymbol(sym: string): Exclude<Exchange, "HK"> {
  if (/^(92|4|8)/.test(sym)) return "BJ";
  if (/^(6|9)/.test(sym)) return "SH";
  return "SZ";
}

export function parseCode(code: string): ParsedCode {
  const m = code.match(/^(\d+)\.(SH|SZ|BJ|HK)$/);
  if (!m) throw new Error(`非法证券代码：${code}`);
  const exchange = m[2] as Exchange;
  return { symbol: m[1]!, exchange, market: exchange === "HK" ? "HK" : "A" };
}

export function marketOf(code: string): Market {
  return code.endsWith(".HK") ? "HK" : "A";
}

/** A 股板块按代码段判定；港股创业板代码 08xxx。 */
export function boardOf(code: string): Board {
  const { symbol, exchange } = parseCode(code);
  if (exchange === "HK") return symbol.startsWith("08") ? "hk_gem" : "hk_main";
  if (exchange === "BJ") return "bse";
  if (symbol.startsWith("688") || symbol.startsWith("689")) return "star";
  if (symbol.startsWith("300") || symbol.startsWith("301") || symbol.startsWith("302"))
    return "gem";
  return "main";
}

/** A 股普通股代码段（排除 B 股 200/900、存托凭证等）。 */
export function isAShareSymbol(sym: string): boolean {
  return /^(60[0-5]\d{3}|688\d{3}|689\d{3}|00[0-3]\d{3}|30[0-2]\d{3}|920\d{3}|8[3-7]\d{4}|43\d{4})$/.test(
    sym,
  );
}

/** 腾讯行情代码：sh600519 / sz000001 / bj830799 / hk00700。 */
export function tencentSymbol(code: string): string {
  const { symbol, exchange } = parseCode(code);
  return `${exchange.toLowerCase()}${symbol}`;
}

export const BOARD_LABEL: Record<Board, string> = {
  main: "主板",
  gem: "创业板",
  star: "科创板",
  bse: "北交所",
  hk_main: "港股主板",
  hk_gem: "港股创业板",
};

export const MARKET_LABEL: Record<Market, string> = { A: "A 股", HK: "港股" };

/**
 * 收盘价定稿的北京时间：A 股 15:00 收盘、港股 16:10 收市竞价结束，各留出数据源发布的余量。
 * 这之前抓日线会把盘中价当成收盘价写进库（夜间增量随后会跳过已有当天 K 线的股票，错价就留下了）。
 */
export const CLOSE_FINAL_HM: Record<Market, string> = { A: "15:30", HK: "16:30" };

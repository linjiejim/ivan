/**
 * 东财历史日 K（push2his.eastmoney.com）：一次请求返回整段历史，含成交额。
 * 口径（2026-09 实测）：fqt=0 不复权、fqt=2 后复权；后复权同腾讯一样是「a × 不复权价 + b」的仿射形式，
 * 价格精度 A 股 2 位小数、港股 3 位。本机与 jim-server 均可达（注意不是 push2.eastmoney.com）。
 */
import { type DateStr, parseCode } from "@ivan/core";
import type { HttpLike } from "../http.ts";
import type { Fq, KBar } from "./tencent.ts";

const URL_BASE = "https://push2his.eastmoney.com/api/qt/stock/kline/get";

export function emSecid(code: string): string {
  const { symbol, exchange } = parseCode(code);
  if (exchange === "HK") return `116.${symbol}`;
  return `${exchange === "SH" ? 1 : 0}.${symbol}`;
}

interface EmKlineResp {
  rc: number;
  data: { code: string; decimal: number; klines: string[] } | null;
}

export interface EmKBar extends KBar {
  /** 成交额（本币） */
  amount: number;
  /** 涨跌额：收盘 − 参考前收（A 股除权除息日的参考前收是交易所公布的除权参考价） */
  chg: number;
}

export async function emKline(
  http: HttpLike,
  code: string,
  fq: Fq,
  from: DateStr,
  to: DateStr,
): Promise<{ bars: EmKBar[]; decimals: number }> {
  const params = new URLSearchParams({
    secid: emSecid(code),
    fields1: "f1,f2,f3",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60",
    klt: "101",
    fqt: fq === "hfq" ? "2" : "0",
    beg: from.replaceAll("-", ""),
    end: to.replaceAll("-", ""),
    lmt: "100000",
  });
  const res = await http.json<EmKlineResp>(`${URL_BASE}?${params}`);
  if (!res.data) return { bars: [], decimals: 2 };
  const bars: EmKBar[] = [];
  for (const line of res.data.klines ?? []) {
    // 日期,开,收,高,低,成交量,成交额,振幅,涨跌幅,涨跌额
    const f = line.split(",");
    const bar = {
      date: f[0]!,
      open: Number(f[1]),
      close: Number(f[2]),
      high: Number(f[3]),
      low: Number(f[4]),
      volume: Number(f[5]),
      amount: Number(f[6]),
      chg: Number(f[9]),
    };
    if (bar.close > 0 && bar.date >= from && bar.date <= to) bars.push(bar);
  }
  return { bars, decimals: res.data.decimal ?? 2 };
}

/** 指数日 K（收盘价）。secid 如 1.000300 沪深300、1.000001 上证、100.HSI 恒指、100.HSCEI 国企。 */
export async function emIndexKline(
  http: HttpLike,
  secid: string,
  from: DateStr,
  to: DateStr,
): Promise<Array<{ date: DateStr; close: number }>> {
  const params = new URLSearchParams({
    secid,
    fields1: "f1,f2,f3",
    fields2: "f51,f52,f53",
    klt: "101",
    fqt: "0",
    beg: from.replaceAll("-", ""),
    end: to.replaceAll("-", ""),
    lmt: "100000",
  });
  const res = await http.json<EmKlineResp>(`${URL_BASE}?${params}`);
  const out: Array<{ date: DateStr; close: number }> = [];
  for (const line of res.data?.klines ?? []) {
    const f = line.split(",");
    const close = Number(f[2]);
    if (close > 0 && f[0]! >= from && f[0]! <= to) out.push({ date: f[0]!, close });
  }
  return out;
}


/**
 * 夜间增量的离线夹具（测试专用）：东财日 K 假路由（按请求的 secid 与起止日现算工作日的行）。
 * 和 seedSyntheticMarket 一起用，就能对合成市场连跑几晚 daily()。
 */
import { addDays, type DateStr, weekday } from "@ivan/core";
import type { FakeRoute } from "./fake-http.ts";

const iso = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` as DateStr;

/** A 股合成市场默认要的三个指数（沪深300、上证、创业板指） */
export const A_INDEX_SECIDS: Record<string, number> = {
  "1.000300": 4000,
  "1.000001": 3000,
  "0.399006": 2000,
};

/**
 * 东财 push2his 日 K：base 是 secid → 收盘价（不变）；没列的 secid 回空（来源说没有）。
 * skip(secid, date) 为真的那天不给这行（模拟某只股票缺今天）。
 */
export function emDailyRoute(
  base: Record<string, number>,
  skip: (secid: string, date: DateStr) => boolean = () => false,
): FakeRoute {
  return {
    match: /push2his\.eastmoney\.com/,
    reply: ({ url }) => {
      const q = new URL(url).searchParams;
      const secid = q.get("secid")!;
      const close = base[secid];
      if (close === undefined) return { rc: 0, data: null };
      const end = iso(q.get("end")!);
      const lines: string[] = [];
      for (let d = iso(q.get("beg")!); d <= end; d = addDays(d, 1)) {
        if (weekday(d) === 0 || weekday(d) === 6 || skip(secid, d)) continue;
        lines.push(`${d},${close},${close},${close},${close},1000,${close * 100_000},0,0,0`);
      }
      return { rc: 0, data: { code: secid.slice(2), decimal: 2, klines: lines } };
    },
  };
}

/** 东财个股 secid：600000.SH → 1.600000，000001.SZ → 0.000001 */
export function emSecidOf(code: string): string {
  const [sym, ex] = code.split(".");
  return `${ex === "SH" ? 1 : 0}.${sym}`;
}

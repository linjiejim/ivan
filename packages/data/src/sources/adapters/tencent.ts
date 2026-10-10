/**
 * 腾讯适配器（封禁风险 2：fqkline 有 WAF，突发请求会被封 IP 约半小时）：包装 tencent.ts 的现有函数，行为不变。
 * - 日线：不复权 + 后复权（3 位小数）→ raw+hfq_affine；没有成交额，成交量单位按板块推断（D51）
 * - 批量实时报价：夜间增量的主路径（一次约 60 只，域名 qt.gtimg.cn）
 * - 指数：价格指数日 K（腾讯原始代码 sh000300、hkHSI）
 */
import { marketOf } from "@ivan/core";
import { indexKline, klineRange, quotes } from "../tencent.ts";
import type { SourceAdapter } from "../types.ts";

const KLINE_HOST = "web.ifzq.gtimg.cn";
const QUOTE_HOST = "qt.gtimg.cn";

export const tencentAdapter: SourceAdapter = {
  id: "tencent",
  label: "腾讯",
  hosts: { bars: [KLINE_HOST], index: [KLINE_HOST], quotes: [QUOTE_HOST] },
  banRisk: 2,
  capabilities: { bars: ["A", "HK"], quotes: ["A", "HK"], index: ["A", "HK"] },
  async dailyBars(ctx, code, from, to) {
    const raw = await klineRange(ctx.http, code, "raw", from, to);
    const hfq = raw.length ? await klineRange(ctx.http, code, "hfq", from, to) : [];
    return {
      bars: raw.map((b) => ({ ...b, amount: null })),
      caliber: "raw+hfq_affine",
      hfq,
      decimals: 3,
      volumeUnit: "infer",
      currency: marketOf(code) === "HK" ? "HKD" : "CNY",
    };
  },
  quotes(ctx, codes) {
    return quotes(ctx.http, codes);
  },
  async indexBars(ctx, sym, from, to) {
    const bars = await indexKline(ctx.http, sym, from, to);
    return bars.map((b) => ({ date: b.date, close: b.close }));
  },
};

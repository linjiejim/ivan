/**
 * 东财适配器（封禁风险 1）：包装 emkline.ts 的现有函数，行为不变。
 * - A 股日线：一次请求不复权日 K，涨跌额给出交易所参考前收（D31）→ raw+ref_prev_close
 * - 港股日线：不复权 + 后复权两次请求 → raw+hfq_affine（东财港股后复权 3 位小数）
 * - 指数：价格指数日 K（secid 如 1.000300、100.HSI）
 * push2his 串行、0.6 秒间隔（D31），是默认链的第一家。
 */
import { marketOf } from "@ivan/core";
import { emIndexKline, emKline } from "../emkline.ts";
import type { SourceAdapter } from "../types.ts";

const HOST = "push2his.eastmoney.com";

export const eastmoneyAdapter: SourceAdapter = {
  id: "eastmoney",
  label: "东财",
  hosts: { bars: [HOST], index: [HOST] },
  banRisk: 1,
  capabilities: { bars: ["A", "HK"], index: ["A", "HK"] },
  async dailyBars(ctx, code, from, to) {
    const raw = await emKline(ctx.http, code, "raw", from, to);
    if (marketOf(code) === "A") {
      return { bars: raw.bars, caliber: "raw+ref_prev_close", volumeUnit: "infer", currency: "CNY" };
    }
    // 不复权是空的就不再要后复权（少一次请求）
    const hfq = raw.bars.length ? await emKline(ctx.http, code, "hfq", from, to) : { bars: [], decimals: 3 };
    return {
      bars: raw.bars,
      caliber: "raw+hfq_affine",
      hfq: hfq.bars,
      decimals: hfq.decimals,
      volumeUnit: "shares",
      currency: "HKD",
    };
  },
  indexBars(ctx, sym, from, to) {
    return emIndexKline(ctx.http, sym, from, to);
  },
};

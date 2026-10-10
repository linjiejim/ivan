/**
 * 数据源接口（D9 的实现，D72）：本轮只开日线、实时报价、指数三种能力，只为本轮真的会用的东西开口子。
 * token、显式专用来源、本地导入这些成员不在这里，接 Tushare / 本地导入时再加。
 *
 * 价格口径 PriceCaliber 没有「前复权」：前复权的历史价每次除权都会变，换不回「不复权 + 等比因子」，
 * 所以根本声明不了；其余口径由 compute/normalize.ts 统一换成 Ivan 的口径，换不成的在接口处拒收。
 */
import type { DateStr, Market } from "@ivan/core";
import type { HttpLike } from "../http.ts";
import type { KBar, Quote } from "./tencent.ts";

export type SourceId = "eastmoney" | "tencent" | "csindex";
export type Capability = "bars" | "quotes" | "index";

/**
 * 来源给出的价格口径：
 * - raw+ref_prev_close：不复权 + 每天的参考前收（东财 A 股的涨跌额，D31）
 * - raw+hfq_affine：不复权 + 后复权（后复权 = a × 不复权 + b，加法复权是 a = 1 的特例）
 * - raw+adj_factor：不复权 + 复权因子序列
 * - total_return / price_index：总收益序列、价格指数，只能当基准用，不能当个股日线
 */
export type PriceCaliber =
  | "raw+ref_prev_close"
  | "raw+hfq_affine"
  | "raw+adj_factor"
  | "total_return"
  | "price_index";

export interface SourceCtx {
  http: HttpLike;
  today: DateStr;
  log: (msg: string) => void;
}

/** 来源给的一根不复权日线：成交额拿不到为 null；chg = 收盘 − 参考前收（只有 raw+ref_prev_close 有） */
export type SourceBar = KBar & { amount: number | null; chg?: number };

export interface SourceBars {
  bars: SourceBar[];
  caliber: PriceCaliber;
  /** raw+hfq_affine：后复权日线 */
  hfq?: KBar[];
  /** 后复权价的小数位数（决定舍入容差） */
  decimals?: number;
  /** raw+adj_factor：与 bars 一一对应的复权因子 */
  adjFactor?: number[];
  /** 成交量单位：infer = 按成交额判断、判断不了按板块（D51） */
  volumeUnit: "shares" | "lots" | "infer";
  currency: "CNY" | "HKD";
}

export interface IndexBar {
  date: DateStr;
  close: number;
}

export interface SourceAdapter {
  id: SourceId;
  /** 中文名（管理页、日志） */
  label: string;
  /** 各能力请求的域名：这些域名全被封时整条链跳过这家 */
  hosts: Partial<Record<Capability, readonly string[]>>;
  /** 封禁风险 1–3：越高越容易触发风控，默认链排在越后面 */
  banRisk: 1 | 2 | 3;
  /** 各能力支持的市场 */
  capabilities: Partial<Record<Capability, readonly Market[]>>;
  dailyBars?(ctx: SourceCtx, code: string, from: DateStr, to: DateStr): Promise<SourceBars>;
  quotes?(ctx: SourceCtx, codes: string[]): Promise<Quote[]>;
  /** sym 是这家来源自己的指数代码（东财 secid、腾讯原始代码、中证指数代码） */
  indexBars?(ctx: SourceCtx, sym: string, from: DateStr, to: DateStr): Promise<IndexBar[]>;
}

/** 行级来源代码（bars_daily / index_bars / corp_actions 的 src 列）：em 东财、tx 腾讯日 K、txq 腾讯报价、csi 中证 */
export type SrcCode = "em" | "tx" | "txq" | "csi";

export function srcCode(id: SourceId, cap: Capability): SrcCode {
  if (id === "eastmoney") return "em";
  if (id === "csindex") return "csi";
  return cap === "quotes" ? "txq" : "tx";
}

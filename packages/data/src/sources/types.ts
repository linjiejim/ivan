/**
 * 数据源接口（D9 的实现，D72）：日线、实时报价、指数三种能力，S15 加点时事件数据（events，D81）。
 * token 成员见 S16；本地导入仍在三期。
 *
 * 价格口径 PriceCaliber 没有「前复权」：前复权的历史价每次除权都会变，换不回「不复权 + 等比因子」，
 * 所以根本声明不了；其余口径由 compute/normalize.ts 统一换成 Ivan 的口径，换不成的在接口处拒收。
 */
import type { CanaryStatus, DateStr, Market, PitDatasetId } from "@ivan/core";
import type { HttpLike } from "../http.ts";
import type { KBar, Quote } from "./tencent.ts";

export type SourceId = "eastmoney" | "tencent" | "csindex";
export type Capability = "bars" | "quotes" | "index" | "events";

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

/** 点时事件数据的一块（回填与夜间窗口都按块取、按块写）：id 是 etl_progress 的键 */
export interface PitChunk {
  id: string;
  from: DateStr;
  to: DateStr;
}

export interface PitFetchResult<R> {
  /** 规范化后的行（单位已统一） */
  rows: R[];
  /** 来源给的原始行数（含 ETF、基金这些后来丢掉的） */
  rawCount: number;
  requests: number;
  /** 两融到齐检查用：原始行按交易所计数（含 ETF） */
  byExchange?: { sh: number; sz: number };
}

/** 金丝雀的结果（D82）：detail 不含 URL 与查询串 */
export interface CanaryResult {
  status: CanaryStatus;
  source: SourceId;
  at: string;
  detail: string;
}

/**
 * 一个点时事件数据集在某家来源上的实现（D81）：运行器只认这两个方法与规范化的行，
 * 不认来源的报表名、列名与过滤串。
 */
export interface PitFetcher<R> {
  fetchChunk(sctx: SourceCtx, chunk: PitChunk): Promise<PitFetchResult<R>>;
  canary(sctx: SourceCtx, today: DateStr, prevTd: DateStr): Promise<CanaryResult>;
  /** 回填估算：这个区间里大约多少行（一次计数请求）；不实现就不估 */
  estimateRows?(sctx: SourceCtx, from: DateStr, to: DateStr): Promise<number>;
}

/**
 * 来源报告「结构变了」（字段不存在、请求过的键缺失）：这个数据集这次不删不写（D82）。各家来源的错误类带
 * `schemaDrift = true`，运行器只认这个标记，不认具体来源的错误类。
 */
export function isSchemaDrift(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { schemaDrift?: unknown }).schemaDrift === true;
}

/** 来源报告「翻页对不上」（行数不符、重复行）：这一块失败，之后重跑 */
export function isPageDrift(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { pageDrift?: unknown }).pageDrift === true;
}

/** 两融明细一行（金额元、融券余量股；rzyezb 是来源原样的 %） */
export interface MarginRow {
  code: string;
  date: DateStr;
  rzye: number | null;
  rzmre: number | null;
  rzche: number | null;
  rqye: number | null;
  rqyl: number | null;
  floatMcap: number | null;
  rzyezb: number | null;
}

/** 股东户数一行：endDate 截至日，noticeDate 公告日 */
export interface HolderRow {
  code: string;
  endDate: DateStr;
  noticeDate: DateStr;
  holderNum: number;
  preHolderNum: number | null;
  preEndDate: DateStr | null;
}

/** 限售解禁一行：股数为股，比例为小数 */
export interface LockupRow {
  code: string;
  freeDate: DateStr;
  type: string;
  unlockShares: number | null;
  ableShares: number | null;
  /** 解禁后的流通股 */
  floatAfter: number | null;
  /** 解禁股数 ÷ 解禁前的流通股（floatAfter − unlockShares），不管解禁日过没过都是这一个口径 */
  ratioFloat: number | null;
  ratioTotal: number | null;
}

/** 大宗交易一笔：premium 是相对当日收盘的小数，金额元、数量股 */
export interface BlockRow {
  code: string;
  tradeDate: DateStr;
  dealPrice: number | null;
  closePrice: number | null;
  premium: number | null;
  dealVolume: number | null;
  dealAmount: number | null;
  buyerInst: boolean;
  sellerInst: boolean;
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
  /** 点时事件数据集（S15，只有 A 股） */
  events?: Partial<Record<PitDatasetId, PitFetcher<unknown>>>;
}

/** 行级来源代码（bars_daily / index_bars / corp_actions 的 src 列）：em 东财、tx 腾讯日 K、txq 腾讯报价、csi 中证 */
export type SrcCode = "em" | "tx" | "txq" | "csi";

export function srcCode(id: SourceId, cap: Capability): SrcCode {
  if (id === "eastmoney") return "em";
  if (id === "csindex") return "csi";
  return cap === "quotes" ? "txq" : "tx";
}

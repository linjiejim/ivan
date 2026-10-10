/**
 * 完整性闸门（D73，修正 D36）：日线更新之后、财报与因子计算之前判断今晚拿全了没有。拿不全就别往下算——
 * 缺数据会被引擎当成停牌，悄悄改变成交与跟踪重放。
 *
 * - 缺失（整条链都没拿到、被体检拒收、口径换算失败，或报价漏掉又补不上的 quote_omitted）超过
 *   A 股 max(3, ⌈0.2% × 应更新数⌉)、港股 max(5, ⌈0.3% × 应更新数⌉) → 失败；
 * - 无成交数 > max(2 × 近 20 个版本的中位数, 中位数 + 30) → 失败（防止报价没更新）；历史不足 5 个版本时不判；
 * - 缺失的股票是运行中跟踪的持仓或明日计划（critical）→ 不让整晚失败，记进 missingCritical，相关跟踪显示「数据未更新」；
 * - ETL_ACCEPT_MISSING 放行的代码不计数，记进 accepted。
 */
import {
  type CanaryStatus,
  type DateStr,
  MARKET_LABEL,
  type Market,
  type PitDatasetId,
  type SoftStep,
  toCode,
} from "@ivan/core";

export { SOFT_STEP_LABEL, type SoftStep } from "@ivan/core";

/** 可以自动重跑的 ETL 失败（45 分钟后再排一次，最多 2 次） */
export class RetryableEtlError extends Error {
  readonly retryable = true;
}

/** 完整性闸门没过：版本已提交成 incomplete */
export class IncompleteDataError extends RetryableEtlError {}

/** 缺失原因：整条链失败 / 报价漏掉又补不上 / 被体检拒收（rejected:<规则>，口径换算失败是 rejected:caliber） */
export type MissingReason = "chain_failed" | "quote_omitted" | `rejected:${string}`;

export interface SoftOutcome {
  step: SoftStep;
  ok: boolean;
  /** 写了多少行（步骤函数给得出时） */
  rows?: number;
  error?: string;
}

/** 一个点时事件数据集这一晚（或这次周检）的结果（S15） */
export interface DatasetCompleteness {
  ok: boolean;
  /** 金丝雀的结果；没跑到为 null */
  canary: CanaryStatus | null;
  rows: number;
  requests: number;
  /** 写入了但没到齐的块（两融的日子） */
  partial: string[];
  /** 周检补扫新找到的行数 */
  lateRows?: number;
}

export interface CompletenessInput {
  market: Market;
  /** 今天应该有日线的股票数 */
  expected: number;
  /** 今天有了日线的股票数 */
  updated: number;
  /** 今天没成交（停牌）的股票数 */
  noTrade: number;
  missing: Array<{ code: string; reason: MissingReason }>;
  /** 运行中跟踪的持仓与明日计划里的代码 */
  critical: Set<string>;
  /** ETL_ACCEPT_MISSING 放行的代码 */
  accepted: Set<string>;
  /** 近 20 个版本（ok / incomplete）的无成交数 */
  noTradeHistory: number[];
}

export interface Completeness {
  expected: number;
  updated: number;
  noTrade: number;
  /** 缺失的代码（最多 200 个） */
  missing: string[];
  missingReasons: Record<string, number>;
  /** 缺失里属于运行中跟踪的持仓或明日计划的（不让整晚失败） */
  missingCritical: string[];
  /** 缺失里被 ETL_ACCEPT_MISSING 放行的 */
  accepted: string[];
  ok: boolean;
  reasons: string[];
  /** 这一晚（夜间增量写进数据版本时补上） */
  date?: DateStr;
  /** 辅助步骤的结果（失败沿用旧数据） */
  soft?: SoftOutcome[];
  /** 点时事件数据集（S15，只有 A 股；周检的版本也写，带 lateRows） */
  datasets?: Partial<Record<PitDatasetId, DatasetCompleteness>>;
}

/** 闸门阈值：缺失超过这个数就让整晚失败 */
export function missingThreshold(market: Market, expected: number): number {
  return market === "A"
    ? Math.max(3, Math.ceil(0.002 * expected))
    : Math.max(5, Math.ceil(0.003 * expected));
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** 纯函数：今晚的日线拿全了没有 */
export function assessCompleteness(i: CompletenessInput): Completeness {
  const reasons: string[] = [];
  const missingCritical: string[] = [];
  const accepted: string[] = [];
  const missingReasons: Record<string, number> = {};
  let counted = 0;
  for (const m of i.missing) {
    missingReasons[m.reason] = (missingReasons[m.reason] ?? 0) + 1;
    if (i.accepted.has(m.code)) accepted.push(m.code);
    else if (i.critical.has(m.code)) missingCritical.push(m.code);
    else counted++;
  }
  const label = MARKET_LABEL[i.market];
  if (counted > missingThreshold(i.market, i.expected)) {
    reasons.push(`${label}有 ${counted} 只股票今天的日线没拿到，已停止更新，以免被当成停牌`);
  }
  if (i.noTradeHistory.length >= 5) {
    const m = median(i.noTradeHistory);
    if (i.noTrade > Math.max(2 * m, m + 30)) {
      reasons.push(
        `今天没成交的股票有 ${i.noTrade} 只，远多于平时（约 ${Math.round(m)} 只），报价可能没更新`,
      );
    }
  }
  return {
    expected: i.expected,
    updated: i.updated,
    noTrade: i.noTrade,
    missing: i.missing.slice(0, 200).map((m) => m.code),
    missingReasons,
    missingCritical,
    accepted,
    ok: reasons.length === 0,
    reasons,
  };
}

/** 应急开关 ETL_ACCEPT_MISSING=代码1,代码2（逗号分隔；写错的代码忽略） */
export function acceptMissingFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = [];
  for (const raw of (env.ETL_ACCEPT_MISSING ?? "").split(",")) {
    if (!/^\d{5,6}(\.(SH|SZ|BJ|HK))?$/i.test(raw.trim())) continue;
    try {
      out.push(toCode(raw));
    } catch {
      // 写错的代码不放行任何东西
    }
  }
  return out;
}

/** 辅助步骤近况（管理页横幅、stale_fundamentals 提示）：最近成功的日子与连续失败的晚数 */
export interface SoftStepStatus {
  step: SoftStep;
  lastOkDate: DateStr | null;
  failingNights: number;
  /** 这一串连续失败的第一晚（没在失败时为 null） */
  firstFailDate: DateStr | null;
}

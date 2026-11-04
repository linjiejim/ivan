/**
 * 完整性闸门（D73，修正 D36）：日线更新之后、财报与因子计算之前判断今晚拿全了没有。拿不全就别往下算——
 * 缺数据会被引擎当成停牌，悄悄改变成交与跟踪重放。
 *
 * - 缺失（整条链都没拿到、被风控又没等到解封的 rate_limited、被体检拒收、口径换算失败，或报价漏掉又补不上的 quote_omitted）超过
 *   A 股 max(3, ⌈0.2% × 应更新数⌉)、港股 max(5, ⌈0.3% × 应更新数⌉) → 失败；
 * - 无成交数 > max(2 × 近 20 个版本的中位数, 中位数 + 30) → 失败（防止报价没更新）；历史不足 5 个版本时不判；
 * - 缺失的股票是运行中跟踪的持仓或明日计划（critical）→ 不让整晚失败，记进 missingCritical，相关跟踪显示「数据未更新」；
 * - ETL_ACCEPT_MISSING 放行的代码不计数，记进 accepted。
 *
 * 补数据（D111）：缺失的股票里有些不只缺今天、之前的日子也还没补上（behind，日线停在昨天之前）。缺得多时整晚不通过，
 * 但「数据齐全到哪一天」可以往前推：catchUpAsOf 找最晚的一天 D，使日线没齐到 D 的股票不超过阈值，夜间增量把截至日提交到 D，
 * 剩下的接着补（逐股补按最早停住的先补），一晚晚收敛，不再整市场停在第一天。
 * 无成交的基准（noTradeHistory）只取缺失没超阈值的晚上：缺得多的晚上不活跃的股票大多记成了缺失、无成交数偏低，
 * 拿它们当「平时」会把补齐那晚的正常无成交数误判成报价没更新（2026-11-03 港股 451 > 448）。
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

/**
 * 缺失原因：整条链失败 / 报价漏掉又补不上 / 整条链被风控、没等到解封（rate_limited，D108）/
 * 被体检拒收（rejected:<规则>，口径换算失败是 rejected:caliber）
 */
export type MissingReason =
  | "chain_failed"
  | "quote_omitted"
  | "rate_limited"
  /** 报价说今天有成交，逐股日 K 里却还没有今天（来源还没更新，D111）：是缺，不是停牌 */
  | "kline_behind"
  | `rejected:${string}`;

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
  /**
   * 缺失的股票里日线停在昨天之前的（之前的日子也没补上，D111）：代码 → 日线齐全到哪一天（含记着没成交的日子；
   * 从没有过日线为 null）。只缺今天的不在里面。
   */
  behind?: ReadonlyMap<string, DateStr | null>;
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
  /** 缺失数超过阈值（D111：只因为这个没通过时可以把截至日提交到之前齐全的那天） */
  missingFailed?: boolean;
  /** 无成交数远多于平时 */
  noTradeFailed?: boolean;
  /** 计入阈值的缺失里，之前的日子也没补上的只数（D111，管理页与横幅说「补数据中」） */
  behind?: number;
  /** 这一晚把截至日提交到了之前齐全的那天（D111） */
  catchUp?: CatchUp;
  /** 这一晚（夜间增量写进数据版本时补上） */
  date?: DateStr;
  /** 辅助步骤的结果（失败沿用旧数据） */
  soft?: SoftOutcome[];
  /** 点时事件数据集（S15，只有 A 股；周检的版本也写，带 lateRows） */
  datasets?: Partial<Record<PitDatasetId, DatasetCompleteness>>;
}

/**
 * 补数据进度（D111）：since 是开始补之前最后一次提交到的那天；asOf 是这一晚提交到的那天；
 * done / total 是 (since, asOf] 与 (since, latest] 里的交易日数（「第 done/total 天」）；behind 是还没补齐的只数。
 */
export interface CatchUp {
  since: DateStr | null;
  asOf: DateStr;
  latest: DateStr;
  done: number;
  total: number;
  behind: number;
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
  const isCounted = (code: string) => !i.accepted.has(code) && !i.critical.has(code);
  const behind = i.behind ? [...i.behind.keys()].filter(isCounted).length : 0;
  const missingFailed = counted > missingThreshold(i.market, i.expected);
  if (missingFailed) {
    const limited = i.missing.filter((m) => m.reason === "rate_limited" && isCounted(m.code)).length;
    const notes = [
      behind ? `其中 ${behind} 只之前的日子也还没补上` : "",
      limited ? `${behind ? "" : "其中 "}${limited} 只是数据源风控、没等到解封` : "",
    ].filter(Boolean);
    reasons.push(
      `${label}有 ${counted} 只股票今天的日线没拿到` +
        (notes.length ? `（${notes.join("，")}）` : "") +
        `，已停止更新，以免被当成停牌`,
    );
  }
  let noTradeFailed = false;
  if (i.noTradeHistory.length >= 5) {
    const m = median(i.noTradeHistory);
    if (i.noTrade > Math.max(2 * m, m + 30)) {
      noTradeFailed = true;
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
    ...(missingFailed ? { missingFailed } : {}),
    ...(noTradeFailed ? { noTradeFailed } : {}),
    ...(behind ? { behind } : {}),
  };
}

/**
 * 一晚记下的无成交数能不能当「平时」（D111）：缺失（计入阈值的）没超过阈值的晚上才算。缺得多的晚上，
 * 不活跃的股票大多记成了缺失（它们最容易落到逐股补、最容易被风控挡住），无成交数偏低。
 */
export function reliableNoTrade(market: Market, c: Partial<Completeness>): number | null {
  if (typeof c.noTrade !== "number") return null;
  // 早于 D73 记录缺失数的旧行：没法判断，照旧用
  if (typeof c.expected !== "number") return c.noTrade;
  const missing =
    Object.values(c.missingReasons ?? {}).reduce((a, b) => a + b, 0) || (c.missing?.length ?? 0);
  const counted = missing - (c.missingCritical?.length ?? 0) - (c.accepted?.length ?? 0);
  return counted > missingThreshold(market, c.expected) ? null : c.noTrade;
}

/**
 * 补数据时这一晚能把截至日提交到哪天（D111，纯函数）：calendar 是到 latest 为止的交易日（升序）。
 * 找最晚的一天 D（早于 latest、晚于 committed），使日线没齐到 D 的股票（计入阈值的）不超过阈值；
 * 只缺今天的股票齐到了昨天，不挡 D。没有这样的一天（或缺失本来就没超阈值）返回 null。
 */
export function catchUpAsOf(i: {
  market: Market;
  expected: number;
  missing: ReadonlyArray<{ code: string }>;
  /** 缺失的股票里之前的日子也没补上的：代码 → 齐全到哪天（null = 从没有过日线） */
  behind: ReadonlyMap<string, DateStr | null>;
  /**
   * 今天算没成交、但之前有日子没能确认的（逐股日 K 最后一根之后没有报价佐证）：代码 → 齐全到哪天。
   * 不计入今天的缺失（和以前一样），但截至日不能越过它们齐到的那天（D111）
   */
  unverified?: ReadonlyMap<string, DateStr>;
  critical: ReadonlySet<string>;
  accepted: ReadonlySet<string>;
  calendar: readonly DateStr[];
  latest: DateStr;
  /** 当前已提交的截至日 */
  committed: DateStr | null;
}): DateStr | null {
  const counted = i.missing.filter((m) => !i.accepted.has(m.code) && !i.critical.has(m.code));
  const thr = missingThreshold(i.market, i.expected);
  if (counted.length <= thr) return null;
  const prev = i.calendar.filter((d) => d < i.latest).at(-1);
  if (!prev) return null;
  // 每只缺失的股票齐到哪天：只缺今天的齐到昨天；从没有过日线的当成哪天都没齐；之前有日子没确认的也算进来
  const counts = (code: string) => !i.accepted.has(code) && !i.critical.has(code);
  const through = [
    ...counted.map((m) => (i.behind.has(m.code) ? (i.behind.get(m.code) ?? "") : prev)),
    ...[...(i.unverified ?? new Map<string, DateStr>())]
      .filter(([code]) => counts(code))
      .map(([, d]) => d),
  ].sort();
  // 第 thr+1 早的那只齐到 k：D ≤ k 时，没齐到 D 的（through < D）最多 thr 只
  const k = through[thr]!;
  const d = i.calendar.filter((x) => x <= k && x < i.latest).at(-1);
  if (!d || (i.committed !== null && d <= i.committed)) return null;
  return d;
}

/** 补数据进度（D111）：since 之后到 asOf、到 latest 各有几个交易日 */
export function catchUpProgress(
  calendar: readonly DateStr[],
  since: DateStr | null,
  asOf: DateStr,
  latest: DateStr,
  behind: number,
): CatchUp {
  const after = (d: DateStr) => since === null || d > since;
  return {
    since,
    asOf,
    latest,
    done: calendar.filter((d) => after(d) && d <= asOf).length,
    total: calendar.filter((d) => after(d) && d <= latest).length,
    behind,
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

/**
 * 沿回退链取数（D72）：被封、空结果、报错都换下一家；整条链的结果与每家的尝试记进 FetchLedger，
 * 提交数据版本时写进 data_versions.sources，管理页显示「今晚东财 N 只、腾讯 M 只（回退 K 次）」。
 *
 * 结局：
 * - 有一家给了非空结果 → 用它；
 * - 没有非空结果、但有一家正常答了「空」→ 返回这个空结果（能连上的来源说没有，就是没有；缺不缺由调用方判断）；
 * - 每家都被封 → 抛最早解封时间的 BlockedError，现有的等解封逻辑照常工作；
 * - 其余（有报错）→ 抛「… 所有数据源都失败：…」，带上每家的尝试。
 */
import type { PitDatasetId } from "@ivan/core";
import { BlockedError, type HttpLike } from "../http.ts";
import type { ResolvedChain } from "./registry.ts";
import { type Capability, type SourceAdapter, type SourceId, type SrcCode, srcCode } from "./types.ts";

export interface Attempt {
  source: SourceId;
  outcome: "ok" | "empty" | "blocked" | "error";
  ms: number;
  msg?: string;
}

export interface ChainResult<T> {
  value: T;
  servedBy: SourceId;
  attempts: Attempt[];
  /** 没有一家给出非空结果（value 是某家正常返回的空结果） */
  empty: boolean;
}

/** 整条链都没拿到：带上每家的尝试 */
export class ChainError extends Error {
  constructor(
    message: string,
    readonly attempts: Attempt[],
  ) {
    super(message);
  }
}

/** 错误上带的尝试明细（ChainError，或整条链被封时的 BlockedError） */
export function attemptsOf(e: unknown): Attempt[] | undefined {
  if (e instanceof ChainError) return e.attempts;
  const a = (e as { attempts?: unknown } | null)?.attempts;
  return Array.isArray(a) ? (a as Attempt[]) : undefined;
}

const OUTCOME_TEXT: Record<Attempt["outcome"], string> = {
  ok: "成功",
  empty: "没有数据",
  blocked: "被风控暂停",
  error: "出错",
};

const LABEL: Record<SourceId, string> = { eastmoney: "东财", tencent: "腾讯", csindex: "中证官网" };

/** 「东财 出错（HTTP 500）；腾讯 被风控暂停」 */
export function summarizeAttempts(attempts: readonly Attempt[]): string {
  return attempts
    .map((a) => `${LABEL[a.source]} ${OUTCOME_TEXT[a.outcome]}${a.msg ? `（${a.msg}）` : ""}`)
    .join("；");
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function fetchWithChain<T>(
  chain: ResolvedChain,
  what: string,
  fn: (a: SourceAdapter) => Promise<T>,
  isEmpty: (v: T) => boolean,
  gate: Pick<HttpLike, "isBlocked" | "earliestUnblock">,
): Promise<ChainResult<T>> {
  const attempts: Attempt[] = [];
  const blocked: Array<{ host: string; until: number }> = [];
  let firstEmpty: { value: T; source: SourceId } | undefined;
  for (const a of chain.adapters) {
    const hosts = [...(a.hosts[chain.cap] ?? [])];
    if (hosts.length && hosts.every((h) => gate.isBlocked(h))) {
      const until = gate.earliestUnblock(hosts);
      blocked.push({ host: hosts[0]!, until });
      attempts.push({ source: a.id, outcome: "blocked", ms: 0, msg: `${hosts[0]} 暂停中` });
      continue;
    }
    const t0 = Date.now();
    let v: T;
    try {
      v = await fn(a);
    } catch (e) {
      const ms = Date.now() - t0;
      if (e instanceof BlockedError) {
        blocked.push({ host: e.host, until: e.until });
        attempts.push({ source: a.id, outcome: "blocked", ms, msg: e.message });
      } else {
        attempts.push({ source: a.id, outcome: "error", ms, msg: errText(e).slice(0, 200) });
      }
      continue;
    }
    const ms = Date.now() - t0;
    if (isEmpty(v)) {
      attempts.push({ source: a.id, outcome: "empty", ms });
      firstEmpty ??= { value: v, source: a.id };
      continue;
    }
    attempts.push({ source: a.id, outcome: "ok", ms });
    return { value: v, servedBy: a.id, attempts, empty: false };
  }
  if (firstEmpty) {
    return { value: firstEmpty.value, servedBy: firstEmpty.source, attempts, empty: true };
  }
  if (blocked.length && blocked.length === attempts.length) {
    const first = blocked.reduce((m, b) => (b.until < m.until ? b : m));
    throw Object.assign(new BlockedError(blocked[0]!.host, first.until), { attempts });
  }
  throw new ChainError(`${what} 所有数据源都失败：${summarizeAttempts(attempts)}`, attempts);
}

export interface LedgerFailure {
  code: string;
  msg: string;
  attempts?: Attempt[];
}

/** 一个点时事件数据集这一晚由谁给的、几次请求、写了几行（S15，只在夜间记） */
export interface DatasetLedger {
  servedBy: SrcCode | null;
  requests: number;
  rows: number;
}

/**
 * data_versions.sources 的内容。第 1 版（S12）；第 2 版（S15）加 datasets（夜间的点时事件数据集），其余不变，
 * 读的一方（lastFetchSources）两版都认。
 */
export interface SourcesLedger {
  v: 2;
  /** 各来源最终服务的股票数（同一只股票被重拉时以最后一次为准） */
  served: Partial<Record<SrcCode, number>>;
  /** 首选来源没给、换下一家才拿到的次数 */
  fallbacks: number;
  /** 整条链都正常答了「没有数据」的股票数 */
  empty: number;
  /** 整条链都没拿到（含口径换算拒收）的股票数 */
  failed: number;
  /** 失败明细（最多 50 条） */
  failures: LedgerFailure[];
  /** 各指数这次由哪家给的 */
  index: Record<string, SrcCode>;
  /** 点时事件数据集（S15） */
  datasets: Partial<Record<PitDatasetId, DatasetLedger>>;
}

export const LEDGER_FAILURE_CAP = 50;

/** 一次任务（夜间增量、回填）的取数台账 */
export class FetchLedger {
  private readonly bySrc = new Map<string, SrcCode>();
  private readonly emptyCodes = new Set<string>();
  private readonly failedCodes = new Set<string>();
  private readonly failures: LedgerFailure[] = [];
  private readonly index: Record<string, SrcCode> = {};
  private readonly datasets: Partial<Record<PitDatasetId, DatasetLedger>> = {};
  private fallbacks = 0;

  /** 一只股票沿链取到了（cap 决定行级来源代码） */
  record(code: string, r: ChainResult<unknown>, cap: Capability = "bars"): void {
    if (r.attempts.length && r.attempts[0]!.source !== r.servedBy) this.fallbacks++;
    if (r.empty) {
      this.emptyCodes.add(code);
      return;
    }
    this.served(code, srcCode(r.servedBy, cap));
  }

  /** 直接记一只股票的来源（批量报价写进去的行） */
  served(code: string, src: SrcCode): void {
    this.bySrc.set(code, src);
    this.emptyCodes.delete(code);
    this.failedCodes.delete(code);
  }

  /** 一只股票整条链都没拿到（或拿到了但被拒收） */
  recordFailure(code: string, e: unknown): void {
    this.bySrc.delete(code);
    this.failedCodes.add(code);
    if (this.failures.length < LEDGER_FAILURE_CAP) {
      const attempts = attemptsOf(e);
      this.failures.push({ code, msg: errText(e).slice(0, 300), ...(attempts ? { attempts } : {}) });
    }
  }

  recordIndex(sym: string, r: ChainResult<unknown>): void {
    if (!r.empty) this.index[sym] = srcCode(r.servedBy, "index");
  }

  /** 一个点时事件数据集这一晚的结果（夜间同步记；后台回填不记） */
  recordDataset(id: PitDatasetId, r: { servedBy: SourceId | null; requests: number; rows: number }): void {
    this.datasets[id] = {
      servedBy: r.servedBy ? srcCode(r.servedBy, "events") : null,
      requests: r.requests,
      rows: r.rows,
    };
  }

  toJSON(): SourcesLedger {
    const served: Partial<Record<SrcCode, number>> = {};
    for (const src of this.bySrc.values()) served[src] = (served[src] ?? 0) + 1;
    return {
      v: 2,
      served,
      fallbacks: this.fallbacks,
      empty: this.emptyCodes.size,
      failed: this.failedCodes.size,
      failures: [...this.failures],
      index: { ...this.index },
      datasets: { ...this.datasets },
    };
  }
}

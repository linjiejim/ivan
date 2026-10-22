/**
 * 一个任务里「等风控解封」的总预算（D108）。
 *
 * 日线来源都被封时，原来每只股票最多等 12 次、每次等到解封（5 分钟起翻倍，最长 1 小时）：一晚的更新可以挂好几个小时，
 * 期间它一直是「在跑的写库任务」，回测全部排队，后面的任务也排着（2026-10-09 卡了约 21 小时，10-20 手动补跑卡了一个多小时）。
 *
 * 现在 worker 里的夜间更新与每周抽检带一个预算：几只股票同时在等同一段时间只算一次（按时间段的并集记账）；
 * 预算不够等到解封时不再睡，直接让这只股票失败、记成 rate_limited 缺失——完整性闸门照常判断，缺得多就提交 incomplete、
 * 45 分钟后自动重跑（排着队等重跑时不挡回测）。命令行回填（worker 停着）不给预算，照旧等到解封。
 */
import { BlockedError } from "../http.ts";

/** 夜间更新与每周抽检默认最多等多久（毫秒）：环境变量 ETL_RATE_LIMIT_WAIT_MS 可改 */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 30 * 60_000;

export class RateLimitWaitBudget {
  private spent = 0;
  /** 已经记过账的等待一直覆盖到哪个时刻：别的股票同时在等的那段不再重复扣 */
  private coveredUntil = 0;
  private exhausted = false;

  constructor(
    readonly totalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get spentMs(): number {
    return this.spent;
  }

  get remainingMs(): number {
    return Math.max(0, this.totalMs - this.spent);
  }

  /** 预算已经用完（之后被拦的一律不等） */
  get isExhausted(): boolean {
    return this.exhausted;
  }

  /**
   * 想一直等到 untilMs：预算够就记账、返回 true（调用方去睡）；不够返回 false，并且之后都返回 false
   * （剩一点零头时不让后面的股票一个个去试）。
   */
  reserve(untilMs: number): boolean {
    if (this.exhausted) return false;
    const start = Math.max(this.now(), this.coveredUntil);
    const cost = Math.max(0, untilMs - start);
    if (cost > this.remainingMs) {
      this.exhausted = true;
      return false;
    }
    this.spent += cost;
    this.coveredUntil = Math.max(this.coveredUntil, untilMs);
    return true;
  }
}

/** 等风控的预算用完了，这只股票这次不等了（仍是一种 BlockedError：调用方按「被封」处理） */
export class RateLimitBudgetError extends BlockedError {
  constructor(cause: BlockedError, budget: RateLimitWaitBudget) {
    super(cause.host, cause.until, cause.reason);
    this.message = `${cause.message}；这次任务等风控的 ${Math.round(budget.totalMs / 60_000)} 分钟用完了，不再等`;
  }
}

/** 从环境变量读预算（毫秒）；不合法或没写用默认值，0 = 一被封就不等 */
export function rateLimitWaitMsFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.ETL_RATE_LIMIT_WAIT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RATE_LIMIT_WAIT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RATE_LIMIT_WAIT_MS;
}

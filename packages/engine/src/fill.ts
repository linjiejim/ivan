/**
 * 按流动性成交（D64，纯函数）：报价、按交易单位取整、拒单诊断的记录器。
 *
 * - 参考价 = 当日开盘；半价差 h = 单边滑点 +（tickSpread 时）0.5 × 最小价位 ÷ 参考价（bp）；
 * - 冲击 I = 系数 × 日波动 × √(min(想成交金额, 上限) ÷ 日均成交额)（日波动缺失时按 2.5%，并计数）；
 * - 买价 = min(涨停价, 参考价 × (1 + (h + I))）；卖价 = max(跌停价, 参考价 × (1 − (h + I))）；
 * - 买入上限 = 单笔比例 × 日均成交额；日均成交额未知的买单拒绝（no_liquidity），卖单不设上限。
 *
 * 旧办法成交（isLegacyFill：滑点 0、无价位、无冲击、无上限）时模拟器不经过这里，保证逐字节复现。
 */
import {
  type DateStr,
  type ExecConfig,
  type Market,
  type RejectReason,
  type RejectSample,
  type SimDiagnostics,
  tickSize,
} from "@ivan/core";
import { quantile7 } from "./stats/moments.ts";

export type { RejectReason } from "@ivan/core";

/** 日波动缺失时冲击成本用的日波动（约年化 40%） */
export const SIGMA_FALLBACK = 0.025;

export interface QuoteCtx {
  market: Market;
  exec: ExecConfig;
  side: "buy" | "sell";
  /** 参考价：回测里是当日开盘，明日计划的估算是最后收盘 */
  open: number;
  /** 决策日（及以前最后一个有效值）的 20 日均成交额（元），未知为 NaN */
  adv: number;
  /** 决策日的日波动，未知为 NaN */
  sigma: number;
  /** A 股当日涨跌停价；港股与估算时 null */
  limit: { up: number; down: number } | null;
  date: DateStr;
  /** 仓位控制的增减：付价差与冲击，但不设单笔上限、不因日均成交额未知而拒绝 */
  uncapped?: boolean;
}

export type Quote =
  | {
      ok: true;
      price: number;
      ref: number;
      /** 这一笔最多能买的金额（卖单与不设上限时 Infinity） */
      maxValue: number;
      /** 半价差（单边滑点 + 半个最小价位，bp） */
      slipBps: number;
      impactBps: number;
      sigmaFallback: boolean;
    }
  | { ok: false; reason: RejectReason };

export function quote(c: QuoteCtx, wantValue: number): Quote {
  const { exec } = c;
  const ref = c.open;
  let maxValue = Infinity;
  if (exec.participation !== null && c.side === "buy" && !c.uncapped) {
    if (!(c.adv > 0)) return { ok: false, reason: "no_liquidity" };
    maxValue = exec.participation * c.adv;
  }
  const slipBps =
    exec.slippageBps +
    (exec.tickSpread ? ((0.5 * tickSize(c.market, ref, c.date)) / ref) * 1e4 : 0);
  let impactBps = 0;
  let sigmaFallback = false;
  if (exec.impact === "sqrt" && c.adv > 0) {
    let sigma = c.sigma;
    if (!(Number.isFinite(sigma) && sigma > 0)) {
      sigma = SIGMA_FALLBACK;
      sigmaFallback = true;
    }
    const size = Math.max(0, Math.min(wantValue, maxValue));
    impactBps = exec.impactEta * sigma * Math.sqrt(size / c.adv) * 1e4;
  }
  const k = (slipBps + impactBps) / 1e4;
  const price =
    c.side === "buy"
      ? Math.min(c.limit?.up ?? Infinity, ref * (1 + k))
      : Math.max(c.limit?.down ?? 0, ref * (1 - k));
  return { ok: true, price, ref, maxValue, slipBps, impactBps, sigmaFallback };
}

/**
 * 按交易单位向下取整的股数：A 股主板 / 创业板整百股，科创板按 1 股（不到 200 股买不了），港股按每手。
 * `minStar` 为 false 时科创板不管 200 股的下限（只用来折算持仓的增减）。
 */
export function lotFloor(
  market: Market,
  board: string | null,
  lotSize: number | null,
  shares: number,
  minStar = false,
): number {
  if (!(shares > 0)) return 0;
  if (market === "A") {
    if (board === "star") {
      const s = Math.floor(shares);
      return minStar && s < 200 ? 0 : s;
    }
    return Math.floor(shares / 100) * 100;
  }
  const lot = lotSize && lotSize > 0 ? lotSize : 100;
  return Math.floor(shares / lot) * lot;
}

/** 最近的 N 条拒单样例 */
export const SAMPLE_LIMIT = 500;

/**
 * 拒单与成交统计的记录器：拒单按（方向, 原因）计数与金额，样例只留最近 SAMPLE_LIMIT 条（环形缓冲）。
 * 只记录，从不影响成交决定。
 */
export class FillLog {
  private readonly rejections: Record<string, { count: number; value: number }> = {};
  private readonly ring: RejectSample[] = [];
  private head = 0;
  /** 建仓 / 信号买入的参与率（成交金额 ÷ 日均成交额） */
  readonly parts: number[] = [];
  /** 过了报价、按预算算了股数的买单数，其中被上限截小的 */
  sized = 0;
  capped = 0;
  advUnknownBuys = 0;
  sigmaFallbacks = 0;
  slippageCost = 0;

  reject(
    date: DateStr,
    code: string,
    side: "buy" | "sell",
    reason: RejectReason,
    wantValue: number,
    filledValue = 0,
  ): void {
    const key = `${side}:${reason}`;
    const r = (this.rejections[key] ??= { count: 0, value: 0 });
    const unfilled = Math.max(0, wantValue - filledValue);
    r.count++;
    r.value += Number.isFinite(unfilled) ? unfilled : 0;
    const sample: RejectSample = { date, code, side, reason, wantValue, filledValue };
    if (this.ring.length < SAMPLE_LIMIT) this.ring.push(sample);
    else {
      this.ring[this.head] = sample;
      this.head = (this.head + 1) % SAMPLE_LIMIT;
    }
  }

  /** 旧办法成交只给拒单统计与样例；按流动性成交再给参与率、容量与滑点 */
  result(o: { liquidity: boolean; capital: number; participation: number | null }): SimDiagnostics {
    // 环形缓冲按写入顺序（即日期顺序）展开；同一天保持写入顺序
    const samples = [...this.ring.slice(this.head), ...this.ring.slice(0, this.head)];
    const out: SimDiagnostics = { rejections: this.rejections, samples };
    if (!o.liquidity) return out;
    const parts = [...this.parts].sort((a, b) => a - b);
    const participation = parts.length
      ? { p50: quantile7(parts, 0.5), p90: quantile7(parts, 0.9), max: parts.at(-1)! }
      : null;
    return {
      ...out,
      participation,
      cappedBuyShare: this.sized > 0 ? this.capped / this.sized : 0,
      advUnknownBuys: this.advUnknownBuys,
      sigmaFallbacks: this.sigmaFallbacks,
      slippageCost: this.slippageCost,
      capacityEstimate:
        o.participation !== null && participation && participation.p90 > 0
          ? (o.capital * o.participation) / participation.p90
          : null,
    };
  }
}

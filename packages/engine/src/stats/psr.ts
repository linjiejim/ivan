/**
 * 概率夏普比（PSR，Bailey & López de Prado 2012，D65）：观测到的（每个观测期的）夏普比 srObs 在给定偏度、
 * 峰度（非超额，正态为 3）下，真实夏普比高于 srStar 的「把握」。界面上只说「按历史重抽样，跑赢基准的把握」，
 * 不说概率。观测少于 30 个或方差项不为正时返回 null。
 */
import { normCdf } from "./normal.ts";

export const PSR_MIN_OBS = 30;

export function psr(
  srObs: number,
  T: number,
  skew: number,
  kurt: number,
  srStar = 0,
): number | null {
  if (T < PSR_MIN_OBS || ![srObs, skew, kurt, srStar].every(Number.isFinite)) return null;
  const v = 1 - skew * srObs + ((kurt - 1) / 4) * srObs * srObs;
  if (!(v > 0)) return null;
  return normCdf(((srObs - srStar) * Math.sqrt(T - 1)) / Math.sqrt(v));
}

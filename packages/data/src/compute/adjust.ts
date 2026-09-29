/**
 * 复权因子：从「后复权」价反推公司行动，再自己算等比复权因子（分红再投入）。
 *
 * 实测（2026-09，腾讯与东财都是）：后复权不是等比复权，而是
 *   后复权价 = a × 不复权价 + b
 * a 只在送转/拆并股时变（乘以 1 + 送转比例），b 在每次除息时加 a × 每股现金分红。
 * 直接拿「后复权 / 不复权」当因子会把历史分红当成不再投资的现金，收益被系统性低估（茅台约 14%）。
 *
 * 算法（对后复权价只有 2 位小数的低价股也稳）：
 * 1. 斜率分段：送转当天原价相对后复权价的跳变 ≥ 8%；或振幅够大的日子日内斜率显著偏离本段
 *    （东财对部分实物分派按比例调整，a 只变几个百分点，如腾讯 2022-01 派京东股份），据此切成若干「a 段」。
 * 2. 每个 a 段内用「日内」偏差做合并回归求 a：同一天的开高低收共享 (a, b)，日内去均值后 b 被消掉，
 *    除息跳变不影响斜率；几百天的日内振幅合起来，斜率非常准。
 * 3. 每天 b = 当日后复权均值 − a × 当日原价均值；b 在段内分段为常数，做阶跃检测找除息日
 *    （跳变要被随后两天确认，单日坏点不算）。
 * 4. 事件：送转比例 s = a' / a − 1，每股现金 D = (b' − b) / a（配股为负）；
 *    除权参考价 = (前收 − D) / (1 + s)，等比因子在这天乘以 前收 / 除权参考价。
 */
import type { DateStr } from "@ivan/core";

export interface PriceBar {
  date: DateStr;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface CorpAction {
  date: DateStr;
  /** 每股现金分红（除权前股本口径，不复权价单位）；配股等为负 */
  cash: number;
  /** 送转/拆并比例：10 送 10 → 1；10 并 1 → −0.9 */
  split: number;
}

/**
 * 除权除息的原始事实：前一日收盘与除权参考价。A 股单请求路径只拿得到这两个数，
 * 现金与送转比例要等股本变动到了再拆（resolveActions）。
 */
export interface RefAction {
  date: DateStr;
  prevClose: number;
  refPrice: number;
  /** 已知时直接给（后复权反推路径）；未知为 null */
  cash: number | null;
  split: number | null;
}

/**
 * A 股单请求路径（D31）：东财不复权日 K 的「涨跌额」是相对交易所参考前收算的，
 * 参考前收 = 收盘 − 涨跌额。平常等于昨收；除权除息日是除权参考价，二者之比就是等比因子的跳变。
 */
export function adjFromRefPrices(
  bars: ReadonlyArray<{ date: DateStr; close: number; chg: number }>,
): { adj: number[]; actions: RefAction[] } {
  const adj: number[] = new Array(bars.length).fill(1);
  const actions: RefAction[] = [];
  let f = 1;
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]!.close;
    const b = bars[i]!;
    const ref = Math.round((b.close - b.chg) * 1000) / 1000;
    if (Number.isFinite(ref) && ref > 0 && Math.abs(ref - prev) > 0.0051 && Number.isFinite(b.chg)) {
      f *= prev / ref;
      actions.push({ date: b.date, prevClose: prev, refPrice: ref, cash: null, split: null });
    }
    adj[i] = f;
  }
  return { adj, actions };
}

/**
 * 把参考价事实拆成现金与送转：附近 7 天内有送转/拆并类股本变动就用它的比例 s，
 * 现金 = 前收 − 参考价 × (1 + s)。
 */
export function resolveActions(
  actions: readonly RefAction[],
  shares: ReadonlyArray<{ eff_date: DateStr; total_shares: number; reason: string | null }>,
  splitReason: RegExp,
): CorpAction[] {
  return actions.map((a) => {
    if (a.cash !== null && a.split !== null) return { date: a.date, cash: a.cash, split: a.split };
    let s = 0;
    const t = Date.parse(a.date);
    for (let i = 1; i < shares.length; i++) {
      const c = shares[i]!;
      if (!c.reason || !splitReason.test(c.reason)) continue;
      if (Math.abs(Date.parse(c.eff_date) - t) > 7 * 86_400_000) continue;
      const before = shares[i - 1]!.total_shares;
      if (before > 0) s = c.total_shares / before - 1;
      break;
    }
    let cash = a.prevClose - a.refPrice * (1 + s);
    if (Math.abs(cash) < Math.max(0.001, 1e-4 * a.prevClose)) cash = 0;
    return { date: a.date, cash: Math.round(cash * 10_000) / 10_000, split: Math.round(s * 10_000) / 10_000 };
  });
}

interface Day {
  /** 在 raw 里的下标 */
  i: number;
  xbar: number;
  ybar: number;
  /** 日内去均值后的 Σ(x − x̄)² 与 Σ(x − x̄)(y − ȳ) */
  sxx: number;
  sxy: number;
  close: number;
  hclose: number;
}

const SPLIT_LOG = Math.log(1.08);

/**
 * @param decimals 后复权价的小数位数（腾讯 3 位；东财 A 股 2 位、港股 3 位），决定舍入容差
 */
export function decomposeHfq(
  raw: readonly PriceBar[],
  hfq: readonly PriceBar[],
  decimals = 3,
): { adj: number[]; events: CorpAction[] } {
  const unit = 10 ** -decimals;
  const hfqByDate = new Map(hfq.map((b) => [b.date, b]));

  // ── 逐日汇总 ──
  const days: Day[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]!;
    const h = hfqByDate.get(r.date);
    if (!h || !(r.close > 0) || !(h.close > 0)) continue;
    const pts = (
      [
        [r.open, h.open],
        [r.high, h.high],
        [r.low, h.low],
        [r.close, h.close],
      ] as Array<[number, number]>
    ).filter(([x, y]) => x > 0 && y > 0);
    const xbar = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const ybar = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    let sxx = 0;
    let sxy = 0;
    for (const [x, y] of pts) {
      sxx += (x - xbar) ** 2;
      sxy += (x - xbar) * (y - ybar);
    }
    days.push({ i, xbar, ybar, sxx, sxy, close: r.close, hclose: h.close });
  }
  const adj: number[] = new Array(raw.length).fill(1);
  if (days.length < 2) return { adj, events: [] };

  // ── 1. 斜率 a 分段 ──
  // 两种信号：送转当天原价相对后复权价跳 ≥ 8%；或振幅够大的日子日内斜率显著偏离本段合并斜率
  // （有的实物分派会被按比例调整，a 只变几个百分点），并要被随后的精确日确认。
  const sigma = 0.29 * unit;
  const aStarts = [0];
  let segSxx = days[0]!.sxx;
  let segSxy = days[0]!.sxy;
  const precise = (d: Day, a: number) => d.sxx > 0 && sigma / Math.sqrt(d.sxx) < 0.002 * a;
  for (let k = 1; k < days.length; k++) {
    const p = days[k - 1]!;
    const c = days[k]!;
    const q = Math.log(c.hclose / p.hclose / (c.close / p.close));
    const aSeg = segSxx > 0 ? segSxy / segSxx : c.ybar / c.xbar;
    let cut = Math.abs(q) > SPLIT_LOG;
    if (!cut && segSxx > 0 && precise(c, aSeg)) {
      const aDay = c.sxy / c.sxx;
      const se = Math.sqrt(sigma ** 2 / c.sxx + sigma ** 2 / segSxx);
      if (Math.abs(aDay - aSeg) > Math.max(6 * se, 0.002 * aSeg)) {
        // 随后最多 5 天里的精确日，都要更接近新斜率
        const conf: number[] = [];
        for (let j = k + 1; j < Math.min(k + 6, days.length) && conf.length < 2; j++) {
          if (precise(days[j]!, aSeg)) conf.push(days[j]!.sxy / days[j]!.sxx);
        }
        if (conf.length && conf.every((v) => Math.abs(v - aDay) < Math.abs(v - aSeg))) cut = true;
        else continue; // 单日异常，不并入
      }
    }
    if (cut) {
      aStarts.push(k);
      segSxx = c.sxx;
      segSxy = c.sxy;
    } else {
      segSxx += c.sxx;
      segSxy += c.sxy;
    }
  }

  // ── 2. 每段求 a（日内合并回归） ──
  const aOf: number[] = new Array(days.length);
  for (let s = 0; s < aStarts.length; s++) {
    const from = aStarts[s]!;
    const to = s + 1 < aStarts.length ? aStarts[s + 1]! : days.length;
    let sxx = 0;
    let sxy = 0;
    for (let k = from; k < to; k++) {
      sxx += days[k]!.sxx;
      sxy += days[k]!.sxy;
    }
    let a: number;
    if (sxx > 0 && sxy > 0) a = sxy / sxx;
    else if (s > 0) {
      // 整段都是一字板：按跳变比例从前一段推
      const p = days[from - 1]!;
      const c = days[from]!;
      a = aOf[from - 1]! * (c.hclose / p.hclose / (c.close / p.close));
    } else a = days[from]!.ybar / days[from]!.xbar;
    for (let k = from; k < to; k++) aOf[k] = a;
  }

  // ── 3. 逐日 b，段内阶跃检测 ──
  const b = days.map((d, k) => d.ybar - aOf[k]! * d.xbar);
  // 每日 b 的噪声：后复权价舍入（4 个点平均）+ 斜率误差 × 价格偏离，给足余量
  const thr = (k: number) => 1.5 * unit + 2e-7 * days[k]!.ybar;
  const minCash = (k: number) => Math.max(0.001, 1e-4 * days[k - 1]!.close);
  const eventAt = new Map<number, CorpAction>();
  const aStartSet = new Set(aStarts);
  let segSum = b[0]!;
  let segN = 1;
  let segA = aOf[0]!;
  for (let k = 1; k < days.length; k++) {
    const mean = segSum / segN;
    if (aStartSet.has(k)) {
      // 送转日：新 a 段；这天可能同时派现，b 的跳变按旧 a 折回每股现金
      // 新截距：这天及随后与它同一水平的几天（遇到下一次除息就停，别把它混进来）
      let nb = b[k]!;
      let n = 1;
      for (let j = k + 1; j < Math.min(k + 5, days.length) && !aStartSet.has(j); j++) {
        if (Math.abs(b[j]! - b[k]!) > thr(j)) break;
        nb += b[j]!;
        n++;
      }
      const split = aOf[k]! / segA - 1;
      let cash = (nb / n - mean) / segA;
      if (Math.abs(cash) < minCash(k)) cash = 0;
      eventAt.set(k, { date: raw[days[k]!.i]!.date, cash: round(cash, 4), split: round(split, 4) });
      segSum = b[k]!;
      segN = 1;
      segA = aOf[k]!;
      continue;
    }
    if (Math.abs(b[k]! - mean) <= thr(k)) {
      segSum += b[k]!;
      segN++;
      continue;
    }
    // 候选除息日：随后两天（同一 a 段内）要更接近新水平，否则当成单日坏点
    const next: number[] = [];
    for (let j = k + 1; j < Math.min(k + 3, days.length) && !aStartSet.has(j); j++) next.push(b[j]!);
    if (!next.every((v) => Math.abs(v - b[k]!) < Math.abs(v - mean))) continue;
    // 新水平用这天和随后几天的均值，精度更高
    const level = (b[k]! + next.reduce((s, v) => s + v, 0)) / (1 + next.length);
    const cash = (level - mean) / segA;
    if (Math.abs(cash) >= minCash(k)) {
      eventAt.set(k, { date: raw[days[k]!.i]!.date, cash: round(cash, 4), split: 0 });
    }
    segSum = b[k]!;
    segN = 1;
  }

  // ── 4. 等比复权因子（首日 = 1） ──
  const eventByRaw = new Map<number, CorpAction>();
  for (const [k, e] of eventAt) eventByRaw.set(days[k]!.i, e);
  let f = 1;
  for (let i = 0; i < raw.length; i++) {
    const e = eventByRaw.get(i);
    if (e && i > 0) {
      const prevClose = raw[i - 1]!.close;
      const ref = (prevClose - e.cash) / (1 + e.split);
      if (ref > 0) f *= prevClose / ref;
    }
    adj[i] = f;
  }
  return { adj, events: [...eventAt.values()] };
}

function round(x: number, d: number): number {
  const m = 10 ** d;
  return Math.round(x * m) / m;
}

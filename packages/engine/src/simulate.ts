/**
 * 模拟器（纯函数，回测与向前跟踪共用，D13）。
 *
 * 时序（spec §5，D6）：T 日收盘后决策（选股、止盈止损），T+1 日开盘成交，先卖后买。
 * - 卖：停牌或（A 股）开盘价触及跌停 → 顺延到下一个交易日。
 * - 买：停牌或（A 股）开盘价触及涨停 → 当天放弃，空位留到下次调仓（D15）。
 * - 计价：持仓按等比复权因子折算（分红再投入）；止盈止损按含分红的涨跌判断（不含费用）。
 * - 调仓（D15 + 缓冲）：调仓日掉出前 ⌈top × buffer⌉ 名的持仓卖出，空位按名单顺序补足；
 *   新买入每只预算 = min(上一收盘总资产 / top, 现金 / 空位数, 单只上限)。持仓不做再平衡。
 */
import {
  type BacktestParams,
  type DateStr,
  type HoldingSnapshot,
  type OpenPosition,
  type PendingOrder,
  periodKey,
  priceLimitPct,
  limitPrices,
  type SeriesPoint,
  sharesForBudget,
  type SimInput,
  type SimResult,
  type Trade,
  type TradeReason,
  tradeFees,
} from "@ivan/core";
import { runChecks } from "./checks.ts";
import { attribution, computeMetrics, periodMetrics } from "./metrics.ts";

export const ENGINE_VERSION = "1.0.0";

interface Position {
  code: string;
  /** 买入股数 */
  shares: number;
  entryIdx: number;
  entryPrice: number;
  entryAdj: number;
  /** 买入金额 + 费用 */
  cost: number;
}

export class SimError extends Error {}

/** 回测区间在日历上的下标：第一个 ≥ start 的交易日到最后一个 ≤ end 的交易日。 */
export function periodIndexes(calendar: readonly DateStr[], params: BacktestParams) {
  const startIdx = calendar.findIndex((d) => d >= params.start);
  let endIdx = -1;
  for (let i = calendar.length - 1; i >= 0; i--) {
    if (calendar[i]! <= params.end) {
      endIdx = i;
      break;
    }
  }
  return { startIdx, endIdx };
}

/**
 * 调仓日（开盘成交的日子）：区间第一天 + 之后每个周期的第一个交易日。
 * 决策日 = 调仓日的前一个交易日（数据层按决策日选股）。
 */
export function rebalanceDays(
  calendar: readonly DateStr[],
  params: BacktestParams,
  every: "week" | "month" | "quarter",
): { execIdx: number[]; decisionDates: DateStr[] } {
  const { startIdx, endIdx } = periodIndexes(calendar, params);
  const execIdx: number[] = [];
  if (startIdx < 1 || endIdx < startIdx) return { execIdx, decisionDates: [] };
  execIdx.push(startIdx);
  // 日历里若多给了区间后一天（向前跟踪用来出「明日计划」），它也可能是调仓日
  const last = Math.min(endIdx + 1, calendar.length - 1);
  for (let i = startIdx + 1; i <= last; i++) {
    if (periodKey(calendar[i]!, every) !== periodKey(calendar[i - 1]!, every)) execIdx.push(i);
  }
  return { execIdx, decisionDates: execIdx.map((i) => calendar[i - 1]!) };
}

export function simulate(input: SimInput): SimResult {
  const { spec, params, calendar, prices, securities } = input;
  const { startIdx, endIdx } = periodIndexes(calendar, params);
  if (startIdx < 1) throw new SimError("交易日历需要包含回测起点之前至少一个交易日");
  if (endIdx < startIdx) throw new SimError("回测区间内没有交易日");
  const market = spec.market;
  const N = spec.mode === "signals" ? (spec.signals?.maxPositions ?? 10) : (spec.rank?.top ?? 10);
  const band = Math.ceil(N * spec.rebalance.buffer);
  const costs = spec.costs ?? {};

  // 调仓日（规则模式）或信号买入日（信号模式）
  const execSet = new Set<number>();
  const buyListAt = new Map<number, string[]>();
  if (spec.mode === "rules") {
    for (const i of rebalanceDays(calendar, params, spec.rebalance.every).execIdx) {
      execSet.add(i);
      buyListAt.set(i, input.selections.get(calendar[i - 1]!) ?? []);
    }
  } else {
    for (const s of input.signals ?? []) {
      // 信号日收盘后决策，下一个交易日开盘买
      const i = calendar.findIndex((d) => d > s.date);
      if (i < startIdx || i > endIdx + 1 || i < 0) continue;
      const list = buyListAt.get(i) ?? [];
      if (!list.includes(s.code)) list.push(s.code);
      buyListAt.set(i, list);
    }
  }

  // 基准：缺值向前填
  const bench = new Float64Array(calendar.length);
  let lastBench = NaN;
  for (let i = 0; i < calendar.length; i++) {
    const v = input.bench[i];
    if (v !== undefined && Number.isFinite(v) && v > 0) lastBench = v;
    bench[i] = lastBench;
  }
  const bench0 = Number.isFinite(bench[startIdx]!)
    ? bench[startIdx]!
    : (bench.find((v) => v > 0) ?? 1);

  const px = (code: string, i: number) => {
    const p = prices.get(code);
    if (!p) return undefined;
    const k = i - p.from;
    if (k < 0 || k >= p.close.length) return undefined;
    return { p, k };
  };
  /** 最近一个有收盘价的交易日（停牌时沿用），返回收盘价与当日因子 */
  const lastClose = (code: string, i: number) => {
    const p = prices.get(code);
    if (!p) return undefined;
    for (let k = Math.min(i - p.from, p.close.length - 1); k >= 0; k--) {
      if (Number.isFinite(p.close[k]!)) return { close: p.close[k]!, adj: p.adj[k]!, k };
    }
    return undefined;
  };
  const nameOf = (code: string) => securities.get(code)?.name ?? code;

  let cash = params.capital;
  const positions = new Map<string, Position>();
  const pendingSells = new Map<string, TradeReason>();
  const trades: Trade[] = [];
  const series: SeriesPoint[] = [];
  const holdings: HoldingSnapshot[] = [];
  let prevEquity = params.capital;

  const posValue = (pos: Position, i: number) => {
    const lc = lastClose(pos.code, i);
    if (!lc) return pos.cost;
    return pos.shares * lc.close * (lc.adj / pos.entryAdj);
  };

  /** A 股：当日开盘是否触及涨/跌停（参考价 = 前收按复权因子折算到除权后） */
  const limitHit = (code: string, i: number, side: "buy" | "sell"): boolean => {
    if (market !== "A") return false;
    const cur = px(code, i);
    if (!cur) return false;
    const { p, k } = cur;
    let pk = k - 1;
    while (pk >= 0 && !Number.isFinite(p.close[pk]!)) pk--;
    if (pk < 0) return false; // 上市首日不设限（默认也会排除次新股）
    const ref = (p.close[pk]! * p.adj[pk]!) / p.adj[k]!;
    const pct = priceLimitPct(
      "A",
      securities.get(code)?.board ?? null,
      p.st[k] === 1,
      calendar[i]!,
    );
    if (pct === null) return false;
    const { up, down } = limitPrices(ref, pct);
    const open = p.open[k]!;
    return side === "buy" ? open >= up - 1e-6 : open <= down + 1e-6;
  };

  for (let i = startIdx; i <= endIdx; i++) {
    const date = calendar[i]!;

    // ── 0. 退市：到退市日还拿着的，按最后收盘价清出（长期停牌但没退市的继续冻结） ──
    for (const pos of [...positions.values()]) {
      const dl = securities.get(pos.code)?.delistDate;
      if (!dl || date < dl) continue;
      const lc = lastClose(pos.code, i);
      if (!lc) continue;
      const sharesNow = pos.shares * (lc.adj / pos.entryAdj);
      const amount = sharesNow * lc.close;
      const fee = tradeFees(market, "sell", amount, date, costs).total;
      cash += amount - fee;
      trades.push({
        date,
        code: pos.code,
        side: "sell",
        price: lc.close,
        shares: sharesNow,
        amount,
        fee,
        reason: "delisted",
        pnl: amount - fee - pos.cost,
        holdDays: i - pos.entryIdx,
      });
      positions.delete(pos.code);
      pendingSells.delete(pos.code);
    }

    // ── 1. 开盘：先卖 ──
    for (const [code, reason] of [...pendingSells]) {
      const pos = positions.get(code);
      if (!pos) {
        pendingSells.delete(code);
        continue;
      }
      const cur = px(code, i);
      if (!cur || !Number.isFinite(cur.p.open[cur.k]!)) continue; // 停牌：顺延
      if (limitHit(code, i, "sell")) continue; // 跌停开盘：顺延
      const open = cur.p.open[cur.k]!;
      const sharesNow = pos.shares * (cur.p.adj[cur.k]! / pos.entryAdj);
      const amount = sharesNow * open;
      const fee = tradeFees(market, "sell", amount, date, costs).total;
      cash += amount - fee;
      trades.push({
        date,
        code,
        side: "sell",
        price: open,
        shares: sharesNow,
        amount,
        fee,
        reason,
        pnl: amount - fee - pos.cost,
        holdDays: i - pos.entryIdx,
      });
      positions.delete(code);
      pendingSells.delete(code);
    }

    // ── 2. 开盘：再买 ──
    const buyList = buyListAt.get(i);
    if (buyList?.length) {
      let vacancies = N - positions.size;
      for (const code of buyList) {
        if (vacancies <= 0) break;
        if (positions.has(code)) continue;
        const cur = px(code, i);
        if (!cur || !Number.isFinite(cur.p.open[cur.k]!)) continue; // 停牌
        if (limitHit(code, i, "buy")) continue; // 涨停开盘买不进
        const open = cur.p.open[cur.k]!;
        const sec = securities.get(code);
        let budget = Math.min(prevEquity / N, cash / vacancies);
        if (spec.sizing.maxWeight) budget = Math.min(budget, prevEquity * spec.sizing.maxWeight);
        let shares = sharesForBudget(
          market,
          sec?.board ?? null,
          sec?.lotSize ?? null,
          budget * 0.998,
          open,
        );
        let amount = shares * open;
        let fee = tradeFees(market, "buy", amount, date, costs).total;
        // 费用让现金不够时退一手
        while (shares > 0 && amount + fee > cash) {
          shares = sharesForBudget(
            market,
            sec?.board ?? null,
            sec?.lotSize ?? null,
            amount - open * 1.0001,
            open,
          );
          amount = shares * open;
          fee = tradeFees(market, "buy", amount, date, costs).total;
        }
        if (shares <= 0) continue;
        cash -= amount + fee;
        positions.set(code, {
          code,
          shares,
          entryIdx: i,
          entryPrice: open,
          entryAdj: cur.p.adj[cur.k]!,
          cost: amount + fee,
        });
        trades.push({
          date,
          code,
          side: "buy",
          price: open,
          shares,
          amount,
          fee,
          reason: spec.mode === "signals" ? "signal" : "entry",
        });
        vacancies--;
      }
    }

    // ── 3. 收盘：估值 ──
    let value = 0;
    const values = new Map<string, number>();
    for (const pos of positions.values()) {
      const v = posValue(pos, i);
      values.set(pos.code, v);
      value += v;
    }
    const equity = cash + value;
    series.push({
      date,
      nav: equity / params.capital,
      bench: Number.isFinite(bench[i]!) ? bench[i]! / bench0 : 1,
      cash,
      positions: positions.size,
    });
    if (execSet.has(i) || (spec.mode === "signals" && buyList?.length)) {
      holdings.push({
        date,
        items: [...values.entries()]
          .map(([code, v]) => ({ code, weight: equity > 0 ? v / equity : 0 }))
          .sort((a, b) => b.weight - a.weight),
      });
    }
    prevEquity = equity;

    // ── 4. 收盘：止盈止损 / 最长持有 ──
    const ex = spec.exits;
    for (const pos of positions.values()) {
      if (pendingSells.has(pos.code)) continue;
      const lc = lastClose(pos.code, i);
      if (!lc) continue;
      const ret = (lc.close * lc.adj) / (pos.entryPrice * pos.entryAdj) - 1;
      if (ex.takeProfit && ret >= ex.takeProfit) pendingSells.set(pos.code, "take_profit");
      else if (ex.stopLoss && ret <= -ex.stopLoss) pendingSells.set(pos.code, "stop_loss");
      else if (ex.maxHoldDays && i - pos.entryIdx >= ex.maxHoldDays)
        pendingSells.set(pos.code, "max_hold");
    }

    // ── 5. 收盘：明天调仓？ ──
    if (spec.mode === "rules" && execSet.has(i + 1) && ex.dropWhenFiltered) {
      const ranked = buyListAt.get(i + 1) ?? [];
      const inBand = new Set(ranked.slice(0, band));
      const inList = new Set(ranked);
      for (const pos of positions.values()) {
        if (pendingSells.has(pos.code) || inBand.has(pos.code)) continue;
        const cur = px(pos.code, i);
        // 决策日停牌：没有当天数据，不因「掉出名单」而卖
        if (!cur || !Number.isFinite(cur.p.close[cur.k]!)) continue;
        pendingSells.set(pos.code, inList.has(pos.code) ? "rebalance" : "filtered");
      }
    }
  }

  // ── 结果 ──
  const lastIdx = endIdx;
  const finalDate = calendar[lastIdx]!;
  const finalEquity = series.at(-1)!.nav * params.capital;
  const openPositions: OpenPosition[] = [...positions.values()].map((pos) => {
    const v = posValue(pos, lastIdx);
    const lc = lastClose(pos.code, lastIdx);
    return {
      code: pos.code,
      name: nameOf(pos.code),
      shares: lc ? pos.shares * (lc.adj / pos.entryAdj) : pos.shares,
      value: v,
      weight: finalEquity > 0 ? v / finalEquity : 0,
      entryDate: calendar[pos.entryIdx]!,
      entryPrice: pos.entryPrice,
      ret: lc ? (lc.close * lc.adj) / (pos.entryPrice * pos.entryAdj) - 1 : 0,
    };
  });
  // 下一个交易日要执行的单：卖单 + （若明天调仓/有信号）买单
  const pending: PendingOrder[] = [...pendingSells].map(([code, reason]) => ({
    code,
    name: nameOf(code),
    side: "sell",
    reason,
  }));
  const nextBuys = buyListAt.get(lastIdx + 1);
  if (nextBuys?.length) {
    const remaining = new Set([...positions.keys()].filter((c) => !pendingSells.has(c)));
    let vacancies = N - remaining.size;
    for (const code of nextBuys) {
      if (vacancies <= 0) break;
      if (remaining.has(code)) continue;
      pending.push({
        code,
        name: nameOf(code),
        side: "buy",
        reason: spec.mode === "signals" ? "signal" : "entry",
      });
      vacancies--;
    }
  }

  const metrics = computeMetrics(series, trades, params.capital);
  const oosStartDate = params.oosMonths > 0 ? oosStart(series, params.oosMonths) : null;
  const segments = oosStartDate
    ? {
        inSample: periodMetrics(series.filter((p) => p.date < oosStartDate)),
        outOfSample: periodMetrics(series.filter((p) => p.date >= oosStartDate)),
      }
    : { inSample: periodMetrics(series), outOfSample: null };
  const attr = attribution(trades, openPositions, holdings, securities);

  return {
    engineVersion: ENGINE_VERSION,
    series,
    trades,
    holdings,
    metrics,
    segments,
    attribution: attr,
    checks: runChecks({ input, metrics, segments, attribution: attr, trades }),
    final: { date: finalDate, cash, equity: finalEquity, positions: openPositions, pending },
  };
}

/** 样本外起点：区间最后 N 个月；区间不到 2N 个月时不分段。 */
function oosStart(series: SeriesPoint[], months: number): DateStr | null {
  if (series.length < 2) return null;
  const first = series[0]!.date;
  const last = series.at(-1)!.date;
  const y = Number(last.slice(0, 4));
  const m = Number(last.slice(5, 7)) - months;
  const d = new Date(Date.UTC(y, m - 1, Number(last.slice(8, 10))));
  const cut = d.toISOString().slice(0, 10);
  const spanMonths =
    (Number(last.slice(0, 4)) - Number(first.slice(0, 4))) * 12 +
    (Number(last.slice(5, 7)) - Number(first.slice(5, 7)));
  if (spanMonths < months * 2) return null;
  return cut;
}

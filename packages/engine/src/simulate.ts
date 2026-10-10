/**
 * 模拟器（纯函数，回测与向前跟踪共用，D13）。
 *
 * 时序（spec §5，D6）：T 日收盘后决策（选股、止盈止损），T+1 日开盘成交，先卖后买。
 * - 卖：停牌或（A 股）开盘价触及跌停 → 顺延到下一个交易日。
 * - 买：停牌或（A 股）开盘价触及涨停 → 当天放弃，空位留到下次调仓（D15）。
 * - 计价：持仓按等比复权因子折算（分红再投入）；止盈止损按含分红的涨跌判断（不含费用）。
 * - 调仓（D15 + 缓冲）：调仓日掉出前 ⌈top × buffer⌉ 名的持仓卖出，空位按名单顺序补足；
 *   新买入每只预算 = min(上一收盘总资产 × 仓位系数 / top, 现金 / 空位数, 单只上限)。持仓不做再平衡。
 * - 仓位控制（D52，可选）：每周最后一个交易日收盘，按当前持仓组合近 N 日的年化波动算出下周的仓位系数
 *   （目标波动 ÷ 实际波动，按 10% 取整，最多 1）；系数变了就在下一交易日开盘把每只持仓按同一比例增减。
 * - 按流动性成交（D64，挂在成交假设上）：成交价 = 开盘价加减半价差与冲击（fill.ts 的 quote），
 *   买单不超过决策日日均成交额的一定比例；旧办法成交时不经过报价，逐字节复现 1.1.0。
 *   拒单（停牌、涨跌停、上限、不够一手、现金不足、没有成交额数据）都记进 diagnostics，只记录、不改变决定。
 */
import {
  type BacktestParams,
  type DateStr,
  type HoldingSnapshot,
  isLegacyFill,
  type OpenPosition,
  type PendingOrder,
  type PriceSeries,
  periodKey,
  priceLimitPct,
  limitPrices,
  resolveExec,
  type SeriesPoint,
  sharesForBudget,
  type SimInput,
  type SimResult,
  type Trade,
  type TradeReason,
  tradeFees,
} from "@ivan/core";
import { runChecks } from "./checks.ts";
import { FillLog, lotFloor as lotFloorOf, type Quote, quote } from "./fill.ts";
import { annualDrag, attribution, computeMetrics, oosStart, periodMetrics } from "./metrics.ts";

/**
 * 引擎版本（D56）：本轮只从 1.1.0 升到 1.2.0 一次；之后的新行为都挂在成交假设 exec 的字段上，
 * 旧口径（exec 缺省 / LEGACY_EXEC）必须逐字节复现 1.1.0 的结果（legacy.test.ts）。
 */
export const ENGINE_VERSION = "1.2.0";

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
  // 成交假设：缺省字段按旧口径补齐；规则表与指标版本挂在它上面（D62、D63）
  const exec = resolveExec(params.exec);
  const rules = exec.rules;
  // 按流动性成交（D64）：旧办法（开盘价、不计滑点、不设上限）不经过报价；拒单统计两种都记
  const legacyFill = isLegacyFill(exec);
  const fills = new FillLog();
  const { startIdx, endIdx } = periodIndexes(calendar, params);
  if (startIdx < 1) throw new SimError("交易日历需要包含回测起点之前至少一个交易日");
  if (endIdx < startIdx) throw new SimError("回测区间内没有交易日");
  const market = spec.market;
  const N = spec.mode === "signals" ? (spec.signals?.maxPositions ?? 10) : (spec.rank?.top ?? 10);
  const band = Math.ceil(N * spec.rebalance.buffer);
  const costs = spec.costs ?? {};
  const volTarget = spec.exposure?.volTarget;
  const volLookback = spec.exposure?.lookback ?? 60;

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
  /**
   * 第 i 天开盘成交用的日均成交额 / 日波动（D64）：决策日（i − 1）及以前最后一个有效值。
   * 面板第 i 格含第 i 天自己的成交量，开盘时还不知道，用它就是偷看。
   */
  const decisionValue = (field: "adv" | "sigma", code: string, i: number): number => {
    const p = prices.get(code);
    const a = p?.[field];
    if (!p || !a) return NaN;
    for (let k = Math.min(i - 1 - p.from, a.length - 1); k >= 0; k--) {
      const v = a[k]!;
      if (Number.isFinite(v)) return v;
    }
    return NaN;
  };

  let cash = params.capital;
  const positions = new Map<string, Position>();
  const pendingSells = new Map<string, TradeReason>();
  const trades: Trade[] = [];
  const series: SeriesPoint[] = [];
  const holdings: HoldingSnapshot[] = [];
  let prevEquity = params.capital;
  /** 仓位系数：持仓规模相对「满仓」的比例（D52）；nextScale = 收盘定下、下一交易日开盘生效 */
  let scale = 1;
  let nextScale: number | null = null;

  const posValue = (pos: Position, i: number) => {
    const lc = lastClose(pos.code, i);
    if (!lc) return pos.cost;
    return pos.shares * lc.close * (lc.adj / pos.entryAdj);
  };

  /** 按交易单位向下取整的股数：A 股主板/创业板整百股，科创板按 1 股，港股按每手 */
  const lotFloor = (code: string, shares: number): number => {
    const sec = securities.get(code);
    if (market === "A")
      return sec?.board === "star" ? Math.floor(shares) : Math.floor(shares / 100) * 100;
    const lot = sec?.lotSize && sec.lotSize > 0 ? sec.lotSize : 100;
    return Math.floor(shares / lot) * lot;
  };

  /**
   * 当前持仓组合的年化波动（D52）：按当前市值加权，回看 volLookback 个交易日的日收益（含分红），
   * 再乘上「满仓时股票占总资产的比例」，这样有空仓位时不会高估。数据不够（少于 20 天）返回 null。
   */
  const holdingsVol = (i: number, equity: number): number | null => {
    const items: Array<{ p: PriceSeries; w: number }> = [];
    let total = 0;
    for (const pos of positions.values()) {
      const p = prices.get(pos.code);
      const v = posValue(pos, i);
      if (!p || !(v > 0)) continue;
      items.push({ p, w: v });
      total += v;
    }
    if (!items.length || !(total > 0) || !(equity > 0)) return null;
    const fullFrac = Math.min(1, total / Math.max(scale, 1e-9) / equity);
    const rets: number[] = [];
    for (let t = Math.max(1, i - volLookback + 1); t <= i; t++) {
      let r = 0;
      let seen = 0;
      for (const { p, w } of items) {
        const k = t - p.from;
        if (k < 1 || k >= p.close.length) continue;
        const a = p.close[k]! * p.adj[k]!;
        const b = p.close[k - 1]! * p.adj[k - 1]!;
        if (!Number.isFinite(a) || !Number.isFinite(b) || !(b > 0)) continue;
        r += (w / total) * (a / b - 1);
        seen += w;
      }
      if (seen > 0) rets.push(r * fullFrac);
    }
    if (rets.length < 20) return null;
    const mean = rets.reduce((x, y) => x + y, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((x, y) => x + (y - mean) ** 2, 0) / (rets.length - 1));
    return sd * Math.sqrt(243);
  };

  /** 上市后第几个交易日（上市当天 = 0）；上市日早于日历或不知道时当作老股 */
  const daysSinceList = (listDate: DateStr | null | undefined, i: number): number => {
    if (!listDate || listDate < calendar[0]!) return 1e9;
    return i - lowerBound(calendar, listDate);
  };

  /** A 股当日的涨跌停价（参考价 = 前收按复权因子折算到除权后）；港股、不设涨跌幅的日子为 null */
  const limitsAt = (code: string, i: number): { up: number; down: number } | null => {
    if (market !== "A") return null;
    const cur = px(code, i);
    if (!cur) return null;
    const { p, k } = cur;
    let pk = k - 1;
    while (pk >= 0 && !Number.isFinite(p.close[pk]!)) pk--;
    if (pk < 0) return null; // 上市首日不设限（默认也会排除次新股）
    const ref = (p.close[pk]! * p.adj[pk]!) / p.adj[k]!;
    const sec = securities.get(code);
    const pct =
      rules === 1
        ? priceLimitPct("A", sec?.board ?? null, p.st[k] === 1, calendar[i]!)
        : priceLimitPct("A", sec?.board ?? null, p.st[k] === 1, calendar[i]!, {
            rules,
            listDate: sec?.listDate ?? null,
            daysSinceList: daysSinceList(sec?.listDate, i),
          });
    if (pct === null) return null;
    return limitPrices(ref, pct);
  };

  /** A 股：当日开盘是否触及涨/跌停 */
  const limitHit = (code: string, i: number, side: "buy" | "sell"): boolean => {
    const lim = limitsAt(code, i);
    if (!lim) return false;
    const cur = px(code, i)!;
    const open = cur.p.open[cur.k]!;
    return side === "buy" ? open >= lim.up - 1e-6 : open <= lim.down + 1e-6;
  };

  /** 第 i 天开盘的报价（D64），带上决策日的日均成交额（成交记录要算参与率） */
  const quoteAt = (
    code: string,
    i: number,
    side: "buy" | "sell",
    open: number,
    wantValue: number,
    uncapped = false,
  ): { q: Quote; adv: number } => {
    const adv = decisionValue("adv", code, i);
    const q = quote(
      {
        market,
        exec,
        side,
        open,
        adv,
        sigma: decisionValue("sigma", code, i),
        limit: limitsAt(code, i),
        date: calendar[i]!,
        uncapped,
      },
      wantValue,
    );
    if (q.ok && q.sigmaFallback) fills.sigmaFallbacks++;
    return { q, adv };
  };
  /** 成交记录的参考价、价差与冲击金额、参与率 */
  const liquidityOf = (
    q: Quote,
    shares: number,
    amount: number,
    adv: number,
  ): Pick<Trade, "ref" | "slip" | "part"> => {
    if (!q.ok) return {};
    const slip = Math.abs(q.price - q.ref) * shares;
    return adv > 0 ? { ref: q.ref, slip, part: amount / adv } : { ref: q.ref, slip };
  };
  /** 买入股数的上限：上限金额 ÷ 价格，按交易单位向下取整（科创板不到 200 股为 0） */
  const capShares = (code: string, value: number, price: number): number => {
    const sec = securities.get(code);
    return lotFloorOf(market, sec?.board ?? null, sec?.lotSize ?? null, value / price, true);
  };

  for (let i = startIdx; i <= endIdx; i++) {
    const date = calendar[i]!;
    // 仓位控制：昨天收盘定下的系数今天开盘生效，已有持仓在买卖之后按比例增减（见 2.5）
    let scaleFrom: number | null = null;
    if (nextScale !== null) {
      scaleFrom = scale;
      scale = nextScale;
      nextScale = null;
    }

    // ── 0. 退市：到退市日还拿着的，按最后收盘价清出（长期停牌但没退市的继续冻结） ──
    for (const pos of [...positions.values()]) {
      const dl = securities.get(pos.code)?.delistDate;
      if (!dl || date < dl) continue;
      const lc = lastClose(pos.code, i);
      if (!lc) continue;
      const sharesNow = pos.shares * (lc.adj / pos.entryAdj);
      const amount = sharesNow * lc.close;
      const fee = tradeFees(market, "sell", amount, date, costs, rules).total;
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
      if (!cur || !Number.isFinite(cur.p.open[cur.k]!)) {
        fills.reject(date, code, "sell", "suspended", posValue(pos, i));
        continue; // 停牌：顺延
      }
      const open = cur.p.open[cur.k]!;
      const sharesNow = pos.shares * (cur.p.adj[cur.k]! / pos.entryAdj);
      if (limitHit(code, i, "sell")) {
        fills.reject(date, code, "sell", "limit_down", sharesNow * open);
        continue; // 跌停开盘：顺延
      }
      let price = open;
      let liq: Pick<Trade, "ref" | "slip" | "part"> = {};
      if (!legacyFill) {
        const { q, adv } = quoteAt(code, i, "sell", open, sharesNow * open);
        if (q.ok) {
          price = q.price;
          liq = liquidityOf(q, sharesNow, sharesNow * price, adv);
        }
      }
      const amount = sharesNow * price;
      const fee = tradeFees(market, "sell", amount, date, costs, rules).total;
      cash += amount - fee;
      trades.push({
        date,
        code,
        side: "sell",
        price,
        shares: sharesNow,
        amount,
        fee,
        reason,
        pnl: amount - fee - pos.cost,
        holdDays: i - pos.entryIdx,
        ...liq,
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
        const sec = securities.get(code);
        let budget = Math.min((prevEquity * scale) / N, cash / vacancies);
        if (spec.sizing.maxWeight) budget = Math.min(budget, prevEquity * spec.sizing.maxWeight);
        const cur = px(code, i);
        if (!cur || !Number.isFinite(cur.p.open[cur.k]!)) {
          fills.reject(date, code, "buy", "suspended", budget);
          continue; // 停牌
        }
        if (limitHit(code, i, "buy")) {
          fills.reject(date, code, "buy", "limit_up", budget);
          continue; // 涨停开盘买不进
        }
        const open = cur.p.open[cur.k]!;
        let price = open;
        let quoted: { q: Quote; adv: number } | null = null;
        if (!legacyFill) {
          quoted = quoteAt(code, i, "buy", open, budget);
          if (!(quoted.adv > 0)) fills.advUnknownBuys++;
          if (!quoted.q.ok) {
            fills.reject(date, code, "buy", quoted.q.reason, budget);
            continue; // 没有成交额数据：不能假设无限流动性
          }
          price = quoted.q.price;
        }
        let shares = sharesForBudget(
          market,
          sec?.board ?? null,
          sec?.lotSize ?? null,
          budget * 0.998,
          price,
        );
        // 单笔上限（D64）：超过决策日日均成交额的比例时截小，空位照样占用（D15）
        let capped = false;
        if (quoted?.q.ok && Number.isFinite(quoted.q.maxValue)) {
          const cap = capShares(code, quoted.q.maxValue, price);
          if (cap < shares) {
            shares = cap;
            capped = true;
          }
        }
        let amount = shares * price;
        let fee = tradeFees(market, "buy", amount, date, costs, rules).total;
        // 费用让现金不够时退一手
        let steppedDown = false;
        while (shares > 0 && amount + fee > cash) {
          steppedDown = true;
          shares = sharesForBudget(
            market,
            sec?.board ?? null,
            sec?.lotSize ?? null,
            amount - price * 1.0001,
            price,
          );
          amount = shares * price;
          fee = tradeFees(market, "buy", amount, date, costs, rules).total;
        }
        if (quoted) {
          fills.sized++;
          if (capped) fills.capped++;
        }
        if (shares <= 0) {
          // 空位不占用，名单顺延
          const why = steppedDown ? "cash" : capped ? "capacity" : "lot_zero";
          fills.reject(date, code, "buy", why, budget);
          continue;
        }
        if (capped) fills.reject(date, code, "buy", "capacity", budget, amount);
        cash -= amount + fee;
        positions.set(code, {
          code,
          shares,
          entryIdx: i,
          entryPrice: price,
          entryAdj: cur.p.adj[cur.k]!,
          cost: amount + fee,
        });
        let liq: Pick<Trade, "ref" | "slip" | "part"> = {};
        if (quoted) {
          liq = liquidityOf(quoted.q, shares, amount, quoted.adv);
          if (quoted.adv > 0) fills.parts.push(amount / quoted.adv);
        }
        trades.push({
          date,
          code,
          side: "buy",
          price,
          shares,
          amount,
          fee,
          reason: spec.mode === "signals" ? "signal" : "entry",
          ...liq,
        });
        vacancies--;
      }
    }

    // ── 2.5 开盘：仓位系数变了，已有持仓（今天新买的除外）按同一比例增减 ──
    if (scaleFrom !== null && scaleFrom > 0 && scale !== scaleFrom) {
      const f = scale / scaleFrom;
      const plans: Array<{ pos: Position; open: number; adjNow: number; real: number; q: number }> =
        [];
      for (const pos of positions.values()) {
        if (pos.entryIdx === i || pendingSells.has(pos.code)) continue;
        const cur = px(pos.code, i);
        if (!cur || !Number.isFinite(cur.p.open[cur.k]!)) continue; // 停牌：这只不调
        if (limitHit(pos.code, i, f < 1 ? "sell" : "buy")) continue;
        const adjNow = cur.p.adj[cur.k]!;
        const real = pos.shares * (adjNow / pos.entryAdj);
        const q = lotFloor(pos.code, real * Math.abs(1 - f));
        if (q > 0) plans.push({ pos, open: cur.p.open[cur.k]!, adjNow, real, q });
      }
      if (f > 1) {
        // 加仓：现金不够时所有加仓同比例缩小
        const need = plans.reduce((t, x) => t + x.q * x.open * 1.001, 0);
        if (need > cash && need > 0) {
          const k = (cash * 0.998) / need;
          for (const x of plans) x.q = lotFloor(x.pos.code, x.q * k);
        }
      }
      for (const { pos, open, adjNow, real, q } of plans) {
        if (q <= 0) continue;
        // 仓位控制的增减也付价差与冲击，但不设单笔上限（D64）
        let price = open;
        let liq: Pick<Trade, "ref" | "slip" | "part"> = {};
        if (!legacyFill) {
          const r = quoteAt(pos.code, i, f < 1 ? "sell" : "buy", open, q * open, true);
          if (r.q.ok) {
            price = r.q.price;
            liq = liquidityOf(r.q, q, q * price, r.adv);
          }
        }
        const amount = q * price;
        if (f < 1) {
          const fee = tradeFees(market, "sell", amount, date, costs, rules).total;
          const costPart = pos.cost * (q / real);
          cash += amount - fee;
          pos.cost -= costPart;
          pos.shares -= q * (pos.entryAdj / adjNow);
          trades.push({
            date,
            code: pos.code,
            side: "sell",
            price,
            shares: q,
            amount,
            fee,
            reason: "exposure",
            pnl: amount - fee - costPart,
            holdDays: i - pos.entryIdx,
            ...liq,
          });
          if (pos.shares * (adjNow / pos.entryAdj) < 1e-6) positions.delete(pos.code);
        } else {
          const fee = tradeFees(market, "buy", amount, date, costs, rules).total;
          if (amount + fee > cash) continue;
          cash -= amount + fee;
          pos.cost += amount + fee;
          pos.shares += q * (pos.entryAdj / adjNow);
          trades.push({
            date,
            code: pos.code,
            side: "buy",
            price,
            shares: q,
            amount,
            fee,
            reason: "exposure",
            ...liq,
          });
        }
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

    // ── 6. 收盘：仓位控制，每周最后一个交易日定下周的系数（D52） ──
    if (volTarget) {
      const next = calendar[i + 1];
      const weekEnd = next ? periodKey(next, "week") !== periodKey(date, "week") : false;
      if (weekEnd) {
        const vol = holdingsVol(i, equity);
        const target =
          vol && vol > 0 ? Math.min(1, Math.floor((volTarget / vol) * 10 + 1e-9) / 10) : 1;
        if (Math.abs(target - scale) >= 0.1 - 1e-9) nextScale = target;
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
      cost: pos.cost,
    };
  });
  // 下一个交易日要执行的单：卖单 + （若明天调仓/有信号）买单。
  // 估算（D64，给决策账本用）：在最后收盘价上用同一个报价与同样的预算规则估成交价、股数与仓位
  const nextDate = calendar[lastIdx + 1] ?? finalDate;
  const estQuote = (code: string, side: "buy" | "sell", refClose: number, want: number) =>
    quote(
      {
        market,
        exec,
        side,
        open: refClose,
        adv: decisionValue("adv", code, lastIdx + 1),
        sigma: decisionValue("sigma", code, lastIdx + 1),
        limit: null,
        date: nextDate,
      },
      want,
    );
  let estCash = cash;
  const pending: PendingOrder[] = [...pendingSells].map(([code, reason]) => {
    const o: PendingOrder = { code, name: nameOf(code), side: "sell", reason };
    const pos = positions.get(code);
    const lc = lastClose(code, lastIdx);
    if (pos && lc) {
      const shares = pos.shares * (lc.adj / pos.entryAdj);
      const value = shares * lc.close;
      const q = legacyFill ? null : estQuote(code, "sell", lc.close, value);
      const estPrice = q?.ok ? q.price : lc.close;
      const weight = finalEquity > 0 ? value / finalEquity : 0;
      o.estPrice = estPrice;
      o.estShares = shares;
      o.estWeight = weight;
      o.refClose = lc.close;
      o.curWeight = weight;
      const amount = shares * estPrice;
      estCash += amount - tradeFees(market, "sell", amount, nextDate, costs, rules).total;
    }
    return o;
  });
  const nextBuys = buyListAt.get(lastIdx + 1);
  if (nextBuys?.length) {
    const remaining = new Set([...positions.keys()].filter((c) => !pendingSells.has(c)));
    let vacancies = N - remaining.size;
    const scaleNext = nextScale ?? scale;
    for (const code of nextBuys) {
      if (vacancies <= 0) break;
      if (remaining.has(code)) continue;
      const o: PendingOrder = {
        code,
        name: nameOf(code),
        side: "buy",
        reason: spec.mode === "signals" ? "signal" : "entry",
      };
      const lc = lastClose(code, lastIdx);
      if (lc) {
        let budget = Math.min((finalEquity * scaleNext) / N, estCash / vacancies);
        if (spec.sizing.maxWeight) budget = Math.min(budget, finalEquity * spec.sizing.maxWeight);
        budget *= 0.998;
        const q = estQuote(code, "buy", lc.close, budget);
        const sec = securities.get(code);
        let shares = 0;
        if (q.ok) {
          shares = sharesForBudget(
            market,
            sec?.board ?? null,
            sec?.lotSize ?? null,
            budget,
            q.price,
          );
          if (Number.isFinite(q.maxValue))
            shares = Math.min(shares, capShares(code, q.maxValue, q.price));
        }
        const amount = q.ok ? shares * q.price : 0;
        o.estPrice = q.ok ? q.price : null;
        o.estShares = shares;
        o.estWeight = finalEquity > 0 ? amount / finalEquity : 0;
        o.refClose = lc.close;
        if (amount > 0)
          estCash -= amount + tradeFees(market, "buy", amount, nextDate, costs, rules).total;
      }
      pending.push(o);
      vacancies--;
    }
  }

  const exposure = volTarget ? { current: scale, next: nextScale ?? scale } : undefined;
  let anchor: SeriesPoint | undefined;
  let metrics: SimResult["metrics"];
  let segments: SimResult["segments"];
  if (exec.metrics === 1) {
    metrics = computeMetrics(series, trades, params.capital);
    const oosStartDate = params.oosMonths > 0 ? oosStart(series, params.oosMonths) : null;
    segments = oosStartDate
      ? {
          inSample: periodMetrics(series.filter((p) => p.date < oosStartDate)),
          outOfSample: periodMetrics(series.filter((p) => p.date >= oosStartDate)),
        }
      : { inSample: periodMetrics(series), outOfSample: null };
  } else {
    // 指标第 2 版（D63）：决策日虚拟加一点（净值 1，基准按决策日收盘归一），只在指标里加
    const b = bench[startIdx - 1]!;
    anchor = {
      date: calendar[startIdx - 1]!,
      nav: 1,
      bench: Number.isFinite(b) ? b / bench0 : 1,
      cash: params.capital,
      positions: 0,
    };
    metrics = computeMetrics(series, trades, params.capital, {
      version: 2,
      anchor,
      held: new Set(positions.keys()),
    });
    const oosStartDate = params.oosMonths > 0 ? oosStart(series, params.oosMonths, 2) : null;
    const first = series[0]?.date;
    // 样本内的数值带锚点算，起点写第一个真实的交易日（同 metrics.start）
    const fromFirst = (p: ReturnType<typeof periodMetrics>) => (first ? { ...p, start: first } : p);
    segments = oosStartDate
      ? {
          inSample: fromFirst(
            periodMetrics([anchor, ...series.filter((p) => p.date < oosStartDate)]),
          ),
          outOfSample: periodMetrics(series.filter((p) => p.date >= oosStartDate)),
        }
      : {
          inSample: fromFirst(periodMetrics([anchor, ...series], metrics.totalReturn)),
          outOfSample: null,
        };
  }
  // 按流动性成交（D64）：费用拖累拆成费用与滑点两部分（costDrag = 两者之和）
  fills.slippageCost = trades.reduce((s, t) => s + (t.slip ?? 0), 0);
  if (!legacyFill) {
    const slipDrag = annualDrag(series, params.capital, fills.slippageCost);
    metrics = {
      ...metrics,
      slippageCost: fills.slippageCost,
      feeDrag: metrics.costDrag,
      slipDrag,
      costDrag: metrics.costDrag + slipDrag,
    };
  }
  const diagnostics = fills.result({
    liquidity: !legacyFill,
    capital: params.capital,
    participation: exec.participation,
  });
  const attr = attribution(trades, openPositions, holdings, securities);

  return {
    engineVersion: ENGINE_VERSION,
    exec,
    series,
    ...(anchor ? { anchor } : {}),
    trades,
    holdings,
    metrics,
    segments,
    attribution: attr,
    checks: runChecks({ input, metrics, segments, attribution: attr, trades, diagnostics }),
    diagnostics,
    final: {
      date: finalDate,
      cash,
      equity: finalEquity,
      positions: openPositions,
      pending,
      exposure,
    },
  };
}

/** 日历上第一个 ≥ d 的下标 */
function lowerBound(calendar: readonly DateStr[], d: DateStr): number {
  let lo = 0;
  let hi = calendar.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (calendar[mid]! < d) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

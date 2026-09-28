/**
 * 市场规则与费率（spec §5）：整手、涨跌停、按日期生效的费率。回测与向前跟踪共用。
 */
import type { DateStr } from "./dates.ts";
import type { Market } from "./market.ts";

/** 涨跌幅限制（A 股）；港股返回 null（不设涨跌停）。 */
export function priceLimitPct(
  market: Market,
  board: string | null,
  isST: boolean,
  date: DateStr,
): number | null {
  if (market === "HK") return null;
  if (board === "star") return 0.2;
  if (board === "gem") return date >= "2020-08-24" ? 0.2 : isST ? 0.05 : 0.1;
  return isST ? 0.05 : 0.1;
}

/** 涨停价 / 跌停价（四舍五入到分）。 */
export function limitPrices(prevClose: number, pct: number): { up: number; down: number } {
  const r = (x: number) => Math.round(x * 100 + 1e-9) / 100;
  return { up: r(prevClose * (1 + pct)), down: r(prevClose * (1 - pct)) };
}

/**
 * 按预算能买多少股：A 股主板/创业板整百股；科创板至少 200 股、之后按 1 股递增；港股按每手股数。
 */
export function sharesForBudget(
  market: Market,
  board: string | null,
  lotSize: number | null,
  budget: number,
  price: number,
): number {
  if (!(price > 0) || !(budget > 0)) return 0;
  const raw = budget / price;
  if (market === "A") {
    if (board === "star") return raw >= 200 ? Math.floor(raw) : 0;
    return Math.floor(raw / 100) * 100;
  }
  const lot = lotSize && lotSize > 0 ? lotSize : 100;
  return Math.floor(raw / lot) * lot;
}

export interface CostOverrides {
  commission?: number;
  minCommission?: number;
}

export interface FeeBreakdown {
  commission: number;
  tax: number;
  other: number;
  total: number;
}

/** 单笔交易费用（spec §5 费率表，按日期生效）。 */
export function tradeFees(
  market: Market,
  side: "buy" | "sell",
  amount: number,
  date: DateStr,
  overrides: CostOverrides = {},
): FeeBreakdown {
  if (!(amount > 0)) return { commission: 0, tax: 0, other: 0, total: 0 };
  if (market === "A") {
    const rate = overrides.commission ?? 0.00025;
    const min = overrides.minCommission ?? 5;
    const commission = Math.max(amount * rate, min);
    const stamp = side === "sell" ? amount * (date >= "2023-08-28" ? 0.0005 : 0.001) : 0;
    const transfer = amount * 0.00001;
    return { commission, tax: stamp, other: transfer, total: commission + stamp + transfer };
  }
  const rate = overrides.commission ?? 0.0003;
  const min = overrides.minCommission ?? 3;
  const commission = Math.max(amount * rate, min);
  const stampRate = date >= "2023-11-17" ? 0.001 : date >= "2021-08-01" ? 0.0013 : 0.001;
  const stamp = amount * stampRate;
  const tradingFee = amount * 0.0000565;
  const levy = amount * 0.000027;
  const afrc = date >= "2022-01-01" ? amount * 0.0000015 : 0;
  const settlement = Math.min(Math.max(amount * 0.00002, 2), 100);
  const other = tradingFee + levy + afrc + settlement;
  return { commission, tax: stamp, other, total: commission + stamp + other };
}

/**
 * 市场规则与费率（spec §5）：整手、涨跌停、按日期生效的费率。回测与向前跟踪共用。
 *
 * 规则表版本（D62，成交假设 `exec.rules`）：
 * - 第 1 版：引擎 1.1.0 的写法，旧运行与跟踪永远按它算，逐字节不变（金标准守着）；
 * - 第 2 版：按日期的表格，每行写出处（`cite`）。表里出自记忆、标「待核对」的行，上线前要逐条对照交易所 / 港交所公告原文，
 *   错了只改一行。
 */
import type { DateStr } from "./dates.ts";
import type { Market } from "./market.ts";

export type RulesVersion = 1 | 2;

/** 按日期生效的一行规则：from 当天起生效，直到下一行的 from。 */
export interface DatedRow<T> {
  from: DateStr;
  value: T;
  /** 出处（公告名）；待核对的行写明「待核对」 */
  cite: string;
}

/** date 当天生效的那一行（表按 from 升序；早于第一行时取第一行）。 */
export function effective<T>(date: DateStr, rows: readonly DatedRow<T>[]): T {
  let v = rows[0]!.value;
  for (const r of rows) {
    if (r.from <= date) v = r.value;
    else break;
  }
  return v;
}

/** 沪深主板风险警示（ST）股票的涨跌幅 */
export const ST_MAIN_LIMIT: readonly DatedRow<number>[] = [
  { from: "1990-01-01", value: 0.05, cite: "沪深主板风险警示股票涨跌幅 5%" },
  {
    from: "2025-07-07",
    value: 0.1,
    cite: "沪深交易所 2025 年修订：主板风险警示股票涨跌幅调为 10%（待核对公告原文）",
  },
];

/**
 * 新股上市后不设涨跌幅的交易日数（按上市日查表）：注册制以后前 5 个交易日，之前只有上市首日。
 * 不在表里的板块（北交所等）只有上市首日。
 */
export const IPO_NO_LIMIT: Readonly<Record<"star" | "gem" | "main", readonly DatedRow<number>[]>> =
  {
    star: [
      { from: "1990-01-01", value: 1, cite: "上市首日不设涨跌幅" },
      {
        from: "2019-07-22",
        value: 5,
        cite: "科创板上市后前 5 个交易日不设涨跌幅（待核对公告原文）",
      },
    ],
    gem: [
      { from: "1990-01-01", value: 1, cite: "上市首日不设涨跌幅" },
      {
        from: "2020-08-24",
        value: 5,
        cite: "创业板注册制：前 5 个交易日不设涨跌幅（待核对公告原文）",
      },
    ],
    main: [
      { from: "1990-01-01", value: 1, cite: "上市首日不设涨跌幅" },
      {
        from: "2023-04-10",
        value: 5,
        cite: "主板注册制：前 5 个交易日不设涨跌幅（待核对公告原文）",
      },
    ],
  };

/** A 股过户费（按成交金额，双边） */
export const A_TRANSFER_FEE: readonly DatedRow<number>[] = [
  {
    from: "1990-01-01",
    value: 0.00002,
    cite: "过户费 0.02‰（2015-08-01 前沪市按股数收，此处近似）",
  },
  {
    from: "2022-04-29",
    value: 0.00001,
    cite: "中国结算 2022-04-29 起过户费下调 50%（待核对公告原文）",
  },
];

/** 港股交易费（联交所，按成交金额，双边） */
export const HK_TRADING_FEE: readonly DatedRow<number>[] = [
  { from: "1990-01-01", value: 0.00005, cite: "联交所交易费 0.005%" },
  {
    from: "2023-01-01",
    value: 0.0000565,
    cite: "联交所交易费 2023-01-01 起 0.00565%（待核对公告原文）",
  },
];

/** 港股价位表：[价格上限（含）, 最小价位]，按价格从低到高 */
export const HK_TICK_TABLE: readonly DatedRow<ReadonlyArray<readonly [number, number]>>[] = [
  {
    from: "1990-01-01",
    value: [
      [0.25, 0.001],
      [0.5, 0.005],
      [10, 0.01],
      [20, 0.02],
      [100, 0.05],
      [200, 0.1],
      [500, 0.2],
      [1000, 0.5],
      [2000, 1],
      [5000, 2],
      [Infinity, 5],
    ],
    cite: "港交所价位表（第一部分）",
  },
];

export interface LimitOpts {
  /** 规则表版本；缺省 1（旧口径） */
  rules?: RulesVersion;
  /** 上市日（第 2 版判断新股不设涨跌幅的窗口） */
  listDate?: DateStr | null;
  /** 上市后第几个交易日（上市当天 = 0） */
  daysSinceList?: number;
}

/** 涨跌幅限制（A 股）；港股返回 null（不设涨跌停）；第 2 版新股不设涨跌幅的日子也返回 null。 */
export function priceLimitPct(
  market: Market,
  board: string | null,
  isST: boolean,
  date: DateStr,
  o: LimitOpts = {},
): number | null {
  if ((o.rules ?? 1) === 1) {
    if (market === "HK") return null;
    if (board === "star") return 0.2;
    if (board === "gem") return date >= "2020-08-24" ? 0.2 : isST ? 0.05 : 0.1;
    return isST ? 0.05 : 0.1;
  }
  if (market === "HK") return null;
  if (o.listDate && o.daysSinceList !== undefined) {
    const rows =
      board === "star" || board === "gem" || board === "main" ? IPO_NO_LIMIT[board] : null;
    const n = rows ? effective(o.listDate, rows) : 1;
    if (o.daysSinceList < n) return null;
  }
  if (board === "bse") return 0.3;
  if (board === "star") return 0.2;
  if (board === "gem") return date >= "2020-08-24" ? 0.2 : isST ? 0.05 : 0.1;
  return isST ? effective(date, ST_MAIN_LIMIT) : 0.1;
}

/** 最小价位：A 股 0.01；港股按价位表。 */
export function tickSize(market: Market, price: number, date: DateStr): number {
  if (market === "A") return 0.01;
  const table = effective(date, HK_TICK_TABLE);
  for (const [upper, tick] of table) if (price <= upper) return tick;
  return table.at(-1)![1];
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

/** 单笔交易费用（spec §5 费率表，按日期生效）。rules = 2 时过户费、港股交易费查表，港股印花税按整港元取整。 */
export function tradeFees(
  market: Market,
  side: "buy" | "sell",
  amount: number,
  date: DateStr,
  overrides: CostOverrides = {},
  rules: RulesVersion = 1,
): FeeBreakdown {
  if (!(amount > 0)) return { commission: 0, tax: 0, other: 0, total: 0 };
  const v2 = rules >= 2;
  if (market === "A") {
    const rate = overrides.commission ?? 0.00025;
    const min = overrides.minCommission ?? 5;
    const commission = Math.max(amount * rate, min);
    const stamp = side === "sell" ? amount * (date >= "2023-08-28" ? 0.0005 : 0.001) : 0;
    const transfer = amount * (v2 ? effective(date, A_TRANSFER_FEE) : 0.00001);
    return { commission, tax: stamp, other: transfer, total: commission + stamp + transfer };
  }
  const rate = overrides.commission ?? 0.0003;
  const min = overrides.minCommission ?? 3;
  const commission = Math.max(amount * rate, min);
  const stampRate = date >= "2023-11-17" ? 0.001 : date >= "2021-08-01" ? 0.0013 : 0.001;
  // 第 2 版：印花税每边按整港元向上取整（减去 1e-9 免得浮点误差多进一元）
  const stamp = v2 ? Math.ceil(amount * stampRate - 1e-9) : amount * stampRate;
  const tradingFee = amount * (v2 ? effective(date, HK_TRADING_FEE) : 0.0000565);
  const levy = amount * 0.000027;
  const afrc = date >= "2022-01-01" ? amount * 0.0000015 : 0;
  const settlement = Math.min(Math.max(amount * 0.00002, 2), 100);
  const other = tradingFee + levy + afrc + settlement;
  return { commission, tax: stamp, other, total: commission + stamp + other };
}

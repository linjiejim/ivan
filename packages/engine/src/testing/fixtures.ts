/**
 * 引擎夹具（纯函数，无 IO）：手算测试与 1.1.0 金标准（D56）共用同一套输入。
 *
 * 每个构造器每次调用都返回全新的对象（Map、Float64Array 不共享），测试里改了也不影响别的用例。
 * 金标准记录的是这些夹具在引擎上的结果指纹：夹具一旦提交就不能再改（港股的稀疏日历是有意的），
 * 要新场景就加新夹具。
 */
import {
  addDays,
  type DateStr,
  type PriceSeries,
  periodKey,
  type SecurityInfo,
  type Signal,
  type SimInput,
  type StrategySpec,
  StrategySpecSchema,
  weekday,
} from "@ivan/core";

/** 从 start 起 count 个工作日（周一到周五），不含 start 之前的日子。 */
export function weekdays(start: DateStr, count: number): DateStr[] {
  const out: DateStr[] = [];
  for (let d = start; out.length < count; d = addDays(d, 1)) {
    const w = weekday(d);
    if (w !== 0 && w !== 6) out.push(d);
  }
  return out;
}

interface SeriesOpts {
  /** 指定日子的开盘价（默认 = 收盘价） */
  open?: Record<string, number>;
  /** 停牌（没有行情）的日子 */
  missing?: string[];
  /** 从某天起复权因子变成某个值（模拟除息） */
  adjFrom?: [string, number];
  /** ST 的日子 */
  st?: string[];
}

/** 一只股票在 calendar 上的价格序列：高低价取开收的较大 / 较小值，缺行情（或收盘 NaN）的日子全为 NaN。 */
export function seriesOn(
  calendar: readonly DateStr[],
  code: string,
  closes: readonly number[],
  opts: SeriesOpts = {},
): PriceSeries {
  const n = calendar.length;
  const f = (v: number) => new Float64Array(n).fill(v);
  const s: PriceSeries = {
    code,
    from: 0,
    open: f(NaN),
    high: f(NaN),
    low: f(NaN),
    close: f(NaN),
    adj: f(1),
    st: new Uint8Array(n),
  };
  for (let i = 0; i < n; i++) {
    if (opts.missing?.includes(calendar[i]!)) continue;
    const c = closes[i]!;
    if (!Number.isFinite(c)) continue;
    const o = opts.open?.[calendar[i]!] ?? c;
    s.open[i] = o;
    s.close[i] = c;
    s.high[i] = Math.max(o, c);
    s.low[i] = Math.min(o, c);
    if (opts.adjFrom && calendar[i]! >= opts.adjFrom[0]) s.adj[i] = opts.adjFrom[1];
    if (opts.st?.includes(calendar[i]!)) s.st[i] = 1;
  }
  return s;
}

const flatBench = (n: number) => new Float64Array(n).fill(1000);

// ── 基础夹具：3 只 A 股主板股票、24 个交易日（simulate.test.ts 的手算夹具） ──

/** 基础夹具的原始数据：手算测试要直接用日历、收盘价和价格表。 */
export function baseData() {
  // 2025-06-02（周一）起 24 个工作日（到 07-03）；回测从 06-03 开始（06-02 是决策日）
  const calendar = weekdays("2025-06-02", 24);
  const n = calendar.length;
  const flat = (v: number) => new Array(n).fill(v) as number[];
  // AAA：10 元横盘；06-10 除息 0.5 元（因子 × 10 / 9.5），之后收 9.5
  const aaaCloses = flat(10).map((v, i) => (calendar[i]! >= "2025-06-10" ? 9.5 : v));
  // BBB：20 元，06-05 起一路跌，触发 10% 止损
  const bbbCloses = flat(20).map((v, i) => (calendar[i]! >= "2025-06-05" ? 17.5 : v));
  // CCC：第一天开盘涨停（前收 10 → 开 11），买不进；06-05 停牌
  const cccCloses = flat(10).map((v, i) => (i >= 1 ? 11 : v));
  const prices = new Map<string, PriceSeries>([
    [
      "000001.SZ",
      seriesOn(calendar, "000001.SZ", aaaCloses, { adjFrom: ["2025-06-10", 10 / 9.5] }),
    ],
    ["000002.SZ", seriesOn(calendar, "000002.SZ", bbbCloses, { missing: ["2025-06-06"] })],
    ["000003.SZ", seriesOn(calendar, "000003.SZ", cccCloses, { open: { "2025-06-03": 11 } })],
  ]);
  const securities = new Map<string, SecurityInfo>([
    ["000001.SZ", { code: "000001.SZ", name: "甲", board: "main", lotSize: 100, industry: "银行" }],
    ["000002.SZ", { code: "000002.SZ", name: "乙", board: "main", lotSize: 100, industry: "地产" }],
    ["000003.SZ", { code: "000003.SZ", name: "丙", board: "main", lotSize: 100, industry: "医药" }],
  ]);
  const spec: StrategySpec = StrategySpecSchema.parse({
    name: "夹具",
    market: "A",
    rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 3 },
    rebalance: { every: "month", buffer: 1 },
    exits: { stopLoss: 0.1 },
  });
  return { calendar, n, aaaCloses, bbbCloses, cccCloses, prices, securities, spec };
}

/** 基础夹具：月度调仓前 3 只，覆盖涨停买不进、停牌顺延、分红、止损、整手、最低佣金。 */
export function baseFixture(extra: Partial<SimInput> = {}): SimInput {
  const { calendar, n, prices, securities, spec } = baseData();
  return {
    spec,
    params: { start: "2025-06-03", end: calendar.at(-1)!, capital: 100_000, oosMonths: 0 },
    calendar,
    prices,
    securities,
    selections: new Map([["2025-06-02", ["000003.SZ", "000001.SZ", "000002.SZ"]]]),
    bench: flatBench(n),
    benchLabel: "测试基准",
    benchWithDividends: true,
    ...extra,
  };
}

/** 月初调仓：7 月第一个交易日按 6 月最后一天的名单补位（甲掉出、乙重新买、丙不再涨停）。 */
export function monthlyFixture(): SimInput {
  const { calendar } = baseData();
  const july = calendar.find((d) => d >= "2025-07-01")!;
  return baseFixture({
    selections: new Map([
      ["2025-06-02", ["000003.SZ", "000001.SZ", "000002.SZ"]],
      [calendar[calendar.indexOf(july) - 1]!, ["000002.SZ", "000003.SZ"]],
    ]),
  });
}

/** 退市清出：甲的退市日 06-20 在区间内，06-16 起没有行情。 */
export function delistFixture(): SimInput {
  const { calendar, aaaCloses, prices, securities } = baseData();
  const delisting = new Map(securities);
  delisting.set("000001.SZ", { ...securities.get("000001.SZ")!, delistDate: "2025-06-20" });
  const cut = new Map(prices);
  cut.set(
    "000001.SZ",
    seriesOn(calendar, "000001.SZ", aaaCloses, {
      adjFrom: ["2025-06-10", 10 / 9.5],
      missing: calendar.filter((d) => d >= "2025-06-16"),
    }),
  );
  return baseFixture({ prices: cut, securities: delisting });
}

// ── 仓位控制（D52）：一只股票、80 个交易日 ──

export const EXPOSURE_CALENDAR_START = "2025-01-06";

/** 仓位控制夹具的通用构造：一只股票，每天都在名单里，季度调仓前 1 只。 */
export function exposureInput(
  code: string,
  closeAt: (i: number) => number,
  volTarget?: number,
): SimInput {
  const calendar = weekdays(EXPOSURE_CALENDAR_START, 80);
  const n = calendar.length;
  const close = Float64Array.from({ length: n }, (_, i) => closeAt(i));
  const series: PriceSeries = {
    code,
    from: 0,
    open: close,
    high: close,
    low: close,
    close,
    adj: new Float64Array(n).fill(1),
    st: new Uint8Array(n),
  };
  const securities = new Map<string, SecurityInfo>([
    [
      "000001.SZ",
      { code: "000001.SZ", name: "波动大", board: "main", lotSize: 100, industry: "电子" },
    ],
    [
      "000002.SZ",
      { code: "000002.SZ", name: "很平稳", board: "main", lotSize: 100, industry: "公用" },
    ],
  ]);
  const spec = StrategySpecSchema.parse({
    name: "仓位控制",
    market: "A",
    rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 1 },
    rebalance: { every: "quarter", buffer: 1 },
    ...(volTarget ? { exposure: { volTarget, lookback: 20 } } : {}),
  });
  return {
    spec,
    params: { start: calendar[1]!, end: calendar.at(-1)!, capital: 1_000_000, oosMonths: 0 },
    calendar,
    prices: new Map([[code, series]]),
    securities,
    selections: new Map(calendar.map((d) => [d, [code]])),
    bench: flatBench(n),
    benchLabel: "测试基准",
    benchWithDividends: true,
  };
}

/** 10 / 10.6 来回跳（不碰 10% 涨跌停）：日波动约 5.8%，年化约 90% */
export const choppyClose = (i: number) => (i % 2 === 0 ? 10 : 10.6);
/** 几乎不动 */
export const calmClose = (i: number) => 10 * (1 + 0.0005 * Math.sin(i));

/** 三种仓位控制场景：波动远超目标（choppy）、波动很低（calm）、不设仓位控制（none）。 */
export function exposureFixture(kind: "choppy" | "calm" | "none"): SimInput {
  if (kind === "choppy") return exposureInput("000001.SZ", choppyClose, 0.2);
  if (kind === "calm") return exposureInput("000002.SZ", calmClose, 0.2);
  return exposureInput("000001.SZ", choppyClose);
}

// ── 港股：每手 500 与 2000，交易跨过三个费率变化日 ──

/**
 * 港股夹具：两只主板股票（每手 500、2000），日历是四段各 15 个工作日，分别围着
 * 2021-08-01（印花税 0.1% → 0.13%）、2022-01-01（开始收财汇局交易征费）、
 * 2023-01-01（1.1.0 在这天没有费率变化；S04 的规则表 v2 在这天调港股交易费）、2023-11-17（印花税回到 0.1%）；
 * 每周调仓前 1 只、名单逐周轮换，所以每个日子前后都有买有卖。稀疏日历是有意的，不能改。
 */
export function hkFixture(): SimInput {
  const calendar = [
    ...weekdays("2021-07-19", 15),
    ...weekdays("2021-12-20", 15),
    ...weekdays("2022-12-19", 15),
    ...weekdays("2023-11-06", 15),
  ];
  const n = calendar.length;
  const aCloses = calendar.map((_, i) => Math.round(50 * (1 + 0.04 * Math.sin(i / 2)) * 100) / 100);
  const bCloses = calendar.map(
    (_, i) => Math.round(3.2 * (1 + 0.05 * Math.cos(i / 3)) * 1000) / 1000,
  );
  const prices = new Map<string, PriceSeries>([
    ["00005.HK", seriesOn(calendar, "00005.HK", aCloses)],
    ["03988.HK", seriesOn(calendar, "03988.HK", bCloses)],
  ]);
  const securities = new Map<string, SecurityInfo>([
    [
      "00005.HK",
      { code: "00005.HK", name: "港甲", board: "hk_main", lotSize: 500, industry: "银行" },
    ],
    [
      "03988.HK",
      { code: "03988.HK", name: "港乙", board: "hk_main", lotSize: 2000, industry: "银行" },
    ],
  ]);
  // 名单逐周轮换：周五的名单给下一周用，所以周五算下一周；偶数周港甲第一，奇数周港乙第一
  const selections = new Map<string, string[]>();
  let week = -1;
  let prevKey = "";
  for (const d of calendar) {
    const k = periodKey(d, "week");
    if (k !== prevKey) week++;
    prevKey = k;
    const w = week + (weekday(d) === 5 ? 1 : 0);
    selections.set(d, w % 2 === 0 ? ["00005.HK", "03988.HK"] : ["03988.HK", "00005.HK"]);
  }
  const spec = StrategySpecSchema.parse({
    name: "港股夹具",
    market: "HK",
    rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 1 },
    rebalance: { every: "week", buffer: 1 },
  });
  return {
    spec,
    params: { start: calendar[1]!, end: calendar.at(-1)!, capital: 1_000_000, oosMonths: 0 },
    calendar,
    prices,
    securities,
    selections,
    bench: Float64Array.from({ length: n }, (_, i) => 20_000 * 1.0004 ** i),
    benchLabel: "测试基准",
    benchWithDividends: true,
  };
}

// ── 信号模式 ──

/**
 * 信号模式：4 只 A 股、30 个交易日，最多同时持有 2 只，持有 5 个交易日或涨 8% 就卖（两种卖出都会发生）。
 * 买入循环的三条跳过分支都走到（signals.test 里有断言盯着，夹具改了会报）：
 * - 满仓时发出的信号：第 5 天两只都拿着，信丁买不进；
 * - 下一交易日停牌（开盘 NaN）：第 11 天有空位，信丙停牌跳过、同一天的信丁照常买；
 * - 已持有时重复发出：第 13 天还有一个空位，信丁已持有不加仓、同一天的信甲照常买。
 */
export function signalsFixture(): SimInput {
  const calendar = weekdays("2024-03-04", 30);
  const n = calendar.length;
  const at = (i: number) => calendar[i]!;
  const closes = (base: number, drift: number) =>
    calendar.map((_, i) => Math.round(base * (1 + drift * i) * 100) / 100);
  const prices = new Map<string, PriceSeries>([
    ["600001.SH", seriesOn(calendar, "600001.SH", closes(10, 0.004))],
    // 信乙每天约 +2%，持有 4 天后触发 8% 止盈
    ["600002.SH", seriesOn(calendar, "600002.SH", closes(8, 0.02))],
    // 信丙：第 11 天停牌（信号在第 10 天，第 11 天开盘买不进）
    ["600003.SH", seriesOn(calendar, "600003.SH", closes(15, -0.002), { missing: [at(11)] })],
    ["600004.SH", seriesOn(calendar, "600004.SH", closes(5, 0.001))],
  ]);
  const securities = new Map<string, SecurityInfo>([
    [
      "600001.SH",
      { code: "600001.SH", name: "信甲", board: "main", lotSize: 100, industry: "电力" },
    ],
    [
      "600002.SH",
      { code: "600002.SH", name: "信乙", board: "main", lotSize: 100, industry: "电子" },
    ],
    [
      "600003.SH",
      { code: "600003.SH", name: "信丙", board: "main", lotSize: 100, industry: "化工" },
    ],
    [
      "600004.SH",
      { code: "600004.SH", name: "信丁", board: "main", lotSize: 100, industry: "建筑" },
    ],
  ]);
  const signals: Signal[] = [
    { date: at(1), code: "600001.SH" },
    { date: at(2), code: "600002.SH" },
    // 满仓时发出，买不进
    { date: at(4), code: "600004.SH" },
    // 第 8、9 天两只都卖了；信丙下一个交易日停牌买不进，信丁照常买
    { date: at(10), code: "600003.SH" },
    { date: at(10), code: "600004.SH" },
    // 还有一个空位：信丁已持有，重复信号不加仓；信甲照常买
    { date: at(12), code: "600004.SH" },
    { date: at(12), code: "600001.SH" },
    { date: at(20), code: "600003.SH" },
  ];
  const spec = StrategySpecSchema.parse({
    name: "信号夹具",
    market: "A",
    mode: "signals",
    signals: { datasetId: "ds_fixture", maxPositions: 2 },
    exits: { takeProfit: 0.08, maxHoldDays: 5 },
  });
  return {
    spec,
    params: { start: at(1), end: calendar.at(-1)!, capital: 200_000, oosMonths: 0 },
    calendar,
    prices,
    securities,
    selections: new Map(),
    signals,
    bench: flatBench(n),
    benchLabel: "测试基准",
    benchWithDividends: true,
  };
}

// ── 单只上限 ──

/**
 * 单只上限 maxWeight 0.2：月度调仓前 3 只（等权本该 33%），预算被压到 20%；
 * 高价股（每股 150 元）整百股取整后只能买 100 股，整手约束起作用。
 */
export function maxWeightFixture(): SimInput {
  const calendar = weekdays("2024-05-27", 30);
  const n = calendar.length;
  const wave = (base: number, amp: number) =>
    calendar.map((_, i) => Math.round(base * (1 + amp * Math.sin(i / 4)) * 100) / 100);
  const prices = new Map<string, PriceSeries>([
    ["000101.SZ", seriesOn(calendar, "000101.SZ", wave(10, 0.03))],
    ["000102.SZ", seriesOn(calendar, "000102.SZ", wave(25, -0.02))],
    ["000103.SZ", seriesOn(calendar, "000103.SZ", wave(150, 0.01))],
    ["000104.SZ", seriesOn(calendar, "000104.SZ", wave(6, 0.05))],
  ]);
  const securities = new Map<string, SecurityInfo>([
    [
      "000101.SZ",
      { code: "000101.SZ", name: "限甲", board: "main", lotSize: 100, industry: "食品" },
    ],
    [
      "000102.SZ",
      { code: "000102.SZ", name: "限乙", board: "main", lotSize: 100, industry: "家电" },
    ],
    [
      "000103.SZ",
      { code: "000103.SZ", name: "限丙", board: "main", lotSize: 100, industry: "白酒" },
    ],
    [
      "000104.SZ",
      { code: "000104.SZ", name: "限丁", board: "main", lotSize: 100, industry: "钢铁" },
    ],
  ]);
  const june = calendar.find((d) => d >= "2024-06-01")!;
  const july = calendar.find((d) => d >= "2024-07-01")!;
  const spec = StrategySpecSchema.parse({
    name: "单只上限夹具",
    market: "A",
    rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 3 },
    rebalance: { every: "month", buffer: 1 },
    sizing: { method: "equal", maxWeight: 0.2 },
  });
  return {
    spec,
    params: { start: calendar[1]!, end: calendar.at(-1)!, capital: 100_000, oosMonths: 0 },
    calendar,
    prices,
    securities,
    selections: new Map([
      [calendar[0]!, ["000103.SZ", "000101.SZ", "000102.SZ"]],
      [calendar[calendar.indexOf(june) - 1]!, ["000101.SZ", "000104.SZ", "000103.SZ"]],
      [calendar[calendar.indexOf(july) - 1]!, ["000102.SZ", "000103.SZ", "000104.SZ"]],
    ]),
    bench: flatBench(n),
    benchLabel: "测试基准",
    benchWithDividends: true,
  };
}

// ── 科创板 ──

/**
 * 科创板：200 股起、之后按 1 股递增，涨跌幅 20%。每周调仓前 2 只：
 * 星乙 300 元，预算约 5 万买不够 200 股，一直跳过；星甲按 1 股取整；
 * 星丙第三周一开盘涨停（+20%）买不进，第四周一开盘 +15%（主板会碰涨停，科创板不会）照常买入。
 */
export function starFixture(): SimInput {
  const calendar = weekdays("2024-09-02", 25);
  const n = calendar.length;
  const at = (i: number) => calendar[i]!;
  // 星甲 123.45 元，第 8 天收盘 +15%
  const aCloses = calendar.map((_, i) => (i < 8 ? 123.45 : Math.round(123.45 * 1.15 * 100) / 100));
  // 星乙 300 元
  const bCloses = calendar.map(() => 300);
  // 星丙 40 元；第 10 天开盘涨停 48、收 46；第 15 天开盘 52.9（+15%）
  const cCloses = calendar.map((_, i) => (i < 10 ? 40 : i < 15 ? 46 : 52.9));
  const prices = new Map<string, PriceSeries>([
    ["688001.SH", seriesOn(calendar, "688001.SH", aCloses)],
    ["688002.SH", seriesOn(calendar, "688002.SH", bCloses)],
    ["688003.SH", seriesOn(calendar, "688003.SH", cCloses, { open: { [at(10)]: 48 } })],
  ]);
  const securities = new Map<string, SecurityInfo>([
    [
      "688001.SH",
      { code: "688001.SH", name: "星甲", board: "star", lotSize: 200, industry: "半导体" },
    ],
    [
      "688002.SH",
      { code: "688002.SH", name: "星乙", board: "star", lotSize: 200, industry: "软件" },
    ],
    [
      "688003.SH",
      { code: "688003.SH", name: "星丙", board: "star", lotSize: 200, industry: "医疗" },
    ],
  ]);
  const selections = new Map<string, string[]>();
  for (let i = 0; i < n; i++) {
    // 第一周：星乙、星甲、星丙；第二周星丙掉出名单（卖出）；第三周起星丙排第一
    selections.set(
      at(i),
      i < 4
        ? ["688002.SH", "688001.SH", "688003.SH"]
        : i < 9
          ? ["688002.SH", "688001.SH"]
          : ["688003.SH", "688001.SH", "688002.SH"],
    );
  }
  const spec = StrategySpecSchema.parse({
    name: "科创板夹具",
    market: "A",
    universe: { boards: ["star"] },
    rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 2 },
    rebalance: { every: "week", buffer: 1 },
  });
  return {
    spec,
    params: { start: at(1), end: calendar.at(-1)!, capital: 100_000, oosMonths: 0 },
    calendar,
    prices,
    securities,
    selections,
    bench: flatBench(n),
    benchLabel: "测试基准",
    benchWithDividends: true,
  };
}

/** 金标准覆盖的 10 个夹具（键名即 legacy-1.1.0.json 里的键）。 */
export const LEGACY_FIXTURES: Record<string, () => SimInput> = {
  base: () => baseFixture(),
  monthly: monthlyFixture,
  "exposure.choppy": () => exposureFixture("choppy"),
  "exposure.calm": () => exposureFixture("calm"),
  "exposure.none": () => exposureFixture("none"),
  hk: hkFixture,
  signals: signalsFixture,
  maxWeight: maxWeightFixture,
  delist: delistFixture,
  star: starFixture,
};

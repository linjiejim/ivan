/**
 * 组装回测输入（纯数据，交给引擎）：日历 → 决策日选股 → 价格面板 → 基准 → 数据局限说明。
 * 重计算留在 DuckDB（选股），JS 里只装被选中过的股票的日线（D3）。
 */
import {
  addDays,
  type BacktestParams,
  benchmarkOf,
  BENCHMARKS,
  type DateStr,
  type PriceSeries,
  type SecurityInfo,
  type Signal,
  type SimInput,
  type StrategySpec,
  weekday,
} from "@ivan/core";
import { rebalanceDays } from "@ivan/engine";
import { sqlCodeList, type Warehouse } from "../warehouse/db.ts";
import { runSelection } from "./selection.ts";

export interface DataVersionInfo {
  id: number | null;
  asOf: DateStr | null;
}

export async function latestDataVersion(wh: Warehouse, market: string): Promise<DataVersionInfo> {
  const r = await wh.one<{ id: number; as_of: string }>(
    `SELECT id, as_of::VARCHAR AS as_of FROM data_versions WHERE market = $m ORDER BY id DESC LIMIT 1`,
    { m: market },
  );
  return { id: r?.id ?? null, asOf: r?.as_of ?? null };
}

export interface BuildOptions {
  signals?: Signal[];
  priorVersionsOnPeriod?: number;
  /**
   * 向前跟踪：在日历末尾补一个「下一个工作日」，让引擎给出明日计划（节假日可能不准，只影响计划日期标注）。
   */
  appendNextDay?: boolean;
}

export interface BuiltInput {
  input: SimInput;
  dataVersion: DataVersionInfo;
  /** 实际使用的区间（end 会被截到数据截至日） */
  params: BacktestParams;
  stats: { decisionDates: number; codes: number; priceRows: number; ms: number };
}

export async function buildSimInput(
  wh: Warehouse,
  spec: StrategySpec,
  paramsIn: BacktestParams,
  opts: BuildOptions = {},
): Promise<BuiltInput> {
  const t0 = Date.now();
  const market = spec.market;
  const dataVersion = await latestDataVersion(wh, market);
  const lastDay = await wh.scalar<string>(
    `SELECT max(date)::VARCHAR FROM factors_daily WHERE market = $m`,
    { m: market },
  );
  if (!lastDay) throw new Error(`${market} 行情仓还没有数据，先运行回填`);
  const params = { ...paramsIn, end: paramsIn.end > lastDay ? lastDay : paramsIn.end };

  const calRows = await wh.all<{ d: string }>(
    `SELECT DISTINCT date::VARCHAR AS d FROM trade_calendar
     WHERE market = $m AND date >= $a::DATE AND date <= $b::DATE ORDER BY d`,
    { m: market, a: addDays(params.start, -15), b: params.end },
  );
  const calendar = calRows.map((r) => r.d);
  if (opts.appendNextDay && calendar.at(-1) === lastDay) {
    let next = addDays(lastDay, 1);
    while (weekday(next) === 0 || weekday(next) === 6) next = addDays(next, 1);
    calendar.push(next);
  }

  // 选股
  let selections = new Map<DateStr, string[]>();
  let decisionDates: DateStr[] = [];
  if (spec.mode === "rules" && spec.rank) {
    decisionDates = rebalanceDays(calendar, params, spec.rebalance.every).decisionDates.filter(
      (d) => d <= lastDay,
    );
    const limit = Math.ceil(spec.rank.top * spec.rebalance.buffer) + spec.rank.top;
    selections = await runSelection(wh, spec, decisionDates, limit);
  }
  const codes = new Set<string>();
  for (const list of selections.values()) for (const c of list) codes.add(c);
  for (const s of opts.signals ?? []) codes.add(s.code);
  const codeList = [...codes];

  // 价格面板
  const prices = new Map<string, PriceSeries>();
  const securities = new Map<string, SecurityInfo>();
  let priceRows = 0;
  if (codeList.length) {
    const calIdx = new Map(calendar.map((d, i) => [d, i]));
    const cols = await wh.columns(
      `SELECT b.code, b.date::VARCHAR AS d, b.open, b.high, b.low, b.close, b.adj,
              coalesce(f.flag_st, false) AS st
       FROM bars_daily b
       LEFT JOIN factors_daily f ON f.code = b.code AND f.date = b.date
       WHERE b.code IN (${sqlCodeList(codeList)})
         AND b.date >= $a::DATE AND b.date <= $b::DATE
       ORDER BY b.code, b.date`,
      { a: calendar[0]!, b: calendar.at(-1)! },
    );
    const code = cols.code as string[];
    const d = cols.d as string[];
    priceRows = code.length;
    let i = 0;
    while (i < code.length) {
      const c = code[i]!;
      let j = i;
      while (j < code.length && code[j] === c) j++;
      // 这只股票在日历上的起点
      let from = calIdx.get(d[i]!) ?? 0;
      for (let k = i; k < j; k++) {
        const ci = calIdx.get(d[k]!);
        if (ci !== undefined) {
          from = Math.min(from, ci);
          break;
        }
      }
      const len = calendar.length - from;
      const f = () => new Float64Array(len).fill(NaN);
      const s: PriceSeries = {
        code: c,
        from,
        open: f(),
        high: f(),
        low: f(),
        close: f(),
        adj: new Float64Array(len).fill(NaN),
        st: new Uint8Array(len),
      };
      for (let k = i; k < j; k++) {
        const ci = calIdx.get(d[k]!);
        if (ci === undefined || ci < from) continue;
        const x = ci - from;
        s.open[x] = cols.open![k] as number;
        s.high[x] = cols.high![k] as number;
        s.low[x] = cols.low![k] as number;
        s.close[x] = cols.close![k] as number;
        s.adj[x] = cols.adj![k] as number;
        s.st[x] = cols.st![k] ? 1 : 0;
      }
      // 缺行情的日子因子沿用前值（停牌期间除权的极少数情况由下一根 K 线的因子体现）
      let lastAdj = NaN;
      for (let x = 0; x < len; x++) {
        if (Number.isFinite(s.adj[x]!)) lastAdj = s.adj[x]!;
        else if (Number.isFinite(lastAdj)) s.adj[x] = lastAdj;
      }
      const firstAdj = s.adj.find((v) => Number.isFinite(v)) ?? 1;
      for (let x = 0; x < len && !Number.isFinite(s.adj[x]!); x++) s.adj[x] = firstAdj;
      prices.set(c, s);
      i = j;
    }
    const secs = await wh.all<{
      code: string;
      name: string;
      board: string;
      lot_size: number;
      industry: string;
      delist_date: string | null;
    }>(
      `SELECT code, name, board, lot_size, industry, delist_date::VARCHAR AS delist_date
       FROM securities WHERE code IN (${sqlCodeList(codeList)})`,
    );
    for (const s of secs) {
      securities.set(s.code, {
        code: s.code,
        name: s.name ?? s.code,
        board: s.board ?? null,
        lotSize: s.lot_size ?? null,
        industry: s.industry ?? null,
        delistDate: s.delist_date ?? null,
      });
    }
  }

  // 基准
  const bk = BENCHMARKS[benchmarkOf(spec)];
  const benchRows = await wh.all<{ d: string; close: number }>(
    `SELECT date::VARCHAR AS d, close FROM index_bars
     WHERE sym = $s AND date >= $a::DATE AND date <= $b::DATE ORDER BY date`,
    { s: bk.sym, a: calendar[0]!, b: calendar.at(-1)! },
  );
  const benchMap = new Map(benchRows.map((r) => [r.d, r.close]));
  const bench = Float64Array.from(calendar, (d) => benchMap.get(d) ?? NaN);

  // 数据局限（D21、D25）
  const caveats: NonNullable<SimInput["dataCaveats"]> = [];
  if (market === "HK") {
    caveats.push({
      id: "survivorship",
      level: "warn",
      title: "港股有幸存者偏差",
      detail: "港股拿不到退市名单，股票池只含现在还在交易的公司，历史表现会偏乐观。",
    });
  }
  if (market === "A" && params.start < "2018-01-01") {
    caveats.push({
      id: "st_approx",
      level: "info",
      title: "早年沪市 ST 为近似判定",
      detail: "2018 年以前的沪市股票和沪市退市股没有公开的简称历史，ST 用「最近两期年报都亏损」近似。",
    });
  }

  return {
    input: {
      spec,
      params,
      calendar,
      prices,
      securities,
      selections,
      signals: opts.signals,
      bench,
      benchLabel: bk.label,
      benchWithDividends: bk.withDividends,
      priorVersionsOnPeriod: opts.priorVersionsOnPeriod,
      dataCaveats: caveats,
    },
    dataVersion,
    params,
    stats: { decisionDates: decisionDates.length, codes: codeList.length, priceRows, ms: Date.now() - t0 },
  };
}

/**
 * 组装回测输入（纯数据，交给引擎）：日历 → 决策日选股 → 价格面板 → 基准 → 数据局限说明。
 * 重计算留在 DuckDB（选股），JS 里只装被选中过的股票的日线（D3）。
 */
import {
  addDays,
  type BacktestParams,
  benchmarkOf,
  BENCHMARKS,
  benchUnavailableText,
  type DateStr,
  type ExecConfig,
  type PriceSeries,
  resolveExec,
  type RunProvenance,
  type SecurityInfo,
  type Signal,
  type SimInput,
  type StrategySpec,
  nextTradingDay,
  type TradingDayBasis,
} from "@ivan/core";
import { rebalanceDays } from "@ivan/engine";
import type { SourcesLedger } from "../sources/chain.ts";
import { sqlCodeList, type Warehouse } from "../warehouse/db.ts";
import { benchFirstDate, benchMismatchCaveat } from "./bench.ts";
import { runProvenance } from "./data-health.ts";
import { REGIME_INDEX, runRegimeSelection, selectionContext } from "./selection.ts";

export interface DataVersionInfo {
  id: number | null;
  asOf: DateStr | null;
}

/**
 * 最新的已提交数据版本（D60）：只认 ok（旧行 status 为空也算 ok）；open、incomplete、failed、skipped 都不会被引用。
 */
export async function latestDataVersion(wh: Warehouse, market: string): Promise<DataVersionInfo> {
  const r = await wh.one<{ id: number; as_of: string }>(
    `SELECT id, as_of::VARCHAR AS as_of FROM data_versions
     WHERE market = $m AND coalesce(status, 'ok') = 'ok' ORDER BY id DESC LIMIT 1`,
    { m: market },
  );
  return { id: r?.id ?? null, asOf: r?.as_of ?? null };
}

/**
 * 「读到哪一天」（D60）：最新 ok 版本的截至日。回测终点、跟踪结算、选股默认日期都用它——
 * 某晚写了因子却失败时，读的人还停在上一个提交过的版本上。
 */
export async function committedAsOf(wh: Warehouse, market: string): Promise<DateStr | null> {
  return (await latestDataVersion(wh, market)).asOf;
}

/**
 * 决策日落到交易日：取该市场交易日历上不晚于 date 的最后一个交易日（周末、节假日退到前一个交易日）。
 * 回测只在交易日决策，问「3 月 3 日（周日）为什么」时按前一个交易日回答；日历里没有更早的交易日时原样返回。
 */
export async function lastTradingDay(wh: Warehouse, market: string, date: DateStr): Promise<DateStr> {
  const d = await wh.scalar<string>(
    `SELECT max(date)::VARCHAR FROM trade_calendar WHERE market = $m AND date <= $d::DATE`,
    { m: market, d: date },
  );
  return d ?? date;
}

/** 正在写的版本与上一个版本的结果（管理页「正在更新」、版本状态徽标用） */
export async function dataVersionState(
  wh: Warehouse,
  market: string,
): Promise<{
  /** startedAt：毫秒时间戳（库里存的是 DuckDB 时区下的本地时间，按同一时区换算） */
  openVersion: { id: number; startedAt: number | null } | null;
  lastVersionStatus: string | null;
}> {
  const open = await wh.one<{ id: number; started_at: number | null }>(
    `SELECT id, epoch_ms(started_at::TIMESTAMPTZ) AS started_at FROM data_versions
     WHERE market = $m AND status = 'open' ORDER BY id DESC LIMIT 1`,
    { m: market },
  );
  const last = await wh.one<{ status: string }>(
    `SELECT coalesce(status, 'ok') AS status FROM data_versions
     WHERE market = $m AND coalesce(status, 'ok') <> 'open' ORDER BY id DESC LIMIT 1`,
    { m: market },
  );
  return {
    openVersion: open ? { id: open.id, startedAt: open.started_at ?? null } : null,
    lastVersionStatus: last?.status ?? null,
  };
}

/** 最近一晚的取数来源（管理页「今晚东财 N 只、腾讯 M 只（回退 K 次）」，D72） */
export interface FetchSourcesSummary {
  versionId: number;
  status: string;
  /** 这一晚的日期（版本开始的那天） */
  date: DateStr | null;
  served: SourcesLedger["served"];
  fallbacks: number;
  failed: number;
  empty: number;
  index: SourcesLedger["index"];
}

/**
 * 最近一个写了取数台账的夜间增量版本（ok / incomplete / failed；休市的夜里只拉了指数，不算）。
 * 台账 JSON 读不懂（以后改了格式又回滚）时返回 null，不让数据状态接口出错。
 */
export async function lastFetchSources(
  wh: Warehouse,
  market: string,
): Promise<FetchSourcesSummary | null> {
  const r = await wh.one<{ id: number; status: string; d: string | null; sources: string }>(
    `SELECT id, status, started_at::DATE::VARCHAR AS d, sources FROM data_versions
     WHERE market = $m AND kind = 'daily' AND status IN ('ok', 'incomplete', 'failed')
       AND sources IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
    { m: market },
  );
  if (!r) return null;
  let s: Partial<SourcesLedger>;
  try {
    s = JSON.parse(r.sources) as Partial<SourcesLedger>;
  } catch {
    return null;
  }
  if (s?.v !== 1) return null;
  return {
    versionId: r.id,
    status: r.status,
    date: r.d ?? null,
    served: s.served ?? {},
    fallbacks: s.fallbacks ?? 0,
    failed: s.failed ?? 0,
    empty: s.empty ?? 0,
    index: s.index ?? {},
  };
}

/** 成交假设要不要日均成交额与波动率（D64）：设了单笔上限或计冲击成本时才把这两列装进价格面板 */
export function needsLiquidity(exec: ExecConfig): boolean {
  return exec.participation !== null || exec.impact !== "none";
}

export interface BuildOptions {
  signals?: Signal[];
  priorVersionsOnPeriod?: number;
  /**
   * 向前跟踪：在日历末尾补「下一个交易日」，让引擎给出明日计划。按交易所休市日表推算（D68），
   * 表里没有那一年时退回下一个工作日（nextDayBasis = weekday）。只影响今晚补的这一天：计划日，以及长假前最后一个交易日
   * 是不是周度策略的决策日；过去的重放与回测不受影响（前缀指纹按「执行日 ≤ cut」算，不含补的这天）。
   */
  appendNextDay?: boolean;
}

export interface BuiltInput {
  input: SimInput;
  dataVersion: DataVersionInfo;
  /** 实际使用的区间（end 会被截到数据截至日） */
  params: BacktestParams;
  /** 补的「下一个交易日」按什么推算；没补时为 null */
  nextDayBasis: TradingDayBasis | null;
  /** 行情来源占比、缺失与数据问题（S13）：写进运行卡 data.provenance，不进输入指纹 */
  provenance: RunProvenance;
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
  // 只读到最新的已提交版本（D60）：之后写进来的日线、因子（夜间更新写到一半或失败）都不读
  const dataVersion = await latestDataVersion(wh, market);
  const lastDay = dataVersion.asOf;
  if (!lastDay) throw new Error(`${market} 行情仓还没有提交过的数据，先运行回填`);
  const params = { ...paramsIn, end: paramsIn.end > lastDay ? lastDay : paramsIn.end };

  // 起点前多带一段日历与价格：仓位控制（D52）要回看持仓近 N 个交易日的波动
  const lead = spec.exposure ? Math.ceil(spec.exposure.lookback * 1.6) + 15 : 15;
  const calRows = await wh.all<{ d: string }>(
    `SELECT DISTINCT date::VARCHAR AS d FROM trade_calendar
     WHERE market = $m AND date >= $a::DATE AND date <= $b::DATE ORDER BY d`,
    { m: market, a: addDays(params.start, -lead), b: params.end },
  );
  const calendar = calRows.map((r) => r.d);

  // 基准在起点前一个交易日要有数据（D75）：回测在这里拒绝（不拿一条平线比）；跟踪只加提示，免得全收益基准晚到让结算失败
  const benchKey = benchmarkOf(spec);
  const bk = BENCHMARKS[benchKey];
  const anchor = calendar.filter((d) => d < params.start).at(-1) ?? calendar.find((d) => d >= params.start);
  const benchFirst = await benchFirstDate(wh, bk.sym);
  const benchProblem = anchor ? benchUnavailableText(benchKey, benchFirst, anchor) : null;
  if (benchProblem && !opts.appendNextDay) throw new Error(benchProblem);

  let nextDayBasis: TradingDayBasis | null = null;
  if (opts.appendNextDay && calendar.at(-1) === lastDay) {
    const next = nextTradingDay(market, lastDay);
    calendar.push(next.date);
    nextDayBasis = next.basis;
  }

  // 选股
  let selections = new Map<DateStr, string[]>();
  let decisionDates: DateStr[] = [];
  let weakDates = new Set<DateStr>();
  // 港股通股票池（D77）：名单没有记录时抛错（server 提交前已经拦过一次）
  const sctx = spec.mode === "rules" ? await selectionContext(wh, spec) : {};
  if (spec.mode === "rules" && spec.rank) {
    decisionDates = rebalanceDays(calendar, params, spec.rebalance.every).decisionDates.filter(
      (d) => d <= lastDay,
    );
    const limit = Math.ceil(spec.rank.top * spec.rebalance.buffer) + spec.rank.top;
    const r = await runRegimeSelection(wh, spec, decisionDates, limit, sctx);
    selections = r.selections;
    weakDates = r.weak;
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
    const liquidity = needsLiquidity(resolveExec(params.exec));
    const cols = await wh.columns(
      `SELECT b.code, b.date::VARCHAR AS d, b.open, b.high, b.low, b.close, b.adj,
              coalesce(f.flag_st, false) AS st${liquidity ? ", f.turnover_20d AS t20, f.volatility_60d AS v60" : ""}
       FROM bars_daily b
       LEFT JOIN factors_daily f ON f.code = b.code AND f.date = b.date
       WHERE b.code IN (${sqlCodeList(codeList)})
         AND b.date >= $a::DATE AND b.date <= $b::DATE
       ORDER BY b.code, b.date`,
      // 补出来的「下一个交易日」只是计划日期，不读那天的行情（可能是还没提交的数据）
      { a: calendar[0]!, b: lastDay < calendar.at(-1)! ? lastDay : calendar.at(-1)! },
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
      // 日均成交额（元）与日波动（D64）：第 x 格是第 x 天的值，引擎只用决策日及以前的
      if (liquidity) {
        s.adv = new Float32Array(len).fill(NaN);
        s.sigma = new Float32Array(len).fill(NaN);
      }
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
        if (s.adv && s.sigma) {
          const t20 = cols.t20![k] as number | null;
          const v60 = cols.v60![k] as number | null;
          s.adv[x] = t20 === null || t20 === undefined ? NaN : t20 * 1e8;
          s.sigma[x] = v60 === null || v60 === undefined ? NaN : v60 / 100 / Math.sqrt(250);
        }
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
      list_date: string | null;
    }>(
      `SELECT code, name, board, lot_size, industry, delist_date::VARCHAR AS delist_date,
              list_date::VARCHAR AS list_date
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
        listDate: s.list_date ?? null,
      });
    }
  }

  // 面板读行情的区间：日历起点到最后一个已提交的交易日（补出来的「下一个交易日」不读）
  const panelEnd = lastDay < calendar.at(-1)! ? lastDay : calendar.at(-1)!;

  // 基准
  const benchRows = await wh.all<{ d: string; close: number }>(
    `SELECT date::VARCHAR AS d, close FROM index_bars
     WHERE sym = $s AND date >= $a::DATE AND date <= $b::DATE ORDER BY date`,
    { s: bk.sym, a: calendar[0]!, b: panelEnd },
  );
  const benchMap = new Map(benchRows.map((r) => [r.d, r.close]));
  const bench = Float64Array.from(calendar, (d) => benchMap.get(d) ?? NaN);

  // 数据局限（D21、D25）与策略设置的说明
  const caveats: NonNullable<SimInput["dataCaveats"]> = [];
  if (spec.rank?.regime && decisionDates.length) {
    caveats.push({
      id: "regime",
      level: "info",
      title: "按大盘状态切换了排序",
      detail: `共 ${decisionDates.length} 次调仓，其中 ${weakDates.size} 次决策日${REGIME_INDEX[market].label}在 ${spec.rank.regime.ma} 日均线下方，用的是弱势排序。`,
    });
  }
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
  // 行情来源与数据提示（D73、D74）：缺口、数据问题、财报久未更新。只是报告：进 reportHash，不进输入指纹
  const prov = await runProvenance(wh, market, codeList, calendar[0]!, panelEnd);
  caveats.push(...prov.caveats);
  // 基准与股票池的提示（D75、D77）：同样只是报告
  if (opts.appendNextDay && anchor) {
    const missing = calendar.filter((d, i) => d >= anchor && d <= panelEnd && !Number.isFinite(bench[i]!));
    if (benchProblem || missing.length) {
      const at = missing[0] ?? anchor;
      caveats.push({
        id: "bench_missing",
        level: "warn",
        title: "基准缺数据",
        detail: `基准「${bk.label}」在 ${at} 没有数据，超额按缺值处理${missing.length > 1 ? `（共 ${missing.length} 个交易日）` : ""}。`,
      });
    }
  }
  const mismatch = await benchMismatchCaveat(wh, spec, selections);
  if (mismatch) caveats.push(mismatch);
  if (sctx.hkConnect) {
    const early = params.start < sctx.hkConnect.first;
    const szOnly = !sctx.hkConnect.attrs.includes("hk_connect_sh");
    if (early || szOnly) {
      const parts = [
        early
          ? `港股通名单从 ${sctx.hkConnect.first} 起逐日记录，之前的日期用的是那天的名单（以后才纳入的股票会被当成一直能买）`
          : null,
        szOnly ? "目前只记录了深港通名单" : null,
      ].filter(Boolean);
      caveats.push({
        id: "hk_connect_approx",
        level: "info",
        title: "港股通名单为近似",
        detail: `${parts.join("；")}。`,
      });
    }
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
    nextDayBasis,
    provenance: prov.provenance,
    stats: { decisionDates: decisionDates.length, codes: codeList.length, priceRows, ms: Date.now() - t0 },
  };
}

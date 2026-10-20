/**
 * 大盘与市场宽度、行业表现（spec 20261020 D101、D102）。
 */
import type { IndustryMember, IndustryPerformance, IndustryRow, MarketOverview, PeriodInput } from "@ivan/core";
import { addDays, addMonths, diffDays, limitPrices, type Market, periodLabel, priceLimitPct } from "@ivan/core";
import { indexOnOrBefore, median, percentileOf, vsMovingAverage, windowReturns } from "../../compute/price-stats.ts";
import { INDEXES } from "../../etl/reference.ts";
import { type Warehouse } from "../../warehouse/db.ts";
import { lastTradingDay } from "../backtest.ts";
import { AnalyticsError, asOfOf, endOf, fromOf, dataNote, loadIndexSeries } from "./common.ts";

// ── 3. 大盘与市场宽度 ──

/** 大盘概览看的价格指数 */
export const OVERVIEW_INDEXES: Record<Market, string[]> = {
  A: ["sse", "csi300", "csi500", "csi1000", "chinext", "csi_div"],
  HK: ["hsi", "hscei"],
};

const BUCKETS: Array<[string, (x: number) => boolean]> = [
  ["跌 7% 以上", (x) => x <= -0.07],
  ["跌 3%–7%", (x) => x > -0.07 && x <= -0.03],
  ["跌 0–3%", (x) => x > -0.03 && x < 0],
  ["平", (x) => x === 0],
  ["涨 0–3%", (x) => x > 0 && x < 0.03],
  ["涨 3%–7%", (x) => x >= 0.03 && x < 0.07],
  ["涨 7% 以上", (x) => x >= 0.07],
];

export async function marketOverview(
  wh: Warehouse,
  q: { market: Market; date?: string | null },
): Promise<MarketOverview> {
  const m = q.market;
  if (m !== "A" && m !== "HK") throw new AnalyticsError(400, "市场只能是 A 或 HK");
  const asOf = await asOfOf(wh, m);
  const date = await endOf(wh, m, q.date);
  const prevDate =
    (await wh.scalar<string>(
      `SELECT max(date)::VARCHAR FROM trade_calendar WHERE market = $m AND date < $d::DATE`,
      { m, d: date },
    )) ?? null;
  const notes = [dataNote(m, asOf)];

  // 指数
  const indices: MarketOverview["indices"] = [];
  for (const sym of OVERVIEW_INDEXES[m]) {
    const s = await loadIndexSeries(wh, sym, addMonths(date, -14), date);
    if (!s.dates.length || s.dates.at(-1) !== date) continue;
    const n = s.close.length;
    indices.push({
      sym,
      label: INDEXES[sym]!.label,
      close: s.close[n - 1]!,
      chg1d: n >= 2 ? s.close[n - 1]! / s.close[n - 2]! - 1 : null,
      windows: windowReturns(s.dates, s.close, ["1w", "1m", "3m", "ytd", "1y"]),
      vsMa60: vsMovingAverage(s.close, 60),
      vsMa250: vsMovingAverage(s.close, 250),
    });
  }

  // 个股涨跌：复权涨跌幅；涨跌停用不复权价（除权日用参考价当前收）
  type Row = {
    code: string;
    close: number;
    pclose: number;
    chg: number;
    volume: number | null;
    amt: number | null;
    ref_price: number | null;
    st: boolean | null;
    board: string | null;
    industry_l1: string | null;
    above_ma60: boolean | null;
    list_date: string | null;
  };
  const rows = prevDate
    ? await wh.all<Row>(
        `WITH t AS (
           SELECT b.code, b.close, b.adj, b.volume, coalesce(b.amount, b.close * b.volume) AS amt
           FROM bars_daily b JOIN securities s ON s.code = b.code AND s.market = $m
           WHERE b.date = $d::DATE AND b.close > 0),
         p AS (
           SELECT b.code, b.close, b.adj FROM bars_daily b JOIN securities s ON s.code = b.code AND s.market = $m
           WHERE b.date = $p::DATE AND b.close > 0)
         SELECT t.code, t.close, p.close AS pclose,
                CASE WHEN t.adj IS NULL OR p.adj IS NULL THEN t.close / p.close - 1
                     ELSE (t.close * t.adj) / (p.close * p.adj) - 1 END AS chg,
                t.volume, t.amt, ca.ref_price, f.flag_st AS st, s.board, f.industry_l1, f.above_ma60,
                s.list_date::VARCHAR AS list_date
         FROM t JOIN p USING (code)
         JOIN securities s ON s.code = t.code
         LEFT JOIN corp_actions ca ON ca.code = t.code AND ca.date = $d::DATE
         LEFT JOIN factors_daily f ON f.code = t.code AND f.date = $d::DATE`,
        { m, d: date, p: prevDate },
      )
    : [];
  const traded = rows.filter((r) => (r.volume ?? 1) > 0 && Number.isFinite(r.chg));
  const chgs = traded.map((r) => r.chg);
  let limitUp: number | null = null;
  let limitDown: number | null = null;
  if (m === "A") {
    limitUp = 0;
    limitDown = 0;
    for (const r of traded) {
      // 上市不满 10 个自然日的新股可能不设涨跌幅（注册制前 5 个交易日），不算
      if (r.list_date && diffDays(date, r.list_date) < 10) continue;
      const pct = priceLimitPct("A", r.board, Boolean(r.st), date, { rules: 2 });
      if (pct === null) continue;
      const { up, down } = limitPrices(r.ref_price ?? r.pclose, pct);
      if (r.close >= up - 1e-6) limitUp++;
      else if (r.close <= down + 1e-6) limitDown++;
    }
  }
  const above = traded.filter((r) => r.above_ma60 !== null && r.above_ma60 !== undefined);

  // 新高新低：近 250 个交易日（复权收盘）
  const hl = await wh.one<{ hi: number; lo: number }>(
    `WITH cal AS (
       SELECT date FROM trade_calendar WHERE market = $m AND date <= $d::DATE ORDER BY date DESC LIMIT 250),
     w AS (
       SELECT b.code,
              max(b.close * coalesce(b.adj, 1)) FILTER (WHERE b.date < $d::DATE) AS hi,
              min(b.close * coalesce(b.adj, 1)) FILTER (WHERE b.date < $d::DATE) AS lo,
              max(b.close * coalesce(b.adj, 1)) FILTER (WHERE b.date = $d::DATE) AS cur,
              count(*) AS n
       FROM bars_daily b JOIN securities s ON s.code = b.code AND s.market = $m
       WHERE b.date >= (SELECT min(date) FROM cal) AND b.date <= $d::DATE AND b.close > 0
       GROUP BY b.code)
     SELECT count(*) FILTER (WHERE cur > hi AND n >= 120)::INTEGER AS hi,
            count(*) FILTER (WHERE cur < lo AND n >= 120)::INTEGER AS lo
     FROM w`,
    { m, d: date },
  );

  // 成交额：今天与之前 20 个交易日
  // 成交额按当天所有有行情的股票合计（新股、复牌股前一天没有行情、不在涨跌样本里，但成交额要算；和 20 日均同口径）
  const amount =
    (await wh.scalar<number>(
      `SELECT sum(coalesce(b.amount, b.close * b.volume)) FROM bars_daily b
       JOIN securities s ON s.code = b.code AND s.market = $m
       WHERE b.date = $d::DATE`,
      { m, d: date },
    )) ?? 0;
  const prior = await wh.all<{ d: string; amt: number }>(
    `WITH cal AS (
       SELECT date FROM trade_calendar WHERE market = $m AND date < $d::DATE ORDER BY date DESC LIMIT 20)
     SELECT b.date::VARCHAR AS d, sum(coalesce(b.amount, b.close * b.volume)) AS amt
     FROM bars_daily b JOIN securities s ON s.code = b.code AND s.market = $m
     WHERE b.date IN (SELECT date FROM cal)
     GROUP BY b.date`,
    { m, d: date },
  );
  const avg20 = prior.length >= 10 ? prior.reduce((a, r) => a + r.amt, 0) / prior.length : null;

  // 行业
  const byInd = new Map<string, number[]>();
  for (const r of traded) {
    if (!r.industry_l1) continue;
    let xs = byInd.get(r.industry_l1);
    if (!xs) byInd.set(r.industry_l1, (xs = []));
    xs.push(r.chg);
  }
  const inds = [...byInd]
    .filter(([, xs]) => xs.length >= 5)
    .map(([industry, xs]) => ({
      industry,
      medianChg: median(xs)!,
      count: xs.length,
      upRatio: xs.filter((x) => x > 0).length / xs.length,
    }))
    .sort((a, b) => b.medianChg - a.medianChg);

  // 估值：今天的中位数与近 5 年每周一天的中位数
  const val = await wh.all<{ d: string; pe: number | null; pb: number | null; dy: number | null }>(
    `WITH days AS (
       SELECT date FROM trade_calendar
       WHERE market = $m AND date > $f::DATE AND date <= $d::DATE AND (dayofweek(date) = 5 OR date = $d::DATE))
     SELECT date::VARCHAR AS d,
            median(pe_ttm) FILTER (WHERE pe_ttm > 0) AS pe,
            median(pb) FILTER (WHERE pb > 0) AS pb,
            median(dividend_yield_ttm) AS dy
     FROM factors_daily WHERE market = $m AND date IN (SELECT date FROM days)
     GROUP BY date ORDER BY date`,
    { m, d: date, f: addMonths(date, -60) },
  );
  const today = val.find((v) => v.d === date) ?? null;
  const hist = (k: "pe" | "pb" | "dy") =>
    val.map((v) => v[k]).filter((x): x is number => x !== null && Number.isFinite(x));
  if (val.length && val.length < 150)
    notes.push(`估值分位只有 ${val.length} 个周度样本（不到 3 年），参考意义有限。`);
  notes.push("估值分位按全市场中位数算：股票池逐年变大（新股多），和指数估值不是一回事。");
  if (m === "A") notes.push("涨跌停按收盘价是否等于涨跌停价判断（除权日按参考价），上市不满 10 天的新股不算。");

  return {
    market: m,
    date,
    prevDate,
    dataAsOf: asOf,
    indices,
    breadth: {
      traded: traded.length,
      up: chgs.filter((x) => x > 0).length,
      down: chgs.filter((x) => x < 0).length,
      flat: chgs.filter((x) => x === 0).length,
      medianChg: median(chgs),
      buckets: BUCKETS.map(([label, f]) => ({ label, count: chgs.filter(f).length })),
      limitUp,
      limitDown,
      aboveMa60Ratio: above.length ? above.filter((r) => r.above_ma60).length / above.length : null,
      newHigh250: hl?.hi ?? 0,
      newLow250: hl?.lo ?? 0,
    },
    turnover: {
      amount,
      avg20dAmount: avg20,
      ratioTo20d: avg20 ? amount / avg20 : null,
    },
    industries: { top: inds.slice(0, 5), bottom: inds.slice(-5).reverse() },
    valuation: {
      pe_ttm: today?.pe ?? null,
      pb: today?.pb ?? null,
      dividend_yield_ttm: today?.dy ?? null,
      pePercentile5y: today && today.pe !== null ? percentileOf(hist("pe"), today.pe) : null,
      pbPercentile5y: today && today.pb !== null ? percentileOf(hist("pb"), today.pb) : null,
      dividendYieldPercentile5y:
        today && today.dy !== null ? percentileOf(hist("dy"), today.dy) : null,
      samples: val.length,
    },
    notes,
  };
}

// ── 4. 行业表现 ──

const MEMBER_SORT = ["ret", "mcap", "pe_ttm", "pb", "roe_ttm", "dividend_yield_ttm"] as const;
export type MemberSort = (typeof MEMBER_SORT)[number];

export async function industryPerformance(
  wh: Warehouse,
  q: {
    market: Market;
    period?: PeriodInput | null;
    from?: string | null;
    to?: string | null;
    level?: "l1" | "l2" | null;
    industry?: string | null;
    sort?: string | null;
    limit?: number | null;
  },
): Promise<IndustryPerformance> {
  const m = q.market;
  if (m !== "A" && m !== "HK") throw new AnalyticsError(400, "市场只能是 A 或 HK");
  const level = q.level === "l2" ? "l2" : "l1";
  const end = await endOf(wh, m, q.to);
  const fromDate = fromOf(end, q, "1m");
  if (fromDate === null) throw new AnalyticsError(400, "行业表现要给一个区间（比如 1m、ytd、1y）");
  const start = await lastTradingDay(wh, m, fromDate);
  const sort: MemberSort = MEMBER_SORT.includes(q.sort as MemberSort) ? (q.sort as MemberSort) : "mcap";
  type Row = {
    code: string;
    name: string | null;
    industry_l1: string | null;
    industry: string | null;
    mcap: number | null;
    pe_ttm: number | null;
    pb: number | null;
    roe_ttm: number | null;
    dividend_yield_ttm: number | null;
    rev_yoy: number | null;
    np_yoy: number | null;
    ret: number | null;
    mcap0: number | null;
  };
  const rows = await wh.all<Row>(
    `WITH e AS (
       SELECT code, industry_l1, industry, mcap, pe_ttm, pb, roe_ttm, dividend_yield_ttm, rev_yoy, np_yoy
       FROM factors_daily WHERE market = $m AND date = $d1::DATE),
     b1 AS (SELECT code, close * coalesce(adj, 1) AS v FROM bars_daily WHERE date = $d1::DATE AND close > 0),
     b0 AS (SELECT code, close * coalesce(adj, 1) AS v FROM bars_daily WHERE date = $d0::DATE AND close > 0),
     m0 AS (SELECT code, mcap FROM factors_daily WHERE market = $m AND date = $d0::DATE)
     SELECT e.*, s.name, b1.v / b0.v - 1 AS ret, m0.mcap AS mcap0
     FROM e JOIN securities s USING (code)
     LEFT JOIN b1 USING (code) LEFT JOIN b0 USING (code) LEFT JOIN m0 USING (code)`,
    { m, d1: end, d0: start },
  );
  if (!rows.length) throw new AnalyticsError(404, `${end} 没有因子数据`);
  const keyOf = (r: Row) => (level === "l1" ? r.industry_l1 : r.industry);
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = keyOf(r);
    if (!k) continue;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(r);
  }
  const num = (xs: Array<number | null>, pos = false) =>
    xs.filter((x): x is number => x !== null && Number.isFinite(x) && (!pos || x > 0));
  const industries: IndustryRow[] = [...groups].map(([industry, g]) => {
    const withRet = g.filter((r) => r.ret !== null && Number.isFinite(r.ret));
    const w = withRet.filter((r) => r.mcap0 !== null && r.mcap0 > 0);
    const wsum = w.reduce((a, r) => a + r.mcap0!, 0);
    return {
      industry,
      count: withRet.length,
      members: g.length,
      capWeightedRet: wsum > 0 ? w.reduce((a, r) => a + r.mcap0! * r.ret!, 0) / wsum : null,
      medianRet: median(withRet.map((r) => r.ret!)),
      upRatio: withRet.length ? withRet.filter((r) => r.ret! > 0).length / withRet.length : null,
      mcap: g.reduce((a, r) => a + (r.mcap ?? 0), 0),
      median: {
        pe_ttm: median(num(g.map((r) => r.pe_ttm), true)),
        pb: median(num(g.map((r) => r.pb), true)),
        roe_ttm: median(num(g.map((r) => r.roe_ttm))),
        dividend_yield_ttm: median(num(g.map((r) => r.dividend_yield_ttm))),
      },
    };
  });
  industries.sort((a, b) => (b.capWeightedRet ?? -Infinity) - (a.capWeightedRet ?? -Infinity));

  let focus: IndustryPerformance["focus"] = null;
  if (q.industry) {
    const want = q.industry.trim();
    const names = [...groups.keys()];
    // 两级都找：先精确，再包含
    const allNames = new Set<string>();
    for (const r of rows) {
      if (r.industry_l1) allNames.add(r.industry_l1);
      if (r.industry) allNames.add(r.industry);
    }
    let match = [...allNames].filter((n) => n === want);
    if (!match.length) match = [...allNames].filter((n) => n.includes(want) || want.includes(n));
    if (!match.length) {
      throw new AnalyticsError(
        404,
        `没有叫「${want}」的行业。${level === "l1" ? "一级" : "二级"}行业有：${names.slice(0, 40).join("、")}`,
      );
    }
    if (match.length > 1 && !match.includes(want)) {
      throw new AnalyticsError(400, `「${want}」对应多个行业：${match.slice(0, 12).join("、")}，请说具体一个`);
    }
    const name = match.includes(want) ? want : match[0]!;
    const members = rows
      .filter((r) => r.industry_l1 === name || r.industry === name)
      .map<IndustryMember>((r) => ({
        code: r.code,
        name: r.name ?? r.code,
        industry: r.industry,
        ret: r.ret !== null && Number.isFinite(r.ret) ? r.ret : null,
        mcap: r.mcap,
        pe_ttm: r.pe_ttm,
        pb: r.pb,
        roe_ttm: r.roe_ttm,
        dividend_yield_ttm: r.dividend_yield_ttm,
        rev_yoy: r.rev_yoy,
        np_yoy: r.np_yoy,
      }));
    // PE、PB 从低到高（只排为正的，亏损或净资产为负的放最后）；其余从高到低；没有值的放最后
    const asc = sort === "pe_ttm" || sort === "pb";
    const usable = (x: number | null): x is number =>
      x !== null && Number.isFinite(x) && (!asc || x > 0);
    members.sort((a, b) => {
      const x = a[sort];
      const y = b[sort];
      if (!usable(x)) return usable(y) ? 1 : 0;
      if (!usable(y)) return -1;
      return asc ? x - y : y - x;
    });
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 50);
    focus = { industry: name, members: members.slice(0, limit), total: members.length };
  }

  const benchSym = m === "A" ? "csi300" : "hsi";
  const bs = await loadIndexSeries(wh, benchSym, addDays(start, -10), end);
  const i0 = indexOnOrBefore(bs.dates, start);
  const benchmark =
    i0 >= 0 && bs.dates.at(-1) === end
      ? { sym: benchSym, label: INDEXES[benchSym]!.label, ret: bs.close.at(-1)! / bs.close[i0]! - 1 }
      : null;
  return {
    market: m,
    level,
    start,
    end,
    period: { label: q.from ? `${q.from} ~ ${end}` : periodLabel(q.period ?? "1m") },
    benchmark,
    industries,
    focus,
    notes: [
      dataNote(m, await asOfOf(wh, m)),
      "行业归属按终点当天；市值加权收益的权重是起点总市值（分红再投入）；区间起点还没上市或停牌的股票不算收益。",
      "行业指数用的是行情仓里的股票自己算的，不是官方行业指数。",
    ],
  };
}


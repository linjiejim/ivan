/**
 * 参考数据 ETL：指数（价格 + 含分红基准）、交易日历、汇率、简称历史。
 */
import { addDays, type DateStr, type Market } from "@ivan/core";
import { mapLimit } from "../http.ts";
import { centralParity } from "../sources/chinamoney.ts";
import { emQuery, str } from "../sources/eastmoney.ts";
import { szseNameChanges } from "../sources/exchanges.ts";
import { klineRange } from "../sources/tencent.ts";
import { emKline } from "../sources/emkline.ts";
import { fetchWithChain } from "../sources/chain.ts";
import { chainFor, chainOf } from "../sources/registry.ts";
import { type IndexBar, type SourceId, srcCode, type SrcCode } from "../sources/types.ts";
import { decomposeHfq } from "../compute/adjust.ts";
import type { EtlContext } from "./context.ts";

/**
 * 基准与参考指数（D24）。source：
 * - index：价格指数，东财为主（emSecid）、腾讯为备（tencentSym）
 * - csindex：中证官网全收益指数
 * - etf：ETF 不复权 + 后复权反推公司行动，得到含分红（再投入）的总收益序列
 */
export const INDEXES: Record<
  string,
  {
    market: Market;
    label: string;
    source: "index" | "csindex" | "etf";
    id: string;
    tencentSym?: string;
  }
> = {
  csi300_tr: { market: "A", label: "沪深300全收益", source: "csindex", id: "H00300" },
  csi300: { market: "A", label: "沪深300", source: "index", id: "1.000300", tencentSym: "sh000300" },
  // 中证 500 / 1000 / 红利（D75）：全收益走中证官网，价格孪生用来临时补齐晚发布的全收益
  csi500_tr: { market: "A", label: "中证500全收益", source: "csindex", id: "H00905" },
  csi500: { market: "A", label: "中证500", source: "index", id: "1.000905", tencentSym: "sh000905" },
  csi1000_tr: { market: "A", label: "中证1000全收益", source: "csindex", id: "H00852" },
  csi1000: { market: "A", label: "中证1000", source: "index", id: "1.000852", tencentSym: "sh000852" },
  csi_div_tr: { market: "A", label: "中证红利全收益", source: "csindex", id: "H00922" },
  csi_div: { market: "A", label: "中证红利", source: "index", id: "1.000922", tencentSym: "sh000922" },
  sse: { market: "A", label: "上证指数", source: "index", id: "1.000001", tencentSym: "sh000001" },
  chinext: { market: "A", label: "创业板指", source: "index", id: "0.399006", tencentSym: "sz399006" },
  hsi_tr: { market: "HK", label: "恒指（盈富基金 02800 含分红）", source: "etf", id: "02800.HK" },
  hsi: { market: "HK", label: "恒生指数", source: "index", id: "100.HSI", tencentSym: "hkHSI" },
  hscei_tr: { market: "HK", label: "国企指数（02828 含分红）", source: "etf", id: "02828.HK" },
  hscei: { market: "HK", label: "恒生国企指数", source: "index", id: "100.HSCEI", tencentSym: "hkHSCEI" },
};

/** 行情仓的历史起点：回填默认从这天起，新加的指数第一次更新也从这天拉全 */
export const DEFAULT_SINCE = "2013-01-01";

/** 全收益指数晚发布（D24）：用价格孪生的涨跌临时补齐的配对 [全收益, 价格] */
export const PROVISIONAL_PAIRS: Record<Market, ReadonlyArray<readonly [string, string]>> = {
  A: [
    ["csi300_tr", "csi300"],
    ["csi500_tr", "csi500"],
    ["csi1000_tr", "csi1000"],
    ["csi_div_tr", "csi_div"],
  ],
  HK: [
    ["hsi_tr", "hsi"],
    ["hscei_tr", "hscei"],
  ],
};

/** 交易日历来源：A 股看上证，港股看恒指。 */
const CALENDAR_INDEX: Record<Market, string> = { A: "sse", HK: "hsi" };

/** 指数来源：csi 中证官网、em 东财、tx 腾讯 */
type IndexSource = SrcCode;

async function fetchIndex(
  ctx: EtlContext,
  sym: string,
  from: DateStr,
  to: DateStr,
): Promise<{ bars: IndexBar[]; src: IndexSource }> {
  const def = INDEXES[sym]!;
  if (def.source !== "etf") {
    // 价格指数走指数链（D72，默认东财在前、腾讯在后）；全收益指数只有中证官网一家
    const symOf: Partial<Record<SourceId, string>> =
      def.source === "csindex" ? { csindex: def.id } : { eastmoney: def.id, tencent: def.tencentSym };
    const base =
      def.source === "csindex"
        ? chainOf("index", def.market, ["csindex"], true)
        : chainFor("index", def.market, ctx.log);
    const chain = { ...base, adapters: base.adapters.filter((a) => symOf[a.id]) };
    const sctx = { http: ctx.http, today: ctx.today, log: ctx.log };
    const r = await fetchWithChain(
      chain,
      `指数 ${def.label}`,
      (a) => a.indexBars!(sctx, symOf[a.id]!, from, to),
      (b) => !b.length,
      ctx.http,
    );
    ctx.ledger?.recordIndex(sym, r);
    return { bars: r.value, src: srcCode(r.servedBy, "index") };
  }
  const useTencent = process.env.KLINE_SOURCE === "tencent";
  // ETF：总收益序列 = 不复权收盘 × 等比因子（从上市或 from 起算，只看涨跌）
  if (!useTencent) {
    try {
      const raw = await emKline(ctx.http, def.id, "raw", from, to);
      const hfq = await emKline(ctx.http, def.id, "hfq", from, to);
      const { adj } = decomposeHfq(raw.bars, hfq.bars, hfq.decimals);
      return { bars: raw.bars.map((b, i) => ({ date: b.date, close: b.close * adj[i]! })), src: "em" };
    } catch (e) {
      if (ctx.http.isBlocked("web.ifzq.gtimg.cn")) throw e;
    }
  }
  const raw = await klineRange(ctx.http, def.id, "raw", from, to);
  const hfq = await klineRange(ctx.http, def.id, "hfq", from, to);
  const { adj } = decomposeHfq(raw, hfq, 3);
  return { bars: raw.map((b, i) => ({ date: b.date, close: b.close * adj[i]! })), src: "tx" };
}

/**
 * ETF 总收益序列只在「这次拉取的区间内」成立（等比因子从区间第一天算起），增量更新时要按库里已存的值
 * 缩放接上，否则每晚在窗口起点凭空跳一截（实测盈富基金跳了 −29%）。锚点 = 窗口里第一个库里已有的非临时日子。
 */
export function chainToStored(
  bars: Array<{ date: DateStr; close: number }>,
  anchor: { date: DateStr; close: number } | undefined,
): Array<{ date: DateStr; close: number }> {
  if (!anchor) return bars;
  const b = bars.find((x) => x.date === anchor.date);
  if (!b || !(b.close > 0)) return bars;
  const k = anchor.close / b.close;
  return bars.map((x) => ({ date: x.date, close: x.close * k }));
}

export async function updateIndexes(
  ctx: EtlContext,
  market: Market,
  from: DateStr,
): Promise<{ calendarLast: DateStr | null }> {
  const syms = Object.keys(INDEXES).filter((s) => INDEXES[s]!.market === market);
  // 库里一行都没有的指数（新加的基准，D75）：这次从 DEFAULT_SINCE 拉全，不用停 worker 跑回填
  const stored = new Set(
    (
      await ctx.wh.all<{ sym: string }>(
        `SELECT DISTINCT sym FROM index_bars WHERE sym IN (${syms.map((x) => `'${x}'`).join(", ")})`,
      )
    ).map((r) => r.sym),
  );
  const empty = new Set(syms.filter((sym) => !stored.has(sym) && from > DEFAULT_SINCE));
  for (const sym of empty) ctx.log(`指数 ${sym} 第一次更新，从 ${DEFAULT_SINCE} 补齐`);
  const fromOf = (sym: string) => (empty.has(sym) ? DEFAULT_SINCE : from);
  // 日历指数必须成功；其他指数（全收益、ETF）失败时跳过，下次再补
  const fetched = await mapLimit(syms, 3, async (sym) => {
    try {
      const got = await fetchIndex(ctx, sym, fromOf(sym), ctx.today);
      let bars = got.bars;
      if (INDEXES[sym]!.source === "etf" && bars.length) {
        const anchor = await ctx.wh.one<{ date: string; close: number }>(
          `SELECT date::VARCHAR AS date, close FROM index_bars
           WHERE sym = $s AND NOT provisional AND date >= $f::DATE ORDER BY date LIMIT 1`,
          { s: sym, f: bars[0]!.date },
        );
        bars = chainToStored(bars, anchor);
      }
      return { sym, bars, src: got.src as IndexSource | null };
    } catch (e) {
      if (sym === CALENDAR_INDEX[market]) throw e;
      ctx.log(`指数 ${sym} 更新失败，先跳过：${e instanceof Error ? e.message : e}`);
      return { sym, bars: [] as Array<{ date: string; close: number }>, src: null };
    }
  });
  const ver = ctx.ver ?? null;
  await ctx.wh.exclusive(async () => {
    for (const { sym, bars, src } of fetched) {
      if (!bars.length) continue;
      await ctx.wh.run(`DELETE FROM index_bars WHERE sym = $s AND date >= $f::DATE`, {
        s: sym,
        f: fromOf(sym),
      });
      await ctx.wh.append(
        "index_bars",
        bars.map((b) => [sym, b.date, b.close, false, src, ver]),
      );
    }
    const cal = fetched.find((f) => f.sym === CALENDAR_INDEX[market])!;
    if (cal.bars.length) {
      await ctx.wh.run(`DELETE FROM trade_calendar WHERE market = $m AND date >= $f::DATE`, {
        m: market,
        f: from,
      });
      // 日历指数第一次更新时拉的是全段，日历只换 from 起的部分
      await ctx.wh.append(
        "trade_calendar",
        cal.bars.filter((b) => b.date >= from).map((b) => [market, b.date, ver]),
      );
    }
  });
  await fillProvisionalTr(ctx, market);
  const last = await ctx.wh.scalar<string>(
    `SELECT max(date)::VARCHAR FROM trade_calendar WHERE market = $m`,
    { m: market },
  );
  ctx.log(`${market} 指数与日历更新到 ${last}`);
  return { calendarLast: last ?? null };
}

/**
 * 全收益指数晚发布（D24）：日历里有、全收益还没有的日子，用价格指数涨跌临时补齐并标 provisional，
 * 下次拿到真实值时覆盖。
 */
export async function fillProvisionalTr(ctx: EtlContext, market: Market): Promise<void> {
  for (const [tr, price] of PROVISIONAL_PAIRS[market]) {
    await ctx.wh.exclusive(async () => {
      await ctx.wh.run(`DELETE FROM index_bars WHERE sym = $tr AND provisional`, { tr });
      const lastTr = await ctx.wh.one<{ date: string; close: number }>(
        `SELECT date::VARCHAR AS date, close FROM index_bars WHERE sym = $tr ORDER BY date DESC LIMIT 1`,
        { tr },
      );
      if (!lastTr) return;
      const px = await ctx.wh.all<{ date: string; close: number }>(
        `SELECT date::VARCHAR AS date, close FROM index_bars WHERE sym = $p AND date >= $d::DATE ORDER BY date`,
        { p: price, d: lastTr.date },
      );
      if (px.length < 2 || px[0]!.date !== lastTr.date) return;
      const rows: unknown[][] = [];
      for (let i = 1; i < px.length; i++) {
        rows.push([
          tr,
          px[i]!.date,
          lastTr.close * (px[i]!.close / px[0]!.close),
          true,
          "prov",
          ctx.ver ?? null,
        ]);
      }
      await ctx.wh.append("index_bars", rows);
    });
  }
}

/** 中间价币种对 → 港币汇率换算（D23）。 */
const FX_PAIRS = [
  "USD/CNY",
  "HKD/CNY",
  "EUR/CNY",
  "100JPY/CNY",
  "GBP/CNY",
  "AUD/CNY",
  "SGD/CNY",
  "CAD/CNY",
  "CNY/MYR",
  "CNY/MOP",
  "CNY/THB",
];

export async function updateFx(ctx: EtlContext, from: DateStr): Promise<number> {
  const rows = await centralParity(ctx.http, FX_PAIRS, from, ctx.today);
  const out: unknown[][] = [];
  for (const r of rows) {
    const hkd = r.rates["HKD/CNY"];
    if (!hkd) continue;
    // 1 单位外币 = 多少人民币
    const cny: Record<string, number | undefined> = {
      CNY: 1,
      USD: r.rates["USD/CNY"],
      EUR: r.rates["EUR/CNY"],
      JPY: r.rates["100JPY/CNY"] ? r.rates["100JPY/CNY"]! / 100 : undefined,
      GBP: r.rates["GBP/CNY"],
      AUD: r.rates["AUD/CNY"],
      SGD: r.rates["SGD/CNY"],
      CAD: r.rates["CAD/CNY"],
      MYR: r.rates["CNY/MYR"] ? 1 / r.rates["CNY/MYR"]! : undefined,
      MOP: r.rates["CNY/MOP"] ? 1 / r.rates["CNY/MOP"]! : undefined,
      THB: r.rates["CNY/THB"] ? 1 / r.rates["CNY/THB"]! : undefined,
    };
    for (const [ccy, v] of Object.entries(cny)) if (v) out.push([ccy, r.date, v / hkd]);
  }
  await ctx.wh.exclusive(async () => {
    await ctx.wh.run(`DELETE FROM fx_hkd WHERE date >= $f::DATE`, { f: from });
    await ctx.wh.append("fx_hkd", out);
  });
  ctx.log(`汇率 ${rows.length} 天`);
  return rows.length;
}

/** 深交所官方简称变更（全量或只看前几页）。 */
export async function updateSzseNames(ctx: EtlContext, maxPages?: number): Promise<number> {
  const rows = await szseNameChanges(ctx.http, maxPages);
  await ctx.wh.exclusive(async () => {
    if (maxPages) {
      const minDate = rows.reduce((m, r) => (r.date < m ? r.date : m), "9999-12-31");
      await ctx.wh.run(`DELETE FROM name_changes WHERE source = 'szse' AND date >= $d::DATE`, {
        d: minDate,
      });
    } else {
      await ctx.wh.run(`DELETE FROM name_changes WHERE source = 'szse'`);
    }
    await ctx.wh.append(
      "name_changes",
      rows.map((r) => [r.code, r.date, r.before, r.after, "szse"]),
    );
  });
  ctx.log(`深交所简称变更 ${rows.length} 条`);
  return rows.length;
}

/**
 * 沪市每日简称（D21）：逐个交易日取东财估值表里的简称，只记变化。断点在 meta.em_names_last。
 */
export async function updateEmDailyNames(
  ctx: EtlContext,
  opts: { from?: DateStr; maxDays?: number } = {},
): Promise<number> {
  const lastDone = await ctx.wh.meta("em_names_last");
  const start = lastDone ? addDays(lastDone, 1) : (opts.from ?? "2018-01-02");
  const dates = (
    await ctx.wh.all<{ d: string }>(
      `SELECT date::VARCHAR AS d FROM trade_calendar WHERE market = 'A' AND date >= $s::DATE ORDER BY date`,
      { s: start },
    )
  )
    .map((r) => r.d)
    .slice(0, opts.maxDays ?? 100_000);
  if (!dates.length) return 0;
  const current = new Map(
    (
      await ctx.wh.all<{ code: string; name: string }>(
        `SELECT code, arg_max(after, date) AS name FROM name_changes WHERE source = 'em_daily' GROUP BY code`,
      )
    ).map((r) => [r.code, r.name]),
  );
  let changes = 0;
  // 按日期顺序处理（变化要逐日比较），抓取可以并发，写入按序
  const chunk = 8;
  for (let i = 0; i < dates.length; i += chunk) {
    const part = dates.slice(i, i + chunk);
    const fetched = await mapLimit(part, 4, (d) =>
      emQuery(ctx.http, {
        report: "RPT_VALUEANALYSIS_DET",
        filter: `(TRADE_DATE='${d}')`,
        columns: "SECUCODE,SECURITY_NAME_ABBR",
        pageSize: 5000,
      }),
    );
    const rows: unknown[][] = [];
    part.forEach((d, k) => {
      for (const r of fetched[k]!) {
        const code = String(r.SECUCODE);
        if (!code.endsWith(".SH")) continue;
        const name = str(r.SECURITY_NAME_ABBR);
        if (!name || current.get(code) === name) continue;
        rows.push([code, d, current.get(code) ?? null, name, "em_daily"]);
        current.set(code, name);
      }
    });
    await ctx.wh.exclusive(async () => {
      await ctx.wh.append("name_changes", rows);
      await ctx.wh.setMeta("em_names_last", part[part.length - 1]!);
    });
    changes += rows.length;
    if ((i / chunk) % 25 === 0) ctx.log(`沪市每日简称 ${Math.min(i + chunk, dates.length)}/${dates.length}`);
  }
  ctx.log(`沪市每日简称：${dates.length} 天，${changes} 条变化`);
  return changes;
}

/** 交易日判断：最近的交易日与上一个交易日（取自日历）。 */
export async function latestTradeDates(
  ctx: EtlContext,
  market: Market,
): Promise<{ latest: DateStr | null; prev: DateStr | null }> {
  const rows = await ctx.wh.all<{ d: string }>(
    `SELECT date::VARCHAR AS d FROM trade_calendar WHERE market = $m ORDER BY date DESC LIMIT 2`,
    { m: market },
  );
  return { latest: rows[0]?.d ?? null, prev: rows[1]?.d ?? null };
}


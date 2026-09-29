/**
 * 日线 ETL：不复权 OHLC + 等比复权因子 + 公司行动（D27、D28）。
 * - 数据源：东财 push2his 为主（一次请求整段历史），腾讯为备（腾讯 fqkline 有 WAF，突发请求会被封 IP）。
 * - 复权：两家的「后复权」都是 a × 价 + b 的仿射形式，由 compute/adjust.ts 反推送转与现金分红，
 *   自己算等比因子（分红再投入）。
 * - 回填：逐股两次请求（不复权 + 后复权），断点续跑。
 * - 增量（A 股）：只差一个交易日时用腾讯批量报价（一次 60 只）；交易所发布的除权参考前收 ≠ 库里收盘的
 *   股票，以及差多天的股票，逐股补最近 60 天。
 * - 增量（港股）：当天行情同样用批量报价；港股报价的前收不做除权调整、看不出除权日，所以复权因子
 *   每晚轮换刷新五分之一的股票（每只最多 5 个交易日后被修正；跟踪每天从起点重放，修正会自动生效）。
 */
import { addDays, type DateStr, type Market, marketOf } from "@ivan/core";
import {
  adjFromRefPrices,
  type CorpAction,
  decomposeHfq,
  type RefAction,
} from "../compute/adjust.ts";
import { volumeMultiplier } from "../compute/volume-unit.ts";
import { BlockedError, mapLimit, sleep } from "../http.ts";
import { emKline } from "../sources/emkline.ts";
import { type KBar, klineRange, quotes } from "../sources/tencent.ts";
import { sqlCodeList } from "../warehouse/db.ts";
import {
  doneKeys,
  errMsg,
  type EtlContext,
  markDone,
  markFailed,
  type SecurityRow,
} from "./context.ts";

type BarRow = [string, DateStr, number, number, number, number, number, number | null, number];


const KLINE_HOSTS = ["push2his.eastmoney.com", "web.ifzq.gtimg.cn"];

interface FetchedBars {
  rows: BarRow[];
  actions: RefAction[];
  source: "eastmoney" | "tencent";
}

/** 后复权反推出来的事件 → 除权事实（前收、参考价） */
function toRefActions(raw: readonly KBar[], events: CorpAction[]): RefAction[] {
  const idx = new Map(raw.map((b, i) => [b.date, i]));
  return events.map((e) => {
    const i = idx.get(e.date) ?? 0;
    const prev = i > 0 ? raw[i - 1]!.close : raw[i]!.close;
    return {
      date: e.date,
      prevClose: prev,
      refPrice: (prev - e.cash) / (1 + e.split),
      cash: e.cash,
      split: e.split,
    };
  });
}

async function fetchOnce(
  ctx: EtlContext,
  code: string,
  from: DateStr,
  to: DateStr,
): Promise<{ raw: Array<KBar & { amount?: number }>; adj: number[]; actions: RefAction[]; source: FetchedBars["source"] }> {
  const isA = marketOf(code) === "A";
  // KLINE_SOURCE=tencent 时跳过东财（开发机 IP 被东财封禁时用）
  const source = process.env.KLINE_SOURCE ?? "auto";
  if (source !== "tencent" && !ctx.http.isBlocked(KLINE_HOSTS[0]!)) {
    try {
      if (isA) {
        // A 股一次请求：涨跌额给出交易所参考前收（D31）
        const raw = await emKline(ctx.http, code, "raw", from, to);
        if (raw.bars.length) {
          const { adj, actions } = adjFromRefPrices(raw.bars);
          return { raw: raw.bars, adj, actions, source: "eastmoney" };
        }
      } else {
        const raw = await emKline(ctx.http, code, "raw", from, to);
        if (raw.bars.length) {
          const hfq = await emKline(ctx.http, code, "hfq", from, to);
          const { adj, events } = decomposeHfq(raw.bars, hfq.bars, hfq.decimals);
          return { raw: raw.bars, adj, actions: toRefActions(raw.bars, events), source: "eastmoney" };
        }
      }
    } catch (e) {
      if (!(e instanceof BlockedError)) ctx.log(`东财日 K 失败 ${code}，改用腾讯：${errMsg(e)}`);
    }
  }
  if (source === "eastmoney" || ctx.http.isBlocked(KLINE_HOSTS[1]!)) {
    throw new BlockedError(KLINE_HOSTS[1]!, ctx.http.earliestUnblock(KLINE_HOSTS) || Date.now() + 60_000);
  }
  const raw = await klineRange(ctx.http, code, "raw", from, to);
  const hfq = await klineRange(ctx.http, code, "hfq", from, to);
  const { adj, events } = decomposeHfq(raw, hfq, 3);
  return { raw, adj, actions: toRefActions(raw, events), source: "tencent" };
}

/** 两家日 K 都被封时，等最早解封的那家（回填不把这种情况记成失败）。 */
async function withUnblockWait<T>(ctx: EtlContext, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof BlockedError) || attempt >= 12) throw e;
      const until = ctx.http.earliestUnblock(KLINE_HOSTS) || Date.now();
      const wait = Math.max(until - Date.now(), 0) + 5_000;
      ctx.log(`日 K 接口被风控，等待 ${Math.round(wait / 60_000)} 分钟后继续`);
      await sleep(wait);
    }
  }
}

/**
 * 拉一只股票一段区间的日线。anchor：增量补数时，用库里某天的复权因子把新算的因子接上，
 * 保证历史因子不变。
 */
export async function fetchBars(
  ctx: EtlContext,
  code: string,
  from: DateStr,
  to: DateStr,
  anchor?: { date: DateStr; adj: number },
): Promise<FetchedBars> {
  const { raw, adj, actions, source } = await withUnblockWait(ctx, () =>
    fetchOnce(ctx, code, from, to),
  );
  let scale = 1;
  if (anchor) {
    const i = raw.findIndex((b) => b.date === anchor.date);
    if (i >= 0) scale = anchor.adj / adj[i]!;
  }
  // 成交量统一成「股」（D51）：有成交额（东财）就按成交额判断单位，没有（腾讯）按板块
  const mult = volumeMultiplier(code, raw);
  const rows: BarRow[] = raw.map((b, i) => [
    code,
    b.date,
    b.open,
    b.high,
    b.low,
    b.close,
    b.volume * mult,
    b.amount ?? null,
    adj[i]! * scale,
  ]);
  return { rows, actions, source };
}

async function writeBars(
  ctx: EtlContext,
  code: string,
  from: DateStr,
  fetched: FetchedBars,
): Promise<void> {
  await ctx.wh.exclusive(async () => {
    await ctx.wh.run(`DELETE FROM bars_daily WHERE code = $c AND date >= $f::DATE`, {
      c: code,
      f: from,
    });
    await ctx.wh.append("bars_daily", fetched.rows);
    // 窗口第一天的「事件」是和窗口外比出来的，不可靠，只写窗口内第二天起的
    const first = fetched.rows[0]?.[1];
    await ctx.wh.run(`DELETE FROM corp_actions WHERE code = $c AND date > $f::DATE`, {
      c: code,
      f: first ?? from,
    });
    await ctx.wh.append(
      "corp_actions",
      fetched.actions
        .filter((a) => !first || a.date > first)
        .map((a) => [code, a.date, a.prevClose, a.refPrice, a.cash, a.split]),
    );
  });
}

export interface BackfillOptions {
  since: DateStr;
  concurrency?: number;
  limit?: number;
  force?: boolean;
}

export async function backfillBars(
  ctx: EtlContext,
  securities: readonly SecurityRow[],
  opts: BackfillOptions,
): Promise<{ done: number; failed: number; skipped: number }> {
  const task = `bars:${opts.since}`;
  const done = opts.force ? new Set<string>() : await doneKeys(ctx.wh, task);
  let todo = securities.filter(
    (s) => !done.has(s.code) && !(s.delist_date && s.delist_date < opts.since),
  );
  if (opts.limit) todo = todo.slice(0, opts.limit);
  let ok = 0;
  let failed = 0;
  let n = 0;
  const sources = { eastmoney: 0, tencent: 0 };
  await mapLimit(todo, opts.concurrency ?? 2, async (s) => {
    const from = s.list_date && s.list_date > opts.since ? s.list_date : opts.since;
    const to = s.delist_date ? addDays(s.delist_date, -1) : ctx.today;
    try {
      const fetched = await fetchBars(ctx, s.code, from, to);
      sources[fetched.source]++;
      await writeBars(ctx, s.code, opts.since, fetched);
      await ctx.wh.exclusive(() => markDone(ctx.wh, task, s.code, String(fetched.rows.length)));
      ok++;
    } catch (e) {
      failed++;
      await ctx.wh.exclusive(() => markFailed(ctx.wh, task, s.code, errMsg(e)));
      ctx.log(`日线失败 ${s.code}：${errMsg(e)}`);
    }
    n++;
    if (n % 200 === 0 || n === todo.length) {
      ctx.log(`日线 ${n}/${todo.length}（东财 ${sources.eastmoney}，腾讯 ${sources.tencent}）`);
      ctx.progress?.(n / todo.length, `日线 ${n}/${todo.length}`);
    }
  });
  return { done: ok, failed, skipped: securities.length - todo.length };
}

/** 各股票库里最后一根 K 线。 */
async function lastBars(
  ctx: EtlContext,
  market: Market,
): Promise<Map<string, { date: DateStr; close: number; adj: number }>> {
  const rows = await ctx.wh.all<{ code: string; date: string; close: number; adj: number }>(
    `SELECT b.code, b.date::VARCHAR AS date, b.close, b.adj
     FROM bars_daily b
     JOIN (SELECT code, max(date) AS d FROM bars_daily WHERE code IN
             (SELECT code FROM securities WHERE market = $m AND delist_date IS NULL)
           GROUP BY code) m
       ON b.code = m.code AND b.date = m.d`,
    { m: market },
  );
  return new Map(rows.map((r) => [r.code, r]));
}

export async function updateBars(
  ctx: EtlContext,
  market: Market,
  securities: readonly SecurityRow[],
  latestTradeDate: DateStr,
  prevTradeDate: DateStr,
): Promise<{ viaQuote: number; viaKline: number; exRights: number; failed: number }> {
  const active = securities.filter((s) => !s.delist_date);
  const last = await lastBars(ctx, market);
  const quoteable: SecurityRow[] = [];
  const gap: SecurityRow[] = [];
  let neverFilled = 0;
  for (const s of active) {
    const l = last.get(s.code);
    if (!l) {
      // 库里一根 K 线都没有、又不是近 30 天新上市的：从没回填过（比如用了 --top），增量不替它补全历史
      if (s.list_date && s.list_date < addDays(latestTradeDate, -30)) neverFilled++;
      else gap.push(s);
    } else if (l.date >= latestTradeDate) continue;
    else if (l.date === prevTradeDate) quoteable.push(s);
    else gap.push(s);
  }

  const newRows: BarRow[] = [];
  const exRights: SecurityRow[] = [];
  const quoteDate = latestTradeDate.replaceAll("-", "");
  const batches: SecurityRow[][] = [];
  for (let i = 0; i < quoteable.length; i += 60) batches.push(quoteable.slice(i, i + 60));
  await mapLimit(batches, 2, async (batch) => {
    const qs = await quotes(
      ctx.http,
      batch.map((s) => s.code),
    );
    for (const q of qs) {
      const t = q.time.replace(/\D/g, "").slice(0, 8);
      // 当天没成交（停牌）：报价时间不是这一天或开盘价为 0，不写
      if (t !== quoteDate || !(q.open > 0) || !(q.volume > 0)) continue;
      const l = last.get(q.code)!;
      // A 股除权日交易所发布除权参考前收；港股不发布，靠轮换刷新
      if (market === "A" && Math.abs(q.prevClose - l.close) > 0.0051) {
        exRights.push(batch.find((s) => s.code === q.code)!);
        continue;
      }
      newRows.push([
        q.code,
        latestTradeDate,
        q.open,
        Math.max(q.high, q.open, q.price),
        Math.min(q.low > 0 ? q.low : q.price, q.open, q.price),
        q.price,
        q.volume * volumeMultiplier(q.code, [{ close: q.price, volume: q.volume, amount: q.amount }]),
        q.amount > 0 ? q.amount : null,
        l.adj,
      ]);
    }
  });
  if (newRows.length) {
    await ctx.wh.exclusive(async () => {
      await ctx.wh.run(
        `DELETE FROM bars_daily WHERE date = $d::DATE AND code IN (${sqlCodeList(newRows.map((r) => r[0]))})`,
        { d: latestTradeDate },
      );
      await ctx.wh.append("bars_daily", newRows);
    });
  }

  // 港股：按代码哈希轮换，每晚刷新五分之一的复权因子
  const rotate: SecurityRow[] = [];
  if (market === "HK") {
    const slot = Number(latestTradeDate.replaceAll("-", "")) % 5;
    for (const s of quoteable) {
      let h = 0;
      for (const ch of s.code) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      if (h % 5 === slot) rotate.push(s);
    }
  }

  let viaKline = 0;
  let failed = 0;
  await mapLimit([...exRights, ...gap, ...rotate], 3, async (s) => {
    const l = last.get(s.code);
    const from = l ? addDays(l.date, -60) : (s.list_date ?? addDays(latestTradeDate, -60));
    try {
      const anchorRow = l
        ? await ctx.wh.one<{ date: string; adj: number }>(
            `SELECT date::VARCHAR AS date, adj FROM bars_daily WHERE code = $c AND date >= $f::DATE
             ORDER BY date LIMIT 1`,
            { c: s.code, f: from },
          )
        : undefined;
      const fetched = await fetchBars(ctx, s.code, from, latestTradeDate, anchorRow);
      if (fetched.rows.length) await writeBars(ctx, s.code, from, fetched);
      viaKline++;
    } catch (e) {
      failed++;
      ctx.log(`日线增量失败 ${s.code}：${errMsg(e)}`);
    }
  });
  ctx.log(
    `${market} 日线增量：报价 ${newRows.length} 只，逐股 ${viaKline} 只（其中除权 ${exRights.length}），失败 ${failed}` +
      (neverFilled ? `；${neverFilled} 只从没回填过，跳过（要补请跑 backfill）` : ""),
  );
  return { viaQuote: newRows.length, viaKline, exRights: exRights.length, failed };
}

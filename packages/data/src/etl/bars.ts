/**
 * 日线 ETL：不复权 OHLC + 等比复权因子 + 公司行动（D27、D28）。
 * - 数据源：走回退链（D72，sources/registry.ts）：默认东财 push2his 为主（一次请求整段历史），腾讯为备
 *   （腾讯 fqkline 有 WAF，突发请求会被封 IP）；KLINE_SOURCE 指定单一来源、不回退。
 * - 复权：两家的「后复权」都是 a × 价 + b 的仿射形式，由 compute/adjust.ts 反推送转与现金分红，
 *   自己算等比因子（分红再投入）。
 * - 回填：逐股两次请求（不复权 + 后复权），断点续跑。
 * - 增量（A 股）：只差一个交易日时用腾讯批量报价（一次 60 只）；交易所发布的除权参考前收 ≠ 库里收盘的
 *   股票，以及差多天的股票，逐股补最近 60 天。一批报价出错、或报价里漏了请求的代码，这些股票也转去逐股补。
 * - 增量（港股）：当天行情同样用批量报价；港股报价的前收不做除权调整、看不出除权日，所以复权因子
 *   每晚轮换刷新五分之一的股票（每只最多 5 个交易日后被修正；跟踪每天从起点重放，修正会自动生效）。
 * - 体检（D74，compute/hygiene.ts）：写入前都过一遍，拒收的行不入库、记 bar_status 缺失；问题写 data_issues，
 *   同一（代码, 日期）后来重写且没再触发同一条规则时，之前版本的问题记为已解决（refetch）。
 * - 日线状态（D73）：增量写 bar_status——报价说今天没成交 → no_trade；整条链没拿到、被拒收、口径换算失败 → missing；
 *   之后写上了的删掉。
 * - 补数据能收敛（D111）：最后一根 K 线之后每天都记着没成交的股票（停牌、零成交的港股小票）照样走报价；逐股补时窗口里没有的日子
 *   记没成交（最后一根之后的要报价佐证）；逐股补的股票也要报价，报价说今天成交了而日 K 里没有今天 → 缺（kline_behind）；
 *   逐股补按日线停得最早的先补；港股复权轮换排在最后、被风控就停。
 */
import { addDays, type DateStr, type Market, marketOf } from "@ivan/core";
import type { RefAction } from "../compute/adjust.ts";
import { type HygieneCtx, type Issue, validateBars } from "../compute/hygiene.ts";
import { CaliberError, toIvanBars } from "../compute/normalize.ts";
import { volumeMultiplier } from "../compute/volume-unit.ts";
import { BlockedError, mapLimit, sleep } from "../http.ts";
import { fetchWithChain } from "../sources/chain.ts";
import { chainFor } from "../sources/registry.ts";
import type { Quote } from "../sources/tencent.ts";
import { type SourceBar, type SourceBars, type SourceCtx, srcCode } from "../sources/types.ts";
import { sqlCodeList, type Warehouse } from "../warehouse/db.ts";
import type { MissingReason } from "./completeness.ts";
import { RateLimitBudgetError, RateLimitWaitBudget } from "./rate-limit.ts";
import {
  doneKeys,
  errMsg,
  type EtlContext,
  markDone,
  markFailed,
  type SecurityRow,
} from "./context.ts";

/** bars_daily 的一行（按列序）：表尾是来源与数据版本号（第 3 版） */
export type BarRow = [
  code: string,
  date: DateStr,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
  amount: number | null,
  adj: number,
  src: BarSource,
  ver: number | null,
];

/** 日线来源：em 东财日 K、tx 腾讯日 K、txq 腾讯实时报价 */
export type BarSource = "em" | "tx" | "txq";

export interface FetchedBars {
  rows: BarRow[];
  actions: RefAction[];
  source: "em" | "tx";
}

export function sourceCtx(ctx: EtlContext): SourceCtx {
  return { http: ctx.http, today: ctx.today, log: ctx.log };
}

async function fetchOnce(
  ctx: EtlContext,
  code: string,
  from: DateStr,
  to: DateStr,
): Promise<{
  raw: SourceBar[];
  adj: number[];
  actions: RefAction[];
  source: FetchedBars["source"];
  volumeUnit: SourceBars["volumeUnit"];
}> {
  const sctx = sourceCtx(ctx);
  const chain = chainFor("bars", marketOf(code), ctx.log);
  const r = await fetchWithChain(
    chain,
    `日线 ${code}`,
    (a) => a.dailyBars!(sctx, code, from, to),
    (sb) => !sb.bars.length,
    ctx.http,
  );
  for (const a of r.attempts) {
    if (a.outcome === "error") ctx.log(`日线 ${code} ${a.source} 失败，换下一家：${a.msg ?? ""}`);
  }
  // 口径换算不成的在这里拒收（CaliberError），不入库
  const { raw, adj, actions } = toIvanBars(code, r.value);
  ctx.ledger?.record(code, r, "bars");
  return {
    raw,
    adj,
    actions,
    source: srcCode(r.servedBy, "bars") === "tx" ? "tx" : "em",
    volumeUnit: r.value.volumeUnit,
  };
}

/**
 * 整条日线链都被封时，等最早解封的那家（回填不把这种情况记成失败）。
 * 带了等风控的预算（D108，worker 里的夜间更新与抽检）时只在预算内等：不够等到解封就抛 RateLimitBudgetError，
 * 这只股票记成 rate_limited 缺失，交给完整性闸门。
 */
async function withUnblockWait<T>(ctx: EtlContext, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof BlockedError) || e instanceof RateLimitBudgetError || attempt >= 12) throw e;
      const until = Math.max(e.until, Date.now()) + 5_000;
      const budget = ctx.rateLimitBudget;
      if (budget) {
        const first = !budget.isExhausted;
        if (!budget.reserve(until)) {
          // 只在第一次用完时记一行，剩下被拦的股票不再逐只刷日志
          if (first) {
            ctx.log(
              `日 K 接口被风控（${e.message}），等风控的 ${Math.round(budget.totalMs / 60_000)} 分钟预算不够等到解封，` +
                `剩下被拦的股票这次不等、记成缺失`,
            );
          }
          throw new RateLimitBudgetError(e, budget);
        }
      }
      const wait = until - Date.now();
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
  let got: Awaited<ReturnType<typeof fetchOnce>>;
  try {
    got = await withUnblockWait(ctx, () => fetchOnce(ctx, code, from, to));
  } catch (e) {
    ctx.ledger?.recordFailure(code, e);
    throw e;
  }
  const { raw, adj, actions, source, volumeUnit } = got;
  let scale = 1;
  if (anchor) {
    const i = raw.findIndex((b) => b.date === anchor.date);
    if (i >= 0) scale = anchor.adj / adj[i]!;
  }
  // 成交量统一成「股」（D51）：来源说明了单位就照办；infer 时有成交额（东财）按成交额判断，没有（腾讯）按板块
  const mult =
    volumeUnit === "shares" ? 1 : volumeUnit === "lots" ? 100 : volumeMultiplier(code, raw);
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
    source,
    ctx.ver ?? null,
  ]);
  return { rows, actions, source };
}

/** 体检要读的仓库数据：交易日历、证券板块与上市日、最新的 ST 标记（近似，只影响标记） */
interface VetEnv {
  calendar: Set<DateStr>;
  sec: Map<string, { board: string | null; listDate: DateStr | null }>;
  st: Map<string, boolean>;
}

/** 同一个数据版本里只读一次（版本开始时日历与证券表已经更新过）；不在版本里写时每次都读 */
const vetCache = new WeakMap<Warehouse, Map<Market, { ver: number; env: Promise<VetEnv> }>>();

async function loadVetEnv(wh: Warehouse, market: Market): Promise<VetEnv> {
  const cal = await wh.all<{ d: string }>(
    `SELECT DISTINCT date::VARCHAR AS d FROM trade_calendar WHERE market = $m`,
    { m: market },
  );
  const secs = await wh.all<{ code: string; board: string | null; list_date: string | null }>(
    `SELECT code, board, list_date::VARCHAR AS list_date FROM securities WHERE market = $m`,
    { m: market },
  );
  const st = await wh.all<{ code: string; st: boolean | null }>(
    `SELECT code, flag_st AS st FROM factors_daily
     WHERE market = $m AND date = (SELECT max(date) FROM factors_daily WHERE market = $m)`,
    { m: market },
  );
  return {
    calendar: new Set(cal.map((r) => r.d)),
    sec: new Map(secs.map((r) => [r.code, { board: r.board, listDate: r.list_date }])),
    st: new Map(st.map((r) => [r.code, !!r.st])),
  };
}

function vetEnv(ctx: EtlContext, market: Market): Promise<VetEnv> {
  if (ctx.ver === undefined) return loadVetEnv(ctx.wh, market);
  let byMarket = vetCache.get(ctx.wh);
  if (!byMarket) vetCache.set(ctx.wh, (byMarket = new Map()));
  const hit = byMarket.get(market);
  if (hit && hit.ver === ctx.ver) return hit.env;
  const env = loadVetEnv(ctx.wh, market);
  byMarket.set(market, { ver: ctx.ver, env });
  return env;
}

function hygieneCtx(
  ctx: EtlContext,
  env: VetEnv,
  code: string,
  actions: Iterable<DateStr>,
  prevRef?: HygieneCtx["prevRef"],
): HygieneCtx {
  const sec = env.sec.get(code);
  const st = env.st.get(code) ?? false;
  return {
    calendar: env.calendar,
    today: ctx.today,
    board: sec?.board ?? null,
    listDate: sec?.listDate ?? null,
    isST: () => st,
    actions: new Set(actions),
    prevRef,
  };
}

/** 一只股票这次体检的结果，交给 recordHygiene 落库 */
export interface HygieneRecord {
  code: string;
  src: string | null;
  /** 写进 bars_daily 的日期 */
  written: DateStr[];
  issues: Issue[];
}

const ISSUE_COLS = 8;

/** 追加数据问题（dataset = bars） */
async function insertIssues(
  wh: Warehouse,
  rows: Array<{ ver: number | null; code: string; date: DateStr; rule: string; severity: string; detail: string; src: string | null }>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const params: Record<string, string | number | null> = {};
    const values = chunk.map((r, k) => {
      const p = (n: number) => `$p${k * ISSUE_COLS + n}`;
      params[`p${k * ISSUE_COLS}`] = r.ver;
      params[`p${k * ISSUE_COLS + 1}`] = "bars";
      params[`p${k * ISSUE_COLS + 2}`] = r.code;
      params[`p${k * ISSUE_COLS + 3}`] = r.date;
      params[`p${k * ISSUE_COLS + 4}`] = r.rule;
      params[`p${k * ISSUE_COLS + 5}`] = r.severity;
      params[`p${k * ISSUE_COLS + 6}`] = r.detail.slice(0, 300);
      params[`p${k * ISSUE_COLS + 7}`] = r.src;
      return `(${p(0)}, ${p(1)}, ${p(2)}, ${p(3)}::DATE, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)})`;
    });
    await wh.run(
      `INSERT INTO data_issues (ver, dataset, code, date, rule, severity, detail, src) VALUES ${values.join(", ")}`,
      params,
    );
  }
}

/** 按（代码, 日期）删 bar_status 的行 */
async function deleteBarStatus(wh: Warehouse, pairs: Array<[string, DateStr]>): Promise<void> {
  for (let i = 0; i < pairs.length; i += 1000) {
    const chunk = pairs.slice(i, i + 1000);
    // 代码与日期都先校验再内联
    const codes = sqlCodeList([...new Set(chunk.map((p) => p[0]))]);
    for (const [, d] of chunk) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`非法日期 ${d}`);
    const values = chunk.map(([c, d]) => `('${c}', DATE '${d}')`).join(", ");
    await wh.run(
      `DELETE FROM bar_status USING (VALUES ${values}) AS v(c, d)
       WHERE bar_status.code IN (${codes}) AND bar_status.code = v.c AND bar_status.date = v.d`,
    );
  }
}

/** 写 bar_status（先删同一（代码, 日期）的旧行） */
export async function writeBarStatus(
  ctx: EtlContext,
  rows: Array<{ code: string; date: DateStr; status: "no_trade" | "missing"; reason: string | null; src: string | null }>,
): Promise<void> {
  if (!rows.length) return;
  await deleteBarStatus(
    ctx.wh,
    rows.map((r) => [r.code, r.date]),
  );
  await ctx.wh.append(
    "bar_status",
    rows.map((r) => [r.code, r.date, r.status, r.reason, r.src, ctx.ver ?? null]),
  );
}

/**
 * 体检结果落库（在调用方的 exclusive 里调用）：
 * - 新问题写 data_issues（同一（代码, 日期, 规则）已有未解决的就不重复写）；
 * - 拒收的日子记 bar_status = missing（原因 rejected:<规则>），写上了的日子删掉 bar_status；
 * - 写上了的（代码, 日期）上更早版本留下、这次没再触发的问题记为已解决（refetch）。每周抽检的 check_* 不在这里关。
 */
export async function recordHygiene(ctx: EtlContext, recs: readonly HygieneRecord[]): Promise<void> {
  if (!recs.length) return;
  const codes = [...new Set(recs.map((r) => r.code))];
  const open: Array<{ id: number; code: string; d: string; rule: string; ver: number | null }> = [];
  for (let i = 0; i < codes.length; i += 1000) {
    open.push(
      ...(await ctx.wh.all<{ id: number; code: string; d: string; rule: string; ver: number | null }>(
        `SELECT id, code, date::VARCHAR AS d, rule, ver FROM data_issues
         WHERE dataset = 'bars' AND resolved_by IS NULL AND code IN (${sqlCodeList(codes.slice(i, i + 1000))})`,
      )),
    );
  }
  const openKey = new Set(open.map((o) => `${o.code}|${o.d}|${o.rule}`));
  const raised = new Set<string>();
  const fresh: Parameters<typeof insertIssues>[1] = [];
  const statusDelete: Array<[string, DateStr]> = [];
  const missing: Parameters<typeof writeBarStatus>[1] = [];
  const written = new Set<string>();
  for (const r of recs) {
    for (const d of r.written) {
      written.add(`${r.code}|${d}`);
      statusDelete.push([r.code, d]);
    }
    for (const x of r.issues) {
      const key = `${r.code}|${x.date}|${x.rule}`;
      raised.add(key);
      if (!openKey.has(key)) {
        openKey.add(key);
        fresh.push({
          ver: ctx.ver ?? null,
          code: r.code,
          date: x.date,
          rule: x.rule,
          severity: x.severity,
          detail: x.detail,
          src: r.src,
        });
      }
      if (x.severity === "reject") {
        missing.push({ code: r.code, date: x.date, status: "missing", reason: `rejected:${x.rule}`, src: r.src });
      }
    }
  }
  await insertIssues(ctx.wh, fresh);
  await deleteBarStatus(ctx.wh, statusDelete);
  await writeBarStatus(ctx, missing);
  if (ctx.ver === undefined) return;
  const resolved = open
    .filter(
      (o) =>
        o.ver !== null &&
        o.ver < ctx.ver! &&
        !o.rule.startsWith("check_") &&
        written.has(`${o.code}|${o.d}`) &&
        !raised.has(`${o.code}|${o.d}|${o.rule}`),
    )
    .map((o) => o.id);
  for (let i = 0; i < resolved.length; i += 1000) {
    await ctx.wh.run(
      `UPDATE data_issues SET resolved_ver = $v, resolved_by = 'refetch' WHERE id IN (${resolved
        .slice(i, i + 1000)
        .map((id) => Number(id))
        .join(",")})`,
      { v: ctx.ver },
    );
  }
}

/**
 * 整段写入一只股票的日线与公司行动（先删后写）；导出给测试。写之前体检（D74）：拒收的行不入库，
 * 问题与缺失状态落库。返回入库的行与这次的问题。
 */
export async function writeBars(
  ctx: EtlContext,
  code: string,
  from: DateStr,
  fetched: FetchedBars,
  opts: { wholeHistory?: boolean } = {},
): Promise<{ accepted: BarRow[]; issues: Issue[] }> {
  const env = await vetEnv(ctx, marketOf(code));
  const prev = opts.wholeHistory
    ? undefined
    : await ctx.wh.one<{ close: number; adj: number; open: number; high: number; low: number; volume: number }>(
        `SELECT close, adj, open, high, low, volume FROM bars_daily WHERE code = $c AND date < $f::DATE
         ORDER BY date DESC LIMIT 1`,
        { c: code, f: from },
      );
  const { accepted, issues } = validateBars(
    code,
    fetched.rows,
    hygieneCtx(
      ctx,
      env,
      code,
      fetched.actions.map((a) => a.date),
      prev ?? undefined,
    ),
  );
  await ctx.wh.exclusive(async () => {
    if (opts.wholeHistory) {
      await ctx.wh.run(`DELETE FROM bars_daily WHERE code = $c`, { c: code });
    } else {
      await ctx.wh.run(`DELETE FROM bars_daily WHERE code = $c AND date >= $f::DATE`, {
        c: code,
        f: from,
      });
    }
    await ctx.wh.append("bars_daily", accepted);
    if (opts.wholeHistory) {
      await ctx.wh.run(`DELETE FROM corp_actions WHERE code = $c`, { c: code });
    }
    // 窗口第一天的「事件」是和窗口外比出来的，不可靠，只写窗口内第二天起的（整段重写时全写）
    const first = opts.wholeHistory ? undefined : fetched.rows[0]?.[1];
    if (!opts.wholeHistory) {
      await ctx.wh.run(`DELETE FROM corp_actions WHERE code = $c AND date > $f::DATE`, {
        c: code,
        f: first ?? from,
      });
    }
    await ctx.wh.append(
      "corp_actions",
      fetched.actions
        .filter((a) => !first || a.date > first)
        .map((a) => [
          code,
          a.date,
          a.prevClose,
          a.refPrice,
          a.cash,
          a.split,
          fetched.source,
          ctx.ver ?? null,
        ]),
    );
    await recordHygiene(ctx, [
      { code, src: fetched.source, written: accepted.map((r) => r[1]), issues },
    ]);
  });
  return { accepted, issues };
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
  const sources: Record<FetchedBars["source"], number> = { em: 0, tx: 0 };
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
      ctx.log(`日线 ${n}/${todo.length}（东财 ${sources.em}，腾讯 ${sources.tx}）`);
      ctx.progress?.(n / todo.length, `日线 ${n}/${todo.length}`);
    }
  });
  return { done: ok, failed, skipped: securities.length - todo.length };
}

/** 各股票库里最后一根 K 线。 */
interface LastBar {
  date: DateStr;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adj: number;
}

async function lastBars(ctx: EtlContext, market: Market): Promise<Map<string, LastBar>> {
  const rows = await ctx.wh.all<LastBar & { code: string }>(
    `SELECT b.code, b.date::VARCHAR AS date, b.open, b.high, b.low, b.close, b.volume, b.adj
     FROM bars_daily b
     JOIN (SELECT code, max(date) AS d FROM bars_daily WHERE code IN
             (SELECT code FROM securities WHERE market = $m AND delist_date IS NULL)
           GROUP BY code) m
       ON b.code = m.code AND b.date = m.d`,
    { m: market },
  );
  return new Map(rows.map((r) => [r.code, r]));
}

export interface UpdateBarsResult {
  viaQuote: number;
  viaKline: number;
  exRights: number;
  failed: number;
  /** 报价批次失败或报价漏掉、转去逐股补的股票数 */
  quoteFallback: number;
  /** 今天应该有日线的股票数（从没回填过的、还没上市的不算） */
  expected: number;
  /** 今天有了日线的股票数（含之前就已经有的） */
  updated: number;
  /** 今天没成交（停牌）的股票数 */
  noTrade: number;
  /** 今天缺日线的股票与原因（完整性闸门用，D73） */
  missing: Array<{ code: string; reason: MissingReason }>;
  /** 缺失的股票里日线停在昨天之前的：代码 → 齐全到哪天（D111，补数据时决定截至日能提交到哪天） */
  behind: Map<string, DateStr | null>;
  /** 最后一根 K 线早于昨天、但中间每天都记着没成交，这次直接走报价的股票数（D111） */
  resumed: number;
  /** 港股复权轮换刷新：刷新了几只、因为日 K 被风控跳过了几只（D111：轮换让路，不和补数据抢请求） */
  rotation: { done: number; skipped: number };
}

/** 报价时间里的日期：A 股 `20260928161451`、港股 `2026/09/28 16:08:34` → 2026-09-28；读不出为 null */
function quoteDateOf(q: Quote): DateStr | null {
  const t = q.time.replace(/\D/g, "").slice(0, 8);
  return /^\d{8}$/.test(t) ? (`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` as DateStr) : null;
}

/**
 * 每只股票的日线齐全到哪天（D111）：不晚于 upTo 的最后一根 K 线，再往后接上连续记着没成交（bar_status no_trade）的交易日。
 * 从没有过日线的为 null。
 */
export async function completeThrough(
  wh: Warehouse,
  market: Market,
  codes: readonly string[],
  upTo: DateStr,
): Promise<Map<string, DateStr | null>> {
  const out = new Map<string, DateStr | null>();
  if (!codes.length) return out;
  const lastBar = new Map<string, DateStr>();
  for (let i = 0; i < codes.length; i += 1000) {
    const rows = await wh.all<{ code: string; d: string }>(
      `SELECT code, max(date)::VARCHAR AS d FROM bars_daily
       WHERE code IN (${sqlCodeList(codes.slice(i, i + 1000))}) AND date <= $u::DATE GROUP BY code`,
      { u: upTo },
    );
    for (const r of rows) lastBar.set(r.code, r.d);
  }
  const earliest = [...lastBar.values()].sort()[0];
  const noTrade = new Map<string, Set<string>>();
  const cal: DateStr[] = [];
  if (earliest) {
    for (const r of await wh.all<{ d: string }>(
      `SELECT DISTINCT date::VARCHAR AS d FROM trade_calendar
       WHERE market = $m AND date > $a::DATE AND date <= $u::DATE ORDER BY d`,
      { m: market, a: earliest, u: upTo },
    ))
      cal.push(r.d);
    for (let i = 0; i < codes.length; i += 1000) {
      const rows = await wh.all<{ code: string; d: string }>(
        `SELECT code, date::VARCHAR AS d FROM bar_status
         WHERE status = 'no_trade' AND code IN (${sqlCodeList(codes.slice(i, i + 1000))})
           AND date > $a::DATE AND date <= $u::DATE`,
        { a: earliest, u: upTo },
      );
      for (const r of rows) {
        let set = noTrade.get(r.code);
        if (!set) noTrade.set(r.code, (set = new Set()));
        set.add(r.d);
      }
    }
  }
  for (const code of codes) {
    const l = lastBar.get(code);
    if (!l) {
      out.set(code, null);
      continue;
    }
    let through = l;
    const set = noTrade.get(code);
    if (set) {
      for (const d of cal) {
        if (d <= l) continue;
        if (!set.has(d)) break;
        through = d;
      }
    }
    out.set(code, through);
  }
  return out;
}

/**
 * 逐股补的顺序（D111）：除权日的（报价说今天有成交，只有几只）在前；其余按日线停得最早的在前（从没有过日线的最前），
 * 同一只只补一次。
 */
export function klineOrder<T extends { code: string }>(
  exRights: readonly T[],
  gap: readonly T[],
  lastDate: (code: string) => DateStr | undefined,
): T[] {
  const sorted = [...gap].sort((a, b) => {
    const da = lastDate(a.code) ?? "";
    const db = lastDate(b.code) ?? "";
    return da < db ? -1 : da > db ? 1 : 0;
  });
  return [...new Map([...exRights, ...sorted].map((s) => [s.code, s])).values()];
}

export async function updateBars(
  ctx: EtlContext,
  market: Market,
  securities: readonly SecurityRow[],
  latestTradeDate: DateStr,
  prevTradeDate: DateStr,
): Promise<UpdateBarsResult> {
  const active = securities.filter(
    (s) => !s.delist_date && !(s.list_date && s.list_date > latestTradeDate),
  );
  const last = await lastBars(ctx, market);
  const quoteable: SecurityRow[] = [];
  const gap: SecurityRow[] = [];
  /** 最后一根 K 线早于昨天的：中间每天都记着没成交的照样走报价，其余逐股补 */
  const lagging: SecurityRow[] = [];
  let neverFilled = 0;
  /** 今天每只股票的结果：updated 有了日线；no_trade 没成交；missing 缺（带原因） */
  const state = new Map<
    string,
    { s: "updated" } | { s: "no_trade"; src: string } | { s: "missing"; reason: MissingReason; src: string | null }
  >();
  for (const s of active) {
    const l = last.get(s.code);
    if (!l) {
      // 库里一根 K 线都没有、又不是近 30 天新上市的：从没回填过（比如用了 --top），增量不替它补全历史
      if (s.list_date && s.list_date < addDays(latestTradeDate, -30)) neverFilled++;
      else gap.push(s);
    } else if (l.date >= latestTradeDate) state.set(s.code, { s: "updated" });
    else if (l.date === prevTradeDate) quoteable.push(s);
    else lagging.push(s);
  }
  // 停牌续上（D111）：最后一根 K 线之后到昨天，每个交易日都记着没成交（停牌、零成交的港股小票），日线其实齐到了昨天，
  // 和「昨天有 K 线」一样走报价。原来它们每晚都要逐股补（港股三四百只、每只两次请求），一被风控就越积越多
  const through = await completeThrough(
    ctx.wh,
    market,
    lagging.map((s) => s.code),
    prevTradeDate,
  );
  let resumed = 0;
  for (const s of lagging) {
    if ((through.get(s.code) ?? "") >= prevTradeDate) {
      quoteable.push(s);
      resumed++;
    } else gap.push(s);
  }

  const env = await vetEnv(ctx, market);
  const newRows: BarRow[] = [];
  const quoteVets: HygieneRecord[] = [];
  const exRights: SecurityRow[] = [];
  /** 报价批次失败或漏掉、转去逐股补的代码：逐股也补不上时原因记 quote_omitted */
  const omittedCodes = new Set<string>();
  /**
   * 逐股补的股票的报价（D111）：今天有没有成交、报价时间的日期、前收。判断逐股日 K 里没有的日子是没成交还是来源还没更新：
   * 今天成交了日 K 里却没有 → 缺；最后一根之后到昨天，报价的前收等于最后一根的收盘（或报价停在那天）→ 这些天没成交。
   */
  const gapQuote = new Map<string, { date: DateStr | null; traded: boolean; prevClose: number }>();
  const quoteDate = latestTradeDate.replaceAll("-", "");
  const gapCodes = new Set(gap.map((s) => s.code));
  // 逐股补的也一起要报价（同一批 60 只，多几次报价请求），只用来判断有没有成交，不从报价写日线
  const targets = [...quoteable, ...gap];
  const batches: SecurityRow[][] = [];
  for (let i = 0; i < targets.length; i += 60) batches.push(targets.slice(i, i + 60));
  let quoteFallback = 0;
  const sctx = sourceCtx(ctx);
  const quoteChain = chainFor("quotes", market, ctx.log);
  await mapLimit(batches, 2, async (all) => {
    const batch = all.filter((s) => !gapCodes.has(s.code));
    // 一批报价出错不让整晚失败：这批股票转去逐股补日线；报价里漏了的代码（腾讯偶尔漏）也一样
    let qs: Quote[];
    try {
      const r = await fetchWithChain(
        quoteChain,
        `报价 ${all.length} 只`,
        (a) =>
          a.quotes!(
            sctx,
            all.map((s) => s.code),
          ),
        (v) => !v.length,
        ctx.http,
      );
      qs = r.value;
    } catch (e) {
      if (!batch.length) return;
      ctx.log(`报价批次失败，改逐股补日线：${errMsg(e)}`);
      gap.push(...batch);
      for (const s of batch) omittedCodes.add(s.code);
      quoteFallback += batch.length;
      return;
    }
    const got = new Set(qs.map((q) => q.code));
    const omitted = batch.filter((s) => !got.has(s.code));
    if (omitted.length) {
      ctx.log(`报价漏了 ${omitted.length} 只，改逐股补日线`);
      gap.push(...omitted);
      for (const s of omitted) omittedCodes.add(s.code);
      quoteFallback += omitted.length;
    }
    for (const q of qs) {
      if (gapCodes.has(q.code)) {
        const date = quoteDateOf(q);
        gapQuote.set(q.code, {
          date,
          traded: date === latestTradeDate && q.open > 0 && q.volume > 0,
          prevClose: q.prevClose,
        });
        continue;
      }
      const t = q.time.replace(/\D/g, "").slice(0, 8);
      // 当天没成交（停牌）：报价时间不是这一天或开盘价为 0，不写，记 no_trade
      if (t !== quoteDate || !(q.open > 0) || !(q.volume > 0)) {
        state.set(q.code, { s: "no_trade", src: "txq" });
        continue;
      }
      const l = last.get(q.code)!;
      // A 股除权日交易所发布除权参考前收；港股不发布，靠轮换刷新
      if (market === "A" && Math.abs(q.prevClose - l.close) > 0.0051) {
        exRights.push(batch.find((s) => s.code === q.code)!);
        continue;
      }
      const row: BarRow = [
        q.code,
        latestTradeDate,
        q.open,
        Math.max(q.high, q.open, q.price),
        Math.min(q.low > 0 ? q.low : q.price, q.open, q.price),
        q.price,
        q.volume * volumeMultiplier(q.code, [{ close: q.price, volume: q.volume, amount: q.amount }]),
        q.amount > 0 ? q.amount : null,
        l.adj,
        "txq",
        ctx.ver ?? null,
      ];
      // 报价路径也过体检（D74）：拒收的不写、记缺失
      const v = validateBars(q.code, [row], hygieneCtx(ctx, env, q.code, [], l));
      quoteVets.push({ code: q.code, src: "txq", written: v.accepted.map((r) => r[1]), issues: v.issues });
      if (v.accepted.length) {
        newRows.push(...v.accepted);
        state.set(q.code, { s: "updated" });
      } else {
        const rej = v.issues.find((x) => x.severity === "reject")!;
        state.set(q.code, { s: "missing", reason: `rejected:${rej.rule}`, src: "txq" });
      }
    }
  });
  for (const r of newRows) ctx.ledger?.served(r[0], "txq");
  if (newRows.length || quoteVets.length) {
    await ctx.wh.exclusive(async () => {
      if (newRows.length) {
        await ctx.wh.run(
          `DELETE FROM bars_daily WHERE date = $d::DATE AND code IN (${sqlCodeList(newRows.map((r) => r[0]))})`,
          { d: latestTradeDate },
        );
        await ctx.wh.append("bars_daily", newRows);
      }
      await recordHygiene(ctx, quoteVets);
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
  /** 报价说今天有成交的（除权日）：逐股日 K 里没有今天就是缺，不是停牌 */
  const tradedToday = new Set(exRights.map((s) => s.code));
  const caliberRejects: HygieneRecord[] = [];
  /** 逐股日 K 窗口里没有、确认是没成交的日子（D111）：记 no_trade，以后这只股票能走报价 */
  const historyNoTrade: Parameters<typeof writeBarStatus>[1] = [];
  const calendar = [...env.calendar].filter((d) => d < latestTradeDate).sort();
  const fetchOne = async (c: EtlContext, s: SecurityRow, rotation: boolean): Promise<void> => {
    const l = last.get(s.code);
    const from = l ? addDays(l.date, -60) : (s.list_date ?? addDays(latestTradeDate, -60));
    const lost = (reason: MissingReason, src: string | null) => {
      // 报价已经写上了今天（港股轮换刷新失败）就不算缺
      if (state.get(s.code)?.s !== "updated") state.set(s.code, { s: "missing", reason, src });
    };
    const anchorRow = l
      ? await c.wh.one<{ date: string; adj: number }>(
          `SELECT date::VARCHAR AS date, adj FROM bars_daily WHERE code = $c AND date >= $f::DATE
           ORDER BY date LIMIT 1`,
          { c: s.code, f: from },
        )
      : undefined;
    const fetched = await fetchBars(c, s.code, from, latestTradeDate, anchorRow);
    viaKline++;
    if (!fetched.rows.length) {
      // 能连上的来源说没有（empty）：留给闸门当缺失
      if (!rotation) lost(omittedCodes.has(s.code) ? "quote_omitted" : "chain_failed", null);
      return;
    }
    const w = await writeBars(c, s.code, from, fetched);
    if (!rotation) {
      // 窗口里没有的日子（D111）：第一根与最后一根之间的是没成交（来源的历史是定稿的）；最后一根之后到昨天的，
      // 要报价佐证这之后没再成交过（报价停在那天，或报价的前收就是那根的收盘）才记没成交，不然可能是来源还没更新
      const rows = [...fetched.rows].sort((a, b) => (a[1] < b[1] ? -1 : 1));
      const first = rows[0]![1];
      const lastRow = rows.at(-1)!;
      const have = new Set(w.accepted.map((r) => r[1]));
      const rejected = new Set(w.issues.filter((x) => x.severity === "reject").map((x) => x.date));
      const q = gapQuote.get(s.code);
      // 报价时间停在之前的某天（A 股停在最后成交的时刻）：那天不晚于最后一根才算；报价时间是今天、今天没成交
      // （港股零成交的小票报价时间也是今天）：看前收是不是最后一根的收盘
      const trailingOk =
        !!q &&
        !q.traded &&
        (q.date !== null && q.date !== latestTradeDate
          ? q.date <= lastRow[1]
          : Math.abs(q.prevClose - lastRow[5]) < 0.0005);
      for (const d of calendar) {
        if (d <= first || have.has(d) || rejected.has(d)) continue;
        if (d > lastRow[1] && !trailingOk) break;
        historyNoTrade.push({ code: s.code, date: d, status: "no_trade", reason: null, src: fetched.source });
      }
    }
    if (w.accepted.some((r) => r[1] === latestTradeDate)) {
      state.set(s.code, { s: "updated" });
      return;
    }
    if (rotation) return;
    const rej = w.issues.find((x) => x.severity === "reject" && x.date === latestTradeDate);
    if (rej) lost(`rejected:${rej.rule}`, fetched.source);
    else if (tradedToday.has(s.code)) lost("chain_failed", fetched.source);
    // 报价说今天有成交、日 K 里还没有今天：来源还没更新，是缺不是停牌（D111）
    else if (gapQuote.get(s.code)?.traded) lost("kline_behind", fetched.source);
    else if (state.get(s.code)?.s !== "updated") {
      state.set(s.code, { s: "no_trade", src: fetched.source });
    }
  };
  // 除权日的（报价说今天有成交，只有几只）先补；补数据按日线停得最早的先补（D111）：被风控挡住时先把最老的缺口补上，
  // 数据齐全的那天才能往前推
  const ordered = klineOrder(exRights, gap, (code) => last.get(code)?.date);
  await mapLimit(ordered, 3, async (s) => {
    try {
      await fetchOne(ctx, s, false);
    } catch (e) {
      failed++;
      ctx.log(`日线增量失败 ${s.code}：${errMsg(e)}`);
      const lost = (reason: MissingReason) => {
        if (state.get(s.code)?.s !== "updated") state.set(s.code, { s: "missing", reason, src: null });
      };
      if (e instanceof CaliberError) {
        // 口径换算不成的拒收（D72）：记一条数据问题，原因 rejected:caliber
        lost("rejected:caliber");
        caliberRejects.push({
          code: s.code,
          src: null,
          written: [],
          issues: [
            { rule: "caliber", severity: "reject", date: latestTradeDate, detail: errMsg(e).slice(0, 200) },
          ],
        });
      } else if (e instanceof BlockedError) {
        // 整条链被风控、没等到解封（D108）：单独记原因，闸门与管理页能说清是风控
        lost("rate_limited");
      } else {
        lost(omittedCodes.has(s.code) ? "quote_omitted" : "chain_failed");
      }
    }
  });
  // 港股复权轮换（D111）：排在补数据之后；不等风控解封，日 K 一被风控就停，剩下的下一轮再刷（不算失败、不记缺失）
  const queued = new Set(ordered.map((s) => s.code));
  const rotation = { done: 0, skipped: 0 };
  // 一个已经用完的等风控预算：被风控就不等，也不记「预算不够」那行（那是给补数据的）
  const spent = new RateLimitWaitBudget(0);
  spent.reserve(Number.MAX_SAFE_INTEGER);
  const noWait: EtlContext = { ...ctx, rateLimitBudget: spent };
  let stopRotation = false;
  await mapLimit(
    rotate.filter((s) => !queued.has(s.code)),
    3,
    async (s) => {
      if (stopRotation) {
        rotation.skipped++;
        return;
      }
      try {
        await fetchOne(noWait, s, true);
        rotation.done++;
      } catch (e) {
        rotation.skipped++;
        if (e instanceof BlockedError) stopRotation = true;
        else ctx.log(`复权刷新失败 ${s.code}：${errMsg(e)}`);
      }
    },
  );
  if (rotation.skipped) {
    ctx.log(`复权轮换刷新 ${rotation.done} 只，${rotation.skipped} 只这次跳过（日 K 被风控或出错），下一轮再刷`);
  }

  // 日线状态（D73）：没成交 / 缺失记 bar_status；之后写上了的由 recordHygiene 删掉
  const statusRows: Parameters<typeof writeBarStatus>[1] = [...historyNoTrade];
  const missing: UpdateBarsResult["missing"] = [];
  let updated = 0;
  let noTrade = 0;
  // 按代码排好（逐股补是并发的，完成顺序不定）
  for (const [code, st] of [...state].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (st.s === "updated") updated++;
    else if (st.s === "no_trade") {
      noTrade++;
      statusRows.push({ code, date: latestTradeDate, status: "no_trade", reason: null, src: st.src });
    } else {
      missing.push({ code, reason: st.reason });
      statusRows.push({ code, date: latestTradeDate, status: "missing", reason: st.reason, src: st.src });
    }
  }
  await ctx.wh.exclusive(async () => {
    await recordHygiene(ctx, caliberRejects);
    await writeBarStatus(ctx, statusRows);
  });
  // 缺失的股票里之前的日子也没补上的（D111）：日线齐到哪天
  const behind = new Map<string, DateStr | null>();
  for (const [code, d] of await completeThrough(
    ctx.wh,
    market,
    missing.map((m) => m.code),
    prevTradeDate,
  )) {
    if (d === null || d < prevTradeDate) behind.set(code, d);
  }
  const expected = active.length - neverFilled;
  ctx.log(
    `${market} 日线增量：报价 ${newRows.length} 只，逐股 ${viaKline - rotation.done} 只（其中除权 ${exRights.length}` +
      (quoteFallback ? `、报价没拿到 ${quoteFallback}` : "") +
      (resumed ? `；停牌续上走报价 ${resumed}` : "") +
      (rotation.done ? `；复权轮换 ${rotation.done}` : "") +
      `），失败 ${failed}；应更新 ${expected}，已有 ${updated}，没成交 ${noTrade}，缺 ${missing.length}` +
      (behind.size ? `（其中 ${behind.size} 只之前的日子也没补上）` : "") +
      (neverFilled ? `；${neverFilled} 只从没回填过，跳过（要补请跑 backfill）` : ""),
  );
  return {
    viaQuote: newRows.length,
    viaKline,
    exRights: exRights.length,
    failed,
    quoteFallback,
    expected,
    updated,
    noTrade,
    missing,
    behind,
    resumed,
    rotation,
  };
}

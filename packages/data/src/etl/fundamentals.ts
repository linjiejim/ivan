/**
 * 财报与股本 ETL。
 * - A 股财报：逐股取东财主要指标（含退市股；全市场业绩报表不含退市股，D20），公告日即生效日。
 * - 港股财报：逐股取东财港股主要指标 + 记账币种；生效日按法定期限推算（D22）。
 * - 股本变动：A 股 RPT_F10_EH_EQUITY、港股 RPT_HKF10_INFO_EQUITY，带生效日。
 * - 增量：按公告日查全市场近几天的新记录，只重取这些股票的全部历史（简单且不会漏改）。
 */
import { addDays, addYears, type DateStr, type Market, marketOf, normalizeDate } from "@ivan/core";
import { hkEffectiveDate, type Period } from "../compute/financials.ts";
import { mapLimit } from "../http.ts";
import { emQuery, num, str, type EmRow } from "../sources/eastmoney.ts";
import {
  doneKeys,
  errMsg,
  type EtlContext,
  filledCodes,
  markDone,
  markFailed,
  type SecurityRow,
} from "./context.ts";

const A_FIN_COLUMNS =
  "REPORT_DATE,NOTICE_DATE,CURRENCY,TOTALOPERATEREVE,PARENTNETPROFIT,KCFJCXSYJLR," +
  "TOTALOPERATEREVETZ,PARENTNETPROFITTZ,KCFJCXSYJLRTZ,ROEJQ,XSMLL,ZCFZL,NETCASH_OPERATE_PK,BPS,TOTAL_SHARE";

const HK_FIN_COLUMNS =
  "REPORT_DATE,DATE_TYPE_CODE,START_DATE,OPERATE_INCOME,OPERATE_INCOME_YOY,HOLDER_PROFIT," +
  "HOLDER_PROFIT_YOY,ROE_AVG,GROSS_PROFIT_RATIO,DEBT_ASSET_RATIO,NETCASH_OPERATE," +
  "TOTAL_PARENT_EQUITY,ISSUED_COMMON_SHARES";

const HK_PERIOD: Record<string, Period> = { "001": "FY", "002": "H1", "003": "Q1", "004": "Q3" };
const A_PERIOD: Record<string, Period> = { "03": "Q1", "06": "H1", "09": "Q3", "12": "FY" };

type FinTuple = unknown[];

function aFinRow(code: string, r: EmRow): FinTuple | null {
  const report = normalizeDate(str(r.REPORT_DATE));
  if (!report) return null;
  const period = A_PERIOD[report.slice(5, 7)];
  if (!period) return null;
  const notice = normalizeDate(str(r.NOTICE_DATE));
  const bps = num(r.BPS);
  const shares = num(r.TOTAL_SHARE);
  return [
    code,
    report,
    period,
    `${report.slice(0, 4)}-01-01`,
    notice,
    // 没有公告日的老数据：按报告期后 120 天保守生效
    notice ?? addDays(report, 120),
    str(r.CURRENCY) ?? "CNY",
    num(r.TOTALOPERATEREVE),
    num(r.PARENTNETPROFIT),
    num(r.KCFJCXSYJLR),
    num(r.TOTALOPERATEREVETZ),
    num(r.PARENTNETPROFITTZ),
    num(r.KCFJCXSYJLRTZ),
    num(r.ROEJQ),
    num(r.XSMLL),
    num(r.ZCFZL),
    num(r.NETCASH_OPERATE_PK),
    bps !== null && shares !== null ? bps * shares : null,
    shares,
  ];
}

function hkFinRow(code: string, r: EmRow, currency: string | null): FinTuple | null {
  const report = normalizeDate(str(r.REPORT_DATE));
  const period = HK_PERIOD[String(r.DATE_TYPE_CODE)];
  if (!report || !period) return null;
  return [
    code,
    report,
    period,
    normalizeDate(str(r.START_DATE)),
    null,
    hkEffectiveDate(report, period),
    currency,
    num(r.OPERATE_INCOME),
    num(r.HOLDER_PROFIT),
    null,
    num(r.OPERATE_INCOME_YOY),
    num(r.HOLDER_PROFIT_YOY),
    null,
    num(r.ROE_AVG),
    num(r.GROSS_PROFIT_RATIO),
    num(r.DEBT_ASSET_RATIO),
    num(r.NETCASH_OPERATE),
    num(r.TOTAL_PARENT_EQUITY),
    num(r.ISSUED_COMMON_SHARES),
  ];
}

/**
 * 港股每个报告期「主要指标」金额的币种（D23 补充，2026-09 实测）：
 * 东财港股主要指标对人民币记账的公司保留人民币（腾讯、建行），对美元等其他币种记账的公司已换成港币
 * （汇丰）。所以拿利润表里「股东应占溢利」的原币金额和主要指标的归母净利比：比值≈1 用记账币种，
 * 否则按港币。比不了的期：人民币记账按人民币，其余按港币。
 */
async function hkCurrencies(
  ctx: EtlContext,
  code: string,
): Promise<{ statement: Map<DateStr, string>; profit: Map<DateStr, number> }> {
  const rows = await emQuery(ctx.http, {
    report: "RPT_HKF10_FN_INCOME",
    host: "sec",
    filter: `(SECUCODE="${code}")`,
    columns: "REPORT_DATE,CURRENCY_CODE,ITEM_NAME,AMOUNT",
    pageSize: 5000,
  });
  const statement = new Map<DateStr, string>();
  const profit = new Map<DateStr, number>();
  for (const r of rows) {
    const d = normalizeDate(str(r.REPORT_DATE));
    const c = str(r.CURRENCY_CODE);
    if (!d) continue;
    if (c && !statement.has(d)) statement.set(d, c);
    const name = str(r.ITEM_NAME) ?? "";
    const amt = num(r.AMOUNT);
    if (amt !== null && /股东应占溢利|本公司股东应占|母公司股东|股东应占/.test(name) && !profit.has(d)) {
      profit.set(d, amt);
    }
  }
  return { statement, profit };
}

function mainIndicatorCurrency(
  statementCcy: string | null,
  mainProfit: number | null,
  stmtProfit: number | undefined,
): string {
  if (!statementCcy || statementCcy === "HKD") return "HKD";
  if (mainProfit !== null && stmtProfit !== undefined && stmtProfit !== 0) {
    const ratio = mainProfit / stmtProfit;
    if (Math.abs(ratio - 1) < 0.02) return statementCcy;
    return "HKD";
  }
  return statementCcy === "CNY" ? "CNY" : "HKD";
}

export async function fetchFinancials(
  ctx: EtlContext,
  code: string,
  since: DateStr,
): Promise<FinTuple[]> {
  // 多取 3 年：TTM、两年复合、连续下滑都要往前看
  const cutoff = addYears(since, -3);
  if (marketOf(code) === "A") {
    const rows = await emQuery(ctx.http, {
      report: "RPT_F10_FINANCE_MAINFINADATA",
      host: "sec",
      filter: `(SECUCODE="${code}")(REPORT_DATE>='${cutoff}')`,
      columns: A_FIN_COLUMNS,
      sort: "REPORT_DATE",
      pageSize: 200,
    });
    return rows.map((r) => aFinRow(code, r)).filter((r): r is FinTuple => r !== null);
  }
  const [rows, ccy] = await Promise.all([
    emQuery(ctx.http, {
      report: "RPT_HKF10_FN_MAININDICATOR",
      host: "sec",
      filter: `(SECUCODE="${code}")(REPORT_DATE>='${cutoff}')`,
      columns: HK_FIN_COLUMNS,
      sort: "REPORT_DATE",
      pageSize: 200,
    }),
    hkCurrencies(ctx, code),
  ]);
  // 个别报告期利润表缺失时，沿用最近一期的记账币种
  const known = [...ccy.statement.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const stmtAt = (d: DateStr): string | null => {
    if (ccy.statement.has(d)) return ccy.statement.get(d)!;
    let c: string | null = null;
    for (const [k, v] of known) if (k <= d) c = v;
    return c ?? known[0]?.[1] ?? null;
  };
  return rows
    .map((r) => {
      const d = normalizeDate(str(r.REPORT_DATE));
      if (!d) return null;
      const cur = mainIndicatorCurrency(stmtAt(d), num(r.HOLDER_PROFIT), ccy.profit.get(d));
      return hkFinRow(code, r, cur);
    })
    .filter((r): r is FinTuple => r !== null);
}

export async function fetchShareChanges(ctx: EtlContext, code: string): Promise<unknown[][]> {
  const isA = marketOf(code) === "A";
  const rows = await emQuery(ctx.http, {
    report: isA ? "RPT_F10_EH_EQUITY" : "RPT_HKF10_INFO_EQUITY",
    host: "sec",
    filter: `(SECUCODE="${code}")`,
    columns: isA
      ? "END_DATE,NOTICE_DATE,TOTAL_SHARES,CHANGE_REASON"
      : "CHANGE_DATE,NOTICE_DATE,TOTAL_SHARES,CHANGE_REASON",
    pageSize: 500,
  });
  const out: unknown[][] = [];
  for (const r of rows) {
    const eff = normalizeDate(str(isA ? r.END_DATE : r.CHANGE_DATE));
    const total = num(r.TOTAL_SHARES);
    if (!eff || !(total !== null && total > 0)) continue;
    out.push([code, eff, normalizeDate(str(r.NOTICE_DATE)), total, str(r.CHANGE_REASON)]);
  }
  return out;
}

async function writeFundamentals(
  ctx: EtlContext,
  code: string,
  fin: unknown[][] | null,
  shares: unknown[][] | null,
): Promise<void> {
  await ctx.wh.exclusive(async () => {
    if (fin) {
      await ctx.wh.run(`DELETE FROM financials WHERE code = $c`, { c: code });
      await ctx.wh.append("financials", fin);
    }
    if (shares) {
      await ctx.wh.run(`DELETE FROM share_changes WHERE code = $c`, { c: code });
      await ctx.wh.append("share_changes", shares);
    }
  });
}

export async function backfillFundamentals(
  ctx: EtlContext,
  securities: readonly SecurityRow[],
  opts: { since: DateStr; concurrency?: number; limit?: number; force?: boolean },
): Promise<{ done: number; failed: number }> {
  const task = `fund:${opts.since}`;
  const done = opts.force ? new Set<string>() : await doneKeys(ctx.wh, task);
  let todo = securities.filter(
    (s) => !done.has(s.code) && !(s.delist_date && s.delist_date < opts.since),
  );
  if (opts.limit) todo = todo.slice(0, opts.limit);
  let ok = 0;
  let failed = 0;
  let n = 0;
  await mapLimit(todo, opts.concurrency ?? 4, async (s) => {
    try {
      const [fin, shares] = await Promise.all([
        fetchFinancials(ctx, s.code, opts.since),
        fetchShareChanges(ctx, s.code),
      ]);
      await writeFundamentals(ctx, s.code, fin, shares);
      await ctx.wh.exclusive(() =>
        markDone(ctx.wh, task, s.code, `${fin.length}/${shares.length}`),
      );
      ok++;
    } catch (e) {
      failed++;
      await ctx.wh.exclusive(() => markFailed(ctx.wh, task, s.code, errMsg(e)));
      ctx.log(`财报/股本失败 ${s.code}：${errMsg(e)}`);
    }
    n++;
    if (n % 200 === 0 || n === todo.length) {
      ctx.log(`财报/股本 ${n}/${todo.length}`);
      ctx.progress?.(n / todo.length, `财报/股本 ${n}/${todo.length}`);
    }
  });
  return { done: ok, failed };
}

/**
 * 增量：近 lookbackDays 天有新公告的股票，重取财报与股本全部历史（只管库里已有日线的股票）。
 * 港股财报没有公告日：按报告期查最近两期全市场，库里没有的（代码, 报告期）就重取。
 */
export async function updateFundamentals(
  ctx: EtlContext,
  market: Market,
  securities: readonly SecurityRow[],
  since: DateStr,
  lookbackDays = 7,
): Promise<{ fin: number; shares: number }> {
  // 只管库里有日线的股票（夜间增量先跑日线，新股此时已经有了）；从没回填过的（比如用了 --top）不替它补
  const filled = await filledCodes(ctx.wh, market);
  const active = new Set(
    securities.filter((s) => !s.delist_date && filled.has(s.code)).map((s) => s.code),
  );
  const from = addDays(ctx.today, -lookbackDays);
  const finCodes = new Set<string>();
  const shareCodes = new Set<string>();

  if (market === "A") {
    const fin = await emQuery(ctx.http, {
      report: "RPT_F10_FINANCE_MAINFINADATA",
      host: "sec",
      filter: `(NOTICE_DATE>='${from}')`,
      columns: "SECUCODE",
      pageSize: 5000,
    });
    for (const r of fin) if (active.has(String(r.SECUCODE))) finCodes.add(String(r.SECUCODE));
    const sh = await emQuery(ctx.http, {
      report: "RPT_F10_EH_EQUITY",
      host: "sec",
      filter: `(NOTICE_DATE>='${from}')`,
      columns: "SECUCODE",
      pageSize: 5000,
    });
    for (const r of sh) if (active.has(String(r.SECUCODE))) shareCodes.add(String(r.SECUCODE));
  } else {
    const have = new Set(
      (
        await ctx.wh.all<{ k: string }>(
          `SELECT code || '|' || report_date::VARCHAR AS k FROM financials
           WHERE code LIKE '%.HK' AND report_date >= $d::DATE`,
          { d: addDays(ctx.today, -400) },
        )
      ).map((r) => r.k),
    );
    const recent = await emQuery(ctx.http, {
      report: "RPT_HKF10_FN_MAININDICATOR",
      host: "sec",
      filter: `(REPORT_DATE>='${addDays(ctx.today, -200)}')`,
      columns: "SECUCODE,REPORT_DATE",
      pageSize: 5000,
    });
    for (const r of recent) {
      const code = String(r.SECUCODE);
      const d = normalizeDate(str(r.REPORT_DATE));
      if (active.has(code) && d && !have.has(`${code}|${d}`)) finCodes.add(code);
    }
    const sh = await emQuery(ctx.http, {
      report: "RPT_HKF10_INFO_EQUITY",
      host: "sec",
      filter: `(NOTICE_DATE>='${from}')`,
      columns: "SECUCODE",
      pageSize: 5000,
    });
    for (const r of sh) if (active.has(String(r.SECUCODE))) shareCodes.add(String(r.SECUCODE));
  }

  const codes = [...new Set([...finCodes, ...shareCodes])];
  await mapLimit(codes, 4, async (code) => {
    try {
      const [fin, shares] = await Promise.all([
        finCodes.has(code) ? fetchFinancials(ctx, code, since) : Promise.resolve(null),
        shareCodes.has(code) ? fetchShareChanges(ctx, code) : Promise.resolve(null),
      ]);
      await writeFundamentals(ctx, code, fin, shares);
    } catch (e) {
      ctx.log(`财报/股本增量失败 ${code}：${errMsg(e)}`);
    }
  });
  ctx.log(`${market} 财报增量 ${finCodes.size} 只，股本增量 ${shareCodes.size} 只`);
  return { fin: finCodes.size, shares: shareCodes.size };
}

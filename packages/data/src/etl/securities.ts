/**
 * 证券表刷新（D20）。
 * - A 股：东财公司资料（含退市，给上市日、三级行业）+ 最新交易日的在市名单 + 交易所退市名单（给退市日）。
 *   既不在市、又不在退市名单里的（多为换了代码的，如 601313 江南嘉捷 → 601360），退市日取最后一根 K 线的次日。
 *   北交所 v1 不纳入。
 * - 港股：东财证券资料（在市普通股：非H股 / H股 / 红筹股）+ 公司资料（行业）。消失的代码按最后一根 K 线标记退市。
 */
import { addDays, boardOf, isAShareSymbol, normalizeDate } from "@ivan/core";
import { emQuery, num, str } from "../sources/eastmoney.ts";
import { sqlCodeList } from "../warehouse/db.ts";
import { type DelistedRow, sseDelisted, szseDelisted } from "../sources/exchanges.ts";
import type { EtlContext, SecurityRow } from "./context.ts";

const SEC_COLUMNS = [
  "code",
  "market",
  "name",
  "board",
  "list_date",
  "delist_date",
  "lot_size",
  "industry_l1",
  "industry",
  "sec_type",
] as const;

function toRow(s: SecurityRow): unknown[] {
  return [...SEC_COLUMNS.map((k) => s[k]), new Date().toISOString()];
}

/** 最近一个有估值数据的交易日及当天在市的 A 股（代码 → 简称）。 */
async function listedANow(ctx: EtlContext): Promise<{ date: string; names: Map<string, string> }> {
  const latest = await emQuery(ctx.http, {
    report: "RPT_VALUEANALYSIS_DET",
    columns: "TRADE_DATE",
    sort: "TRADE_DATE",
    pageSize: 1,
    maxRows: 1,
  });
  const date = normalizeDate(String(latest[0]?.TRADE_DATE ?? ""));
  if (!date) throw new Error("东财估值表拿不到最新交易日");
  const rows = await emQuery(ctx.http, {
    report: "RPT_VALUEANALYSIS_DET",
    filter: `(TRADE_DATE='${date}')`,
    columns: "SECUCODE,SECURITY_NAME_ABBR",
    pageSize: 5000,
  });
  return { date, names: new Map(rows.map((r) => [String(r.SECUCODE), String(r.SECURITY_NAME_ABBR)])) };
}

export async function refreshSecuritiesA(ctx: EtlContext): Promise<{ total: number; delisted: number }> {
  const [org, listed] = await Promise.all([
    emQuery(ctx.http, {
      report: "RPT_F10_BASIC_ORGINFO",
      host: "sec",
      filter: '(SECURITY_TYPE_CODE="058001001")',
      columns: "SECUCODE,SECURITY_NAME_ABBR,LISTING_DATE,EM2016",
      pageSize: 5000,
    }),
    listedANow(ctx),
  ]);
  // 交易所退市名单拿不到时（被限流等）沿用库里已有的退市日，不让整次刷新失败
  let delistedRows: DelistedRow[];
  try {
    delistedRows = [
      ...(await szseDelisted(ctx.http)),
      ...(await sseDelisted(ctx.http, "1")),
      ...(await sseDelisted(ctx.http, "8")),
    ];
  } catch (e) {
    ctx.log(`交易所退市名单拉取失败，沿用库里的退市日：${e instanceof Error ? e.message : e}`);
    delistedRows = (
      await ctx.wh.all<{ code: string; name: string; list_date: string | null; delist_date: string }>(
        `SELECT code, name, list_date::VARCHAR AS list_date, delist_date::VARCHAR AS delist_date
         FROM securities WHERE market = 'A' AND delist_date IS NOT NULL`,
      )
    ).map((r) => ({ code: r.code, name: r.name, listDate: r.list_date, delistDate: r.delist_date }));
  }
  const delisted = new Map(delistedRows.map((r) => [r.code, r]));
  const rows = new Map<string, SecurityRow>();

  const add = (code: string, name: string | null, listDate: string | null, em2016: string | null) => {
    const sym = code.slice(0, 6);
    if (!isAShareSymbol(sym) || code.endsWith(".BJ")) return;
    if (listDate && listDate > ctx.today) return;
    if (!listDate && !listed.names.has(code)) return;
    const [l1, l2] = (em2016 ?? "").split("-");
    const d = delisted.get(code);
    rows.set(code, {
      code,
      market: "A",
      name: listed.names.get(code) ?? name ?? d?.name ?? null,
      board: boardOf(code),
      list_date: listDate,
      delist_date: listed.names.has(code) ? null : (d?.delistDate ?? null),
      lot_size: 100,
      industry_l1: l1 || null,
      industry: l2 || l1 || null,
      sec_type: null,
    });
  };

  for (const r of org) {
    add(
      String(r.SECUCODE),
      str(r.SECURITY_NAME_ABBR),
      normalizeDate(str(r.LISTING_DATE)),
      str(r.EM2016),
    );
  }
  // 在市但公司资料里没有的（如存托凭证 689009）
  for (const [code, name] of listed.names) {
    if (!rows.has(code)) add(code, name, delisted.get(code)?.listDate ?? null, null);
  }
  // 退市名单里有、公司资料里没有的（B 股会被代码段过滤掉）
  for (const d of delisted.values()) {
    if (!rows.has(d.code)) add(d.code, d.name, d.listDate, null);
  }

  await ctx.wh.exclusive(async () => {
    await ctx.wh.run(`DELETE FROM securities WHERE market = 'A'`);
    await ctx.wh.append("securities", [...rows.values()].map(toRow));
    // 不在市、也不在退市名单里：按最后一根 K 线标退市（K 线还没回填时先留空，回填后下次刷新补上）
    await ctx.wh.run(
      `UPDATE securities s SET delist_date = b.last_date + 1
       FROM (SELECT code, max(date) AS last_date FROM bars_daily GROUP BY code) b
       WHERE s.code = b.code AND s.market = 'A' AND s.delist_date IS NULL
         AND s.code NOT IN (${sqlCodeList([...listed.names.keys()])})
         AND b.last_date < $cutoff::DATE`,
      { cutoff: addDays(listed.date, -30) },
    );
    // 上市日缺失的（不在公司资料里的在市证券）取第一根 K 线
    await ctx.wh.run(
      `UPDATE securities s SET list_date = b.first_date
       FROM (SELECT code, min(date) AS first_date FROM bars_daily GROUP BY code) b
       WHERE s.code = b.code AND s.market = 'A' AND s.list_date IS NULL`,
    );
  });
  const n = [...rows.values()].filter((r) => r.delist_date).length;
  ctx.log(`A 股证券表：${rows.size} 只，其中已退市 ${n} 只（在市名单日期 ${listed.date}）`);
  return { total: rows.size, delisted: n };
}

const HK_TYPES = new Set(["非H股", "H股", "红筹股"]);

/**
 * 港股人民币柜台（8xxxx，如 80941 中国移动-R、80700 腾讯控股-R）和港币柜台是同一家公司、同一份股本，
 * 留在股票池里会让策略同时持有一家公司两次、估值也重复算。创业板是 08xxx，不受影响。
 */
export const HK_RMB_COUNTER = /^8\d{4}\.HK$/;

/** 把库里已有的人民币柜台数据整只删掉（早期回填进来的） */
async function purgeHkRmbCounters(ctx: EtlContext): Promise<number> {
  const codes = (
    await ctx.wh.all<{ code: string }>(
      `SELECT code FROM securities WHERE market = 'HK' AND regexp_matches(code, '^8[0-9]{4}\\.HK$')`,
    )
  ).map((r) => r.code);
  if (!codes.length) return 0;
  const list = sqlCodeList(codes);
  await ctx.wh.exclusive(async () => {
    for (const t of [
      "factors_daily",
      "bars_daily",
      "corp_actions",
      "share_changes",
      "financials",
      "securities",
    ]) {
      await ctx.wh.run(`DELETE FROM ${t} WHERE code IN (${list})`);
    }
  });
  ctx.log(`删掉了 ${codes.length} 个港股人民币柜台（${codes.join("、")}），它们和港币柜台是同一家公司`);
  return codes.length;
}

export async function refreshSecuritiesHK(ctx: EtlContext): Promise<{ total: number }> {
  const [info, profile] = await Promise.all([
    emQuery(ctx.http, {
      report: "RPT_HKF10_INFO_SECURITYINFO",
      host: "sec",
      columns: "SECUCODE,SECURITY_NAME_ABBR,SECURITY_TYPE,BOARD,TRADE_UNIT,LISTING_DATE",
      pageSize: 5000,
    }),
    emQuery(ctx.http, {
      report: "RPT_HKF10_INFO_ORGPROFILE",
      host: "sec",
      columns: "SECUCODE,BELONG_INDUSTRY",
      pageSize: 5000,
    }),
  ]);
  const industry = new Map(profile.map((r) => [String(r.SECUCODE), str(r.BELONG_INDUSTRY)]));
  const rows: SecurityRow[] = [];
  for (const r of info) {
    const code = String(r.SECUCODE);
    if (!/^\d{5}\.HK$/.test(code) || !HK_TYPES.has(String(r.SECURITY_TYPE))) continue;
    if (HK_RMB_COUNTER.test(code)) continue;
    const listDate = normalizeDate(str(r.LISTING_DATE));
    if (listDate && listDate > ctx.today) continue;
    const ind = industry.get(code) ?? null;
    rows.push({
      code,
      market: "HK",
      name: str(r.SECURITY_NAME_ABBR),
      board: String(r.BOARD).includes("创业") ? "hk_gem" : "hk_main",
      list_date: listDate,
      delist_date: null,
      lot_size: num(r.TRADE_UNIT),
      industry_l1: ind,
      industry: ind,
      sec_type: str(r.SECURITY_TYPE),
    });
  }
  await purgeHkRmbCounters(ctx);
  const current = new Set(rows.map((r) => r.code));
  await ctx.wh.exclusive(async () => {
    // 之前在表里、这次消失的：保留行，按最后一根 K 线标退市（D25：港股没有退市名单）
    const gone = await ctx.wh.all<{ code: string }>(
      `SELECT code FROM securities WHERE market = 'HK' AND delist_date IS NULL`,
    );
    for (const g of gone) {
      if (current.has(g.code)) continue;
      await ctx.wh.run(
        `UPDATE securities SET delist_date = coalesce((SELECT max(date) + 1 FROM bars_daily WHERE code = $c), current_date)
         WHERE code = $c`,
        { c: g.code },
      );
    }
    if (current.size) {
      await ctx.wh.run(
        `DELETE FROM securities WHERE market = 'HK' AND code IN (${sqlCodeList([...current])})`,
      );
    }
    await ctx.wh.append("securities", rows.map(toRow));
  });
  ctx.log(`港股证券表：${rows.length} 只在市普通股`);
  return { total: rows.length };
}

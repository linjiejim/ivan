/**
 * 交易所官方数据：退市名单、证券简称变更。
 * - 深交所：www.szse.cn/api/report/ShowReport/data（JSON，每页 20 条）
 * - 上交所：query.sse.com.cn/commonQuery.do（需要 Referer）
 */
import { type DateStr, normalizeDate } from "@ivan/core";
import type { Http } from "../http.ts";

export interface DelistedRow {
  code: string;
  name: string;
  listDate: DateStr | null;
  delistDate: DateStr | null;
}

export interface NameChangeRow {
  code: string;
  date: DateStr;
  before: string;
  after: string;
}

interface SzseTab<T> {
  metadata: { tabkey: string; recordcount: number; pagecount: number; pagesize: number };
  data: T[];
}

async function szsePage<T>(http: Http, catalog: string, tab: string, page: number) {
  const url = `https://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=${catalog}&TABKEY=${tab}&PAGENO=${page}`;
  const tabs = await http.json<SzseTab<T>[]>(url);
  const t = tabs.find((x) => x.metadata.tabkey === tab);
  if (!t) throw new Error(`深交所 ${catalog}/${tab} 结构变了`);
  return t;
}

async function szseAll<T>(http: Http, catalog: string, tab: string, maxPages = 1000): Promise<T[]> {
  const first = await szsePage<T>(http, catalog, tab, 1);
  const pages = Math.min(first.metadata.pagecount || 1, maxPages);
  const out = [...first.data];
  for (let p = 2; p <= pages; p++) out.push(...(await szsePage<T>(http, catalog, tab, p)).data);
  return out;
}

export async function szseRecordCount(http: Http, catalog: string, tab: string): Promise<number> {
  return (await szsePage(http, catalog, tab, 1)).metadata.recordcount;
}

/** 深交所终止上市公司。 */
export async function szseDelisted(http: Http): Promise<DelistedRow[]> {
  const rows = await szseAll<{ zqdm: string; zqjc: string; ssrq: string; zzrq: string }>(
    http,
    "1793_ssgs",
    "tab2",
  );
  return rows.map((r) => ({
    code: `${r.zqdm}.SZ`,
    name: stripHtml(r.zqjc),
    listDate: normalizeDate(r.ssrq),
    delistDate: normalizeDate(r.zzrq),
  }));
}

/** 深交所证券简称变更（ST 摘帽戴帽的时点来源）。maxPages 用于增量只翻前几页。 */
export async function szseNameChanges(http: Http, maxPages?: number): Promise<NameChangeRow[]> {
  const rows = await szseAll<{ bgrq: string; zqdm: string; bgqzqjc: string; bghzqjc: string }>(
    http,
    "SSGSGMXX",
    "tab2",
    maxPages,
  );
  return rows
    .map((r) => ({
      code: `${r.zqdm}.SZ`,
      date: normalizeDate(r.bgrq)!,
      before: stripHtml(r.bgqzqjc),
      after: stripHtml(r.bghzqjc),
    }))
    .filter((r) => r.date);
}

interface SseResp<T> {
  pageHelp: { total: number; pageCount: number; data: T[] | null };
  result: T[] | null;
}

/** 上交所终止上市公司。stockType：1 主板 A 股，8 科创板。 */
export async function sseDelisted(http: Http, stockType: "1" | "8" = "1"): Promise<DelistedRow[]> {
  const out: DelistedRow[] = [];
  for (let page = 1; page < 100; page++) {
    const url =
      "https://query.sse.com.cn/commonQuery.do?sqlId=COMMON_SSE_CP_GPJCTPZ_GPLB_GP_L" +
      `&STOCK_TYPE=${stockType}&COMPANY_STATUS=3&type=inParams&isPagination=true` +
      `&pageHelp.cacheSize=1&pageHelp.beginPage=${page}&pageHelp.pageSize=100&pageHelp.pageNo=${page}`;
    const res = await http.json<
      SseResp<{ A_STOCK_CODE: string; COMPANY_ABBR: string; LIST_DATE: string; DELIST_DATE: string }>
    >(url, { headers: { Referer: "https://www.sse.com.cn/" } });
    const data = res.pageHelp.data ?? [];
    for (const r of data) {
      if (!/^\d{6}$/.test(r.A_STOCK_CODE)) continue;
      out.push({
        code: `${r.A_STOCK_CODE}.SH`,
        name: r.COMPANY_ABBR,
        listDate: normalizeDate(r.LIST_DATE),
        delistDate: normalizeDate(r.DELIST_DATE),
      });
    }
    if (page >= (res.pageHelp.pageCount || 1)) break;
  }
  return out;
}

function stripHtml(s: string): string {
  return String(s ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
}

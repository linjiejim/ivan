/**
 * 东财数据中心 JSON 报表（非官方接口）。两个 host：
 * - web: datacenter-web.eastmoney.com（业绩报表、估值等）
 * - sec: datacenter.eastmoney.com/securities（F10：主要指标、股本、公司资料、港股）
 *
 * 不用 push2.eastmoney.com：部分网络环境下连不上。
 */
import type { HttpLike } from "../http.ts";

const HOSTS = {
  web: "https://datacenter-web.eastmoney.com/api/data/v1/get",
  sec: "https://datacenter.eastmoney.com/securities/api/data/v1/get",
} as const;

export interface EmQuery {
  report: string;
  filter?: string;
  columns?: string;
  host?: keyof typeof HOSTS;
  /** 排序列：多列时按顺序排，sortTypes 给同样多个、都按 asc */
  sort?: string | readonly string[];
  asc?: boolean;
  pageSize?: number;
  /** 最多取多少行（默认取完所有页） */
  maxRows?: number;
}

interface EmResponse<T> {
  success: boolean;
  code: number;
  message: string;
  result: { pages: number; count: number; data: T[] } | null;
}

export type EmRow = Record<string, string | number | null>;

export class EastmoneyError extends Error {
  constructor(
    message: string,
    /** 东财的错误码（9501 字段不存在、9201 空结果……）；不是东财给的错误为 0 */
    readonly code = 0,
  ) {
    super(message);
  }
}

/** 报表结构变了：请求的列不存在（9501 /「字段不存在」），或返回行缺了请求过的键（D82） */
export class SchemaDriftError extends EastmoneyError {
  /** 与来源无关的标记（运行器按它判断，见 sources/types.ts 的 isSchemaDrift） */
  readonly schemaDrift = true;
}

/** 翻页结果对不上：行数 ≠ 报表给的 count，或同一块里有完全相同的两行（排序不唯一时会重一行、丢一行） */
export class PageDriftError extends EastmoneyError {
  readonly pageDrift = true;
  constructor(
    message: string,
    /** 这次翻页用了几次请求 */
    readonly requests = 0,
    /** 只有「行数对得上、但有完全相同的行」时才带上这次拿到的结果（emQueryPagedChecked 用它比两次是否一致） */
    readonly duplicates?: { rows: Record<string, unknown>[]; count: number },
  ) {
    super(message);
  }
}

/** 数据中心单页最多给 500 行（实测 pageSize=5000 也只回 500 行） */
export const EM_PAGE_CAP = 500;

/** 东财空结果的错误码：是正常结果 */
const EM_EMPTY = 9201;

function emError(report: string, code: number, message: string): EastmoneyError {
  const text = `东财 ${report} 报错 ${code}：${message}`;
  return code === 9501 || /字段不存在/.test(message ?? "")
    ? new SchemaDriftError(text, code)
    : new EastmoneyError(text, code);
}

function emParams(q: EmQuery, page: number, pageSize: number): URLSearchParams {
  const params = new URLSearchParams({
    reportName: q.report,
    columns: q.columns ?? "ALL",
    filter: q.filter ?? "",
    pageNumber: String(page),
    pageSize: String(pageSize),
    source: "WEB",
    client: "WEB",
  });
  if (q.sort && q.sort.length) {
    const cols = typeof q.sort === "string" ? [q.sort] : [...q.sort];
    params.set("sortColumns", cols.join(","));
    params.set("sortTypes", cols.map(() => (q.asc ? "1" : "-1")).join(","));
  }
  return params;
}

export async function emQuery<T = EmRow>(http: HttpLike, q: EmQuery): Promise<T[]> {
  const pageSize = q.pageSize ?? 500;
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const params = emParams(q, page, pageSize);
    const res = await http.json<EmResponse<T>>(`${HOSTS[q.host ?? "web"]}?${params}`);
    if (!res.result) {
      // 9201 = 返回数据为空，是正常结果
      if (res.code === EM_EMPTY) return out;
      throw emError(q.report, res.code, res.message);
    }
    out.push(...res.result.data);
    if (q.maxRows && out.length >= q.maxRows) return out.slice(0, q.maxRows);
    if (page >= res.result.pages) return out;
  }
}

/** 只要总行数（探针/体检用）。 */
export async function emCount(http: HttpLike, q: Omit<EmQuery, "pageSize" | "maxRows">): Promise<number> {
  const params = emParams({ ...q, sort: undefined }, 1, 1);
  const res = await http.json<EmResponse<unknown>>(`${HOSTS[q.host ?? "web"]}?${params}`);
  if (!res.result) {
    if (res.code === EM_EMPTY) return 0;
    throw emError(q.report, res.code, res.message);
  }
  return res.result.count;
}

/**
 * 计数请求（事件数据的回填估算）：一次请求、pageSize 1，**带上明确的列清单**（从不用 ALL），
 * 这样「任何请求都不含禁用列」的检查覆盖到计数请求。
 */
export async function emCountCols(
  http: HttpLike,
  report: string,
  filter: string,
  columns: readonly string[],
): Promise<number> {
  if (!columns.length) throw new Error("emCountCols 要给明确的列清单");
  return emCount(http, { report, filter, columns: columns.join(",") });
}

/** 一行的规范形式（判断翻页重复用）：键按字母序 */
function canonicalRow(r: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k] ?? null]));
}

/**
 * 整块翻页（D81）：单页 ≤ 500，翻完所有页后核对「拿到的行数 = 报表给的 count」，并检查没有完全相同的两行；
 * 任一不满足抛 PageDriftError（emQueryPagedChecked 负责重取一次）。9201 是空结果；9501 /「字段不存在」抛 SchemaDriftError。
 */
export async function emQueryPaged<T extends Record<string, unknown> = EmRow>(
  http: HttpLike,
  q: Omit<EmQuery, "maxRows">,
): Promise<{ rows: T[]; count: number; requests: number }> {
  const pageSize = Math.min(q.pageSize ?? EM_PAGE_CAP, EM_PAGE_CAP);
  const rows: T[] = [];
  let count = 0;
  let requests = 0;
  for (let page = 1; ; page++) {
    const params = emParams(q, page, pageSize);
    requests++;
    const res = await http.json<EmResponse<T>>(`${HOSTS[q.host ?? "web"]}?${params}`);
    if (!res.result) {
      if (res.code === EM_EMPTY && page === 1) return { rows: [], count: 0, requests };
      if (res.code === EM_EMPTY) break;
      throw emError(q.report, res.code, res.message);
    }
    count = res.result.count;
    rows.push(...res.result.data);
    if (page >= res.result.pages) break;
  }
  if (rows.length !== count) {
    throw new PageDriftError(
      `东财 ${q.report} 翻页后行数对不上：拿到 ${rows.length} 行，报表说 ${count} 行`,
      requests,
    );
  }
  const seen = new Set<string>();
  for (const r of rows) {
    const k = canonicalRow(r);
    if (seen.has(k)) throw new PageDriftError(`东财 ${q.report} 翻页结果有重复行`, requests, { rows, count });
    seen.add(k);
  }
  return { rows, count, requests };
}

/** 重取时用的单页行数：和第一次不同，页边界错开（排序不唯一造成的重行、丢行会跟着页边界变） */
export const EM_REFETCH_PAGE_SIZE = 400;

/** 行的多重集合（规范形式排序后拼起来），比较两次翻页结果用 */
function rowMultiset(rows: readonly Record<string, unknown>[]): string {
  return JSON.stringify(rows.map(canonicalRow).sort());
}

/**
 * 整块取并核对（D81）：emQueryPaged 对不上就换一个单页行数重取一次，还不对就抛 PageDriftError。
 * 例外：两次都只是「有完全相同的行」（行数都对得上），而且两次拿到的行（多重集合）完全一样，就当成真有几笔一模一样的记录
 * （比如同一卖方按同价同量卖给同一个机构专用席位的几笔大宗），照常返回——翻页漂移在页边界错开后不会重出一模一样的结果。
 * onRetry 在重取前调用（记日志用）。
 */
export async function emQueryPagedChecked<T extends Record<string, unknown> = EmRow>(
  http: HttpLike,
  q: Omit<EmQuery, "maxRows">,
  onRetry?: (e: PageDriftError) => void,
): Promise<{ rows: T[]; count: number; requests: number; duplicateRows: number }> {
  let first: PageDriftError;
  try {
    return { ...(await emQueryPaged<T>(http, q)), duplicateRows: 0 };
  } catch (e) {
    if (!(e instanceof PageDriftError)) throw e;
    first = e;
  }
  onRetry?.(first);
  try {
    const r = await emQueryPaged<T>(http, { ...q, pageSize: EM_REFETCH_PAGE_SIZE });
    return { ...r, requests: r.requests + first.requests, duplicateRows: 0 };
  } catch (e) {
    if (!(e instanceof PageDriftError)) throw e;
    const a = first.duplicates;
    const b = e.duplicates;
    if (!a || !b || a.count !== b.count || rowMultiset(a.rows) !== rowMultiset(b.rows)) throw e;
    const distinct = new Set(b.rows.map(canonicalRow)).size;
    return { rows: b.rows as T[], count: b.count, requests: first.requests + e.requests, duplicateRows: b.rows.length - distinct };
  }
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || v === "-") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" || s === "-" ? null : s;
}

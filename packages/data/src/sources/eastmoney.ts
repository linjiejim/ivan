/**
 * 东财数据中心 JSON 报表（非官方接口）。两个 host：
 * - web: datacenter-web.eastmoney.com（业绩报表、估值等）
 * - sec: datacenter.eastmoney.com/securities（F10：主要指标、股本、公司资料、港股）
 *
 * 不用 push2.eastmoney.com：部分网络环境下连不上。
 */
import type { Http } from "../http.ts";

const HOSTS = {
  web: "https://datacenter-web.eastmoney.com/api/data/v1/get",
  sec: "https://datacenter.eastmoney.com/securities/api/data/v1/get",
} as const;

export interface EmQuery {
  report: string;
  filter?: string;
  columns?: string;
  host?: keyof typeof HOSTS;
  sort?: string;
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

export class EastmoneyError extends Error {}

export async function emQuery<T = EmRow>(http: Http, q: EmQuery): Promise<T[]> {
  const pageSize = q.pageSize ?? 500;
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const params = new URLSearchParams({
      reportName: q.report,
      columns: q.columns ?? "ALL",
      filter: q.filter ?? "",
      pageNumber: String(page),
      pageSize: String(pageSize),
      source: "WEB",
      client: "WEB",
    });
    if (q.sort) {
      params.set("sortColumns", q.sort);
      params.set("sortTypes", q.asc ? "1" : "-1");
    }
    const res = await http.json<EmResponse<T>>(`${HOSTS[q.host ?? "web"]}?${params}`);
    if (!res.result) {
      // 9201 = 返回数据为空，是正常结果
      if (res.code === 9201) return out;
      throw new EastmoneyError(`东财 ${q.report} 报错 ${res.code}：${res.message}`);
    }
    out.push(...res.result.data);
    if (q.maxRows && out.length >= q.maxRows) return out.slice(0, q.maxRows);
    if (page >= res.result.pages) return out;
  }
}

/** 只要总行数（探针/体检用）。 */
export async function emCount(http: Http, q: Omit<EmQuery, "pageSize" | "maxRows">): Promise<number> {
  const params = new URLSearchParams({
    reportName: q.report,
    columns: q.columns ?? "ALL",
    filter: q.filter ?? "",
    pageNumber: "1",
    pageSize: "1",
    source: "WEB",
    client: "WEB",
  });
  const res = await http.json<EmResponse<unknown>>(`${HOSTS[q.host ?? "web"]}?${params}`);
  if (!res.result) {
    if (res.code === 9201) return 0;
    throw new EastmoneyError(`东财 ${q.report} 报错 ${res.code}：${res.message}`);
  }
  return res.result.count;
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

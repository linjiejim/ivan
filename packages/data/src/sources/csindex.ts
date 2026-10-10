/**
 * 中证指数官网：全收益指数（如 H00300 沪深300全收益）。
 * 实测：数据一般比交易日晚 1 天以上可得，夜间任务要容忍当天缺失。
 */
import { type DateStr, normalizeDate } from "@ivan/core";
import type { HttpLike } from "../http.ts";

export interface IndexClose {
  date: DateStr;
  close: number;
}

export async function csindexHistory(
  http: HttpLike,
  indexCode: string,
  from: DateStr,
  to: DateStr,
): Promise<IndexClose[]> {
  const url =
    `https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=${indexCode}` +
    `&startDate=${from.replaceAll("-", "")}&endDate=${to.replaceAll("-", "")}`;
  const res = await http.json<{ code: string; data: Array<{ tradeDate: string; close: number | null }> }>(url);
  return (res.data ?? [])
    .map((r) => ({ date: normalizeDate(r.tradeDate)!, close: Number(r.close) }))
    .filter((r) => r.date && r.date >= from && r.date <= to && Number.isFinite(r.close) && r.close > 0);
}

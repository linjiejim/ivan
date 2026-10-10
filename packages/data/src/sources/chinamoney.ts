/**
 * 中国外汇交易中心：人民币汇率中间价（官方）。港股里用人民币/美元记账的公司，
 * 把财报金额换成港币算 PE 时用这里的汇率。
 */
import { type DateStr, addDays } from "@ivan/core";
import type { HttpLike } from "../http.ts";

export interface FxRow {
  date: DateStr;
  /** 键如 "USD/CNY"、"HKD/CNY"：1 单位外币 = 多少人民币 */
  rates: Record<string, number>;
}

interface CcprResp {
  data: { head: string[]; searchlist: string[]; pageTotal: number };
  records: Array<{ date: string; values: string[] }>;
}

/** 单次查询区间不宜过长，这里按 180 天分段、每段翻页取完。 */
export async function centralParity(
  http: HttpLike,
  pairs: string[],
  from: DateStr,
  to: DateStr,
): Promise<FxRow[]> {
  const out = new Map<DateStr, FxRow>();
  for (let start = from; start <= to; start = addDays(start, 180)) {
    const endCand = addDays(start, 179);
    const end = endCand < to ? endCand : to;
    for (let page = 1; page < 50; page++) {
      const url =
        "https://www.chinamoney.com.cn/ags/ms/cm-u-bk-ccpr/CcprHisNew" +
        `?startDate=${start}&endDate=${end}&currency=${pairs.join(",")}&pageNum=${page}&pageSize=50`;
      const res = await http.json<CcprResp>(url, { method: "POST" });
      const list = res.data.searchlist;
      for (const r of res.records ?? []) {
        const rates: Record<string, number> = {};
        list.forEach((p, i) => {
          const v = Number(r.values[i]);
          if (Number.isFinite(v) && v > 0) rates[p] = v;
        });
        out.set(r.date, { date: r.date, rates });
      }
      if (page >= (res.data.pageTotal || 1)) break;
    }
  }
  return [...out.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

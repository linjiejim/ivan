/**
 * 点时事件数据的离线夹具（测试专用）：东财数据中心按报表名的假路由，以及「请求里没有禁用列、不用 ALL」的检查。
 */
import { GLOBAL_FORBIDDEN_RE, EM_EVENT_DEFS } from "../sources/adapters/eastmoney-events.ts";
import type { FakeRequest, FakeRoute } from "./fake-http.ts";

/** 东财数据中心某个报表的假路由（reply 可以按请求现算） */
export function emReportRoute(
  report: string,
  reply: FakeRoute["reply"],
  extra: Partial<FakeRoute> = {},
): FakeRoute {
  return {
    match: new RegExp(`datacenter-web\\.eastmoney\\.com/.*reportName=${report}(&|$)`),
    reply,
    ...extra,
  };
}

/** 一页东财结果（pages、count 按给的行算） */
export function emPage(rows: object[], o: { pages?: number; count?: number } = {}): object {
  return {
    version: null,
    result: { pages: o.pages ?? 1, data: rows, count: o.count ?? rows.length },
    success: true,
    message: "ok",
    code: 0,
  };
}

/** 报表 → 它自己的禁用列（大宗的 CLOSE_PRICE 是当日收盘，可以要；户数的 CLOSE_PRICE 是最新价，禁用） */
const FORBIDDEN = new Map(Object.values(EM_EVENT_DEFS).map((d) => [d.report, new Set(d.forbidden)]));

/**
 * 对事件报表的请求里有没有禁用列或 columns=ALL：返回违规的「报表 + 列」说明（空 = 都合规）。
 */
export function eventColumnViolations(calls: ReadonlyArray<Pick<FakeRequest, "url">>): string[] {
  const out: string[] = [];
  for (const c of calls) {
    if (!c.url.includes("datacenter-web.eastmoney.com")) continue;
    const q = new URL(c.url).searchParams;
    const report = q.get("reportName") ?? "";
    const forbidden = FORBIDDEN.get(report);
    if (!forbidden) continue;
    const cols = (q.get("columns") ?? "ALL").split(",");
    for (const col of cols) {
      if (col.toUpperCase() === "ALL" || forbidden.has(col) || GLOBAL_FORBIDDEN_RE.test(col)) {
        out.push(`${report}:${col}`);
      }
    }
  }
  return out;
}

type EmDataRow = Record<string, string | number | null>;

/**
 * 假的东财数据中心（事件报表）：data 是「报表 → 全部行」（可以在测试里改，模拟东财晚入库、撤下、更正）。
 * 按 filter 里的 (列>='x')(列<='y')(列='x')(列="x") 过滤（日期列按前 10 位比），按 sortColumns / sortTypes 排序，
 * 按 pageNumber / pageSize 翻页，没有结果回 9201。override(report, url) 返回非 undefined 时直接用它回（模拟 9501、行数对不上）。
 */
export function emEventsServer(
  data: Record<string, EmDataRow[]>,
  override?: (report: string, url: string) => object | string | undefined,
): FakeRoute {
  return {
    match: /datacenter-web\.eastmoney\.com/,
    reply: ({ url }) => {
      const q = new URL(url).searchParams;
      const report = q.get("reportName") ?? "";
      const o = override?.(report, url);
      if (o !== undefined) return o;
      const conds = [...(q.get("filter") ?? "").matchAll(/\((\w+)(>=|<=|=)['"]([^'"]*)['"]\)/g)].map(
        (m) => ({ col: m[1]!, op: m[2]!, v: m[3]! }),
      );
      const val = (r: EmDataRow, col: string) => {
        const v = r[col];
        return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : String(v ?? "");
      };
      let rows = (data[report] ?? []).filter((r) =>
        conds.every((c) => {
          const v = val(r, c.col);
          return c.op === "=" ? v === c.v : c.op === ">=" ? v >= c.v : v <= c.v;
        }),
      );
      const sorts = (q.get("sortColumns") ?? "").split(",").filter(Boolean);
      const types = (q.get("sortTypes") ?? "").split(",");
      rows = [...rows].sort((a, b) => {
        for (let i = 0; i < sorts.length; i++) {
          const x = a[sorts[i]!] ?? "";
          const y = b[sorts[i]!] ?? "";
          const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
          if (c) return types[i] === "-1" ? -c : c;
        }
        return 0;
      });
      // 只回请求的列（和东财一样）
      const cols = (q.get("columns") ?? "ALL").split(",");
      if (cols[0] !== "ALL") {
        rows = rows.map((r) => Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]!])));
      }
      if (!rows.length) return { version: null, result: null, success: false, message: "返回数据为空", code: 9201 };
      const size = Number(q.get("pageSize") ?? 500);
      const page = Number(q.get("pageNumber") ?? 1);
      return emPage(rows.slice((page - 1) * size, page * size), {
        pages: Math.ceil(rows.length / size),
        count: rows.length,
      });
    },
  };
}

/**
 * 日线体检（D74，纯函数）：写入日线（整段写入、逐股补）与报价路径都先过一遍。
 *
 * | 规则 | 级别 | 条件 |
 * | R1 ohlc | 拒收 | 任一价格 ≤ 0 或非有限值；最高 < max(开, 收)；最低 > min(开, 收)；最高 < 最低 |
 * | R2 volume | 拒收 | 成交量 < 0 或非有限值（成交量 0 但收盘变了只标记） |
 * | R3 calendar | 拒收 | 日期不在交易日历或晚于今天 |
 * | R4 duplicate | 标记 | 同批重复日期保留最后一条 |
 * | R5 limit_breach（A 股） | 标记 | 相对复权参考前收的涨跌幅超过规则表第 2 版限幅 + 0.5%，当天无公司行动；上市前 5 个交易日跳过 |
 * | R6 adj_jump | 标记 | 复权因子跳变但当天没有公司行动 |
 * | R7 hk_jump | 标记 | 港股单日涨跌超过 50% 且无公司行动 |
 * | R8 stale_print | 标记 | 开高低收量与前一天完全相同且量 > 0 |
 *
 * 拒收的行不入库（调用方把代码记成缺失），标记永远不阻断。涨跌幅只读规则表（priceLimitPct，唯一出处）。
 * 不做加法复权检测：仿射分解已经能还原加法复权，检测器反而会把只派现金的股票误判。
 */
import { type DateStr, marketOf, priceLimitPct } from "@ivan/core";
import type { BarRow } from "../etl/bars.ts";

/** 数据问题的规则：R1–R8 由体检给出，check_* 由每周抽检给出，caliber 是口径换算失败（D72） */
export type IssueRule =
  | "ohlc"
  | "volume"
  | "calendar"
  | "duplicate"
  | "limit_breach"
  | "adj_jump"
  | "hk_jump"
  | "stale_print"
  | "check_adj"
  | "check_volume"
  | "caliber";

export type IssueSeverity = "reject" | "flag";

export interface Issue {
  rule: IssueRule;
  severity: IssueSeverity;
  date: DateStr;
  detail: string;
}

export interface HygieneCtx {
  /** 这个市场的交易日历（空集 = 还没有日历，不判 R3 的「不是交易日」） */
  calendar: Set<DateStr>;
  today: DateStr;
  board: string | null;
  listDate: DateStr | null;
  isST: (d: DateStr) => boolean;
  /** 公司行动（除权除息）日：这些天 R5–R7 不判 */
  actions: Set<DateStr>;
  /** 这批之前库里最后一根 K 线（增量写入时给）：第一行的 R5–R8 拿它比 */
  prevRef?: {
    close: number;
    adj: number;
    open?: number;
    high?: number;
    low?: number;
    volume?: number;
  };
}

/** R5 在规则表限幅之外的容差 */
export const LIMIT_TOLERANCE = 0.005;
/** 上市后前几个交易日不判 R5 */
const IPO_SKIP_SESSIONS = 5;

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

function lowerBound(a: readonly string[], x: string): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** R1–R3：拒收的第一条规则（没有就是 null） */
function rejectOf(
  r: BarRow,
  ctx: HygieneCtx,
  firstCal: DateStr | undefined,
): { rule: IssueRule; detail: string } | null {
  const [, date, o, h, l, c, v] = r;
  const prices = [o, h, l, c];
  const eps = 1e-6 * Math.max(...prices.map((p) => (Number.isFinite(p) ? Math.abs(p) : 0)), 1);
  if (prices.some((p) => !Number.isFinite(p) || p <= 0)) {
    return { rule: "ohlc", detail: `价格不是正数（开 ${o} 高 ${h} 低 ${l} 收 ${c}）` };
  }
  if (h < Math.max(o, c) - eps || l > Math.min(o, c) + eps || h < l - eps) {
    return { rule: "ohlc", detail: `高低价和开收对不上（开 ${o} 高 ${h} 低 ${l} 收 ${c}）` };
  }
  if (!Number.isFinite(v) || v < 0) return { rule: "volume", detail: `成交量 ${v}` };
  if (date > ctx.today) return { rule: "calendar", detail: `日期晚于今天（${ctx.today}）` };
  if (firstCal && date >= firstCal && !ctx.calendar.has(date)) {
    return { rule: "calendar", detail: "日期不在交易日历里" };
  }
  return null;
}

/**
 * 体检一只股票的一批日线（按日期升序给；乱序也行，会先排好）。返回入库的行与问题列表。
 */
export function validateBars(
  code: string,
  rows: readonly BarRow[],
  ctx: HygieneCtx,
): { accepted: BarRow[]; issues: Issue[] } {
  const issues: Issue[] = [];
  // R4：同批重复日期保留最后一条
  const byDate = new Map<DateStr, { row: BarRow; n: number }>();
  for (const r of rows) {
    const had = byDate.get(r[1]);
    byDate.set(r[1], { row: r, n: (had?.n ?? 0) + 1 });
  }
  for (const [date, { n }] of byDate) {
    if (n > 1) {
      issues.push({
        rule: "duplicate",
        severity: "flag",
        date,
        detail: `同一批里有 ${n} 行，保留最后一行`,
      });
    }
  }
  const uniq = [...byDate.values()].map((x) => x.row).sort((a, b) => (a[1] < b[1] ? -1 : 1));

  const cal = [...ctx.calendar].sort();
  const firstCal = cal[0];
  const market = marketOf(code);
  /** 上市后第几个交易日（上市当天 = 0）；不知道上市日或早于日历时当作老股 */
  const sinceList = (d: DateStr): number =>
    !ctx.listDate || !firstCal || ctx.listDate < firstCal
      ? 1e9
      : lowerBound(cal, d) - lowerBound(cal, ctx.listDate);

  const accepted: BarRow[] = [];
  let prev = ctx.prevRef;
  for (const r of uniq) {
    const [, date, o, h, l, c, v, , adj] = r;
    const bad = rejectOf(r, ctx, firstCal);
    if (bad) {
      issues.push({ rule: bad.rule, severity: "reject", date, detail: bad.detail });
      continue;
    }
    const flag = (rule: IssueRule, detail: string) =>
      issues.push({ rule, severity: "flag", date, detail });
    if (prev) {
      const action = ctx.actions.has(date);
      if (v === 0 && c !== prev.close) flag("volume", `成交量为 0，收盘却从 ${prev.close} 变成 ${c}`);
      const ret = (c * adj) / (prev.close * prev.adj) - 1;
      if (!action && market === "A" && Number.isFinite(ret)) {
        const days = sinceList(date);
        const limit =
          days < IPO_SKIP_SESSIONS
            ? null
            : priceLimitPct("A", ctx.board, ctx.isST(date), date, {
                rules: 2,
                listDate: ctx.listDate ?? undefined,
                daysSinceList: days,
              });
        if (limit !== null && Math.abs(ret) > limit + LIMIT_TOLERANCE) {
          flag("limit_breach", `涨跌 ${pct(ret)}，超过限幅 ${pct(limit)}`);
        }
      }
      if (!action && Math.abs(adj / prev.adj - 1) > 1e-6) {
        flag("adj_jump", `复权因子从 ${prev.adj} 变成 ${adj}，当天没有公司行动`);
      }
      if (!action && market === "HK" && Math.abs(ret) > 0.5) {
        flag("hk_jump", `单日涨跌 ${pct(ret)}，当天没有公司行动`);
      }
      if (
        v > 0 &&
        prev.open === o &&
        prev.high === h &&
        prev.low === l &&
        prev.close === c &&
        prev.volume === v
      ) {
        flag("stale_print", "开高低收量与前一天完全相同");
      }
    }
    accepted.push(r);
    prev = { close: c, adj, open: o, high: h, low: l, volume: v };
  }
  return { accepted, issues };
}

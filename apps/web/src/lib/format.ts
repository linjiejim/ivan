/** 数字格式：百分比带符号、金额自动缩写（万 / 亿）。 */
import {
  HEALTH_STATE_TEXT,
  HEALTH_THRESHOLDS,
  type HealthMetric,
  REASON_DETAIL_TEXT,
  type RejectReason,
  SIGNAL_TEXT,
  type TrackingHealth,
  type Verdict,
} from "@ivan/core";

/** 空值占位：国内行情软件的习惯写法「--」（不用破折号） */
export const NA = "--";

export function pct(x: number | null | undefined, digits = 1, signed = true): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return NA;
  const v = (x * 100).toFixed(digits);
  return `${signed && x > 0 ? "+" : ""}${v}%`;
}

export function num(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return NA;
  return x.toLocaleString("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function money(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return NA;
  const a = Math.abs(x);
  if (a >= 1e8) return `${(x / 1e8).toFixed(2)} 亿`;
  if (a >= 1e4) return `${(x / 1e4).toFixed(a >= 1e6 ? 0 : 1)} 万`;
  return x.toFixed(0);
}

/** 涨跌颜色（红涨绿跌）；0 与空值用中性色 */
export function tone(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x) || x === 0) return "text-ink-2";
  return x > 0 ? "text-up" : "text-down";
}

/** 「跑赢回测同期」的百分位：98% */
export function beatPct(p: number | null | undefined): string {
  return p === null || p === undefined ? NA : `${p.toFixed(0)}%`;
}

export function dateTime(ms: number | null | undefined): string {
  if (!ms) return NA;
  return new Date(ms).toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtFactor(value: unknown, unit?: string): string {
  if (value === null || value === undefined) return NA;
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") {
    if (unit === "%") return `${value.toFixed(1)}%`;
    if (unit === "亿") return `${value.toFixed(value >= 100 ? 0 : 1)} 亿`;
    if (unit === "名") return `${value.toFixed(0)}`;
    if (unit === "年") return `${value.toFixed(0)} 年`;
    if (unit === "天") return `${value.toFixed(0)} 天`;
    return value.toFixed(2);
  }
  return String(value);
}

export const MARKET_TEXT: Record<string, string> = { A: "A 股", HK: "港股" };

/** 「偏离百分位」的人话说明（看板、跟踪页的 ⓘ 共用） */
export const DEVIATION_INFO =
  "「跑赢回测同期 X%」：把跟踪以来的超额收益，放进回测里所有同样长度的时段里比，X% 是跟踪跑赢了其中多少。50% 左右是正常表现；低于 10% 值得留意，可能是策略在失效，也可能只是运气不好。";

/**
 * 跟踪净值在基准回测重抽样扇形里的位置（D65）：按绝对净值、不扣基准，和按超额算的「跑赢回测同期」不是一回事，
 * 只放进那个指标的 ⓘ 里。没有扇形时为 null。
 */
export function navFanText(
  p: number | null | undefined,
  band: string | null | undefined,
): string | null {
  if (p === null || p === undefined) return null;
  const where =
    band === "<5"
      ? "低于回测重抽样区间的第 5 百分位"
      : band === ">95"
        ? "高于回测重抽样区间的第 95 百分位"
        : `处于回测重抽样区间第 ${p.toFixed(0)} 百分位`;
  return `按绝对净值：${where}（不扣基准，市场整体涨跌会影响它）`;
}

/** 偏离百分位 → 一句人话；天数太少或没有回测时说明原因 */
export function deviationText(p: number | null, days: number): string {
  if (p !== null) return `跑赢回测同期 ${p.toFixed(0)}%`;
  if (days < 5) return "天数太少，还不好和回测比";
  return "没有可对照的回测";
}

// ── 计划快照（D68）：原因文字表在 @ivan/core，给模型看的摘要用同一张 ──

export { formatPlanReason, PLAN_CAUSE_TEXT, REASON_DETAIL_TEXT, REASON_TEXT } from "@ivan/core";

/** 计划日旁注：按交易所休市安排推算，或表里没有那一年时按工作日推算 */
export function planDateNote(basis: string | null | undefined): string {
  return basis === "holiday_table" ? "（按交易所休市安排推算）" : "（按工作日推算，遇节假日顺延）";
}

/** 分位（0–1）→「83 分位」 */
export function pctile(p: number | null | undefined): string {
  return p === null || p === undefined || !Number.isFinite(p) ? NA : `${Math.round(p * 100)} 分位`;
}

// ── 跟踪判词与健康度（D70）：文字与阈值在 @ivan/core，和引擎同一份 ──

export {
  DECAYED_ADVICE,
  HEALTH_HONESTY,
  HEALTH_STATE_TEXT,
  SIGNAL_TEXT,
  VERDICT_TEXT,
} from "@ivan/core";

/**
 * 判词徽标的颜色（设计系统 §3：down =「正常」状态；warn = 提示、失败、报错）。
 * 「可能失效」另配实心警示图标（VerdictBadge），颜色不是唯一的识别渠道，徽标始终有字。
 */
export const VERDICT_TONE: Record<Verdict, "down" | "warn" | "neutral"> = {
  ON_TRACK: "down",
  DRIFTING: "warn",
  DECAYED: "warn",
  WARMING_UP: "neutral",
  STALE_DATA: "warn",
  SETTLE_FAILED: "warn",
};

/** 保留至多 1 位小数，去掉末尾的 0：3 → "3"、0.75 → "0.8"、1.123 → "1.1" */
function short(v: number, digits = 1): string {
  return String(Number(v.toFixed(digits)));
}

const METRIC_ROW: Record<HealthMetric, (v: number) => [string, string]> = {
  beatBacktestPct: (v) => {
    const t = HEALTH_THRESHOLDS.beatBacktestPct;
    return ["跑赢回测同期", `${short(v)}（正常 ≥ ${t.healthy}，注意 ≥ ${t.warning}）`];
  },
  ddRatio: (v) => {
    const t = HEALTH_THRESHOLDS.ddRatio;
    return ["回撤比", `${short(v, 2)} 倍（正常 ≤ ${t.healthy}，注意 ≤ ${t.warning}）`];
  },
};

/**
 * 判词 ⓘ 里的各行：每个指标的值与阈值（「跑赢回测同期 3（正常 ≥ 5，注意 ≥ 1）」），再是这一晚的读数与状态。
 * 还没有健康读数时为空。
 */
export function verdictInfoRows(
  health: Pick<TrackingHealth, "state" | "signal" | "perMetric"> | null | undefined,
): Array<[string, string]> {
  if (!health) return [];
  const rows: Array<[string, string]> = [];
  for (const k of ["beatBacktestPct", "ddRatio"] as const) {
    const m = health.perMetric[k];
    if (m) rows.push(METRIC_ROW[k](m.value));
  }
  rows.push(["这一晚的读数", SIGNAL_TEXT[health.signal]]);
  rows.push(["状态", HEALTH_STATE_TEXT[health.state]]);
  return rows;
}

/** 判词的一句说明（ⓘ 的第一行） */
export function verdictNote(v: Verdict, lastDate?: string | null): string {
  switch (v) {
    case "ON_TRACK":
      return "各项指标都在回测的正常范围里。";
    case "DRIFTING":
      return "最近的读数持续不在正常范围，和回测的表现有偏离；回到正常范围就恢复。";
    case "DECAYED":
      return "最近的读数持续处在衰减或严重的范围，建议复核规则是否仍然有效。系统不会替你做任何操作。";
    case "WARMING_UP":
      return `跟踪满 ${HEALTH_THRESHOLDS.minDays} 个交易日、且有上线前的回测可对照，才开始判断；样本不足从不算正常。`;
    case "STALE_DATA":
      return `这个跟踪的数据没更新到最新交易日${lastDate ? `，还是 ${lastDate} 的结果` : ""}。`;
    case "SETTLE_FAILED":
      return "最近一次结算失败，下面的数字还是上一次成功结算的。";
  }
}

// ── 决策回溯（D71） ──

export { LEDGER_BREAK_TEXT } from "@ivan/core";

/** 拒单原因（S05 的拒单样例；回测页成交与容量、回溯页重放结果共用） */
export const REJECT_TEXT: Record<RejectReason, string> = {
  suspended: "停牌",
  limit_up: "涨停开盘",
  limit_down: "跌停开盘",
  capacity: "超过成交额上限",
  lot_zero: "不够一手",
  cash: "现金不足",
  no_liquidity: "没有成交额数据",
};

const rejectText = (r: string | null | undefined) =>
  r ? (REJECT_TEXT[r as RejectReason] ?? r) : "原因未记录";

/**
 * 第 1 版计划的一项按现在的数据重放执行得怎样：
 * 「按现在的数据重放：成交 12.31」/「…：没买到（涨停开盘）」/「…：没有执行」；卖出写「没卖出」，部分成交注明没成交的原因。
 */
export function replayLine(
  r:
    | { side: string; outcome: string; price: number | null; rejectReason: string | null }
    | null
    | undefined,
): string {
  if (!r) return "按现在的数据重放：计划日还没结算";
  if (r.outcome === "filled") {
    const price = r.price === null || !Number.isFinite(r.price) ? NA : r.price.toFixed(2);
    const partial = r.rejectReason ? `（部分没成交：${rejectText(r.rejectReason)}）` : "";
    return `按现在的数据重放：成交 ${price}${partial}`;
  }
  if (r.outcome === "rejected") {
    return `按现在的数据重放：${r.side === "sell" ? "没卖出" : "没买到"}（${rejectText(r.rejectReason)}）`;
  }
  return "按现在的数据重放：没有执行";
}

/**
 * 后来怎么样（D79）：买入「+3.1%，跑赢基准 +1.2%」（20 天；不满 20 天时用 5 天并注明）；
 * 卖出看的是卖出之后这只股票的涨跌，前面加「卖出后」；没到时间或算不出写「--」。
 */
export function outcomeText(
  o:
    | {
        side: string;
        ret5: number | null;
        ret20: number | null;
        excess5: number | null;
        excess20: number | null;
      }
    | null
    | undefined,
): string {
  if (!o) return NA;
  const has = (x: number | null) => x !== null && Number.isFinite(x);
  const [ret, excess, note] = has(o.ret20)
    ? [o.ret20, o.excess20, ""]
    : has(o.ret5)
      ? [o.ret5, o.excess5, "（5 天）"]
      : [null, null, ""];
  if (ret === null) return NA;
  // 卖出：只说这只股票之后的走势与相对基准（「跑赢」读起来像是卖对了，其实是卖掉的那只后来更好）；
  // 买入：超额为负写「跑输」，不写「跑赢基准 -0.4%」
  if (o.side === "sell") {
    return `卖出后 ${pct(ret)}${has(excess) ? `，相对基准 ${pct(excess)}` : ""}${note}`;
  }
  const vs = has(excess)
    ? excess! < 0
      ? `，跑输基准 ${pct(-excess!, 1, false)}`
      : `，跑赢基准 ${pct(excess)}`
    : "";
  return `${pct(ret)}${vs}${note}`;
}

/** 时间线条目的徽标文字：计划第 2 版起写「修订」 */
export function ledgerKindText(kind: string, edition?: number | null): string {
  switch (kind) {
    case "plan":
      return edition && edition > 1 ? "修订" : "计划";
    case "replay_drift":
      return "重放差异";
    case "health_transition":
      return "状态变化";
    case "brief":
      return "简报";
    case "tracking_start":
      return "上线";
    case "tracking_stop":
      return "停止";
    default:
      return kind;
  }
}

/** 版次对比里细分原因的短文字（模板里的名次线与条件在计划项里另写） */
export function reasonDetailShort(d: string | null | undefined): string {
  if (!d) return NA;
  if (d === "ranked_out") return "掉出名次线";
  if (d === "failed_filter") return "不再满足条件";
  return (REASON_DETAIL_TEXT as Record<string, string>)[d] ?? d;
}

// ── 两融与筹码（S15b） ──

/** 解禁可得日依据的 Tag 文字（LockupAvailRule） */
export const LOCKUP_RULE_TAG: Record<string, string> = {
  ipo_terms: "上市时已知",
  notice_bound: "按公告推算",
  "notice_bound:weekday": "按工作日推算",
  first_seen: "首次记录",
};

/** 解禁可得日依据的说明（Tag 的 ⓘ、证据项的注释） */
export function lockupRuleText(rule: string, leadTd = 3): string {
  switch (rule) {
    case "ipo_terms":
      return "首发限售，上市时招股书就写明了";
    case "notice_bound":
      return `按解禁前 ${leadTd} 个交易日的提示性公告推算可得日`;
    case "notice_bound:weekday":
      return `按解禁前 ${leadTd} 个工作日推算可得日（那一年没有交易日历）`;
    case "first_seen":
      return "每晚同步首次见到它的那天起算";
    default:
      return rule;
  }
}

/** 已经是百分数（0–100）的值：带符号、默认 1 位小数，如 +2.0%、-9.8% */
export function pctPoints(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return NA;
  return `${x > 0 ? "+" : ""}${x.toFixed(digits)}%`;
}

/** 大宗交易折溢价（百分数）：负数说「折价」、正数说「溢价」，不靠正负号 */
export function premiumText(p: number | null | undefined, digits = 1): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return NA;
  const a = Math.abs(p).toFixed(digits);
  if (Number(a) === 0) return "平价";
  return p < 0 ? `折价 ${a}%` : `溢价 ${a}%`;
}

/** 股数：一万股以上写成「x 万股」（最多 2 位小数），以下写「x 股」 */
export function sharesText(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NA;
  if (Math.abs(n) < 1e4) return `${Math.round(n).toLocaleString("en-US")} 股`;
  return `${(n / 1e4).toLocaleString("en-US", { maximumFractionDigits: 2 })} 万股`;
}

/** 户数：整数加千分位 */
export function holdersText(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NA;
  return `${Math.round(n).toLocaleString("en-US")} 户`;
}

/**
 * 编辑器因子下拉里事件因子（两融与筹码）的后缀与是否禁用：历史还没补算完 →「（补算中）」并禁用；
 * 补完了 →「自 2013-02-13」；不是事件因子或不知道（worker 不在）时什么都不加。
 */
export function eventFactorOption(f: {
  dataset?: string;
  from?: string | null;
  ready?: boolean | null;
}): { suffix: string; disabled: boolean } {
  if (!f.dataset || f.ready === undefined || f.ready === null)
    return { suffix: "", disabled: false };
  if (!f.ready) return { suffix: "（补算中）", disabled: true };
  return { suffix: f.from ? ` 自 ${f.from}` : "", disabled: false };
}

/** 管理页一行：「事件因子：补算中（7 / 14 年）」「已补算（第 1 版）」；S15 的历史回填没完成时「等事件数据补齐」 */
export function eventFactorsText(
  s:
    | {
        v: number;
        complete: boolean;
        doneYears: number;
        totalYears: number;
        backfillComplete?: boolean;
      }
    | undefined,
): string | null {
  if (!s) return null;
  if (s.complete) return `事件因子：已补算（第 ${s.v} 版）`;
  if (s.backfillComplete === false) return "事件因子：等事件数据的历史补齐后再补算";
  return `事件因子：补算中（${s.doneYears} / ${s.totalYears} 年）`;
}

/**
 * 数字核对 ⓘ 里「最接近的工具数」：按证据的种类排版（比率写成百分数、金额写万 / 亿），
 * 好和文字里的数对照；不知道种类（旧结果）时保留 4 位有效数字。
 */
export function nearestValueText(
  n: { value: number; kind?: "ratio" | "points" | "money" | "count" | "number" },
  figureKind: string,
): string {
  const percentish = figureKind === "percent" || figureKind === "points";
  if (n.kind === "ratio" && percentish) return pct(n.value, 2);
  if (n.kind === "points") return `${num(n.value, 2)}%`;
  if (n.kind === "money") return money(n.value);
  if (n.kind === "count") return num(n.value, 0);
  return n.value.toLocaleString("zh-CN", { maximumSignificantDigits: 4 });
}

// ── 回测对话框的成交假设（S05） ──

/** 单边滑点输入框的值 → bp：清空时是「没填」（NaN），不悄悄当成 0 bp */
export function slippageFromInput(raw: string): number {
  return raw.trim() === "" ? Number.NaN : Number(raw);
}

/** 单边滑点没填或不在 0–200 bp 时的提示，填对了是 null；有提示时「开始回测」不能点 */
export function slippageError(bps: number): string | null {
  if (Number.isNaN(bps)) return "请填单边滑点（不计滑点填 0）";
  return bps >= 0 && bps <= 200 ? null : "单边滑点要在 0–200 bp 之间";
}

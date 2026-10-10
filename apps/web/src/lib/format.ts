/** 数字格式：百分比带符号、金额自动缩写（万 / 亿）。 */

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

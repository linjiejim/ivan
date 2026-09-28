/**
 * 日期一律是交易所本地日期字符串 `YYYY-MM-DD`（A 股、港股都是 UTC+8）。
 * 不用毫秒时间戳、不依赖机器时区：服务器在哪个时区都算出同一个「今天」。
 */
export type DateStr = string;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateStr(s: unknown): s is DateStr {
  return typeof s === "string" && DATE_RE.test(s);
}

/** 北京时间的今天。 */
export function todayCN(now: Date = new Date()): DateStr {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** 北京时间的当前时分（HH:MM），调度判断用。 */
export function nowHmCN(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}

function toUtcMs(d: DateStr): number {
  return Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
}

function fromUtcMs(ms: number): DateStr {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(d: DateStr, n: number): DateStr {
  return fromUtcMs(toUtcMs(d) + n * 86_400_000);
}

export function diffDays(a: DateStr, b: DateStr): number {
  return Math.round((toUtcMs(a) - toUtcMs(b)) / 86_400_000);
}

export function addMonths(d: DateStr, n: number): DateStr {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7)) - 1 + n;
  const day = Number(d.slice(8, 10));
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return fromUtcMs(Date.UTC(y, m, Math.min(day, last)));
}

export function addYears(d: DateStr, n: number): DateStr {
  return addMonths(d, n * 12);
}

/** 星期几：0=周日 … 6=周六。 */
export function weekday(d: DateStr): number {
  return new Date(toUtcMs(d)).getUTCDay();
}

/** 东财等接口返回的 `2026-06-30 00:00:00` → `2026-06-30`；`20260630` → `2026-06-30`。 */
export function normalizeDate(s: string | null | undefined): DateStr | null {
  if (!s) return null;
  const t = String(s).trim();
  if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  const head = t.slice(0, 10).replaceAll("/", "-");
  return isDateStr(head) ? head : null;
}

/** 周期键：同一周/月/季的交易日有相同的键，调仓日 = 每个键的第一个交易日。 */
export function periodKey(d: DateStr, every: "week" | "month" | "quarter"): string {
  if (every === "month") return d.slice(0, 7);
  if (every === "quarter")
    return `${d.slice(0, 4)}Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
  // ISO 周：以周一为一周开始
  const wd = weekday(d);
  const monday = addDays(d, wd === 0 ? -6 : 1 - wd);
  return `W${monday}`;
}

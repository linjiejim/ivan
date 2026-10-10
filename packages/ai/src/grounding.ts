/**
 * 数字核对（spec §10，D69）：把「数字只能来自工具结果」从提示词变成机器检查。纯函数，server 的对话与 worker 的简报共用。
 *
 * - 抽数：先规范化（全角、U+2212、零宽字符、千分位），日期、证券代码、版本号、行首序号、反引号里的内容豁免；
 *   带 % / 个百分点 / bp / 货币或单位的是「量」，跟着 天 / 只 / 笔 / 次 / 名 / 户 / 个交易日 的整数是「计数」（裸「股」不算，见 COUNT_UNITS），其余裸整数不核对。
 *   带「万 / 亿」的计数（「4.8 万户」，S15b）按写出的精度核对：x 万（d 位小数）对 n 要 |x × 10⁴ − n| ≤ 0.5 × 10^(4−d)。
 * - 证据：遍历工具给模型看的 JSON，每个有限数字按键名归类；因子先按因子表的单位（Ivan 存的百分数是 4.25 这样的百分点）。
 * - 匹配：按写出的精度留半个末位的余量（或 0.5% 相对误差），按类型匹配，不允许推算。
 * 简报是闸门（对不上就重写一次、再不行用模板），对话只能标注（流式撤不回来）。
 */
import { FACTOR_MAP, type FactorDef } from "@ivan/core";

/** 1 = S09；2 = S15b：「户」是计数单位，带「万 / 亿」的计数（万户、万股……）按写出的精度核对；裸「股」仍不是计数单位 */
export const GROUNDING_VERSION = 2;

/** 文字里的数：百分数、百分点、金额（已按万 / 亿换算）、普通数（小数或倍数）、计数、裸整数（不核对） */
export type FigureKind = "percent" | "points" | "money" | "ratio" | "count" | "plain";

export interface ProseFigure {
  /** 规范化后原样的文字（含单位） */
  raw: string;
  /** 带符号的数值：百分数是 7.3 这样的百分数，金额是换算后的元，bp 换成百分点 */
  value: number;
  kind: FigureKind;
  /** 写出的小数位数（bp 换成百分点后加 2） */
  decimals: number;
  negative: boolean;
  /** 写了「+」：证据为负时不能靠上下文里的「跌、回撤」开脱 */
  plus: boolean;
  /** 金额或计数的单位倍数（元 1、万 1e4、亿 1e8；「4.8 万户」的 1e4），决定「半个写出的末位」有多大 */
  scale: number;
  start: number;
  end: number;
}

export type EvidenceKind = "ratio" | "points" | "money" | "count" | "number";

export interface EvidenceValue {
  value: number;
  kind: EvidenceKind;
  /** 出处：source 加 JSON 路径，如 get_run.excessCagr、lookup_security.factors.mcap */
  path: string;
  source: string;
}

export interface UnverifiedFigure {
  raw: string;
  value: number;
  kind: FigureKind;
  reason: "no_match" | "sign_mismatch";
  /** 同类证据里最接近的一个（给界面 ⓘ 与重写提示用） */
  nearest?: { path: string; value: number; kind?: EvidenceKind };
}

export interface GroundingResult {
  version: typeof GROUNDING_VERSION;
  /** 核对过的「量」与「计数」个数 */
  checked: number;
  /** 豁免的数（日期、代码、版本号、序号、反引号里的、裸整数） */
  exempt: number;
  unverified: UnverifiedFigure[];
}

// ── 规范化 ──

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

export function normalizeText(s: string): string {
  let t = s
    .replace(ZERO_WIDTH, "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/％/g, "%")
    .replace(/．/g, ".")
    .replace(/＋/g, "+")
    .replace(/[－−]/g, "-");
  // 千分位：只认完整的千分位分组（开头 1–3 位、前面不是数字或小数点，之后每组正好 3 位）。
  // 「收盘 1460.52，128 只」「0.82，200 日均线」是两个数，不合并
  t = t.replace(/(?<![\d.])\d{1,3}(?:[,，]\d{3})+(?:\.\d+)?(?!\d)/g, (m) =>
    m.replace(/[,，]/g, ""),
  );
  return t;
}

// ── 抽数 ──

const NUM = /\d+(?:\.\d+)?/g;

/** 豁免的写法：按顺序匹配，命中的范围不再参与抽数 */
const EXEMPT: RegExp[] = [
  /`[^`\n]*`/g, // 反引号里的内容
  /\d+\.\d+\.\d+(?:\.\d+)*/g, // 1.2.0 这样的版本号、点分日期
  /\d{4}\s*[-/]\s*\d{1,2}\s*[-/]\s*\d{1,2}/g, // 2024-06-28
  /\d{4}-\d{1,2}(?![\d-])/g, // 2024-06
  /\d{4}\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*[日号])?/g, // 2024 年 6 月 28 日
  /\d{1,2}\s*月\s*\d{1,2}\s*[日号]/g, // 6 月 28 日
  /\d{4}\s*年/g, // 2024 年
  /(?<![\d.])\d{1,2}\s*月/g, // 6 月
  /\d{6}\.(?:SH|SZ|BJ)/gi, // 600519.SH
  /\d{4,5}\.HK/gi, // 00700.HK
  /(?<![\d.])[01]\.\d{6}(?!\d)/g, // 东财行情代码 1.000905
  /(?<![\d.])\d{6}(?![\d.])(?!\s*(?:%|个百分点|bp|元|港元|万|亿|倍|天|只|笔|次|名|户|个交易日))/g, // 600519
  // v3、MA20、H00905、run_ab12。后面紧跟计量单位的不算标识符：「ROE15%」「PE12.5倍」是因子值，要核对
  /[A-Za-z_][A-Za-z_]*\d[0-9A-Za-z_]*(?![\d.]*\s*(?:%|个百分点|bp|BP|倍|x(?![A-Za-z])|万亿|亿|万|港元|元))/g,
  /^[ \t]*(?:[-*][ \t]*)?(?:\(\d{1,2}\)|（\d{1,2}）|\d{1,2}[.、)）](?!\d))/gm, // 行首序号
  /前\s*\d+\s*(?:名|只|个)/g, // 「前 15 名」是规则参数，不核对
  // 回看窗口不核对（D69）：「近 60 天」「过去 20 个交易日」「每 5 天」，以及紧跟指标名的「60 天波动率」「20 个交易日均成交额」。
  // 「日」不是计数单位，「60 日均线」本来就是裸整数、不核对，这里不用管
  /(?:近|过去|最近|每)\s*\d+\s*(?:个交易日|天)/g,
  /\d+\s*(?:个交易日|天)(?=\s*(?:的\s*)?(?:均|平均|波动|动量|涨幅|跌幅|收益|成交|换手|新高|新低))/g,
];

/** 单位 → 种类与倍数 */
const UNIT =
  /^(\s*)(%|个百分点|bp|BP|万亿|亿港元|亿元|万港元|万元|亿户|万户|亿股|万股|港元|元|亿|万|倍|x(?![A-Za-z])|个交易日|天|只|笔|次|名|户)/;
const MONEY_SCALE: Record<string, number> = {
  万亿: 1e12,
  亿港元: 1e8,
  亿元: 1e8,
  亿: 1e8,
  万港元: 1e4,
  万元: 1e4,
  万: 1e4,
  港元: 1,
  元: 1,
};
// 不含裸「股」：「每 10 股派 3 元」「10 转 5 股」里的整数在证据里没有（分红送转按每股存），按第 1 版当裸整数不核对；
// 股数只核对带「万 / 亿」的写法（解禁股数的证据就是万股）
const COUNT_UNITS = new Set(["个交易日", "天", "只", "笔", "次", "名", "户"]);
/** 带「万 / 亿」的计数单位（S15b）：股东户数、股数 */
const SCALED_COUNT: Record<string, number> = { 亿户: 1e8, 万户: 1e4, 亿股: 1e8, 万股: 1e4 };

function decimalsOf(n: string): number {
  const i = n.indexOf(".");
  return i < 0 ? 0 : n.length - i - 1;
}

/** 数字前面的符号：紧挨着（可隔一个空格）的 + / -（前面不是数字，否则是「5-10」这样的区间）或「负」 */
function signBefore(t: string, i: number): { negative: boolean; plus: boolean; at: number } {
  let j = i - 1;
  if (t[j] === " ") j--;
  const c = t[j];
  if (c === "负") return { negative: true, plus: false, at: j };
  if (c === "-" || c === "+") {
    // Markdown 列表符号「- 12.5%」：行首（前面只有空白）、后面跟空格的不是正负号
    if (t[j + 1] === " " && /^[ \t]*$/.test(t.slice(t.lastIndexOf("\n", j - 1) + 1, j))) {
      return { negative: false, plus: false, at: i };
    }
    let k = j - 1;
    if (t[k] === " ") k--;
    if (k >= 0 && /[\d)）%]/.test(t[k]!)) return { negative: false, plus: false, at: i };
    return { negative: c === "-", plus: c === "+", at: j };
  }
  return { negative: false, plus: false, at: i };
}

export function extractFigures(text: string): { figures: ProseFigure[]; exempt: number } {
  const t = normalizeText(text);
  const masked = new Uint8Array(t.length);
  let exempt = 0;
  for (const re of EXEMPT) {
    for (const m of t.matchAll(re)) {
      const s = m.index;
      const e = s + m[0].length;
      if (masked[s]) continue;
      masked.fill(1, s, e);
      exempt += m[0].match(NUM)?.length ?? 0;
    }
  }
  const figures: ProseFigure[] = [];
  for (const m of t.matchAll(NUM)) {
    const i = m.index;
    if (masked[i]) continue;
    const num = m[0];
    const abs = Number(num);
    const d = decimalsOf(num);
    const after = t.slice(i + num.length);
    const u = UNIT.exec(after);
    const unit = u?.[2] ?? null;
    const end = i + num.length + (u ? u[0].length : 0);
    const sign = signBefore(t, i);
    const signed = sign.negative ? -abs : abs;
    const base = { negative: sign.negative, plus: sign.plus, start: sign.at, end, scale: 1 };
    const raw = t.slice(sign.at, end);
    let fig: ProseFigure;
    if (unit === "%") fig = { ...base, raw, value: signed, kind: "percent", decimals: d };
    else if (unit === "个百分点")
      fig = { ...base, raw, value: signed, kind: "points", decimals: d };
    else if (unit === "bp" || unit === "BP")
      fig = { ...base, raw, value: signed / 100, kind: "points", decimals: d + 2 };
    else if (unit && MONEY_SCALE[unit]) {
      const scale = MONEY_SCALE[unit]!;
      fig = { ...base, raw, value: signed * scale, kind: "money", decimals: d, scale };
    } else if (unit && SCALED_COUNT[unit]) {
      const scale = SCALED_COUNT[unit]!;
      fig = { ...base, raw, value: signed * scale, kind: "count", decimals: d, scale };
    } else if (unit === "倍" || unit === "x")
      fig = { ...base, raw, value: signed, kind: "ratio", decimals: d };
    else if (unit && COUNT_UNITS.has(unit))
      fig = { ...base, raw, value: signed, kind: d === 0 ? "count" : "ratio", decimals: d };
    else if (d > 0) fig = { ...base, raw, value: signed, kind: "ratio", decimals: d };
    else fig = { ...base, raw, value: signed, kind: "plain", decimals: 0 };
    figures.push(fig);
  }
  return { figures, exempt };
}

// ── 证据 ──

/** 键名直接说明是百分点（0–100）的 */
const POINTS_KEY = /Pct$|percentile|beatBacktest/i;
/** 键名说明是金额的（单独的 value 不算：条件、证据项里的 value 先按因子或单位归类） */
const MONEY_KEY = /equity|capital|amount|Value|cash|pnl|fees|money|capacity/i;
const COUNT_KEYS = new Set([
  "days",
  "buys",
  "sells",
  "n",
  "count",
  "trades",
  "rank",
  "positions",
  "years",
  "positiveYears",
  "edition",
  "top",
  // 两融与筹码（S15b）
  "holderNum",
  "preHolderNum",
  "unlockShares",
]);
/** 财报行（个股卡、证据）的字段：不在因子表里，单位同 FIN_FIELDS（金额是元，比率是百分数） */
const FIN_UNIT: Record<string, "%" | "元"> = {
  roe: "%",
  revenue_yoy: "%",
  revenue: "元",
  np: "元",
  deducted_np: "元",
  ocf: "元",
};

type Classified = { kind: EvidenceKind; value: number } | null;

function byUnit(unit: string | undefined, v: number): Classified {
  switch (unit) {
    case "%":
      return { kind: "points", value: v };
    case "亿":
      return { kind: "money", value: v * 1e8 };
    case "万":
      return { kind: "money", value: v * 1e4 };
    case "元":
    case "港元":
    case "CNY":
    case "HKD":
      return { kind: "money", value: v };
    case "x":
      return { kind: "number", value: v };
    case "名":
    case "天":
    case "年":
    case "条":
    case "户":
    case "笔":
    case "股":
      return { kind: Number.isInteger(v) ? "count" : "number", value: v };
    case "万股": {
      // 证据项写的是万股（股数 ÷ 1e4）：换回股数，乘回去的浮点误差按整数算
      const n = v * 1e4;
      const r = Math.round(n);
      return Math.abs(n - r) < 1e-6 ? { kind: "count", value: r } : { kind: "number", value: n };
    }
    default:
      return null;
  }
}

function factorOf(key: unknown): FactorDef | undefined {
  return typeof key === "string" ? FACTOR_MAP.get(key) : undefined;
}

function classify(
  key: string,
  v: number,
  parent: Record<string, unknown> | null,
  parentKey: string,
): { kind: EvidenceKind; value: number } {
  // 0. 容器的键说明是分位（termPct: { pe_ttm: 85 }）：里面的键虽然是因子名，数是百分点
  if (POINTS_KEY.test(parentKey)) return { kind: "points", value: v };
  // 1. 因子按因子表的单位：键是因子名；或是 { factor | key: 因子名, value } 里的 value；或带 unit 的 { value, unit }
  const direct = factorOf(key);
  if (direct) {
    const c = byUnit(direct.unit, v);
    if (c) return c;
  }
  if (key === "value" && parent) {
    const f = factorOf(parent.factor) ?? factorOf(parent.key);
    const c = f
      ? byUnit(f.unit, v)
      : typeof parent.unit === "string"
        ? byUnit(parent.unit, v)
        : null;
    if (c) return c;
  }
  if (FIN_UNIT[key]) return byUnit(FIN_UNIT[key], v)!;
  // 2. 按键名
  if (POINTS_KEY.test(key)) return { kind: "points", value: v };
  if (key !== "value" && MONEY_KEY.test(key)) return { kind: "money", value: v };
  if (COUNT_KEYS.has(key) && Number.isInteger(v)) return { kind: "count", value: v };
  return { kind: Math.abs(v) <= 50 ? "ratio" : "number", value: v };
}

/** 字符串里写出来的数（检查项说明、原因文字、页面上下文摘要）也算工具给过的 */
function stringEvidence(s: string, path: string, source: string, out: EvidenceValue[]): void {
  for (const f of extractFigures(s).figures) {
    const kind: EvidenceKind | null =
      f.kind === "percent"
        ? "ratio"
        : f.kind === "points"
          ? "points"
          : f.kind === "money"
            ? "money"
            : f.kind === "count"
              ? "count"
              : f.kind === "ratio"
                ? "number"
                : null;
    if (!kind) continue;
    out.push({ kind, value: f.kind === "percent" ? f.value / 100 : f.value, path, source });
  }
}

const MAX_EVIDENCE = 20_000;

/** 遍历一份工具结果（模型实际看到的 JSON）收集证据；字符串里的数也收 */
export function collectEvidence(source: string, payload: unknown): EvidenceValue[] {
  const out: EvidenceValue[] = [];
  const walk = (
    v: unknown,
    path: string,
    key: string,
    parent: Record<string, unknown> | null,
    parentKey: string,
  ): void => {
    if (out.length >= MAX_EVIDENCE) return;
    if (typeof v === "number") {
      if (Number.isFinite(v)) out.push({ ...classify(key, v, parent, parentKey), path, source });
    } else if (typeof v === "string") {
      if (/\d/.test(v)) stringEvidence(v, path, source, out);
    } else if (Array.isArray(v)) {
      out.push({ kind: "count", value: v.length, path: `${path}.length`, source });
      v.forEach((x, i) => walk(x, `${path}[${i}]`, key, parent, parentKey));
    } else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const [k, x] of Object.entries(o)) walk(x, path ? `${path}.${k}` : k, k, o, key);
    }
  };
  walk(payload, source, "", null, "");
  return out;
}

// ── 匹配 ──

const EPS = 1e-9;
/** 证据为负时，文字前 12 个字里有这些词就算说清了方向 */
const NEGATIVE_CUE = /跌|回撤|亏|跑输|落后|下滑|低于|下降|负|折价|减少|回落|缩水|少了/;

/** 一个数与一条证据的差距与余量（在同一个量纲里）；类型不兼容时为 null */
function compare(f: ProseFigure, e: EvidenceValue): { diff: number; tol: number } | null {
  const half = 0.5 * 10 ** -f.decimals;
  const fa = Math.abs(f.value);
  const ea = Math.abs(e.value);
  switch (f.kind) {
    case "percent":
    case "points":
      if (e.kind === "ratio")
        return { diff: Math.abs(fa / 100 - ea), tol: Math.max(half / 100, 0.005 * ea) };
      if (e.kind === "points") return { diff: Math.abs(fa - ea), tol: Math.max(half, 0.005 * ea) };
      return null;
    case "money":
      if (e.kind === "money" || e.kind === "number")
        return { diff: Math.abs(fa - ea), tol: Math.max(half * f.scale, 0.005 * ea) };
      return null;
    case "ratio":
      if (e.kind === "count") return null;
      return { diff: Math.abs(fa - ea), tol: Math.max(half, 0.005 * ea) };
    case "count":
      if (!Number.isInteger(e.value) || e.kind === "money") return null;
      // 「4.8 万户」：按写出的精度留半个末位（0.5 × 10^(4−1) = 500 户）；不带万 / 亿的计数要一模一样
      return { diff: Math.abs(fa - ea), tol: f.scale > 1 ? half * f.scale : 0 };
    default:
      return null;
  }
}

export function checkGrounding(text: string, evidence: readonly EvidenceValue[]): GroundingResult {
  const { figures, exempt } = extractFigures(text);
  const t = normalizeText(text);
  let checked = 0;
  let plain = 0;
  const unverified: UnverifiedFigure[] = [];
  for (const f of figures) {
    if (f.kind === "plain") {
      plain++;
      continue;
    }
    checked++;
    let nearest: { e: EvidenceValue; score: number } | null = null;
    const matched: EvidenceValue[] = [];
    for (const e of evidence) {
      const c = compare(f, e);
      if (!c) continue;
      if (c.diff <= c.tol + EPS) matched.push(e);
      const score = c.diff / (c.tol || 1);
      if (!nearest || score < nearest.score) nearest = { e, score };
    }
    const near = nearest
      ? { path: nearest.e.path, value: nearest.e.value, kind: nearest.e.kind }
      : undefined;
    const base = { raw: f.raw, value: f.value, kind: f.kind };
    if (!matched.length) {
      unverified.push({ ...base, reason: "no_match", ...(near ? { nearest: near } : {}) });
      continue;
    }
    // 符号：对上的证据全是负数、文字却没写负号时，要么写了「+」，要么前面没有「跌、回撤」这类词，都算不符
    if (f.negative || matched.some((e) => e.value >= 0)) continue;
    const cue = NEGATIVE_CUE.test(t.slice(Math.max(0, f.start - 12), f.start));
    if (f.plus || !cue) {
      const e = matched[0]!;
      unverified.push({
        ...base,
        reason: "sign_mismatch",
        nearest: { path: e.path, value: e.value, kind: e.kind },
      });
    }
  }
  return { version: GROUNDING_VERSION, checked, exempt: exempt + plain, unverified };
}

/** 把对不上的数换成「[待核对]」（测试与排查用；对话只标注，不改写） */
export function redactUnverified(text: string, r: GroundingResult): string {
  let t = normalizeText(text);
  for (const u of r.unverified) t = t.split(u.raw).join("[待核对]");
  return t;
}

/** 给重写提示与日志用的清单：「+12.4%、41 天」 */
export function unverifiedList(r: GroundingResult): string {
  return [...new Set(r.unverified.map((u) => u.raw.trim()))].join("、");
}

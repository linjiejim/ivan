/**
 * 成交假设（D55）：回测参数，不属于策略版本；券商佣金仍在 spec.costs。
 *
 * 每个字段都带「旧口径」默认值：`resolveExec` 用旧口径补齐缺省字段，所以以前存下的运行与跟踪永远按旧口径解析。
 * 新回测用 `defaultExec(market)`（显式写出推荐值）。纯 zod、不依赖 Node，web 直接引入。
 *
 * 之后的切片加字段的规则：新字段一律 `.default(<旧口径值>)`；`defaultExec` 显式写出新的推荐值；
 * 引擎还没实现的字段不进 schema。字段形状一变，`HASH_VERSION`（@ivan/data 输入指纹）要加 1。
 */
import { z } from "zod";
import type { Market } from "./market.ts";
import { canonicalJson } from "./strategy.ts";

export const ExecConfigSchema = z.strictObject({
  v: z.literal(1, { error: "成交假设的版本只能是 1" }).default(1),
  /** 规则表版本（D62）：1 = 引擎 1.1.0 的涨跌停与费率；2 = 按日期的表格（ST 10%、新股窗口、过户费与港股交易费历史等） */
  rules: z.union([z.literal(1), z.literal(2)], { error: "规则表版本只能是 1 或 2" }).default(1),
  /** 指标版本（D63）：1 = 从首日收盘算起；2 = 从投入第一笔资金算起、按完整持仓算胜率、补风险指标 */
  metrics: z.union([z.literal(1), z.literal(2)], { error: "指标版本只能是 1 或 2" }).default(1),
  // ── 按流动性成交（D64，S05）：旧口径 = 开盘价成交、不计滑点、不设上限 ──
  /** 单边滑点（bp），买价加、卖价减 */
  slippageBps: z
    .number({ error: "单边滑点要在 0–200 bp 之间" })
    .min(0, { error: "单边滑点要在 0–200 bp 之间" })
    .max(200, { error: "单边滑点要在 0–200 bp 之间" })
    .default(0),
  /** 半价差再加半个最小价位（港股低价股的价位很粗） */
  tickSpread: z.boolean({ error: "「加上半个最小价位」只能是是或否" }).default(false),
  /** 冲击成本：none 不计；sqrt = 系数 × 日波动 × √(金额 ÷ 日均成交额) */
  impact: z.enum(["none", "sqrt"], { error: "冲击成本只能是 none 或 sqrt" }).default("none"),
  /** 冲击系数（文献默认 0.5，没有在 A 股 / 港股上校准） */
  impactEta: z
    .number({ error: "冲击系数要在 0–2 之间" })
    .min(0, { error: "冲击系数要在 0–2 之间" })
    .max(2, { error: "冲击系数要在 0–2 之间" })
    .default(0),
  /** 单笔买入不超过决策日 20 日均成交额的这个比例；null = 不设上限 */
  participation: z
    .number({ error: "单笔上限要在日均成交额的 1%–100% 之间" })
    .min(0.01, { error: "单笔上限要在日均成交额的 1%–100% 之间" })
    .max(1, { error: "单笔上限要在日均成交额的 1%–100% 之间" })
    .nullable()
    .default(null),
});

export type ExecConfig = z.output<typeof ExecConfigSchema>;

/** 旧口径：开盘价成交、不计滑点、规则表与指标第 1 版（引擎 1.1.0 的行为）。 */
export const LEGACY_EXEC: ExecConfig = Object.freeze({
  v: 1,
  rules: 1,
  metrics: 1,
  slippageBps: 0,
  tickSpread: false,
  impact: "none",
  impactEta: 0,
  participation: null,
}) as ExecConfig;

export class ExecConfigError extends Error {}

/**
 * 新回测的默认成交假设：规则表与指标第 2 版（S04）；单边滑点 A 股 5bp、港股 10bp，加半个最小价位，
 * 平方根冲击（系数 0.5），单笔不超过日均成交额 10%（S05，D64）。
 */
export function defaultExec(market: Market): ExecConfig {
  return {
    v: 1,
    rules: 2,
    metrics: 2,
    slippageBps: market === "HK" ? 10 : 5,
    tickSpread: true,
    impact: "sqrt",
    impactEta: 0.5,
    participation: 0.1,
  };
}

/**
 * 读存储里的成交假设：缺省字段一律按旧口径补齐。存下的值不合法（以后的版本写入、手工改坏）时报错，
 * 不能悄悄当成旧口径跑。
 */
export function resolveExec(stored?: unknown): ExecConfig {
  const r = ExecConfigSchema.safeParse(stored ?? {});
  if (!r.success) throw new ExecConfigError(`存下的成交假设读不懂：${canonicalJson(stored)}`);
  return r.data;
}

/** 用户覆盖项（严格校验）合并到 defaultExec：不认识的键报错，越界报该字段的中文说明。 */
export function parseExecOverrides(market: Market, overrides?: unknown): ExecConfig {
  if (overrides === undefined || overrides === null) return defaultExec(market);
  if (typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new ExecConfigError("成交假设要是一个对象");
  }
  const r = ExecConfigSchema.safeParse({ ...defaultExec(market), ...overrides });
  if (r.success) return r.data;
  const issue = r.error.issues[0]!;
  if (issue.code === "unrecognized_keys") {
    throw new ExecConfigError(`成交假设里有不认识的设置：${issue.keys.join("、")}`);
  }
  throw new ExecConfigError(issue.message);
}

/** 是否等同旧口径（补齐缺省字段后逐项相等）。读不懂的值不算旧口径。 */
export function isLegacyExec(e: unknown): boolean {
  try {
    return canonicalJson(resolveExec(e)) === canonicalJson(LEGACY_EXEC);
  } catch {
    return false;
  }
}

/**
 * 成交是否按旧办法（开盘价、不计滑点、不设上限）：引擎这时不经过报价，逐字节复现 1.1.0 的成交。
 * 规则表与指标版本不看。
 */
export function isLegacyFill(e: ExecConfig): boolean {
  return e.slippageBps === 0 && !e.tickSpread && e.impact === "none" && e.participation === null;
}

const pctText = (x: number) => `${Number((x * 100).toFixed(1))}%`;

/** 成交部分的中文摘要（不含规则表与指标版本）。 */
export function describeFill(e: ExecConfig): string {
  if (isLegacyFill(e)) return "开盘价成交，不计滑点";
  const parts = [`开盘价成交，单边滑点 ${e.slippageBps}bp${e.tickSpread ? " + 半个最小价位" : ""}`];
  if (e.impact === "sqrt") parts.push(`冲击成本（平方根，系数 ${e.impactEta}）`);
  if (e.participation !== null) parts.push(`单笔不超过日均成交额 ${pctText(e.participation)}`);
  return parts.join("，");
}

/** 一行中文摘要（回测页、跟踪页、对话摘要共用）。 */
export function describeExec(e: ExecConfig): string {
  if (isLegacyExec(e)) return `${describeFill(e)}（旧口径）`;
  return `${describeFill(e)}；规则表第 ${e.rules} 版，指标第 ${e.metrics} 版`;
}

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
});

export type ExecConfig = z.output<typeof ExecConfigSchema>;

/** 旧口径：开盘价成交、不计滑点（引擎 1.1.0 的行为）。 */
export const LEGACY_EXEC: ExecConfig = Object.freeze({ v: 1 }) as ExecConfig;

export class ExecConfigError extends Error {}

/** 新回测的默认成交假设（S02 与旧口径相同，S04 / S05 起逐项换成推荐值）。 */
export function defaultExec(_market: Market): ExecConfig {
  return { v: 1 };
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

/** 一行中文摘要（回测页、跟踪页、对话摘要共用）。 */
export function describeExec(_e: ExecConfig): string {
  return "开盘价成交，不计滑点（旧口径）";
}

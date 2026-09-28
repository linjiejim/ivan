/**
 * 策略 DSL（D4）：结构化、可校验、可编译成 SQL，没有代码执行面。
 * 对话、表单、看板改的都是同一个对象；任何修改都产生新的不可变版本。
 */
import { z } from "zod";
import { FACTOR_MAP, getFactor, isFactorAvailable } from "./factors.ts";
import type { Market } from "./market.ts";

export const BOARDS_BY_MARKET: Record<Market, readonly string[]> = {
  A: ["main", "gem", "star"],
  HK: ["hk_main", "hk_gem"],
};

export const BENCHMARKS = {
  csi300: { market: "A", sym: "csi300_tr", label: "沪深300全收益", withDividends: true },
  sse: { market: "A", sym: "sse", label: "上证指数（不含分红）", withDividends: false },
  hsi: { market: "HK", sym: "hsi_tr", label: "恒指（盈富基金含分红）", withDividends: true },
  hscei: { market: "HK", sym: "hscei_tr", label: "国企指数（02828 含分红）", withDividends: true },
} as const;
export type BenchmarkKey = keyof typeof BENCHMARKS;
export const DEFAULT_BENCHMARK: Record<Market, BenchmarkKey> = { A: "csi300", HK: "hsi" };

const factorKey = z.string().min(1).max(40);

const NumericCondition = z.object({
  factor: factorKey,
  op: z.enum([">", ">=", "<", "<="]),
  value: z.number().finite(),
});
const BetweenCondition = z.object({
  factor: factorKey,
  op: z.literal("between"),
  value: z.tuple([z.number().finite(), z.number().finite()]),
});
const BoolCondition = z.object({
  factor: factorKey,
  op: z.enum(["is", "not"]),
});
const CategoryCondition = z.object({
  factor: factorKey,
  op: z.enum(["in", "not_in"]),
  value: z.array(z.string().min(1).max(40)).min(1).max(50),
});
export const ConditionSchema = z.union([
  NumericCondition,
  BetweenCondition,
  BoolCondition,
  CategoryCondition,
]);
export type Condition = z.infer<typeof ConditionSchema>;

export const StrategySpecSchema = z
  .object({
    schema: z.literal(1).default(1),
    name: z.string().min(1).max(60),
    market: z.enum(["A", "HK"]),
    mode: z.enum(["rules", "signals"]).default("rules"),
    universe: z
      .object({
        boards: z.array(z.string()).optional(),
        exclude: z.array(z.enum(["st", "new_listing", "loss"])).default(["st", "new_listing"]),
        /** 亿，本币 */
        minMcap: z.number().positive().optional(),
        industries: z
          .object({
            include: z.array(z.string().min(1).max(40)).max(80).optional(),
            exclude: z.array(z.string().min(1).max(40)).max(80).optional(),
          })
          .optional(),
      })
      .default({ exclude: ["st", "new_listing"] }),
    filters: z.array(ConditionSchema).max(30).default([]),
    rank: z
      .object({
        terms: z
          .array(
            z.object({
              factor: factorKey,
              weight: z.number().positive().max(100),
              better: z.enum(["high", "low"]),
            }),
          )
          .min(1)
          .max(10),
        /** 目标持仓只数 */
        top: z.number().int().min(1).max(100),
      })
      .optional(),
    rebalance: z
      .object({
        every: z.enum(["week", "month", "quarter"]),
        /** 缓冲倍数：持仓掉出名单前 top × buffer 才卖，降低换手；1 = 严格按前 top 名 */
        buffer: z.number().min(1).max(5).default(1.5),
      })
      .default({ every: "month", buffer: 1.5 }),
    sizing: z
      .object({
        method: z.literal("equal"),
        /** 单只上限（占总资产比例），如 0.2 */
        maxWeight: z.number().gt(0).max(1).optional(),
      })
      .default({ method: "equal" }),
    exits: z
      .object({
        /** 相对成本的收益率，如 0.3 */
        takeProfit: z.number().gt(0).max(10).optional(),
        /** 如 0.15 */
        stopLoss: z.number().gt(0).lt(1).optional(),
        /** 交易日 */
        maxHoldDays: z.number().int().min(1).max(2500).optional(),
        /** 调仓日掉出名单（或不再满足条件）就卖 */
        dropWhenFiltered: z.boolean().default(true),
      })
      .default({ dropWhenFiltered: true }),
    signals: z
      .object({
        datasetId: z.string().min(1),
        /** 最多同时持有几只 */
        maxPositions: z.number().int().min(1).max(100).default(10),
      })
      .optional(),
    costs: z
      .object({
        commission: z.number().min(0).max(0.01).optional(),
        minCommission: z.number().min(0).max(100).optional(),
      })
      .optional(),
    benchmark: z.enum(["csi300", "sse", "hsi", "hscei"]).optional(),
  })
  .superRefine((s, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    const checkFactor = (key: string, path: (string | number)[]) => {
      const f = getFactor(key);
      if (!f) {
        issue(path, `没有因子「${key}」。可用因子见 list_factors。`);
        return undefined;
      }
      if (!isFactorAvailable(key, s.market)) {
        issue(path, `因子「${key}」（${f.label}）在${s.market === "A" ? " A 股" : "港股"}不可用。`);
        return undefined;
      }
      return f;
    };
    s.filters.forEach((c, i) => {
      const f = checkFactor(c.factor, ["filters", i, "factor"]);
      if (!f) return;
      const numeric =
        c.op === ">" || c.op === ">=" || c.op === "<" || c.op === "<=" || c.op === "between";
      if (f.kind === "number" && !numeric)
        issue(["filters", i, "op"], `「${f.label}」是数值，只能用 > >= < <= between。`);
      if (f.kind === "bool" && c.op !== "is" && c.op !== "not")
        issue(["filters", i, "op"], `「${f.label}」是标记，只能用 is / not。`);
      if (f.kind === "category" && c.op !== "in" && c.op !== "not_in")
        issue(["filters", i, "op"], `「${f.label}」是分类，只能用 in / not_in。`);
      if (c.op === "between" && c.value[0] > c.value[1])
        issue(["filters", i, "value"], "between 的下限不能大于上限。");
    });
    if (s.mode === "rules") {
      if (!s.rank) issue(["rank"], "规则策略必须给出排序（rank）与持仓只数（top）。");
      s.rank?.terms.forEach((t, i) => {
        const f = checkFactor(t.factor, ["rank", "terms", i, "factor"]);
        if (f && f.kind !== "number")
          issue(["rank", "terms", i, "factor"], `排序只能用数值因子，「${f.label}」不是。`);
      });
    } else if (!s.signals) {
      issue(["signals"], "信号模式必须指定信号集 signals.datasetId。");
    }
    const boards = BOARDS_BY_MARKET[s.market];
    s.universe.boards?.forEach((b, i) => {
      if (!boards.includes(b))
        issue(["universe", "boards", i], `板块「${b}」不属于该市场，可选：${boards.join(" / ")}。`);
    });
    if (s.benchmark && BENCHMARKS[s.benchmark].market !== s.market) {
      issue(["benchmark"], `基准「${BENCHMARKS[s.benchmark].label}」和策略市场不一致。`);
    }
  });

export type StrategySpec = z.infer<typeof StrategySpecSchema>;
export type StrategySpecInput = z.input<typeof StrategySpecSchema>;

export interface SpecValidation {
  ok: boolean;
  spec?: StrategySpec;
  /** 给 LLM 与界面看的错误（路径 + 中文说明） */
  errors: string[];
}

export function validateSpec(input: unknown): SpecValidation {
  const r = StrategySpecSchema.safeParse(input);
  if (r.success) return { ok: true, spec: r.data, errors: [] };
  return {
    ok: false,
    errors: r.error.issues.map((i) => `${i.path.join(".") || "(根)"}：${i.message}`),
  };
}

export function benchmarkOf(spec: StrategySpec): BenchmarkKey {
  return spec.benchmark ?? DEFAULT_BENCHMARK[spec.market];
}

// ── 人话描述（卡片、LLM 上下文共用） ──

const OP_TEXT: Record<string, string> = { ">": ">", ">=": "≥", "<": "<", "<=": "≤" };

export function describeCondition(c: Condition): string {
  const f = FACTOR_MAP.get(c.factor);
  const label = f?.label ?? c.factor;
  const unit = f?.unit && f.unit !== "名" ? f.unit : "";
  switch (c.op) {
    case "between":
      return `${label} 在 ${c.value[0]}${unit}–${c.value[1]}${unit}`;
    case "is":
      return `是${label}`;
    case "not":
      return `不是${label}`;
    case "in":
      return `${label}属于 ${c.value.join("、")}`;
    case "not_in":
      return `${label}不属于 ${c.value.join("、")}`;
    default:
      return `${label} ${OP_TEXT[c.op]} ${c.value}${unit}`;
  }
}

const EVERY_TEXT = { week: "每周", month: "每月", quarter: "每季" } as const;
const EXCLUDE_TEXT = { st: "ST", new_listing: "次新股", loss: "亏损股" } as const;

export function describeSpec(s: StrategySpec): string[] {
  const lines: string[] = [];
  const u = s.universe;
  const scope = [
    s.market === "A" ? "A 股" : "港股",
    u.boards?.length ? `（${u.boards.join("、")}）` : "",
    u.exclude.length ? `，排除${u.exclude.map((e) => EXCLUDE_TEXT[e]).join("、")}` : "",
    u.minMcap ? `，市值 ≥ ${u.minMcap} 亿` : "",
    u.industries?.include?.length ? `，只看${u.industries.include.join("、")}` : "",
    u.industries?.exclude?.length ? `，不看${u.industries.exclude.join("、")}` : "",
  ].join("");
  lines.push(`股票池：${scope}`);
  if (s.mode === "signals") {
    lines.push(
      `信号：导入的信号集 ${s.signals?.datasetId}，最多同时持有 ${s.signals?.maxPositions} 只`,
    );
  } else {
    if (s.filters.length) lines.push(`条件：${s.filters.map(describeCondition).join("；")}`);
    if (s.rank) {
      const terms = s.rank.terms
        .map(
          (t) =>
            `${FACTOR_MAP.get(t.factor)?.label ?? t.factor}${t.better === "high" ? "越高越好" : "越低越好"}×${t.weight}`,
        )
        .join(" + ");
      lines.push(`排序：${terms}，取前 ${s.rank.top} 只`);
    }
    lines.push(
      `调仓：${EVERY_TEXT[s.rebalance.every]}第一个交易日开盘，${
        s.exits.dropWhenFiltered
          ? `掉出前 ${Math.ceil((s.rank?.top ?? 0) * s.rebalance.buffer)} 名就卖`
          : "调仓日不主动卖出"
      }`,
    );
  }
  const exits: string[] = [];
  if (s.exits.takeProfit) exits.push(`止盈 ${(s.exits.takeProfit * 100).toFixed(0)}%`);
  if (s.exits.stopLoss) exits.push(`止损 ${(s.exits.stopLoss * 100).toFixed(0)}%`);
  if (s.exits.maxHoldDays) exits.push(`最长持有 ${s.exits.maxHoldDays} 个交易日`);
  lines.push(
    `仓位：等权${s.sizing.maxWeight ? `，单只 ≤ ${(s.sizing.maxWeight * 100).toFixed(0)}%` : ""}${exits.length ? `；${exits.join("，")}` : ""}`,
  );
  lines.push(`基准：${BENCHMARKS[benchmarkOf(s)].label}`);
  return lines;
}

/** 规范化后的 JSON（键排序），用来算 spec_hash 与比较版本差异。 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

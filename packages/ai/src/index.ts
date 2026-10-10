/**
 * LLM 配置（D10）：实例统一 key，默认 OpenAI 兼容协议接 DeepSeek，可切 Anthropic。
 * server 的对话与 worker 的夜间简报共用。
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel } from "ai";

export interface LlmConfig {
  provider: "openai-compatible" | "anthropic";
  baseUrl: string;
  apiKey: string;
  model: string;
  briefModel: string;
}

export function llmConfigured(cfg: LlmConfig): boolean {
  return !!cfg.apiKey && !!cfg.model;
}

export function languageModel(cfg: LlmConfig, kind: "chat" | "brief" = "chat"): LanguageModel {
  const id = kind === "brief" ? cfg.briefModel || cfg.model : cfg.model;
  if (cfg.provider === "anthropic") {
    const p = createAnthropic({
      apiKey: cfg.apiKey,
      ...(cfg.baseUrl.includes("anthropic") ? {} : { baseURL: cfg.baseUrl }),
    });
    return p(id);
  }
  const p = createOpenAICompatible({ name: "llm", baseURL: cfg.baseUrl, apiKey: cfg.apiKey });
  return p.chatModel(id);
}

/** 市场当日状态（D78，与 worker 的 market-day.ts 同一组取值；这里重复定义，免得 ai 依赖 worker） */
export type BriefMarketDay = "traded" | "closed" | "stale" | "pending";

export interface BriefFacts {
  date: string;
  dataAsOf: Record<string, string | null>;
  /** 今天各市场的状态（只含用户跟踪涉及的市场）；旧简报没有这个字段 */
  marketDay?: Partial<Record<"A" | "HK", BriefMarketDay>>;
  /** 今天数据没更新（失败或还没跑完）的市场：简报要先说明，下面仍是旧结果；休市不算 */
  staleMarkets?: string[];
  trackings: Array<{
    trackingId?: string;
    name: string;
    market: string;
    days: number;
    /** 最近一个结算日；只有它是今天，dayReturn / dayBench 才有值 */
    lastDate: string | null;
    /** 今天的涨跌；今天没有新行情（休市或还没结算）时为 null */
    dayReturn: number | null;
    dayBench: number | null;
    excessTotal: number | null;
    deviationPct: number | null;
    buys: string[];
    sells: string[];
    /** 相对上一期简报新出现的提示（spec §8「新增检查项」） */
    warnings: string[];
    /** 当前全部提示，只用来和下一期比对，不给模型看 */
    activeWarnings?: string[];
  }>;
}

const pct = (x: number | null, d = 1) =>
  x === null ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`;

/** LLM 不可用时的确定性简报（也是给 LLM 的事实摘要） */
export function templateBrief(f: BriefFacts): string {
  if (!f.trackings.length) return "目前没有运行中的跟踪。";
  const head: string[] = [];
  // 只有用户涉及的市场全部休市才说休市；没更新、进行中的市场永远不说休市（D78）
  const markets = [...new Set(f.trackings.map((t) => t.market))];
  if (f.marketDay && markets.every((m) => f.marketDay?.[m as "A" | "HK"] === "closed")) {
    head.push("今天休市，没有新的行情");
  }
  for (const m of f.staleMarkets ?? []) {
    const label = m === "HK" ? "港股" : "A 股";
    const asOf = f.dataAsOf[m] ?? "上次";
    head.push(
      f.marketDay?.[m as "A" | "HK"] === "pending"
        ? `${label}今天的数据还没更新完，下面还是 ${asOf} 的结果`
        : `${label}今天的数据没更新成功，下面还是 ${asOf} 的结果`,
    );
  }
  // 没有今天涨跌时括号里怎么说：只有休市（或旧简报没有当日状态）才能把 lastDate 叫「最近交易日」；
  // 市场今天开了而这个跟踪没结算到今天（如数据入库后结算失败），说「今天还没结算」，不能把今天说成非交易日
  const stoppedAt = (t: BriefFacts["trackings"][number]) => {
    const day = f.marketDay?.[t.market as "A" | "HK"];
    if (day === "traded") return `今天还没结算，停在 ${t.lastDate}`;
    if (day === "stale" || day === "pending") return `数据停在 ${t.lastDate}`;
    return `最近交易日 ${t.lastDate}`;
  };
  const lines = f.trackings.map((t) => {
    const parts =
      t.dayReturn === null
        ? [
            t.lastDate
              ? `「${t.name}」跟踪 ${t.days} 天累计超额 ${pct(t.excessTotal)}（${stoppedAt(t)}）`
              : `「${t.name}」还没有结算过`,
          ]
        : [
            `「${t.name}」今天 ${pct(t.dayReturn, 2)}（基准 ${pct(t.dayBench, 2)}）`,
            `跟踪 ${t.days} 天累计超额 ${pct(t.excessTotal)}`,
          ];
    if (t.deviationPct !== null) parts.push(`跑赢回测同期 ${t.deviationPct.toFixed(0)}%`);
    if (t.buys.length || t.sells.length) {
      parts.push(`明日计划买 ${t.buys.length} 只、卖 ${t.sells.length} 只`);
    }
    if (t.warnings.length) parts.push(`注意：${t.warnings.join("、")}`);
    return parts.join("，");
  });
  return [...head, ...lines].join("。\n") + "。";
}

/**
 * 简报只说新出现的提示（spec §8「新增检查项」）：和上一期的「当前全部提示」比，
 * 不能和上一期「说过的」比——否则持续存在的提示会隔一天冒出来一次。
 */
export function newWarnings(
  prev: BriefFacts | undefined,
  trackingId: string,
  current: string[],
): { warnings: string[]; activeWarnings: string[] } {
  const p = prev?.trackings.find((x) => x.trackingId === trackingId);
  const told = new Set(p ? (p.activeWarnings ?? p.warnings) : []);
  return { warnings: current.filter((w) => !told.has(w)), activeWarnings: current };
}

function factsForModel(f: BriefFacts) {
  return {
    ...f,
    trackings: f.trackings.map(({ trackingId: _, activeWarnings: __, deviationPct, ...t }) => ({
      ...t,
      // 字段名直接写成意思，免得模型把「百分位」读成「偏离了多少」
      beatBacktestPct: deviationPct === null ? null : Math.round(deviationPct),
    })),
  };
}

/** 夜间简报（spec §8）：只基于 facts 写 ≤150 字的口语化摘要，数字不许编。 */
export async function writeBrief(
  cfg: LlmConfig,
  facts: BriefFacts,
): Promise<{
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  /** 用了模板时的原因（写进任务日志，免得悄悄退化） */
  fallbackReason?: string;
}> {
  const fallback = templateBrief(facts);
  const none = { inputTokens: 0, outputTokens: 0 };
  if (!facts.trackings.length) return { text: fallback, model: "template", usage: none };
  if (!llmConfigured(cfg)) {
    return { text: fallback, model: "template", usage: none, fallbackReason: "没有配置 LLM" };
  }
  try {
    const r = await generateText({
      model: languageModel(cfg, "brief"),
      system:
        "你是选股策略跟踪助手，给用户写收盘后的简报。要求：中文，口语化，像朋友发的消息，不要 AI 腔；" +
        "不超过 150 字；只能使用给定 JSON 里的数字，不许编造或推算新数字（包括自己做减法算差值）；不给买卖建议；" +
        "先说整体表现，再点出最值得注意的一两件事（和回测比、明日调仓、检查项）；" +
        "beatBacktestPct = 跟踪以来的超额收益在回测所有同样长度的时段里跑赢了百分之几，说成「跑赢回测同期 X%」，" +
        "50 左右算正常，越高说明比回测时还好，低于 10 要提醒可能在失效；" +
        "staleMarkets 里的市场今天数据没更新（失败或还没跑完），要先说明这一点，不要说成休市；" +
        "dayReturn 为 null 表示这个跟踪今天没有新行情（休市或还没结算），不要说今天涨跌；" +
        "marketDay 里是 closed 的市场今天休市。",
      prompt: `今天的事实（JSON）：\n${JSON.stringify(factsForModel(facts))}\n\n参考写法（可改写）：\n${fallback}`,
      // 推理模型的「思考」也算输出 token：额度给足、思考调低，否则正文可能是空的
      maxOutputTokens: 2000,
      ...(cfg.provider === "openai-compatible"
        ? { providerOptions: { llm: { reasoningEffort: "low" } } }
        : {}),
      timeout: 60_000,
    });
    const text = r.text.trim();
    const usage = {
      inputTokens: r.totalUsage.inputTokens ?? 0,
      outputTokens: r.totalUsage.outputTokens ?? 0,
    };
    return text
      ? { text, model: cfg.briefModel || cfg.model, usage }
      : {
          text: fallback,
          model: "template",
          usage,
          fallbackReason: `模型没有给出正文（${r.finishReason}）`,
        };
  } catch (e) {
    return {
      text: fallback,
      model: "template",
      usage: none,
      fallbackReason: e instanceof Error ? e.message : String(e),
    };
  }
}

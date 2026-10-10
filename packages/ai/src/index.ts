/**
 * LLM 配置（D10）：实例统一 key，默认 OpenAI 兼容协议接 DeepSeek，可切 Anthropic。
 * server 的对话与 worker 的夜间简报共用。
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  DECAYED_ADVICE,
  HEALTH_STATE_TEXT,
  type HealthState,
  type PerMetric,
  type Verdict,
  VERDICT_TEXT,
} from "@ivan/core";
import { generateText, type LanguageModel, type ModelMessage } from "ai";
import {
  checkGrounding,
  collectEvidence,
  type GroundingResult,
  unverifiedList,
} from "./grounding.ts";

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
  /** 第 2 版（D70）起有判词、上一期判词、健康度与计划快照 id；旧简报没有这个字段 */
  factsVersion?: 2;
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
    /** lastDate 是今天（第 2 版起） */
    tradedToday?: boolean;
    /** 判词（D70，确定性计算） */
    verdict?: Verdict;
    /** 上一期简报的判词（只存一层）；没有上一期判词为 null，按「没变」处理 */
    prevVerdict?: Verdict | null;
    /** 明日计划所在的快照（D68） */
    planSnapshotId?: string | null;
    health?: { state: HealthState; perMetric: PerMetric } | null;
  }>;
}

type BriefTracking = BriefFacts["trackings"][number];

/** 判词变了：上一期没有判词（第一期第 2 版简报、新上线的跟踪）按没变处理 */
export function verdictChanged(t: BriefTracking): boolean {
  return !!t.verdict && !!t.prevVerdict && t.verdict !== t.prevVerdict;
}

/** 判词变化的那一句：「『价值组合』状态：偏离（上次：正常）」；可能失效只建议复核，不说停止或卖出 */
export function verdictChangeLine(t: BriefTracking): string {
  const line = `「${t.name}」状态：${VERDICT_TEXT[t.verdict!]}（上次：${VERDICT_TEXT[t.prevVerdict!]}）`;
  return t.verdict === "DECAYED" ? `${line}，${DECAYED_ADVICE}` : line;
}

/**
 * 不用调 LLM 的日子：用户涉及的市场全部休市、判词都没变、没有新提示、也没有计划买卖。
 * 这时模板已经把要说的都说了，省下 token。
 */
export function quietDay(f: BriefFacts): boolean {
  if (!f.trackings.length || !f.marketDay) return false;
  const markets = [...new Set(f.trackings.map((t) => t.market))];
  if (!markets.every((m) => f.marketDay?.[m as "A" | "HK"] === "closed")) return false;
  return f.trackings.every(
    (t) => !verdictChanged(t) && !t.warnings.length && !t.buys.length && !t.sells.length,
  );
}

const pct = (x: number | null, d = 1) =>
  x === null ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`;

/** LLM 不可用时的确定性简报（也是给 LLM 的事实摘要） */
export function templateBrief(f: BriefFacts): string {
  if (!f.trackings.length) return "目前没有运行中的跟踪。";
  // 先说判词变化（D70）
  const head: string[] = f.trackings.filter(verdictChanged).map(verdictChangeLine);
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

/** 给模型看的事实（简报的数字核对也以它为证据） */
export function factsForModel(f: BriefFacts) {
  return {
    ...f,
    trackings: f.trackings.map(
      ({
        trackingId: _,
        activeWarnings: __,
        planSnapshotId: ___,
        deviationPct,
        verdict,
        prevVerdict,
        health,
        ...t
      }) => ({
        ...t,
        // 字段名直接写成意思，免得模型把「百分位」读成「偏离了多少」
        beatBacktestPct: deviationPct === null ? null : Math.round(deviationPct),
        // 判词给中文，原样说；上一期没有判词时不给，免得模型自己编出「变化」
        ...(verdict ? { verdict: VERDICT_TEXT[verdict] } : {}),
        ...(verdict && prevVerdict ? { prevVerdict: VERDICT_TEXT[prevVerdict] } : {}),
        ...(health
          ? {
              health: {
                state: HEALTH_STATE_TEXT[health.state],
                ...(health.perMetric.ddRatio
                  ? { ddRatio: Math.round(health.perMetric.ddRatio.value * 100) / 100 }
                  : {}),
              },
            }
          : {}),
      }),
    ),
  };
}

const BRIEF_SYSTEM =
  "你是选股策略跟踪助手，给用户写收盘后的简报。要求：中文，口语化，像朋友发的消息，不要 AI 腔；" +
  "不超过 150 字；只能使用给定 JSON 里的数字，不许编造或推算新数字（包括自己做减法算差值）；" +
  "百分比照抄 JSON 里的数（小数换成百分数，保留 1 位小数），不要自己换算、相减或改写舍入；不给买卖建议；" +
  "先说整体表现，再点出最值得注意的一两件事（和回测比、明日调仓、检查项）；" +
  "beatBacktestPct = 跟踪以来的超额收益在回测所有同样长度的时段里跑赢了百分之几，说成「跑赢回测同期 X%」，" +
  "50 左右算正常，越高说明比回测时还好；" +
  "判词（verdict）已经算好，原样说出状态和变化，不要自己评价好坏；verdict 和 prevVerdict 不同时先说这个变化；" +
  `「可能失效」只说${DECAYED_ADVICE}，不说停止或卖出；ddRatio 是跟踪最大回撤与回测最大回撤之比；` +
  "staleMarkets 里的市场今天数据没更新（失败或还没跑完），要先说明这一点，不要说成休市；" +
  "dayReturn 为 null 表示这个跟踪今天没有新行情（休市或还没结算），不要说今天涨跌；" +
  "marketDay 里是 closed 的市场今天休市。";

function modelName(cfg: LlmConfig, injected?: LanguageModel): string {
  const id = cfg.briefModel || cfg.model;
  if (id || !injected) return id;
  return typeof injected === "string" ? injected : injected.modelId;
}

/** 简报里存的核对结果：最后一次 LLM 正文的核对，加上一共写了几次 */
export type BriefGrounding = GroundingResult & { attempts: number };

/**
 * 夜间简报（spec §8）：只基于 facts 写 ≤150 字的口语化摘要。
 * 数字核对是闸门（D69）：正文里有 facts 里找不到的数就把清单告诉模型重写一次，还不行就用确定性模板。
 */
export async function writeBrief(
  cfg: LlmConfig,
  facts: BriefFacts,
  opts: { model?: LanguageModel } = {},
): Promise<{
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  /** 用了模板时的原因（写进任务日志，免得悄悄退化） */
  fallbackReason?: string;
  /** 调了 LLM 才有 */
  grounding?: BriefGrounding;
}> {
  const fallback = templateBrief(facts);
  const none = { inputTokens: 0, outputTokens: 0 };
  if (!facts.trackings.length) return { text: fallback, model: "template", usage: none };
  // 休市、没有变化：直接用模板，不算退化（D70）
  if (quietDay(facts)) return { text: fallback, model: "template", usage: none };
  if (!opts.model && !llmConfigured(cfg)) {
    return { text: fallback, model: "template", usage: none, fallbackReason: "没有配置 LLM" };
  }
  const shown = factsForModel(facts);
  const evidence = collectEvidence("facts", shown);
  const usage = { ...none };
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: `今天的事实（JSON）：\n${JSON.stringify(shown)}\n\n参考写法（可改写）：\n${fallback}`,
    },
  ];
  let last: BriefGrounding | undefined;
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = await generateText({
        model: opts.model ?? languageModel(cfg, "brief"),
        system: BRIEF_SYSTEM,
        messages,
        // 推理模型的「思考」也算输出 token：额度给足、思考调低，否则正文可能是空的
        maxOutputTokens: 2000,
        ...(cfg.provider === "openai-compatible"
          ? { providerOptions: { llm: { reasoningEffort: "low" } } }
          : {}),
        timeout: 60_000,
      });
      usage.inputTokens += r.totalUsage.inputTokens ?? 0;
      usage.outputTokens += r.totalUsage.outputTokens ?? 0;
      const text = r.text.trim();
      if (!text) {
        return {
          text: fallback,
          model: "template",
          usage,
          fallbackReason: `模型没有给出正文（${r.finishReason}）`,
          ...(last ? { grounding: last } : {}),
        };
      }
      last = { ...checkGrounding(text, evidence), attempts: attempt };
      if (!last.unverified.length) {
        return { text, model: modelName(cfg, opts.model), usage, grounding: last };
      }
      messages.push(
        { role: "assistant", content: text },
        {
          role: "user",
          content: `以下数字在事实里找不到：${unverifiedList(last)}。只能照抄 JSON 里的数（百分比保留 1 位小数），不要换算或相减。请重写。`,
        },
      );
    }
    return {
      text: fallback,
      model: "template",
      usage,
      fallbackReason: `数字核对没通过：${unverifiedList(last!)}`,
      grounding: last,
    };
  } catch (e) {
    return {
      text: fallback,
      model: "template",
      usage,
      fallbackReason: e instanceof Error ? e.message : String(e),
      ...(last ? { grounding: last } : {}),
    };
  }
}
export * from "./grounding.ts";
export * from "./model-views.ts";

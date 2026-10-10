import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  type BriefFacts,
  checkGrounding,
  collectEvidence,
  factsForModel,
  type LlmConfig,
  newWarnings,
  quietDay,
  templateBrief,
  writeBrief,
} from "./index.ts";

const facts: BriefFacts = {
  date: "2026-09-28",
  dataAsOf: { A: "2026-09-25", HK: "2026-09-28" },
  staleMarkets: ["A"],
  trackings: [
    {
      name: "低估值",
      market: "A",
      days: 12,
      lastDate: "2026-09-28",
      dayReturn: 0.0123,
      dayBench: 0.005,
      excessTotal: -0.021,
      deviationPct: 18,
      buys: ["甲"],
      sells: [],
      warnings: ["交易太少"],
    },
  ],
};

describe("夜间简报", () => {
  it("确定性模板：先说哪个市场今天没更新，再逐个跟踪说数字", () => {
    const t = templateBrief(facts);
    expect(t.startsWith("A 股今天的数据没更新成功，下面还是 2026-09-25 的结果")).toBe(true);
    expect(t).toContain("「低估值」今天 +1.23%（基准 +0.50%）");
    expect(t).toContain("跑赢回测同期 18%");
    expect(t).toContain("注意：交易太少");
  });

  it("休市（用户涉及的市场全部 closed）：第一句说休市，跟踪写最近交易日、不说今天涨跌", () => {
    const t = templateBrief({
      ...facts,
      date: "2026-10-05",
      marketDay: { A: "closed" },
      staleMarkets: [],
      trackings: [
        { ...facts.trackings[0]!, lastDate: "2026-09-30", dayReturn: null, dayBench: null },
      ],
    });
    expect(t.startsWith("今天休市，没有新的行情。")).toBe(true);
    expect(t).toContain("「低估值」跟踪 12 天累计超额 -2.1%（最近交易日 2026-09-30）");
    expect(t).not.toMatch(/今天 [+-]/);
  });

  it("只有部分市场休市、或市场没更新 / 进行中时，永远不说休市", () => {
    const hk = { ...facts.trackings[0]!, name: "港股红利", market: "HK" };
    const mixed = templateBrief({
      ...facts,
      marketDay: { A: "closed", HK: "traded" },
      staleMarkets: [],
      trackings: [{ ...facts.trackings[0]!, dayReturn: null, dayBench: null }, hk],
    });
    expect(mixed).not.toContain("休市");
    const stale = templateBrief({ ...facts, marketDay: { A: "stale" } });
    expect(stale).not.toContain("休市");
    expect(stale).toContain("A 股今天的数据没更新成功");
    const pending = templateBrief({ ...facts, marketDay: { A: "pending" } });
    expect(pending).not.toContain("休市");
    expect(pending).toContain("A 股今天的数据还没更新完");
  });

  it("市场今天开了、跟踪却没结算到今天：说今天还没结算，不说最近交易日", () => {
    const unsettled = {
      ...facts.trackings[0]!,
      lastDate: "2026-09-25",
      dayReturn: null,
      dayBench: null,
    };
    const traded = templateBrief({
      ...facts,
      marketDay: { A: "traded" },
      staleMarkets: [],
      trackings: [unsettled],
    });
    expect(traded).toContain("（今天还没结算，停在 2026-09-25）");
    expect(traded).not.toContain("最近交易日");
    expect(traded).not.toContain("休市");
    const stale = templateBrief({ ...facts, marketDay: { A: "stale" }, trackings: [unsettled] });
    expect(stale).toContain("（数据停在 2026-09-25）");
    expect(stale).not.toContain("最近交易日");
  });

  it("没配置 LLM 时用模板，用量为 0", async () => {
    const r = await writeBrief(
      { provider: "openai-compatible", baseUrl: "", apiKey: "", model: "", briefModel: "" },
      facts,
    );
    expect(r.model).toBe("template");
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("只说新出现的提示；持续存在的提示不会隔天重复冒出来", () => {
    const day = (prev: BriefFacts | undefined, current: string[]) => {
      const w = newWarnings(prev, "t1", current);
      return { ...facts, trackings: [{ ...facts.trackings[0]!, trackingId: "t1", ...w }] };
    };
    const d1 = day(undefined, ["港股有幸存者偏差"]);
    const d2 = day(d1, ["港股有幸存者偏差"]);
    const d3 = day(d2, ["港股有幸存者偏差", "偏离回测"]);
    const d4 = day(d3, ["港股有幸存者偏差", "偏离回测"]);
    expect(d1.trackings[0]!.warnings).toEqual(["港股有幸存者偏差"]);
    expect(d2.trackings[0]!.warnings).toEqual([]);
    expect(d3.trackings[0]!.warnings).toEqual(["偏离回测"]);
    expect(d4.trackings[0]!.warnings).toEqual([]);
  });

  describe("第 2 版：判词与休市（D70）", () => {
    const closed: BriefFacts = {
      ...facts,
      factsVersion: 2,
      date: "2026-10-05",
      marketDay: { A: "closed" },
      staleMarkets: [],
      trackings: [
        {
          ...facts.trackings[0]!,
          trackingId: "t1",
          lastDate: "2026-09-30",
          tradedToday: false,
          dayReturn: null,
          dayBench: null,
          buys: [],
          warnings: [],
          verdict: "ON_TRACK",
          prevVerdict: "ON_TRACK",
        },
      ],
    };

    it("全部休市：说休市，没有「今天 ±」", () => {
      const t = templateBrief(closed);
      expect(t).toContain("休市");
      expect(t).not.toMatch(/今天 [+-]/);
    });

    it("判词变了：开头一句带上次的判词", () => {
      const t = templateBrief({
        ...closed,
        trackings: [{ ...closed.trackings[0]!, verdict: "DRIFTING", prevVerdict: "ON_TRACK" }],
      });
      expect(t.startsWith("「低估值」状态：偏离（上次：正常）。")).toBe(true);
    });

    it("没有上一期判词（第一期第 2 版）：不出变化句", () => {
      const t = templateBrief({
        ...closed,
        trackings: [{ ...closed.trackings[0]!, verdict: "DRIFTING", prevVerdict: null }],
      });
      expect(t).not.toContain("状态：");
      expect(t).not.toContain("上次");
    });

    it("可能失效：建议复核，不说卖出或停止", () => {
      const t = templateBrief({
        ...closed,
        trackings: [{ ...closed.trackings[0]!, verdict: "DECAYED", prevVerdict: "DRIFTING" }],
      });
      expect(t).toContain("「低估值」状态：可能失效（上次：偏离），建议复核规则是否仍然有效");
      expect(t).not.toMatch(/卖出|停止/);
    });

    it("休市且没有变化：不调 LLM，直接用模板，不算退化", async () => {
      expect(quietDay(closed)).toBe(true);
      const model = new MockLanguageModelV4({ modelId: "mock-brief", doGenerate: [] });
      const r = await writeBrief(
        { provider: "anthropic", baseUrl: "", apiKey: "k", model: "m", briefModel: "" },
        closed,
        { model },
      );
      expect(model.doGenerateCalls).toHaveLength(0);
      expect(r).toMatchObject({ model: "template", text: templateBrief(closed) });
      expect(r.fallbackReason).toBeUndefined();
      // 判词变了、有新提示、有计划、或有市场开了：都要调 LLM
      const t0 = closed.trackings[0]!;
      expect(quietDay({ ...closed, trackings: [{ ...t0, prevVerdict: "DRIFTING" }] })).toBe(false);
      expect(quietDay({ ...closed, trackings: [{ ...t0, warnings: ["交易太少"] }] })).toBe(false);
      expect(quietDay({ ...closed, trackings: [{ ...t0, sells: ["甲"] }] })).toBe(false);
      expect(quietDay({ ...closed, marketDay: { A: "traded" } })).toBe(false);
    });

    it("给模型的事实：判词是中文，没有上一期判词时不给；内部 id 不给", () => {
      const shown = factsForModel({
        ...closed,
        trackings: [
          {
            ...closed.trackings[0]!,
            verdict: "DECAYED",
            prevVerdict: null,
            planSnapshotId: "ps_1",
            health: {
              state: "decayed",
              perMetric: { ddRatio: { value: 1.6789, signal: "decayed" } },
            },
          },
        ],
      });
      const t = shown.trackings[0]!;
      expect(t).toMatchObject({
        verdict: "可能失效",
        health: { state: "可能失效", ddRatio: 1.68 },
      });
      expect(t).not.toHaveProperty("prevVerdict");
      expect(t).not.toHaveProperty("planSnapshotId");
    });
  });

  describe("数字核对闸门（D69）", () => {
    const cfg: LlmConfig = {
      provider: "anthropic",
      baseUrl: "",
      apiKey: "",
      model: "",
      briefModel: "",
    };
    const usage = {
      inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 20, text: 20, reasoning: 0 },
    };
    const reply = (text: string) => ({
      content: [{ type: "text" as const, text }],
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage,
      warnings: [],
    });
    const mock = (...texts: string[]) =>
      new MockLanguageModelV4({ modelId: "mock-brief", doGenerate: texts.map(reply) });
    const good =
      "「低估值」今天涨了 1.2%，基准 +0.5%；跟踪 12 天累计超额 -2.1%，跑赢回测同期 18%，明天买 1 只。";

    it("模板本身的数字都能在 facts 里找到", () => {
      const g = checkGrounding(
        templateBrief(facts),
        collectEvidence("facts", factsForModel(facts)),
      );
      expect(g.checked).toBeGreaterThan(3);
      expect(g.unverified).toEqual([]);
    });

    it("两次都有编造的数字：用模板，原因写明数字核对没通过", async () => {
      const model = mock("「低估值」今天大涨 5.6%，超额 +12.4%。", "「低估值」今天涨 5.6%。");
      const r = await writeBrief(cfg, facts, { model });
      expect(r.model).toBe("template");
      expect(r.text).toBe(templateBrief(facts));
      expect(r.fallbackReason).toContain("数字核对");
      expect(r.fallbackReason).toContain("5.6%");
      expect(r.grounding).toMatchObject({ attempts: 2 });
      expect(r.grounding!.unverified.length).toBeGreaterThan(0);
      expect(r.usage).toEqual({ inputTokens: 200, outputTokens: 40 });
      expect(model.doGenerateCalls).toHaveLength(2);
      // 重写提示里带着对不上的数
      const retry = JSON.stringify(model.doGenerateCalls[1]!.prompt);
      expect(retry).toContain("以下数字在事实里找不到");
      expect(retry).toContain("+12.4%");
    });

    it("第一次编造、重写后对上：用重写的正文", async () => {
      const model = mock("「低估值」今天大涨 5.6%。", good);
      const r = await writeBrief(cfg, facts, { model });
      expect(r.text).toBe(good);
      expect(r.model).toBe("mock-brief");
      expect(r.fallbackReason).toBeUndefined();
      expect(r.grounding).toMatchObject({ attempts: 2, unverified: [] });
    });

    it("第一次就对：只调一次，核对数大于 0", async () => {
      const model = mock(good);
      const r = await writeBrief(cfg, facts, { model });
      expect(r.text).toBe(good);
      expect(model.doGenerateCalls).toHaveLength(1);
      expect(r.grounding!.checked).toBeGreaterThan(0);
      expect(r.grounding!.unverified).toEqual([]);
      expect(r.grounding!.attempts).toBe(1);
    });
  });
});

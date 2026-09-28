import { describe, expect, it } from "vitest";
import { type BriefFacts, newWarnings, templateBrief, writeBrief } from "./index.ts";

const facts: BriefFacts = {
  date: "2026-09-28",
  dataAsOf: { A: "2026-09-25", HK: "2026-09-28" },
  staleMarkets: ["A"],
  trackings: [
    {
      name: "低估值",
      market: "A",
      days: 12,
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
});

import { describe, expect, it } from "vitest";
import { PRESETS } from "./presets.ts";
import { describeSpec, validateSpec } from "./strategy.ts";

describe("预设模板", () => {
  it.each(PRESETS.map((p) => [p.id, p] as const))("%s 能通过校验并生成描述", (_id, p) => {
    const v = validateSpec(p.spec);
    expect(v.errors).toEqual([]);
    expect(describeSpec(v.spec!).length).toBeGreaterThan(3);
  });
});

describe("策略校验给出可读的中文错误", () => {
  it("未知因子、市场不可用的因子、错误的比较符", () => {
    const v = validateSpec({
      name: "x",
      market: "HK",
      filters: [
        { factor: "no_such", op: ">", value: 1 },
        { factor: "flag_st", op: "is" },
        { factor: "industry", op: ">", value: 1 },
      ],
      rank: { terms: [{ factor: "industry", weight: 1, better: "high" }], top: 5 },
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toMatch(/没有因子「no_such」/);
    expect(v.errors.join("\n")).toMatch(/在港股不可用/);
    expect(v.errors.join("\n")).toMatch(/只能用 in \/ not_in/);
    expect(v.errors.join("\n")).toMatch(/排序只能用数值因子/);
  });
});

describe("仓位控制与大盘切换（D52、D53）", () => {
  const base = {
    name: "x",
    market: "A",
    rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 10 },
  };

  it("仓位控制：默认回看 60 天，描述里写明目标波动", () => {
    const v = validateSpec({ ...base, exposure: { volTarget: 0.18 } });
    expect(v.errors).toEqual([]);
    expect(v.spec!.exposure).toEqual({ volTarget: 0.18, lookback: 60 });
    expect(describeSpec(v.spec!).join("\n")).toMatch(
      /按波动控制仓位（目标年化波动 18%，每周评估）/,
    );
  });

  it("大盘切换：弱势排序也要是数值因子；描述分两行写强势 / 弱势排序", () => {
    const bad = validateSpec({
      ...base,
      rank: {
        ...base.rank,
        regime: { weak: { terms: [{ factor: "industry", weight: 1, better: "high" }] } },
      },
    });
    expect(bad.errors.join("\n")).toMatch(/排序只能用数值因子/);
    const v = validateSpec({
      ...base,
      rank: {
        ...base.rank,
        regime: { weak: { terms: [{ factor: "pb", weight: 2, better: "low", neutral: true }] } },
      },
    });
    expect(v.errors).toEqual([]);
    expect(v.spec!.rank!.regime!.ma).toBe(200);
    const text = describeSpec(v.spec!).join("\n");
    expect(text).toMatch(/排序（沪深300在 200 日均线上方）：市盈率 TTM越低越好×1/);
    expect(text).toMatch(/排序（沪深300在 200 日均线下方）：市净率（行业内比）越低越好×2/);
  });
});

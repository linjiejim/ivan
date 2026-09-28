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

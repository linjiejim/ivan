import { describe, expect, it } from "vitest";
import { calculate, evaluate } from "./calc.ts";

describe("对话计算器（D105）", () => {
  it("四则、乘方、括号、优先级与右结合", () => {
    expect(evaluate("1 + 2 * 3")).toBe(7);
    expect(evaluate("(1 + 2) * 3")).toBe(9);
    expect(evaluate("2 ^ 3 ^ 2")).toBe(512);
    expect(evaluate("-2 ^ 2")).toBe(-4);
    expect(evaluate("2 ^ -1")).toBe(0.5);
    expect(evaluate("10 / 4 - -1")).toBe(3.5);
    expect(evaluate("1e6 * 1.5")).toBe(1.5e6);
  });

  it("全角符号、百分号与万 / 亿后缀", () => {
    expect(evaluate("100万 × （1 ＋ 25%）")).toBe(1.25e6);
    expect(evaluate("3.5万亿 ÷ 1亿")).toBe(35000);
    expect(evaluate("12.5%")).toBe(0.125);
  });

  it("白名单函数与金融小工具", () => {
    expect(evaluate("sqrt(16) + abs(-1)")).toBe(5);
    expect(evaluate("round(3.14159, 2)")).toBe(3.14);
    expect(evaluate("max(1, 5, 3)")).toBe(5);
    expect(evaluate("cagr(100, 121, 2)")).toBeCloseTo(0.1, 12);
    expect(evaluate("change(80, 100)")).toBeCloseTo(0.25, 12);
    expect(evaluate("annualize(0.21, 730)")).toBeCloseTo(0.1, 2);
  });

  it("不合法的写法给中文原因，不执行任何代码", () => {
    expect(() => evaluate("1 / 0")).toThrow(/除数是 0/);
    expect(() => evaluate("process.exit(1)")).toThrow(/不认识的函数|看不懂/);
    expect(() => evaluate("constructor(1)")).toThrow(/不认识的函数/);
    expect(() => evaluate("1 +")).toThrow(/不完整/);
    expect(() => evaluate("(1 + 2")).toThrow(/缺少「\)」/);
    expect(() => evaluate("1 2")).toThrow(/多余/);
    expect(() => evaluate("sqrt(-1)")).toThrow(/有限/);
    expect(() => evaluate("pow(2)")).toThrow(/2 个参数/);
    expect(() => evaluate("(".repeat(60) + "1" + ")".repeat(60))).toThrow(/太深/);
    expect(() => evaluate("1+".repeat(200) + "1")).toThrow(/太长/);
  });

  it("unit 为 % 时把比例显示成百分数；去掉浮点尾巴；单条出错不影响别的", () => {
    const r = calculate([
      { label: "涨幅", expr: "12.3 / 10 - 1", unit: "%" },
      { label: "和", expr: "0.1 + 0.2" },
      { label: "坏", expr: "1 / 0", unit: "元" },
    ]);
    expect(r[0]).toMatchObject({ value: 23, unit: "%" });
    expect(r[1]).toMatchObject({ value: 0.3, unit: "" });
    expect(r[2]).toMatchObject({ value: null, error: "除数是 0" });
  });
});

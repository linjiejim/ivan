import { describe, expect, it } from "vitest";
import {
  defaultExec,
  describeExec,
  ExecConfigError,
  isLegacyExec,
  isLegacyFill,
  LEGACY_EXEC,
  parseExecOverrides,
  resolveExec,
} from "./exec.ts";

describe("成交假设（D55）", () => {
  it("缺省字段按旧口径补齐", () => {
    expect(resolveExec(undefined)).toEqual(LEGACY_EXEC);
    expect(resolveExec(null)).toEqual(LEGACY_EXEC);
    expect(resolveExec({})).toEqual(LEGACY_EXEC);
    expect(resolveExec({ v: 1 })).toEqual(LEGACY_EXEC);
    expect(LEGACY_EXEC).toEqual({
      v: 1,
      rules: 1,
      metrics: 1,
      slippageBps: 0,
      tickSpread: false,
      impact: "none",
      impactEta: 0,
      participation: null,
    });
  });

  it("新回测默认：规则表与指标第 2 版（S04），按流动性成交（S05），不再等同旧口径", () => {
    const liq = { tickSpread: true, impact: "sqrt", impactEta: 0.5, participation: 0.1 };
    expect(defaultExec("A")).toEqual({ v: 1, rules: 2, metrics: 2, slippageBps: 5, ...liq });
    expect(defaultExec("HK")).toEqual({ v: 1, rules: 2, metrics: 2, slippageBps: 10, ...liq });
    expect(isLegacyExec(defaultExec("A"))).toBe(false);
    expect(isLegacyFill(defaultExec("A"))).toBe(false);
    expect(isLegacyFill(LEGACY_EXEC)).toBe(true);
    expect(isLegacyFill(resolveExec({ rules: 2, metrics: 2 }))).toBe(true);
    expect(isLegacyFill(resolveExec({ participation: 0.1 }))).toBe(false);
    expect(resolveExec({ v: 1, rules: 2 })).toEqual({ ...LEGACY_EXEC, rules: 2 });
    expect(() => resolveExec({ rules: 3 })).toThrow(ExecConfigError);
  });

  it("存下的值读不懂时报错，不悄悄当旧口径", () => {
    expect(() => resolveExec({ v: 9 })).toThrow(ExecConfigError);
    expect(() => resolveExec({ v: 1, slippage: 5 })).toThrow(/读不懂/);
  });

  it("isLegacyExec", () => {
    expect(isLegacyExec(undefined)).toBe(true);
    expect(isLegacyExec({})).toBe(true);
    expect(isLegacyExec(LEGACY_EXEC)).toBe(true);
    expect(isLegacyExec({ v: 1, rules: 1, metrics: 1 })).toBe(true);
    expect(isLegacyExec({ rules: 2 })).toBe(false);
    expect(isLegacyExec({ v: 2 })).toBe(false);
    expect(isLegacyExec({ foo: 1 })).toBe(false);
  });

  it("用户覆盖项严格校验：不认识的键与越界都给中文说明", () => {
    expect(parseExecOverrides("A")).toEqual(defaultExec("A"));
    expect(parseExecOverrides("HK", {})).toEqual(defaultExec("HK"));
    expect(parseExecOverrides("A", { v: 1 })).toEqual(defaultExec("A"));
    expect(parseExecOverrides("A", { metrics: 1 })).toEqual({ ...defaultExec("A"), metrics: 1 });
    expect(parseExecOverrides("A", { participation: null, impact: "none" })).toMatchObject({
      participation: null,
      impact: "none",
      slippageBps: 5,
    });
    expect(() => parseExecOverrides("A", { slippageBps: 500 })).toThrow(
      "单边滑点要在 0–200 bp 之间",
    );
    expect(() => parseExecOverrides("A", { slippageBps: -1 })).toThrow(
      "单边滑点要在 0–200 bp 之间",
    );
    expect(() => parseExecOverrides("A", { participation: 0.001 })).toThrow(
      "单笔上限要在日均成交额的 1%–100% 之间",
    );
    expect(() => parseExecOverrides("A", { participation: 2 })).toThrow(
      "单笔上限要在日均成交额的 1%–100% 之间",
    );
    expect(() => parseExecOverrides("A", { impactEta: 3 })).toThrow("冲击系数要在 0–2 之间");
    expect(() => parseExecOverrides("A", { impact: "linear" })).toThrow(/冲击成本/);
    expect(() => parseExecOverrides("A", { rules: 3 })).toThrow("规则表版本只能是 1 或 2");
    expect(() => parseExecOverrides("A", { metrics: 0 })).toThrow("指标版本只能是 1 或 2");
    expect(() => parseExecOverrides("A", { foo: 1 })).toThrow("成交假设里有不认识的设置：foo");
    expect(() => parseExecOverrides("A", { v: 2 })).toThrow("成交假设的版本只能是 1");
    expect(() => parseExecOverrides("A", [1])).toThrow(/对象/);
  });

  it("中文摘要", () => {
    expect(describeExec(LEGACY_EXEC)).toBe("开盘价成交，不计滑点（旧口径）");
    expect(describeExec(defaultExec("A"))).toBe(
      "开盘价成交，单边滑点 5bp + 半个最小价位，冲击成本（平方根，系数 0.5），单笔不超过日均成交额 10%；规则表第 2 版，指标第 2 版",
    );
    expect(
      describeExec({
        ...defaultExec("HK"),
        tickSpread: false,
        impact: "none",
        participation: 0.05,
      }),
    ).toBe("开盘价成交，单边滑点 10bp，单笔不超过日均成交额 5%；规则表第 2 版，指标第 2 版");
    expect(describeExec(resolveExec({ rules: 2 }))).toBe(
      "开盘价成交，不计滑点；规则表第 2 版，指标第 1 版",
    );
  });
});

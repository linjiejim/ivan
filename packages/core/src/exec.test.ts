import { describe, expect, it } from "vitest";
import {
  defaultExec,
  describeExec,
  ExecConfigError,
  isLegacyExec,
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
  });

  it("存下的值读不懂时报错，不悄悄当旧口径", () => {
    expect(() => resolveExec({ v: 9 })).toThrow(ExecConfigError);
    expect(() => resolveExec({ v: 1, slippage: 5 })).toThrow(/读不懂/);
  });

  it("isLegacyExec", () => {
    expect(isLegacyExec(undefined)).toBe(true);
    expect(isLegacyExec({})).toBe(true);
    expect(isLegacyExec(LEGACY_EXEC)).toBe(true);
    expect(isLegacyExec({ v: 2 })).toBe(false);
    expect(isLegacyExec({ foo: 1 })).toBe(false);
  });

  it("用户覆盖项严格校验：不认识的键与越界都给中文说明", () => {
    expect(parseExecOverrides("A")).toEqual(defaultExec("A"));
    expect(parseExecOverrides("HK", {})).toEqual(defaultExec("HK"));
    expect(parseExecOverrides("A", { v: 1 })).toEqual({ v: 1 });
    expect(() => parseExecOverrides("A", { foo: 1 })).toThrow("成交假设里有不认识的设置：foo");
    expect(() => parseExecOverrides("A", { v: 2 })).toThrow("成交假设的版本只能是 1");
    expect(() => parseExecOverrides("A", [1])).toThrow(/对象/);
  });

  it("中文摘要", () => {
    expect(describeExec(LEGACY_EXEC)).toBe("开盘价成交，不计滑点（旧口径）");
  });
});

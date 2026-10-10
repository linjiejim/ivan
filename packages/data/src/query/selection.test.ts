/**
 * 选股 SQL 文本不变（S15b，D83）：注册表第 3 版只在表尾加事件因子列，不用它们的策略（全部预设模板）
 * 生成的 SQL 逐字节不变——选股结果与输入指纹因此不变，旧回测「输入一致」、重跑逐笔一致。
 * 指纹在 S15b 改动之前记下，之后不许重录。
 */
import { isEventFactor, PRESETS, factorsUsedBySpec, validateSpec } from "@ivan/core";
import { sha256Hex } from "@ivan/core/node";
import { describe, expect, it } from "vitest";
import { compileSelection, conditionSql, specForRegime } from "./selection.ts";

const PINNED: Record<string, string> = {
  "a-quality-value": "3ce142558e7a302d",
  "a-quality-value-regime": "4487898e1c8aac20",
  "a-dividend-value": "b622d3368fbacbf9",
  "a-garp-value": "2bf6937c0b61edac",
  "a-value-leaders": "35fb7f0edd7def56",
  "a-dividend": "e7a872981397b99a",
  "a-garp": "8dee21cd0912aea4",
  "a-momentum": "4c24d9080a39b4bb",
  "hk-dividend": "464cb1840c862138",
  "hk-value-leaders": "c167436fa16d7486",
  "hk-garp": "012819b82e5c10ef",
  "hk-momentum": "cad8499ad7f5458c",
};

describe("compileSelection 的文本（预设模板）", () => {
  it.each(PRESETS.map((p) => [p.id, p] as const))("%s 的选股 SQL 与 S15b 之前逐字节一致", (id, p) => {
    const spec = validateSpec(p.spec).spec!;
    expect(factorsUsedBySpec(spec).some(isEventFactor)).toBe(false);
    const sql = compileSelection(spec, ["2024-05-06", "2024-05-07"], 30);
    expect(sha256Hex(sql).slice(0, 16)).toBe(PINNED[id]);
    expect(sql).not.toMatch(/margin_|holder_num|unlock_|block_premium/);
    if (spec.rank?.regime) {
      expect(compileSelection(specForRegime(spec, true), ["2024-05-06"], 30)).not.toMatch(/margin_|unlock_/);
    }
  });
});

describe("是非条件：事件因子为空 = 不知道（D84）", () => {
  it("两融标的「是」「不是」都不让空值通过；flag_* 仍把空当「否」", () => {
    expect(conditionSql({ factor: "margin_eligible", op: "is" })).toBe("margin_eligible = true");
    expect(conditionSql({ factor: "margin_eligible", op: "not" })).toBe("margin_eligible = false");
    expect(conditionSql({ factor: "flag_st", op: "not" })).toBe("coalesce(flag_st, false) = false");
    expect(conditionSql({ factor: "flag_st", op: "is" })).toBe("coalesce(flag_st, false) = true");
  });
});

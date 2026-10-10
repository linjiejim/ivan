import { afterEach, describe, expect, it } from "vitest";
import { applyPatch, isSafePatchPath } from "./jsonpatch.ts";

afterEach(() => {
  delete (Object.prototype as Record<string, unknown>).polluted;
});

describe("applyPatch", () => {
  it("add / replace / remove 照常", () => {
    const doc = { a: 1, b: { c: [1, 2] } };
    expect(applyPatch(doc, [{ op: "replace", path: "/a", value: 2 }])).toEqual({
      a: 2,
      b: { c: [1, 2] },
    });
    expect(applyPatch(doc, [{ op: "add", path: "/b/c/-", value: 3 }]).b.c).toEqual([1, 2, 3]);
    expect(applyPatch(doc, [{ op: "add", path: "/x/y", value: 1 }])).toMatchObject({ x: { y: 1 } });
    expect(doc).toEqual({ a: 1, b: { c: [1, 2] } });
  });

  it("原型链上的键一律拒绝，不污染 Object.prototype", () => {
    for (const path of [
      "/__proto__/polluted",
      "/constructor/prototype/polluted",
      "/a/__proto__",
      "/prototype",
    ]) {
      expect(() => applyPatch({ a: {} }, [{ op: "add", path, value: "yes" }])).toThrow(/不能有/);
      expect(isSafePatchPath(path)).toBe(false);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(isSafePatchPath("/exits/stopLoss")).toBe(true);
  });

  it("只沿自己的属性往下走：继承来的属性（toString）当作不存在", () => {
    const r = applyPatch({} as Record<string, unknown>, [
      { op: "add", path: "/toString/x", value: 1 },
    ]);
    expect(Object.hasOwn(r, "toString")).toBe(true);
    expect(r.toString).toEqual({ x: 1 });
    expect(typeof ({} as { toString: unknown }).toString).toBe("function");
  });
});

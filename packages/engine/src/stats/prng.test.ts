import { describe, expect, it } from "vitest";
import { mulberry32 } from "./prng.ts";

describe("mulberry32", () => {
  it("种子 42 的前 5 个数（金标准，Python 独立实现核对过）", () => {
    const r = mulberry32(42);
    expect([r(), r(), r(), r(), r()]).toEqual([
      0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693,
      0.17481389874592423,
    ]);
  });

  it("同一种子同一串数；落在 [0, 1)", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

import { describe, expect, it } from "vitest";
import { psr } from "./psr.ts";

describe("PSR", () => {
  it("psr(0.1, 252, 0, 3) ≈ 0.943", () => {
    expect(Math.abs(psr(0.1, 252, 0, 3)! - 0.943)).toBeLessThan(1e-3);
  });

  it("观测少于 30 个为 null；方差项不为正为 null", () => {
    expect(psr(0.1, 29, 0, 3)).toBeNull();
    expect(psr(0.1, 30, 0, 3)).not.toBeNull();
    // 1 − 20 × 0.1 + … < 0
    expect(psr(0.1, 252, 20, 3)).toBeNull();
  });

  it("夏普为 0 时把握是一半；负偏度、厚尾让把握变低", () => {
    expect(psr(0, 252, 0, 3)).toBeCloseTo(0.5, 12);
    expect(psr(0.1, 252, -1, 8)!).toBeLessThan(psr(0.1, 252, 0, 3)!);
  });
});

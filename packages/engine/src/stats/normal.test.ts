import { describe, expect, it } from "vitest";
import { erfc, normCdf, normInv } from "./normal.ts";

describe("标准正态", () => {
  it("Φ(1.959964) = 0.975，Φ⁻¹(0.975) = 1.959964", () => {
    expect(Math.abs(normCdf(1.959964) - 0.975)).toBeLessThan(1e-7);
    expect(Math.abs(normInv(0.975) - 1.959964)).toBeLessThan(1e-6);
  });

  it("对称：Φ(−x) = 1 − Φ(x)，Φ⁻¹(1 − p) = −Φ⁻¹(p)", () => {
    for (const x of [0, 0.3, 0.46875, 1, 2.5, 4, 6]) {
      expect(normCdf(-x) + normCdf(x)).toBeCloseTo(1, 14);
    }
    for (const p of [1e-9, 0.01, 0.02425, 0.2, 0.5]) {
      expect(normInv(1 - p) + normInv(p)).toBeCloseTo(0, 8);
    }
    expect(normCdf(0)).toBe(0.5);
  });

  it("erfc 与参考值相差 < 1e-9（三段逼近的分界两侧都测）", () => {
    // 参考值：Python math.erfc
    const ref: Array<[number, number]> = [
      [0.1, 0.8875370839817152],
      [0.46875, 0.5073865267820621],
      [0.47, 0.5062549491139179],
      [1, 0.15729920705028516],
      [3, 2.2090496998585438e-5],
      [4, 1.541725790028002e-8],
      [5, 1.537459794428035e-12],
    ];
    for (const [x, v] of ref) expect(Math.abs(erfc(x) - v) / v).toBeLessThan(1e-9);
  });

  it("Φ⁻¹ 与 Φ 互逆；p 不在 (0, 1) 内报错", () => {
    for (const p of [1e-12, 0.001, 0.03, 0.3, 0.7, 0.99, 1 - 1e-9]) {
      expect(normCdf(normInv(p))).toBeCloseTo(p, 12);
    }
    expect(() => normInv(0)).toThrow(RangeError);
    expect(() => normInv(1)).toThrow(RangeError);
    expect(() => normInv(Number.NaN)).toThrow(RangeError);
  });
});

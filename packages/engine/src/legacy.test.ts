/**
 * 引擎 1.1.0 金标准（D56，验收 1）：10 个夹具的 legacyView 指纹必须与 1.1.0 录下的一致。
 * 之后的切片改引擎时，旧口径（exec 缺省 / LEGACY_EXEC）都要让这里保持通过。
 */
import { readFileSync } from "node:fs";
import { addDays, LEGACY_EXEC, type SimInput } from "@ivan/core";
import { sha256Canonical } from "@ivan/core/node";
import { describe, expect, it } from "vitest";
import { ENGINE_VERSION, simulate } from "./simulate.ts";
import { hkFixture, LEGACY_FIXTURES, signalsFixture } from "./testing/fixtures.ts";
import { legacyView } from "./testing/legacy-view.ts";

const golden = JSON.parse(
  readFileSync(new URL("./__fixtures__/legacy-1.1.0.json", import.meta.url), "utf8"),
) as Record<string, string>;

describe("引擎 1.1.0 金标准", () => {
  it("金标准覆盖 10 个夹具", () => {
    expect(Object.keys(golden).sort()).toEqual(Object.keys(LEGACY_FIXTURES).sort());
    expect(Object.keys(golden)).toHaveLength(10);
  });

  it("引擎版本是 1.2.0（本轮只升一次，D56）", () => {
    expect(ENGINE_VERSION).toBe("1.2.0");
  });

  // 旧口径两种写法：exec 缺省（以前存下的运行与跟踪），和显式 LEGACY_EXEC（S02 起存下的旧口径运行）
  const withExec = (input: SimInput): SimInput => ({
    ...input,
    params: { ...input.params, exec: LEGACY_EXEC },
  });
  for (const [name, build] of Object.entries(LEGACY_FIXTURES)) {
    it(`${name} 的结果指纹不变（exec 缺省）`, () => {
      expect(sha256Canonical(legacyView(simulate(build())))).toBe(golden[name]);
    });
    it(`${name} 的结果指纹不变（exec = LEGACY_EXEC），并回显成交假设`, () => {
      const r = simulate(withExec(build()));
      expect(sha256Canonical(legacyView(r))).toBe(golden[name]);
      expect(r.exec).toEqual(LEGACY_EXEC);
    });
  }
});

// 夹具的用意写在这里：之后谁改了夹具、让它不再走到要盯的分支，这里先报，而不是金标准悄悄失去覆盖
describe("金标准夹具确实走到要盯的分支", () => {
  it("信号：满仓、停牌、重复持有三条跳过分支都走到", () => {
    const input = signalsFixture();
    const at = (i: number) => input.calendar[i]!;
    const r = simulate(input);
    const buys = (i: number) =>
      r.trades.filter((t) => t.side === "buy" && t.date === at(i)).map((t) => t.code);
    const held = (i: number) => r.series.find((p) => p.date === at(i))!.positions;
    // 第 5 天满仓（2 只），信丁买不进
    expect(held(4)).toBe(2);
    expect(buys(5)).toEqual([]);
    // 第 11 天前两只都卖了，有空位：信丙停牌跳过，信丁照常买
    expect(held(10)).toBe(0);
    expect(buys(11)).toEqual(["600004.SH"]);
    // 第 13 天还有一个空位：信丁已持有不加仓，信甲照常买
    expect(held(12)).toBe(1);
    expect(buys(13)).toEqual(["600001.SH"]);
    expect(r.trades.filter((t) => t.side === "sell").map((t) => t.reason)).toEqual(
      expect.arrayContaining(["max_hold", "take_profit"]),
    );
  });

  it("港股：每个费率日前后都有成交", () => {
    const r = simulate(hkFixture());
    for (const d of ["2021-08-01", "2022-01-01", "2023-01-01", "2023-11-17"]) {
      expect(r.trades.some((t) => t.date < d && t.date > addDays(d, -30))).toBe(true);
      expect(r.trades.some((t) => t.date > d && t.date < addDays(d, 30))).toBe(true);
    }
  });
});

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

/**
 * 收尾时有待执行订单（final.pending）的旧口径运行：10 个金标准夹具都以空的 pending 收尾，这里把其中几个截到区间中途，
 * 让 pending 的构造分支（止损、止盈、调出、调仓、持有到期卖出，建仓、信号买入）也被钉住。
 * 指纹是在未改动的 1.1.0 引擎（916a43c）上算的 legacyView 指纹（另录在这里，legacy-1.1.0.json 不重录）；
 * 1.2.0 在旧口径下给 pending 多写预估价、股数这些字段，legacyView 投影掉之后必须逐字节一致——
 * 完整重跑比早于运行卡的旧运行时，worker 用的就是这个投影（storedResultHashes）。
 */
const PENDING_END_1_1_0: Array<[name: string, end: string, hash: string]> = [
  ["base", "2025-06-05", "0ad29398ab7b22869631e88a4ed8bfeaccebfa5bf39a3b555c551a3d70ae6396"],
  ["monthly", "2025-06-30", "b2e0507601f355384cdb0166cca59cc9bf7c60aa09a451cc9e2ebdf2786e1ec0"],
  ["hk", "2021-12-31", "d23b6693c0b1e4084828fa44311a382230cc612da8e888a19712f3b197d9010c"],
  ["signals", "2024-03-14", "7c06cb9711efa5ed2f61a5c0c7ca682019147c49044e30b3df9d13fc9bad0e7b"],
  ["signals", "2024-03-18", "6eb17937441587f0a3e7cd55081e0f3f929dffe42613db04530237bf872698d3"],
  ["signals", "2024-04-09", "d04fb3fd971bfea4552f5f3c60e68e80bbc09095b5cff2234d03e62fe8324a35"],
];

describe("引擎 1.1.0 金标准：收尾有待执行订单", () => {
  for (const [name, end, hash] of PENDING_END_1_1_0) {
    it(`${name} 截到 ${end}：pending 非空，legacyView 指纹与 1.1.0 一致（exec 缺省与 LEGACY_EXEC）`, () => {
      const build = (): SimInput => {
        const x = LEGACY_FIXTURES[name]!();
        return { ...x, params: { ...x.params, end } };
      };
      const r = simulate(build());
      expect(r.final.pending.length).toBeGreaterThan(0);
      // 新引擎旧口径下也给 pending 写了预估字段：1.1.0 存的结果里没有它们
      expect(r.final.pending.some((p) => "estPrice" in p)).toBe(true);
      expect(sha256Canonical(legacyView(r))).toBe(hash);
      const withLegacy = simulate({
        ...build(),
        params: { ...build().params, exec: LEGACY_EXEC },
      });
      expect(sha256Canonical(legacyView(withLegacy))).toBe(hash);
    });
  }
  it("覆盖买卖两边与各种原因", () => {
    const kinds = new Set(
      PENDING_END_1_1_0.flatMap(([name, end]) => {
        const x = LEGACY_FIXTURES[name]!();
        return simulate({ ...x, params: { ...x.params, end } }).final.pending.map(
          (p) => `${p.side}:${p.reason}`,
        );
      }),
    );
    expect([...kinds].sort()).toEqual([
      "buy:entry",
      "buy:signal",
      "sell:filtered",
      "sell:max_hold",
      "sell:rebalance",
      "sell:stop_loss",
      "sell:take_profit",
    ]);
  });
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

  it("旧口径也记拒单（D64）：基础夹具丙开盘涨停买不进，记进 buy:limit_up，金标准指纹不变", () => {
    const r = simulate(LEGACY_FIXTURES.base!());
    expect(sha256Canonical(legacyView(r))).toBe(golden.base);
    expect(r.diagnostics!.rejections["buy:limit_up"]).toMatchObject({ count: 1 });
    expect(r.diagnostics!.samples).toContainEqual(
      expect.objectContaining({
        code: "000003.SZ",
        side: "buy",
        reason: "limit_up",
        filledValue: 0,
      }),
    );
    // 参与率、容量这些只在按流动性成交时有；旧口径的成交记录没有参考价与滑点
    expect(r.diagnostics).not.toHaveProperty("participation");
    expect(r.trades.some((t) => "ref" in t || "slip" in t)).toBe(false);
    expect(r.metrics).not.toHaveProperty("slippageCost");
  });

  it("港股：每个费率日前后都有成交", () => {
    const r = simulate(hkFixture());
    for (const d of ["2021-08-01", "2022-01-01", "2023-01-01", "2023-11-17"]) {
      expect(r.trades.some((t) => t.date < d && t.date > addDays(d, -30))).toBe(true);
      expect(r.trades.some((t) => t.date > d && t.date < addDays(d, 30))).toBe(true);
    }
  });
});

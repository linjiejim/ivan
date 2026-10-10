/**
 * 数据源回退链（D72）：默认按封禁风险排序；环境变量只能重排、不能增删；KLINE_SOURCE 是显式单一来源、不回退。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CHAINS, INVALID_CHAIN_TEXT, klineSingleSource, resolveChain } from "./registry.ts";

const ids = (c: ReturnType<typeof resolveChain>) => c.adapters.map((a) => a.id);

describe("resolveChain", () => {
  it("默认：日线与指数东财在前、腾讯在后；报价只有腾讯", () => {
    for (const m of ["A", "HK"] as const) {
      expect(ids(resolveChain("bars", m, {}))).toEqual(["eastmoney", "tencent"]);
      expect(ids(resolveChain("index", m, {}))).toEqual(["eastmoney", "tencent"]);
      expect(ids(resolveChain("quotes", m, {}))).toEqual(["tencent"]);
      expect(resolveChain("bars", m, {}).explicit).toBe(false);
    }
    // 默认链按封禁风险从低到高
    for (const cap of ["bars", "index"] as const) {
      const risks = resolveChain(cap, "A", {}).adapters.map((a) => a.banRisk);
      expect(risks).toEqual([...risks].sort());
    }
    expect(DEFAULT_CHAINS.quotes.A).toEqual(["tencent"]);
  });

  it("合法的重排照办（大小写、空格不敏感）", () => {
    const logs: string[] = [];
    const c = resolveChain("bars", "A", { IVAN_CHAIN_BARS_A: " Tencent , eastmoney" }, (m) => logs.push(m));
    expect(ids(c)).toEqual(["tencent", "eastmoney"]);
    expect(c.explicit).toBe(false);
    expect(logs).toEqual([]);
    // 别的市场不受影响
    expect(ids(resolveChain("bars", "HK", { IVAN_CHAIN_BARS_A: "tencent,eastmoney" }))).toEqual([
      "eastmoney",
      "tencent",
    ]);
    expect(ids(resolveChain("index", "HK", { IVAN_CHAIN_INDEX_HK: "tencent,eastmoney" }))).toEqual([
      "tencent",
      "eastmoney",
    ]);
  });

  it("无效配置（未知来源、删掉一家、多加一家、重复）沿用默认顺序并记日志", () => {
    for (const bad of ["tencent,tushare", "tencent", "eastmoney,tencent,csindex", "tencent,tencent"]) {
      const logs: string[] = [];
      const c = resolveChain("bars", "A", { IVAN_CHAIN_BARS_A: bad }, (m) => logs.push(m));
      expect(ids(c)).toEqual(["eastmoney", "tencent"]);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain(INVALID_CHAIN_TEXT);
      expect(logs[0]).toContain("数据源顺序配置无效，沿用默认顺序");
    }
  });

  it("KLINE_SOURCE=tencent：日线与指数只走腾讯、不回退；报价不受影响", () => {
    const env = { KLINE_SOURCE: "tencent", IVAN_CHAIN_BARS_A: "eastmoney,tencent" };
    const bars = resolveChain("bars", "A", env);
    expect(ids(bars)).toEqual(["tencent"]);
    expect(bars.explicit).toBe(true);
    expect(ids(resolveChain("index", "HK", env))).toEqual(["tencent"]);
    expect(ids(resolveChain("quotes", "A", env))).toEqual(["tencent"]);
    expect(ids(resolveChain("bars", "A", { KLINE_SOURCE: "eastmoney" }))).toEqual(["eastmoney"]);
    expect(ids(resolveChain("bars", "A", { KLINE_SOURCE: "auto" }))).toEqual(["eastmoney", "tencent"]);
    const logs: string[] = [];
    expect(ids(resolveChain("bars", "A", { KLINE_SOURCE: "tushare" }, (m) => logs.push(m)))).toEqual([
      "eastmoney",
      "tencent",
    ]);
    expect(logs[0]).toContain(INVALID_CHAIN_TEXT);
  });

  it("KLINE_SOURCE 的判断去空格、不分大小写（ETF 全收益基准与日线、指数同一个判断）", () => {
    expect(klineSingleSource({ KLINE_SOURCE: " Tencent " })).toBe("tencent");
    expect(ids(resolveChain("bars", "A", { KLINE_SOURCE: " Tencent " }))).toEqual(["tencent"]);
    expect(klineSingleSource({ KLINE_SOURCE: "EASTMONEY" })).toBe("eastmoney");
    expect(klineSingleSource({ KLINE_SOURCE: "auto" })).toBeNull();
    expect(klineSingleSource({})).toBeNull();
  });
});

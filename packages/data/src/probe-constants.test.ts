/**
 * 探针的节奏与检查顺序（D31、D27、D72）：串行、0.6 秒间隔，A 股日线东财优先。探针本身只在命令行联网，
 * 这里只守导出的常量。
 */
import { describe, expect, it } from "vitest";
import { PROBE_A_BARS_ORDER, PROBE_PACING, runProbeCheckForTest } from "./probe.ts";
import { FakeHttp } from "./testing/fake-http.ts";
import { DEFAULT_CHAINS } from "./sources/registry.ts";

describe("探针常量", () => {
  it("串行、同一域名 0.6 秒间隔、抽 10 只", () => {
    expect(PROBE_PACING).toEqual({
      concurrencyPerHost: 1,
      minIntervalMs: 600,
      mapConcurrency: 1,
      sampleCodes: 10,
    });
  });

  it("A 股日线东财优先、腾讯其次，与夜间默认链同序", () => {
    expect(PROBE_A_BARS_ORDER).toEqual(["eastmoney", "tencent"]);
    expect(PROBE_A_BARS_ORDER).toEqual(DEFAULT_CHAINS.bars.A);
  });
});

describe("探针：一个来源出错不影响另一个来源那一行", () => {
  const http = () =>
    new FakeHttp([
      { match: /eastmoney\.com/, status: 500 },
      { match: /gtimg\.cn|qq\.com/, status: 500 },
    ]) as never;

  it("A 股日线：东财、腾讯各记一行「出错」，整项失败", async () => {
    const r = await runProbeCheckForTest("a.bars", http(), { today: "2026-10-07" });
    expect(r.status).toBe("fail");
    expect(r.facts.map((f) => f.split("：")[0])).toEqual(["东财", "腾讯（备用）"]);
    for (const f of r.facts) expect(f).toMatch(/出错/);
  });

  it("价格指数：五个东财代码与腾讯备用各一行", async () => {
    const r = await runProbeCheckForTest("idx.price", http(), { today: "2026-10-07" });
    expect(r.status).toBe("fail");
    expect(r.facts).toHaveLength(6);
    expect(r.facts.at(-1)).toMatch(/^腾讯（备用）sh000300：出错/);
  });
});

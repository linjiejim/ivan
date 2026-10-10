/**
 * 探针的节奏与检查顺序（D31、D27、D72）：串行、0.6 秒间隔，A 股日线东财优先。探针本身只在命令行联网，
 * 这里只守导出的常量。
 */
import { describe, expect, it } from "vitest";
import { PROBE_A_BARS_ORDER, PROBE_PACING } from "./probe.ts";
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

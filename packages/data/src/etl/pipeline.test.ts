/**
 * 夜间增量的休市判断：指数日 K 里没有今天时，只有指数报价日期明确早于今天才算休市（D78、验收 6）。
 */
import { describe, expect, it } from "vitest";
import { FakeHttp } from "../testing/fake-http.ts";
import { confirmNonTradingDay } from "./pipeline.ts";

/** 腾讯行情的一行：第 30 段是报价时间 */
const quote = (sym: string, stamp: string) => {
  const f = Array.from({ length: 40 }, (_, i) => String(i));
  f[30] = stamp;
  return `v_${sym}="${f.join("~")}";`;
};

describe("confirmNonTradingDay", () => {
  it("报价停在之前的交易日：确认休市", async () => {
    const http = new FakeHttp([
      { match: /qt\.gtimg\.cn\/q=sh000001/, reply: quote("sh000001", "20260930150003") },
    ]);
    await expect(confirmNonTradingDay(http, "A", "2026-10-05")).resolves.toBeUndefined();
  });

  it("报价是今天：开市了只是日 K 没更新，任务失败", async () => {
    const http = new FakeHttp([
      { match: /qt\.gtimg\.cn\/q=hkHSI/, reply: quote("hkHSI", "2026/10/05 16:08:01") },
    ]);
    await expect(confirmNonTradingDay(http, "HK", "2026-10-05")).rejects.toThrow(
      "港股今天开市了，但指数日 K 还没有今天的数据",
    );
  });

  it("报价请求失败或读不出日期：确认不了，任务失败而不是当成休市", async () => {
    const down = new FakeHttp([{ match: /qt\.gtimg\.cn/, status: 502 }]);
    await expect(confirmNonTradingDay(down, "A", "2026-10-05")).rejects.toThrow(
      "确认不了今天是否休市",
    );
    const garbled = new FakeHttp([{ match: /qt\.gtimg\.cn/, reply: 'v_sh000001="";' }]);
    await expect(confirmNonTradingDay(garbled, "A", "2026-10-05")).rejects.toThrow(
      "确认不了今天是否休市",
    );
  });
});

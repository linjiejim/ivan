/**
 * 价格面板逐块流式读（D110）：跨好几个数据块（每块约 2048 行）、股票在块中间换手时，序列和逐行对齐的一样；
 * 面板超过上限时停止读、报「行情太多」。
 */
import { defaultExec, LEGACY_EXEC, StrategySpecSchema } from "@ivan/core";
import { afterEach, describe, expect, it } from "vitest";
import { seedSyntheticMarket } from "../testing/seed.ts";
import { Warehouse } from "../warehouse/db.ts";
import { buildSimInput, panelTooLargeText } from "./backtest.ts";

const spec = StrategySpecSchema.parse({
  name: "低估值",
  market: "A",
  rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 3 },
  rebalance: { every: "month", buffer: 1 },
});

const DAYS = 2000;
const LATE = 700; // 第三只股票从第 700 个交易日起才有行情
const stocks = ["600001.SH", "600002.SH", "600003.SH"].map((code, k) => ({
  code,
  name: `股${k}`,
  close: (i: number) => (k === 2 && i < LATE ? NaN : 10 + k + i * 0.01),
  // 复权因子隔一段变一次，验证逐日对齐
  adj: (i: number) => 1 + Math.floor(i / 400) * 0.1,
  factors: (i: number) => ({ pe_ttm: 5 + k, ...(k === 1 && i % 300 === 0 ? { flag_st: true } : {}) }),
}));

const opened: Warehouse[] = [];
afterEach(() => {
  for (const w of opened.splice(0)) w.close();
});

async function market(): Promise<{ wh: Warehouse; calendar: string[] }> {
  const wh = await Warehouse.open(":memory:");
  opened.push(wh);
  const { calendar } = await seedSyntheticMarket(wh, { market: "A", start: "2019-01-01", days: DAYS, stocks });
  return { wh, calendar };
}

describe("价格面板逐块流式读（D110）", () => {
  it("几千行跨多个数据块：每只股票的序列逐日对得上，晚上市的从第一根 K 线起", async () => {
    const { wh, calendar } = await market();
    const built = await buildSimInput(wh, spec, {
      start: calendar[30]!,
      end: calendar.at(-1)!,
      capital: 1_000_000,
      oosMonths: 0,
      exec: defaultExec("A"),
    });
    const cal = built.input.calendar;
    expect(built.stats.codes).toBe(3);
    expect(built.stats.priceRows).toBeGreaterThan(2048 * 2);
    expect([...built.input.prices.keys()]).toEqual(["600001.SH", "600002.SH", "600003.SH"]);
    for (const [k, s] of [...built.input.prices.values()].entries()) {
      const first = k === 2 ? cal.indexOf(calendar[LATE]!) : 0;
      expect(s.from).toBe(first);
      expect(s.close.length).toBe(cal.length - first);
      for (let x = 0; x < s.close.length; x++) {
        const i = calendar.indexOf(cal[first + x]!);
        expect(s.close[x]).toBeCloseTo(10 + k + i * 0.01, 9);
        expect(s.adj[x]).toBeCloseTo(1 + Math.floor(i / 400) * 0.1, 9);
        expect(s.st[x]).toBe(k === 1 && i % 300 === 0 ? 1 : 0);
      }
      // 按流动性成交：日均成交额与波动的数组也按同样的长度建
      expect(s.adv?.length).toBe(s.close.length);
    }
  });

  it("面板超过上限：停止读，报行情太多（不限时照常）", async () => {
    const { wh, calendar } = await market();
    const params = {
      start: calendar[30]!,
      end: calendar.at(-1)!,
      capital: 1_000_000,
      oosMonths: 0,
      exec: LEGACY_EXEC,
    };
    const ok = await buildSimInput(wh, spec, params, { maxPanelBytes: 2 ** 20 });
    expect(ok.input.prices.size).toBe(3);
    // 一只股票约 2000 天 × 41 字节 ≈ 80 KB：上限 100 KB 时读到第二只就超
    await expect(
      buildSimInput(wh, spec, params, { maxPanelBytes: 100 * 1024 }),
    ).rejects.toThrow(/^这次回测要装进内存的行情太多（3 只股票、\d+ 个交易日/);
    expect(panelTooLargeText(3, 1500, 256)).toContain("超过 256 MB 的上限");
    // 出错之后行情仓照常可用（流用的连接已关）
    expect(await wh.scalar("SELECT count(*) FROM bars_daily")).toBeGreaterThan(0);
  });
});

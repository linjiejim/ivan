import { describe, expect, it } from "vitest";
import { prepareMulti, type StrategyLine, valueAt } from "./multi-series.ts";

const pt = (date: string, nav: number, bench: number) => ({ date, nav, bench });

// A 股策略：回测从 01-02 起，01-06 上线；港股策略：回测从 01-03 起（晚一天），01-07 上线
const a: StrategyLine = {
  id: "a",
  name: "A 股价值",
  slot: 0,
  benchLabel: "沪深300全收益",
  startDate: "2026-01-06",
  backtest: [pt("2026-01-02", 1.0, 1.0), pt("2026-01-03", 1.1, 1.05), pt("2026-01-05", 1.2, 1.1)],
  tracking: [pt("2026-01-06", 1.32, 1.1), pt("2026-01-07", 1.26, 1.155)],
};
const hk: StrategyLine = {
  id: "hk",
  name: "港股股息",
  slot: 1,
  benchLabel: "恒指（盈富基金含分红）",
  startDate: "2026-01-07",
  backtest: [pt("2026-01-03", 2.0, 4.0), pt("2026-01-06", 2.2, 4.4)],
  tracking: [pt("2026-01-07", 2.42, 4.4)],
};

describe("看板多策略对照图", () => {
  it("含回测：从两边都有数据的那天起比，各自归一到 0%，基准按市场各一条", () => {
    const p = prepareMulti([a, hk], "nav", "all");
    expect(p.dates).toEqual(["2026-01-03", "2026-01-05", "2026-01-06", "2026-01-07"]);
    const [sa, sh] = p.series;
    expect(sa!.backtest[0]).toBeCloseTo(0, 12);
    expect(sh!.backtest[0]).toBeCloseTo(0, 12);
    // A：1.26 / 1.1 - 1
    expect(sa!.tracking[3]).toBeCloseTo(1.26 / 1.1 - 1, 12);
    // 港股在 01-05 休市：这天没有点
    expect(sh!.backtest[1]).toBeNull();
    expect(p.benches.map((b) => b.label)).toEqual(["沪深300全收益", "恒指（盈富基金含分红）"]);
    expect(p.benches[0]!.values[3]).toBeCloseTo(1.155 / 1.05 - 1, 12);
  });

  it("回测段和跟踪段在上线处共用一个点（画出来连着），上线点标在上线前最后一天", () => {
    const [sa] = prepareMulti([a], "nav", "all").series;
    // dates: 01-02 01-03 01-05 01-06 01-07；上线 01-06，接点是 01-05（下标 2）
    expect(sa!.backtest.slice(0, 3).every((v) => v !== null)).toBe(true);
    expect(sa!.backtest[3]).toBeNull();
    expect(sa!.tracking[2]).toBe(sa!.backtest[2]);
    expect(sa!.goLive).toEqual({ index: 2, value: sa!.backtest[2] });
  });

  it("超额相对各自的基准；超额视图不画基准灰线", () => {
    const p = prepareMulti([a, hk], "excess", "all");
    expect(p.benches).toEqual([]);
    const sh = p.series[1]!;
    // 港股 01-07：(2.42/2.0) / (4.4/4.0) - 1 = 0.1
    expect(sh.tracking[3]).toBeCloseTo(0.1, 12);
  });

  it("只看跟踪：各自从上线前最后一个点起算，所以起点都是 0%", () => {
    const p = prepareMulti([a, hk], "nav", "tracking");
    expect(p.dates[0]).toBe("2026-01-05");
    const [sa, sh] = p.series;
    expect(sa!.tracking[0]).toBeCloseTo(0, 12);
    // 港股从 01-06 的锚点起算
    expect(sh!.tracking[p.dates.indexOf("2026-01-06")]).toBeCloseTo(0, 12);
    expect(sh!.tracking[p.dates.indexOf("2026-01-07")]).toBeCloseTo(0.1, 12);
  });

  it("回撤视图：相对窗口内的前高", () => {
    const [sa] = prepareMulti([a], "drawdown", "all").series;
    expect(sa!.tracking.at(-1)).toBeCloseTo(1.26 / 1.32 - 1, 12);
    expect(sa!.backtest[0]).toBe(0);
  });

  it("窗口起点晚于上线日时不标上线点；还没上线的只有回测段", () => {
    const late = {
      ...hk,
      backtest: [pt("2026-01-07", 2.0, 4.0)],
      tracking: [],
      startDate: "2026-01-08",
    };
    const p = prepareMulti([a, late], "nav", "all");
    expect(p.dates).toEqual(["2026-01-07"]);
    expect(p.series[0]!.goLive).toBeNull();
    expect(p.series[1]!.tracking.every((v) => v === null)).toBe(true);
  });

  it("提示框取值：当天没点就往前找最近的", () => {
    expect(valueAt([0.1, null, null], 2)).toBe(0.1);
    expect(valueAt([null, null], 1)).toBeNull();
  });
});

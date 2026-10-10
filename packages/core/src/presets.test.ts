import { describe, expect, it } from "vitest";
import { PRESETS } from "./presets.ts";
import {
  EVENT_FACTOR_KEYS,
  EVENT_FACTOR_VERSION,
  eventCoverageFrom,
  FACTOR_CORE_VERSION,
  FACTOR_REGISTRY_VERSION,
  type FactorDef,
  FACTORS,
  getFactor,
  isEventFactor,
} from "./factors.ts";
import { benchmarksOf, describeSpec, factorsUsedBySpec, validateSpec } from "./strategy.ts";

describe("预设模板", () => {
  it.each(PRESETS.map((p) => [p.id, p] as const))("%s 能通过校验并生成描述", (_id, p) => {
    const v = validateSpec(p.spec);
    expect(v.errors).toEqual([]);
    expect(describeSpec(v.spec!).length).toBeGreaterThan(3);
  });
});

describe("策略校验给出可读的中文错误", () => {
  it("未知因子、市场不可用的因子、错误的比较符", () => {
    const v = validateSpec({
      name: "x",
      market: "HK",
      filters: [
        { factor: "no_such", op: ">", value: 1 },
        { factor: "flag_st", op: "is" },
        { factor: "industry", op: ">", value: 1 },
      ],
      rank: { terms: [{ factor: "industry", weight: 1, better: "high" }], top: 5 },
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toMatch(/没有因子「no_such」/);
    expect(v.errors.join("\n")).toMatch(/在港股不可用/);
    expect(v.errors.join("\n")).toMatch(/只能用 in \/ not_in/);
    expect(v.errors.join("\n")).toMatch(/排序只能用数值因子/);
  });
});

describe("仓位控制与大盘切换（D52、D53）", () => {
  const base = {
    name: "x",
    market: "A",
    rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 10 },
  };

  it("仓位控制：默认回看 60 天，描述里写明目标波动", () => {
    const v = validateSpec({ ...base, exposure: { volTarget: 0.18 } });
    expect(v.errors).toEqual([]);
    expect(v.spec!.exposure).toEqual({ volTarget: 0.18, lookback: 60 });
    expect(describeSpec(v.spec!).join("\n")).toMatch(
      /按波动控制仓位（目标年化波动 18%，每周评估）/,
    );
  });

  it("大盘切换：弱势排序也要是数值因子；描述分两行写强势 / 弱势排序", () => {
    const bad = validateSpec({
      ...base,
      rank: {
        ...base.rank,
        regime: { weak: { terms: [{ factor: "industry", weight: 1, better: "high" }] } },
      },
    });
    expect(bad.errors.join("\n")).toMatch(/排序只能用数值因子/);
    const v = validateSpec({
      ...base,
      rank: {
        ...base.rank,
        regime: { weak: { terms: [{ factor: "pb", weight: 2, better: "low", neutral: true }] } },
      },
    });
    expect(v.errors).toEqual([]);
    expect(v.spec!.rank!.regime!.ma).toBe(200);
    const text = describeSpec(v.spec!).join("\n");
    expect(text).toMatch(/排序（沪深300在 200 日均线上方）：市盈率 TTM越低越好×1/);
    expect(text).toMatch(/排序（沪深300在 200 日均线下方）：市净率（行业内比）越低越好×2/);
  });
});

describe("新基准与港股通股票池（D75、D77）", () => {
  const a = {
    name: "x",
    market: "A",
    rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 10 },
  };
  const hk = { ...a, market: "HK" };

  it("不带新字段的旧策略照常通过；A 股可以选中证 500 / 1000 / 红利全收益", () => {
    expect(validateSpec(a).errors).toEqual([]);
    expect(validateSpec({ ...a, benchmark: "csi300" }).errors).toEqual([]);
    for (const b of ["csi500", "csi1000", "csi_div"]) {
      const v = validateSpec({ ...a, benchmark: b });
      expect(v.errors).toEqual([]);
      expect(describeSpec(v.spec!).join("\n")).toMatch(/基准：中证(500|1000|红利)全收益/);
    }
    expect(benchmarksOf("A")).toEqual(["csi300", "sse", "csi500", "csi1000", "csi_div"]);
    expect(benchmarksOf("HK")).toEqual(["hsi", "hscei"]);
  });

  it("中证 500 用在港股策略上被拒；不认识的基准被拒", () => {
    expect(validateSpec({ ...hk, benchmark: "csi500" }).errors.join("\n")).toMatch(
      /基准「中证500全收益」和策略市场不一致/,
    );
    expect(validateSpec({ ...a, benchmark: "nope" }).ok).toBe(false);
  });

  it("港股通筛选只用于港股；描述里写明只选港股通标的", () => {
    expect(validateSpec({ ...a, universe: { hkConnect: true } }).errors.join("\n")).toMatch(
      /港股通筛选只适用于港股策略/,
    );
    const v = validateSpec({ ...hk, universe: { hkConnect: true } });
    expect(v.errors).toEqual([]);
    expect(describeSpec(v.spec!)[0]).toMatch(/只选港股通标的/);
    expect(validateSpec({ ...hk, universe: { hkConnect: false } }).ok).toBe(false);
  });
});

describe("注册表第 3 版：事件因子（S15b，D83、D84）", () => {
  const EVENT = [
    "margin_ratio",
    "margin_chg_20d",
    "margin_eligible",
    "holder_num_qoq",
    "unlock_days",
    "unlock_ratio_30d",
    "block_premium_20d",
  ];

  it("版本号：注册表 3、核心 2、事件 1", () => {
    expect(FACTOR_REGISTRY_VERSION).toBe(3);
    expect(FACTOR_CORE_VERSION).toBe(2);
    expect(EVENT_FACTOR_VERSION).toBe(1);
  });

  it("7 个事件因子按约定顺序排在注册表最末，只有 A 股，分组 event，带数据集与预热天数", () => {
    const tail = (FACTORS as readonly FactorDef[]).slice(-7);
    expect(tail.map((f) => f.key)).toEqual(EVENT);
    expect(EVENT_FACTOR_KEYS).toEqual(EVENT);
    for (const f of tail) {
      expect(f.markets).toEqual(["A"]);
      expect(f.group).toBe("event");
      expect(f.dataset).toBeTruthy();
      expect(typeof f.warmupDays).toBe("number");
      expect(f.key.startsWith("flag_")).toBe(false);
      expect(f.describe).toMatch(/可得|181|同步/);
    }
    expect(tail.map((f) => [f.dataset, f.warmupDays])).toEqual([
      ["margin", 7],
      ["margin", 40],
      ["margin", 7],
      ["holders", 200],
      ["lockups", 0],
      ["lockups", 0],
      ["blocks", 40],
    ]);
    // 前面的因子都不是事件因子（核心因子顺序不变）
    expect((FACTORS as readonly FactorDef[]).slice(0, -7).some((f) => f.dataset)).toBe(false);
    expect(getFactor("unlock_days")!.describe).toMatch(/记为 181/);
  });

  it("数据起点 = 覆盖起点 + 预热天数；没有覆盖起点为 null", () => {
    expect(eventCoverageFrom(getFactor("margin_chg_20d")!, "2013-01-04")).toBe("2013-02-13");
    expect(eventCoverageFrom(getFactor("unlock_days")!, "2013-01-01")).toBe("2013-01-01");
    expect(eventCoverageFrom(getFactor("margin_ratio")!, null)).toBeNull();
  });

  it("港股策略用两融因子被拒；A 股可以用", () => {
    const base = {
      name: "x",
      rank: { terms: [{ factor: "margin_ratio", weight: 1, better: "low" }], top: 10 },
    };
    expect(validateSpec({ ...base, market: "HK" }).errors.join("\n")).toMatch(
      /融资余额占流通市值.*在港股不可用|在港股不可用/,
    );
    const v = validateSpec({
      ...base,
      market: "A",
      filters: [
        { factor: "unlock_days", op: ">", value: 90 },
        { factor: "margin_eligible", op: "is" },
      ],
    });
    expect(v.errors).toEqual([]);
    expect(describeSpec(v.spec!).join("\n")).toMatch(/距下次解禁 > 90天/);
  });

  it("factorsUsedBySpec：筛选 + 排序 + 弱势排序，去重", () => {
    const v = validateSpec({
      name: "x",
      market: "A",
      filters: [{ factor: "unlock_days", op: ">", value: 90 }],
      rank: {
        terms: [
          { factor: "pe_ttm", weight: 1, better: "low" },
          { factor: "unlock_days", weight: 1, better: "high" },
        ],
        top: 10,
        regime: { weak: { terms: [{ factor: "holder_num_qoq", weight: 1, better: "low" }] } },
      },
    });
    expect(v.errors).toEqual([]);
    expect(factorsUsedBySpec(v.spec!)).toEqual(["unlock_days", "pe_ttm", "holder_num_qoq"]);
    expect(factorsUsedBySpec(v.spec!).filter(isEventFactor)).toEqual([
      "unlock_days",
      "holder_num_qoq",
    ]);
  });

  it("预设模板都不用事件因子（旧选股 SQL 不变）", () => {
    for (const p of PRESETS) {
      const v = validateSpec(p.spec);
      expect(factorsUsedBySpec(v.spec!).filter(isEventFactor)).toEqual([]);
    }
  });
});

/**
 * 完整性闸门（D73）：A 股 max(3, ⌈0.2%⌉)、港股 max(5, ⌈0.3%⌉) 的缺失阈值；持仓缺失不让整晚失败；
 * 报价漏掉又补不上的算缺失；无成交数远多于平时也失败（历史不足 5 个版本时不判）；应急开关放行指定代码。
 */
import { describe, expect, it } from "vitest";
import {
  acceptMissingFromEnv,
  assessCompleteness,
  catchUpAsOf,
  catchUpProgress,
  type Completeness,
  type CompletenessInput,
  type MissingReason,
  missingThreshold,
  reliableNoTrade,
} from "./completeness.ts";

const codes = (n: number, prefix = 600000) =>
  Array.from({ length: n }, (_, i) => `${prefix + i}.SH`);

function input(o: Partial<CompletenessInput> & { missingCodes?: string[]; reason?: MissingReason }): CompletenessInput {
  const missing = (o.missingCodes ?? []).map((code) => ({ code, reason: o.reason ?? "chain_failed" }));
  return {
    market: "A",
    expected: 5000,
    updated: 5000 - missing.length,
    noTrade: 40,
    missing,
    critical: new Set(),
    accepted: new Set(),
    noTradeHistory: [],
    ...o,
  };
}

describe("assessCompleteness", () => {
  it("阈值：A 股 5000 只 → 10，港股 2600 只 → 8；小市场有下限", () => {
    expect(missingThreshold("A", 5000)).toBe(10);
    expect(missingThreshold("A", 100)).toBe(3);
    expect(missingThreshold("HK", 2600)).toBe(8);
    expect(missingThreshold("HK", 100)).toBe(5);
  });

  it("5000 只缺 2 只通过；缺 20 只失败，原因是中文", () => {
    const pass = assessCompleteness(input({ missingCodes: codes(2) }));
    expect(pass).toMatchObject({ ok: true, reasons: [], missing: codes(2), missingReasons: { chain_failed: 2 } });
    const fail = assessCompleteness(input({ missingCodes: codes(20) }));
    expect(fail.ok).toBe(false);
    expect(fail.reasons).toEqual([
      "A 股有 20 只股票今天的日线没拿到，已停止更新，以免被当成停牌",
    ]);
  });

  it("港股：缺 8 只通过、9 只失败（2600 只）", () => {
    const hk = (n: number) =>
      assessCompleteness(
        input({ market: "HK", expected: 2600, missingCodes: Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(5, "0")}.HK`) }),
      );
    expect(hk(8).ok).toBe(true);
    expect(hk(9).reasons).toEqual(["港股有 9 只股票今天的日线没拿到，已停止更新，以免被当成停牌"]);
  });

  it("持仓股缺失：单独一只不让整晚失败，记进 missingCritical；不计入阈值", () => {
    const one = assessCompleteness(input({ missingCodes: ["600519.SH"], critical: new Set(["600519.SH"]) }));
    expect(one).toMatchObject({ ok: true, missingCritical: ["600519.SH"], missing: ["600519.SH"] });
    // 10 只普通缺失 + 5 只持仓缺失：只数普通的，刚好不超
    const mixed = assessCompleteness(
      input({ missingCodes: [...codes(10), ...codes(5, 601000)], critical: new Set(codes(5, 601000)) }),
    );
    expect(mixed.ok).toBe(true);
    expect(mixed.missingCritical).toHaveLength(5);
  });

  it("报价漏掉又补不上的 quote_omitted 计入缺失", () => {
    const r = assessCompleteness(input({ missingCodes: codes(11), reason: "quote_omitted" }));
    expect(r.ok).toBe(false);
    expect(r.missingReasons).toEqual({ quote_omitted: 11 });
  });

  it("无成交数 400、近 20 个版本中位数 40 → 失败；历史不足 5 个版本不判", () => {
    const history = [38, 40, 41, 39, 42, 40];
    const r = assessCompleteness(input({ noTrade: 400, noTradeHistory: history }));
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(["今天没成交的股票有 400 只，远多于平时（约 40 只），报价可能没更新"]);
    // 70 = 中位数 + 30，不超
    expect(assessCompleteness(input({ noTrade: 70, noTradeHistory: history })).ok).toBe(true);
    expect(assessCompleteness(input({ noTrade: 400, noTradeHistory: history.slice(0, 4) })).ok).toBe(true);
  });

  it("ETL_ACCEPT_MISSING 放行的代码不计数，记进 accepted", () => {
    const accepted = new Set(codes(15));
    const r = assessCompleteness(input({ missingCodes: codes(20), accepted }));
    expect(r.ok).toBe(true);
    expect(r.accepted).toEqual(codes(15));
    expect(acceptMissingFromEnv({ ETL_ACCEPT_MISSING: " 600000.SH, 00700.HK,,不是代码 " })).toEqual([
      "600000.SH",
      "00700.HK",
    ]);
    expect(acceptMissingFromEnv({})).toEqual([]);
  });

  it("缺失列表最多存 200 个代码", () => {
    const r = assessCompleteness(input({ missingCodes: codes(300) }));
    expect(r.missing).toHaveLength(200);
    expect(r.missingReasons.chain_failed).toBe(300);
  });
});

describe("补数据（D111）", () => {
  const cal = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27"];
  const base = {
    market: "HK" as const,
    expected: 2998,
    critical: new Set<string>(),
    accepted: new Set<string>(),
    calendar: cal,
    latest: "2026-10-27",
  };
  const hk = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `${String(from + i).padStart(5, "0")}.HK`);

  it("缺失超阈值、其中之前的日子也没补上：标出 missingFailed 与 behind，原因里写明", () => {
    const missing = hk(20).map((code) => ({ code, reason: "rate_limited" as const }));
    const behind = new Map(hk(12).map((c) => [c, "2026-10-21"]));
    const r = assessCompleteness({
      ...input({}),
      market: "HK",
      expected: 2998,
      missing,
      behind,
    });
    expect(r).toMatchObject({ ok: false, missingFailed: true, behind: 12 });
    expect(r.reasons[0]).toBe(
      "港股有 20 只股票今天的日线没拿到（其中 12 只之前的日子也还没补上，20 只是数据源风控、没等到解封），已停止更新，以免被当成停牌",
    );
  });

  it("catchUpAsOf：截至日 = 第「阈值 + 1」早的那只齐到的那天；只缺今天的不挡；不往回退", () => {
    // 阈值 9：4 只停在 10-20，6 只停在 10-22，其余 20 只只缺今天
    const stuckEarly = hk(4);
    const stuckMid = hk(6, 100);
    const todayOnly = hk(20, 200);
    const missing = [...stuckEarly, ...stuckMid, ...todayOnly].map((code) => ({ code }));
    const behind = new Map<string, string | null>([
      ...stuckEarly.map((c) => [c, "2026-10-20"] as const),
      ...stuckMid.map((c) => [c, "2026-10-22"] as const),
    ]);
    expect(catchUpAsOf({ ...base, missing, behind, committed: "2026-10-19" })).toBe("2026-10-22");
    // 已经提交到 10-22：没有更晚的齐全日
    expect(catchUpAsOf({ ...base, missing, behind, committed: "2026-10-22" })).toBeNull();
    // 再多 6 只停在 10-20（共 10 只 ≥ 阈值 + 1）：只能到 10-20
    const more = new Map([...behind, ...hk(6, 300).map((c) => [c, "2026-10-20"] as const)]);
    const missing2 = [...missing, ...hk(6, 300).map((code) => ({ code }))];
    expect(catchUpAsOf({ ...base, missing: missing2, behind: more, committed: "2026-10-19" })).toBe("2026-10-20");
    // 今天记成没成交、但之前的日子没确认的（不算缺失）也挡截至日：再多 6 只只齐到 10-20
    const unverified = new Map(hk(6, 500).map((c) => [c, "2026-10-20"] as const));
    expect(catchUpAsOf({ ...base, missing, behind, unverified, committed: "2026-10-19" })).toBe("2026-10-20");
    // 从没有过日线的当成哪天都没齐
    const never = new Map<string, string | null>(hk(10, 400).map((c) => [c, null]));
    expect(
      catchUpAsOf({ ...base, missing: hk(10, 400).map((code) => ({ code })), behind: never, committed: null }),
    ).toBeNull();
    // 缺失没超阈值：不是补数据的事
    expect(catchUpAsOf({ ...base, missing: hk(9).map((code) => ({ code })), behind, committed: null })).toBeNull();
  });

  it("catchUpProgress：第 done/total 天按交易日数", () => {
    expect(catchUpProgress(cal, "2026-10-20", "2026-10-22", "2026-10-27", 30)).toEqual({
      since: "2026-10-20",
      asOf: "2026-10-22",
      latest: "2026-10-27",
      done: 2,
      total: 5,
      behind: 30,
    });
  });

  it("无成交的基准只取缺失没超阈值的晚上：2026-11-03 港股的 451 不再被误判", () => {
    const night = (noTrade: number, missing: number, expected = 2998): Partial<Completeness> => ({
      noTrade,
      expected,
      missingReasons: missing ? { rate_limited: missing } : {},
      missingCritical: [],
      accepted: [],
    });
    // 10-22 起每晚都缺上千只（不活跃的股票记成了缺失，无成交只有 150–233）；之前正常的晚上 500、460……
    const spiral = [
      night(189, 985), night(174, 1032), night(168, 994), night(150, 1047), night(213, 931),
      night(200, 996), night(170, 959), night(159, 1011), night(211, 931), night(233, 740),
      night(215, 801), night(232, 682), night(325, 455), night(346, 110), night(438, 17),
    ];
    const normal = [night(500, 0), night(470, 2), night(455, 0), night(480, 1), night(430, 0)];
    const all = [...spiral, ...normal];
    expect(all.map((c) => reliableNoTrade("HK", c)).filter((n) => n !== null)).toEqual([500, 470, 455, 480, 430]);
    // 旧的算法（全都算）中位数约 224，451 被判成报价没更新；只取可靠的晚上就过了
    const r = assessCompleteness({
      ...input({}),
      market: "HK",
      expected: 2998,
      noTrade: 451,
      noTradeHistory: all.map((c) => reliableNoTrade("HK", c)).filter((n): n is number => n !== null),
    });
    expect(r.noTradeFailed).toBeUndefined();
    expect(r.ok).toBe(true);
    // 早于 D73 的旧行没有 expected：照旧用
    expect(reliableNoTrade("HK", { noTrade: 300 })).toBe(300);
  });
});

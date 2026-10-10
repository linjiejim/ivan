/**
 * 完整性闸门（D73）：A 股 max(3, ⌈0.2%⌉)、港股 max(5, ⌈0.3%⌉) 的缺失阈值；持仓缺失不让整晚失败；
 * 报价漏掉又补不上的算缺失；无成交数远多于平时也失败（历史不足 5 个版本时不判）；应急开关放行指定代码。
 */
import { describe, expect, it } from "vitest";
import {
  acceptMissingFromEnv,
  assessCompleteness,
  type CompletenessInput,
  type MissingReason,
  missingThreshold,
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

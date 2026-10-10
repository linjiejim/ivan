/**
 * 运行的数据来源（S13）：面板里各来源的行数、缺失天数（data_gap）、入选过的股票的未解决数据问题（data_issue），
 * 只进检查项，不进输入指纹。
 */
import { StrategySpecSchema } from "@ivan/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedSyntheticMarket } from "../testing/seed.ts";
import { Warehouse } from "../warehouse/db.ts";
import { buildSimInput } from "./backtest.ts";
import { hashSimInput } from "./input-hash.ts";

let wh: Warehouse;
let calendar: string[];
beforeEach(async () => {
  wh = await Warehouse.open(":memory:");
  ({ calendar } = await seedSyntheticMarket(wh, {
    market: "A",
    start: "2026-03-02",
    days: 10,
    stocks: [
      // 名单长度 = 前 1 名 + 缓冲 1 名：600001、600002 在面板里，600003 从不入选
      { code: "600001.SH", name: "入选", close: () => 10, factors: () => ({ pe_ttm: 5 }) },
      { code: "600002.SH", name: "候补", close: () => 20, factors: () => ({ pe_ttm: 50 }) },
      { code: "600003.SH", name: "落选", close: () => 30, factors: () => ({ pe_ttm: 80 }) },
    ],
  }));
});
afterEach(() => wh.close());

const spec = StrategySpecSchema.parse({
  name: "最低市盈率",
  market: "A",
  rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 1 },
  rebalance: { every: "week", buffer: 1 },
});
const build = () =>
  buildSimInput(wh, spec, { start: calendar[1]!, end: calendar.at(-1)!, capital: 1e6, oosMonths: 0 });

async function issue(code: string, date: string, severity: "reject" | "flag", resolved = false) {
  await wh.run(
    `INSERT INTO data_issues (ver, dataset, code, date, rule, severity, detail, src, resolved_ver, resolved_by)
     VALUES (1, 'bars', $c, $d::DATE, 'stale_print', $s, '', 'em', $rv, $rb)`,
    { c: code, d: date, s: severity, rv: resolved ? 2 : null, rb: resolved ? "refetch" : null },
  );
}

describe("buildSimInput 的行情来源与数据提示", () => {
  it("各来源行数：东财、腾讯报价与来源未记录分开数；只数面板代码", async () => {
    await wh.run(`UPDATE bars_daily SET src = 'em' WHERE code = '600001.SH' AND date <= $d::DATE`, { d: calendar[5]! });
    await wh.run(`UPDATE bars_daily SET src = 'txq' WHERE code = '600001.SH' AND date > $d::DATE`, { d: calendar[7]! });
    const built = await build();
    expect([...built.input.prices.keys()].sort()).toEqual(["600001.SH", "600002.SH"]);
    expect(built.provenance).toEqual({
      bySource: { em: 6, txq: 2, unknown: 12 },
      total: 20,
      unknownRows: 12,
      gapDays: 0,
      gapCodes: 0,
      issues: { reject: 0, flag: 0 },
      accepted: [],
    });
    expect(built.input.dataCaveats!.map((c) => c.id)).not.toContain("data_gap");
  });

  it("面板代码在区间里有缺失状态 → data_gap（warn）；别的代码的缺失不算", async () => {
    await wh.run(
      `INSERT INTO bar_status VALUES ('600001.SH', $d::DATE, 'missing', 'chain_failed', NULL, 1),
                                     ('600001.SH', $e::DATE, 'no_trade', NULL, 'txq', 1),
                                     ('600003.SH', $d::DATE, 'missing', 'chain_failed', NULL, 1)`,
      { d: calendar[4]!, e: calendar[5]! },
    );
    const built = await build();
    expect(built.provenance).toMatchObject({ gapDays: 1, gapCodes: 1 });
    expect(built.input.dataCaveats!.find((c) => c.id === "data_gap")).toEqual({
      id: "data_gap",
      level: "warn",
      title: "有数据缺口",
      detail: "有 1 只股票共 1 天的日线没拿到，回测把这些天当成停牌处理。",
    });
  });

  it("数据问题：只数入选过的股票、未解决的；只有标记时 info，有拒收时 warn；不改输入指纹", async () => {
    const before = hashSimInput((await build()).input).inputHash;
    await issue("600003.SH", calendar[3]!, "reject"); // 没入选过
    await issue("600001.SH", calendar[3]!, "flag", true); // 已解决
    await issue("600001.SH", calendar[4]!, "flag");
    let built = await build();
    expect(built.provenance.issues).toEqual({ reject: 0, flag: 1 });
    expect(built.input.dataCaveats!.find((c) => c.id === "data_issue")).toEqual({
      id: "data_issue",
      level: "info",
      title: "数据问题",
      detail: "回测区间里入选过的股票有 1 处数据问题（0 处被拦下），详情见管理页「数据质量」。",
    });
    await issue("600001.SH", calendar[6]!, "reject");
    built = await build();
    expect(built.provenance.issues).toEqual({ reject: 1, flag: 1 });
    expect(built.input.dataCaveats!.find((c) => c.id === "data_issue")).toMatchObject({
      level: "warn",
      detail: "回测区间里入选过的股票有 2 处数据问题（1 处被拦下），详情见管理页「数据质量」。",
    });
    expect(hashSimInput(built.input).inputHash).toBe(before);
  });
});

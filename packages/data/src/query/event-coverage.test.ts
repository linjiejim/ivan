/**
 * 事件因子的覆盖检查与提示（S15b，D83、D84）：补算没完成或起点早于数据起点时回测拒绝、跟踪加 event_coverage；
 * stale_events、event_avail_approx 只是提示（进 reportHash、不进输入指纹）；运行卡 data.events 只在用到事件因子时有。
 */
import { type BacktestParams, LEGACY_EXEC, type StrategySpec, validateSpec } from "@ivan/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backfillEventColumns } from "../etl/event-columns.ts";
import { seedSyntheticMarket } from "../testing/seed.ts";
import { Warehouse } from "../warehouse/db.ts";
import { buildSimInput } from "./backtest.ts";
import { hashSimInput } from "./input-hash.ts";

let wh: Warehouse;
let calendar: string[];

const spec = (filters: unknown[], extra: object = {}): StrategySpec =>
  validateSpec({
    name: "x",
    market: "A",
    filters,
    rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 1 },
    ...extra,
  }).spec!;

const params = (start: string): BacktestParams => ({
  start,
  end: calendar.at(-1)!,
  capital: 1e6,
  oosMonths: 0,
  exec: { ...LEGACY_EXEC },
});

const UNLOCK = spec([{ factor: "unlock_days", op: ">", value: 90 }]);
const MARGIN = spec([{ factor: "margin_chg_20d", op: ">", value: 0 }]);
const PLAIN = spec([{ factor: "pe_ttm", op: "<", value: 100 }]);

beforeAll(async () => {
  wh = await Warehouse.open(":memory:");
  ({ calendar } = await seedSyntheticMarket(wh, {
    market: "A",
    start: "2023-06-01",
    days: 300,
    stocks: [
      { code: "600001.SH", name: "甲", close: () => 10, factors: () => ({ pe_ttm: 8 }) },
      { code: "600002.SH", name: "乙", close: () => 20, factors: () => ({ pe_ttm: 9 }) },
    ],
  }));
  for (const id of ["margin", "holders", "lockups", "blocks"]) {
    await wh.run(
      `INSERT INTO pit_sync (dataset, backfill_from, covered_from, window_through, synced_at, nightly_since)
       VALUES ($d, DATE '2023-06-01', DATE '2023-06-01', $t::DATE, $t::DATE, DATE '2024-03-01')`,
      { d: id, t: calendar.at(-1)! },
    );
  }
});
afterAll(() => wh.close());

describe("补算没完成", () => {
  it("回测拒绝（写明补到第几年）；跟踪只加提示；不用事件因子的策略不受影响", async () => {
    await expect(buildSimInput(wh, UNLOCK, params("2023-07-03"))).rejects.toThrow(
      "两融与筹码类因子的历史还在补算（0/2 年），补完后才能回测；今天的选股可以先用",
    );
    const t = await buildSimInput(wh, UNLOCK, params("2023-07-03"), { appendNextDay: true });
    expect(t.input.dataCaveats!.find((c) => c.id === "event_coverage")).toMatchObject({
      level: "warn",
      detail: "因子「距下次解禁」的历史还在补算，补完之前的日子按空值处理。",
    });
    const plain = await buildSimInput(wh, PLAIN, params("2023-07-03"));
    expect(plain.events).toBeUndefined();
    expect(plain.input.dataCaveats!.map((c) => c.id)).not.toContain("event_coverage");
  });
});

describe("补算完成之后", () => {
  beforeAll(async () => {
    await backfillEventColumns({ wh, log: () => {} }, "A");
  });

  it("起点早于因子的数据起点（覆盖起点 + 预热）：回测拒绝，跟踪加 event_coverage", async () => {
    await expect(buildSimInput(wh, MARGIN, params("2023-07-03"))).rejects.toThrow(
      "因子「融资余额 20 日变化」从 2023-07-11 起才有数据，请把起点设在这之后",
    );
    const t = await buildSimInput(wh, MARGIN, params("2023-07-03"), { appendNextDay: true });
    expect(t.input.dataCaveats!.find((c) => c.id === "event_coverage")!.detail).toBe(
      "因子「融资余额 20 日变化」在 2023-07-11 之前没有数据，这段时间按空值处理。",
    );
    const ok = await buildSimInput(wh, MARGIN, params("2023-07-11"));
    expect(ok.input.dataCaveats!.map((c) => c.id)).not.toContain("event_coverage");
  });

  it("运行卡 data.events：版本、签名、补算批次与用到的数据集", async () => {
    const b = await buildSimInput(wh, UNLOCK, params("2024-03-04"));
    expect(b.events).toMatchObject({
      version: 1,
      sig: expect.stringMatching(/^[0-9a-f]{8}$/),
      batch: expect.any(Number),
      datasets: {
        lockups: { coveredFrom: "2023-06-01", windowThrough: calendar.at(-1), syncedAt: calendar.at(-1) },
      },
    });
    expect(Object.keys(b.events!.datasets)).toEqual(["lockups"]);
  });

  it("event_avail_approx：用到解禁因子且起点早于夜间同步开始；之后起的不提示", async () => {
    const early = await buildSimInput(wh, UNLOCK, params("2023-07-03"));
    expect(early.input.dataCaveats!.find((c) => c.id === "event_avail_approx")).toMatchObject({
      level: "info",
      detail:
        "解禁数据在 2024-03-01 之前按规则推算可得日：首发限售按上市日、其他类型按解禁前 3 个交易日，可能少算提前已知的解禁。",
    });
    const late = await buildSimInput(wh, UNLOCK, params("2024-03-04"));
    expect(late.input.dataCaveats!.map((c) => c.id)).not.toContain("event_avail_approx");
    expect((await buildSimInput(wh, MARGIN, params("2023-07-11"))).input.dataCaveats!.map((c) => c.id)).not.toContain(
      "event_avail_approx",
    );
  });

  it("stale_events：数据集连续 3 晚没更新成功；只进提示，不改输入指纹", async () => {
    const before = await buildSimInput(wh, UNLOCK, params("2024-03-04"));
    const h0 = hashSimInput(before.input);
    const last = calendar.at(-1)!;
    for (let k = 0; k < 3; k++) {
      await wh.run(
        `INSERT INTO data_versions (id, market, as_of, kind, status, started_at, completeness)
         VALUES (nextval('data_version_seq'), 'A', $a::DATE, 'daily', 'ok', current_timestamp, $c)`,
        {
          a: last,
          c: JSON.stringify({ date: `2099-01-0${k + 1}`, soft: [{ step: "lockups", ok: false, error: "x" }] }),
        },
      );
    }
    const after = await buildSimInput(wh, UNLOCK, params("2024-03-04"));
    expect(after.input.dataCaveats!.find((c) => c.id === "stale_events")).toMatchObject({
      level: "warn",
      detail: "「限售解禁」已经 3 晚没更新成功，相关因子按过期规则为空，选股可能变少。",
    });
    const h1 = hashSimInput(after.input);
    expect(h1.inputHash).toBe(h0.inputHash);
    // 两融的策略不提示解禁过期
    expect((await buildSimInput(wh, MARGIN, params("2023-07-11"))).input.dataCaveats!.map((c) => c.id)).not.toContain(
      "stale_events",
    );
  });

  it("stale_events：事件因子的夜间计算本身连续 3 晚失败也提示（用到哪类事件因子都提示）", async () => {
    const last = calendar.at(-1)!;
    for (let k = 0; k < 3; k++) {
      await wh.run(
        `INSERT INTO data_versions (id, market, as_of, kind, status, started_at, completeness)
         VALUES (nextval('data_version_seq'), 'A', $a::DATE, 'daily', 'ok', current_timestamp, $c)`,
        {
          a: last,
          c: JSON.stringify({ date: `2099-02-0${k + 1}`, soft: [{ step: "event_factors", ok: false, error: "oom" }] }),
        },
      );
    }
    const r = await buildSimInput(wh, MARGIN, params("2023-07-11"));
    expect(r.input.dataCaveats!.find((c) => c.id === "stale_events")).toMatchObject({
      level: "warn",
      detail: "两融与筹码类因子已经 3 晚没算成功，这几天的值为空，选股可能变少。",
    });
  });
});

/**
 * 个股两融与筹码明细（S15b）：只读 asOf 当时可得且没撤下的行；asOf 截到已提交的截至日；
 * 环比只拿季末对季末；校验值稳定；港股给「只有 A 股」。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fillEventColumns } from "../compute/event-factors.ts";
import { seedSyntheticMarket } from "../testing/seed.ts";
import { Warehouse } from "../warehouse/db.ts";
import { securityEvents } from "./events.ts";
import { securityDossier } from "./evidence.ts";

let wh: Warehouse;
let calendar: string[];
const SH = "600001.SH";
/** 同一季末有两次公告（更正） */
const SH2 = "600002.SH";

beforeAll(async () => {
  wh = await Warehouse.open(":memory:");
  ({ calendar } = await seedSyntheticMarket(wh, {
    market: "A",
    start: "2024-04-01",
    days: 60,
    stocks: [
      { code: SH, name: "甲", close: () => 10, factors: () => ({ pe_ttm: 8 }) },
      { code: SH2, name: "乙", close: () => 10, factors: () => ({ pe_ttm: 8 }) },
    ],
  }));
  const m: string[] = [];
  for (let i = 0; i < calendar.length - 1; i++) {
    m.push(
      `('${SH}', DATE '${calendar[i]}', DATE '${calendar[i + 1]}', ${1e9 + i * 1e6}, 2e8, 1e11, 'em', NULL, 1)`,
    );
  }
  await wh.run(
    `INSERT INTO margin_daily (code, date, avail_date, rzye, rqye, float_mcap, src, ver, batch) VALUES ${m.join(",")}`,
  );
  await wh.run(
    `INSERT INTO holder_counts (code, end_date, notice_date, avail_date, holder_num, first_seen, last_seen, gone_from, src, ver, batch) VALUES
     ('${SH}', DATE '2023-12-31', DATE '2024-03-20', DATE '2024-03-20', 1000, DATE '2024-03-20', DATE '2024-03-20', NULL, 'em', NULL, 1),
     ('${SH}', DATE '2024-03-31', DATE '2024-04-20', DATE '2024-04-20', 1100, DATE '2024-04-20', DATE '2024-04-20', NULL, 'em', NULL, 1),
     ('${SH}', DATE '2024-04-30', DATE '2024-05-10', DATE '2024-05-10', 1500, DATE '2024-05-10', DATE '2024-05-10', NULL, 'em', NULL, 1),
     ('${SH}', DATE '2024-06-30', DATE '2024-06-05', DATE '2024-06-05', 1210, DATE '2024-06-05', DATE '2024-06-05', DATE '2024-06-12', 'em', NULL, 1),
     ('${SH2}', DATE '2023-12-31', DATE '2024-03-20', DATE '2024-03-20', 1000, DATE '2024-03-20', DATE '2024-03-20', NULL, 'em', NULL, 1),
     ('${SH2}', DATE '2024-03-31', DATE '2024-04-20', DATE '2024-04-20', 1100, DATE '2024-04-20', DATE '2024-04-20', NULL, 'em', NULL, 1),
     ('${SH2}', DATE '2024-03-31', DATE '2024-05-15', DATE '2024-05-15', 1200, DATE '2024-05-15', DATE '2024-05-15', NULL, 'em', NULL, 1)`,
  );
  await wh.run(
    `INSERT INTO lockups (code, free_date, type, unlock_shares, ratio_float, avail_date, avail_rule, first_seen, last_seen, gone_from, src, ver, batch) VALUES
     ('${SH}', DATE '2024-06-20', '定向增发机构配售股份', 2e7, 0.02, DATE '2024-06-17', 'notice_bound', DATE '2024-06-17', DATE '2024-06-17', NULL, 'em', NULL, 1),
     ('${SH}', DATE '2024-07-01', '首发原股东限售股份', 1e8, 0.1, DATE '2024-01-02', 'ipo_terms', DATE '2024-01-02', DATE '2024-01-02', DATE '2024-06-01', 'em', NULL, 1)`,
  );
  await wh.run(
    `INSERT INTO block_trades (code, trade_date, seq, avail_date, deal_price, close_price, premium, deal_volume, deal_amount, buyer_inst, seller_inst, src, ver, batch) VALUES
     ('${SH}', DATE '2024-05-06', 1, DATE '2024-05-07', 9, 10, -0.1, 1e6, 9e6, true, false, 'em', NULL, 1)`,
  );
});
afterAll(() => wh.close());

describe("个股两融与筹码明细", () => {
  it("asOf 截到已提交的截至日；两融只给可得日 ≤ asOf 的（T 日的数据 T+1 才有）", async () => {
    const future = await securityEvents(wh, SH, "2030-01-01");
    expect(future.asOf).toBe(calendar.at(-1));
    const d = "2024-05-20";
    const r = await securityEvents(wh, SH, d);
    expect(r.asOf).toBe(d);
    expect(r.margin.at(-1)!.date).toBe(calendar[calendar.indexOf(d) - 1]);
    for (const x of r.margin) expect(x.availDate <= d).toBe(true);
    expect(r.margin.at(-1)!.marginRatio).toBeCloseTo(((1e9 + (calendar.indexOf(d) - 1) * 1e6) / 1e11) * 100, 10);
    expect(r.margin.at(-1)!.shortAmount).toBe(2e8);
  });

  it("解禁只给 asOf 时已知的；撤下的在撤下之前仍算已知，撤下之后不给", async () => {
    const before = await securityEvents(wh, SH, "2024-05-31");
    expect(before.lockups.map((l) => l.freeDate)).toEqual(["2024-07-01"]);
    expect(before.lockups[0]).toMatchObject({ availRule: "ipo_terms", ratioFloatPct: 10, unlockShares: 1e8 });
    const after = await securityEvents(wh, SH, "2024-06-17");
    expect(after.lockups.map((l) => l.freeDate)).toEqual(["2024-06-20"]);
  });

  it("户数按公告日可得；环比只拿季末对季末；撤下的行撤下之后不给", async () => {
    const r = await securityEvents(wh, SH, "2024-05-20");
    expect(r.holders.map((h) => [h.endDate, h.noticeDate])).toEqual([
      ["2024-04-30", "2024-05-10"],
      ["2024-03-31", "2024-04-20"],
      ["2023-12-31", "2024-03-20"],
    ]);
    expect(r.holders[0]!.qoqPct).toBeNull();
    expect(r.holders[1]!.qoqPct).toBeCloseTo(10, 10);
    const june = await securityEvents(wh, SH, "2024-06-10");
    expect(june.holders[0]).toMatchObject({ endDate: "2024-06-30", holderNum: 1210 });
    expect(june.holders[0]!.qoqPct).toBeCloseTo(10, 10);
    const gone = await securityEvents(wh, SH, "2024-06-12");
    expect(gone.holders[0]!.endDate).toBe("2024-04-30");
  });

  it("同一季末有更正公告：因子、事件卡片的环比与证据的户数取同一次公告（当时可见的最新一次）", async () => {
    await fillEventColumns(
      wh,
      "factors_daily",
      {
        margin: { from: null, windowThrough: null },
        holders: { from: "2023-01-01", syncedAt: calendar.at(-1)! },
        lockups: { from: null, syncedAt: null },
        blocks: { from: null, windowThrough: null },
      },
      calendar[0]!,
      calendar.at(-1)!,
    );
    for (const [d, num, qoq] of [
      ["2024-05-14", 1100, 10],
      ["2024-05-20", 1200, 20],
    ] as const) {
      const f = await wh.one<{ q: number }>(
        `SELECT holder_num_qoq AS q FROM factors_daily WHERE code = $c AND date = $d::DATE`,
        { c: SH2, d },
      );
      expect(f!.q).toBeCloseTo(qoq, 10);
      const card = await securityEvents(wh, SH2, d, ["holders"]);
      expect(card.holders[0]).toMatchObject({ endDate: "2024-03-31", holderNum: num });
      expect(card.holders[0]!.qoqPct).toBeCloseTo(qoq, 10);
      const ev = await securityDossier(wh, SH2, d);
      expect(ev.items.find((i) => i.key === "holders.latest")?.value).toBe(num);
    }
  });

  it("大宗：近 20 个交易日按可得日，折溢价以 % 给出", async () => {
    expect((await securityEvents(wh, SH, "2024-05-06")).blocks).toEqual([]);
    const r = await securityEvents(wh, SH, "2024-05-07");
    expect(r.blocks).toEqual([
      {
        tradeDate: "2024-05-06",
        availDate: "2024-05-07",
        dealPrice: 9,
        closePrice: 10,
        premiumPct: -10,
        dealAmount: 9e6,
        buyerInst: true,
        sellerInst: false,
      },
    ]);
  });

  it("校验值稳定；只取部分数据集；还没补完的数据集给提示", async () => {
    const a = await securityEvents(wh, SH, "2024-05-20");
    const b = await securityEvents(wh, SH, "2024-05-20");
    expect(b.hash).toBe(a.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.caveats.map((c) => c.id)).toContain("event_backfilling");
    const only = await securityEvents(wh, SH, "2024-05-20", ["lockups"]);
    expect(only.margin).toEqual([]);
    expect(Object.keys(only.coverage)).toEqual(["lockups"]);
    await expect(securityEvents(wh, SH, "2024-05-20", ["nope" as "margin"])).rejects.toMatchObject({ status: 400 });
  });

  it("事件因子的夜间计算本身连续 3 晚失败：事件卡片与个股证据都提示（明细照常给）", async () => {
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
    try {
      const ev = await securityEvents(wh, SH, "2024-05-20");
      expect(ev.caveats).toContainEqual(
        expect.objectContaining({
          id: "event_stale",
          title: "两融与筹码类因子已经 3 晚没算成功，这几天的因子值为空（下面的明细不受影响）",
        }),
      );
      expect(ev.margin.length).toBeGreaterThan(0);
      const d = await securityDossier(wh, SH, "2024-05-20");
      expect(d.caveats).toContainEqual(
        expect.objectContaining({ id: "event_stale", title: "两融与筹码类因子已经 3 晚没算成功，这几天的因子值为空" }),
      );
    } finally {
      await wh.run(`DELETE FROM data_versions WHERE completeness LIKE '%2099-02-0%'`);
    }
    // 没有失败的晚上：不提示
    expect((await securityEvents(wh, SH, "2024-05-20")).caveats.map((c) => c.id)).not.toContain("event_stale");
  });

  it("港股：两融、股东户数、解禁、大宗交易目前只有 A 股", async () => {
    await wh.run(`INSERT INTO securities (code, market, name) VALUES ('00700.HK', 'HK', '腾讯')`);
    await expect(securityEvents(wh, "00700.HK")).rejects.toMatchObject({
      status: 404,
      message: "两融、股东户数、解禁、大宗交易目前只有 A 股",
    });
  });
});

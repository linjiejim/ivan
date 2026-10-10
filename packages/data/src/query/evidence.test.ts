/**
 * 个股证据（D67）：唯一的点时读取器。公告日前一天看不到那期财报；财报数值优先用当时首次见到的那一版；
 * 校验值稳定、改一个值就变，复核能指出是哪一项；每项都有出处。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIN_FIELDS } from "../etl/fundamentals.ts";
import { seedSyntheticMarket } from "../testing/seed.ts";
import { Warehouse } from "../warehouse/db.ts";
import { type SecurityDossier, securityDossier, verifyDossier } from "./evidence.ts";

let wh: Warehouse;
let calendar: string[];
const SH = "600001.SH";

function finRow(o: Record<string, unknown>): Record<string, unknown> {
  return {
    report_date: null,
    period: null,
    fy_start: null,
    notice_date: null,
    eff_date: null,
    currency: "CNY",
    revenue: 5e9,
    np: null,
    deducted_np: null,
    revenue_yoy: 10,
    np_yoy: 20,
    deducted_np_yoy: null,
    roe: 15,
    gross_margin: 30,
    debt_ratio: 40,
    ocf: 8e8,
    equity: 2e10,
    shares: 1e9,
    ...o,
  };
}

async function insertFin(code: string, o: Record<string, unknown>) {
  const r = finRow(o);
  const lit = (v: unknown) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v}'`);
  await wh.run(
    `INSERT INTO financials (code, ${FIN_FIELDS.join(", ")}, src, ver)
     VALUES ('${code}', ${FIN_FIELDS.map((k) => lit(r[k])).join(", ")}, 'em', 3)`,
  );
}

beforeAll(async () => {
  wh = await Warehouse.open(":memory:");
  ({ calendar } = await seedSyntheticMarket(wh, {
    market: "A",
    start: "2024-04-01",
    days: 60,
    stocks: [
      {
        code: SH,
        name: "甲",
        industry_l1: "银行",
        close: (i) => 10 + i / 10,
        factors: (i) => ({ pe_ttm: 8 + i / 100, pb: 1.1, roe_ttm: 12, flag_value_trap: i > 30, flag_st: false }),
      },
      { code: "000002.SZ", name: "乙", industry_l1: "医药", close: () => 20, factors: () => ({ pe_ttm: 30 }) },
    ],
  }));
  await insertFin(SH, {
    report_date: "2023-12-31",
    period: "年报",
    fy_start: "2023-01-01",
    notice_date: "2024-03-28",
    eff_date: "2024-03-28",
    np: 9e8,
  });
  // 一季报 4 月 29 日公告；首次见到时归母净利 10 亿，之后被更正成 12 亿
  await insertFin(SH, {
    report_date: "2024-03-31",
    period: "一季报",
    fy_start: "2024-01-01",
    notice_date: "2024-04-29",
    eff_date: "2024-04-29",
    np: 1.2e9,
  });
  const first = finRow({
    report_date: "2024-03-31",
    period: "一季报",
    fy_start: "2024-01-01",
    notice_date: "2024-04-29",
    eff_date: "2024-04-29",
    np: 1e9,
  });
  await wh.run(
    `INSERT INTO financials_seen (code, report_date, row_hash, first_seen, ver, row_json)
     VALUES ($c, DATE '2024-03-31', 'h_first', DATE '2024-05-01', 2, $j)`,
    { c: SH, j: JSON.stringify(first) },
  );
  await wh.run(
    `INSERT INTO corp_actions (code, date, prev_close, ref_price, cash, split, src, ver)
     VALUES ($c, DATE '2024-05-20', 12, 11.5, 0.5, NULL, 'em', 4)`,
    { c: SH },
  );
  // 行业快照从 5 月 15 日起
  await wh.run(
    `INSERT INTO attr_history (code, attr, value, valid_from, valid_to, src, ver)
     VALUES ($c, 'industry_l1', '银行', DATE '2024-05-15', NULL, 'em', 5)`,
    { c: SH },
  );
});
afterAll(() => wh.close());

const item = (d: SecurityDossier, key: string) => d.items.find((i) => i.key === key);

describe("个股证据（D67）", () => {
  it("公告日前一天看不到那期财报，公告日当天能看到", async () => {
    const before = await securityDossier(wh, SH, "2024-04-28");
    expect(item(before, "fin_report_date")!.value).toBe("2023-12-31");
    const on = await securityDossier(wh, SH, "2024-04-29");
    expect(item(on, "fin_report_date")!.value).toBe("2024-03-31");
    expect(item(on, "fin_notice_date")!.value).toBe("2024-04-29");
  });

  it("从不返回晚于决策日的数据；决策日截到已提交的数据截至日", async () => {
    for (const d of ["2024-04-28", "2024-05-10", "2024-06-01"]) {
      const x = await securityDossier(wh, SH, d);
      expect(x.asOf).toBe(calendar.filter((c) => c <= d).at(-1));
      expect(x.dataDate <= d).toBe(true);
      for (const it of x.items) expect(it.availDate <= d, `${it.key} ${it.availDate}`).toBe(true);
    }
    const future = await securityDossier(wh, SH, "2030-01-01");
    expect(future.asOf).toBe(calendar.at(-1));
    expect(future.dataVersion.asOf).toBe(calendar.at(-1));
  });

  it("决策日是周末时落到前一个交易日，和直接问周五一样", async () => {
    const sat = await securityDossier(wh, SH, "2024-04-27");
    const sun = await securityDossier(wh, SH, "2024-04-28");
    const fri = await securityDossier(wh, SH, "2024-04-26");
    expect(calendar).toContain("2024-04-26");
    for (const x of [sat, sun]) {
      expect(x.asOf).toBe("2024-04-26");
      expect(x.dataDate).toBe("2024-04-26");
      expect(x.hash).toBe(fri.hash);
    }
  });

  it("财报数值用首次见到的那一版并注明之后被更正过；留底开始之前给出提示", async () => {
    const x = await securityDossier(wh, SH, "2024-06-01");
    const np = item(x, "fin_np")!;
    expect(np.value).toBeCloseTo(10, 10);
    expect(np.unit).toBe("亿");
    expect(np.note).toBe("（之后被更正过）");
    expect(np.ref).toMatchObject({ table: "financials_seen", src: "em", ver: 2 });
    expect(np.availDate).toBe("2024-05-01");
    expect(x.caveats.map((c) => c.id)).not.toContain("restated_possible");

    const early = await securityDossier(wh, SH, "2024-04-30");
    expect(item(early, "fin_np")!.value).toBeCloseTo(12, 10);
    expect(item(early, "fin_np")!.ref.table).toBe("financials");
    expect(early.caveats).toContainEqual({
      id: "restated_possible",
      level: "info",
      title: "财报数值为最新版本，可能含事后更正",
    });
  });

  it("校验值稳定；改一根 K 线的收盘价后校验值变了，复核指出是哪一项", async () => {
    const d = "2024-05-10";
    const a = await securityDossier(wh, SH, d);
    const b = await securityDossier(wh, SH, d);
    expect(b.hash).toBe(a.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyDossier(wh, SH, d, a.hash)).toEqual({
      same: true,
      hash: a.hash,
      matchedVersion: 2,
      changed: [],
    });
    await wh.run(`UPDATE bars_daily SET close = close + 1 WHERE code = $c AND date = $d::DATE`, {
      c: SH,
      d: a.dataDate,
    });
    const c = await securityDossier(wh, SH, d);
    expect(c.hash).not.toBe(a.hash);
    const v = await verifyDossier(wh, SH, d, a.hash, { items: a.items });
    expect(v.same).toBe(false);
    expect(v.changed.map((i) => i.key)).toEqual(["close"]);
    await wh.run(`UPDATE bars_daily SET close = close - 1 WHERE code = $c AND date = $d::DATE`, {
      c: SH,
      d: a.dataDate,
    });
  });

  it("每项都有出处；因子项引用这天日线的来源；风险标记只收为真的", async () => {
    const x = await securityDossier(wh, SH, "2024-06-03");
    expect(new Set(x.items.map((i) => i.key)).size).toBe(x.items.length);
    for (const it of x.items) {
      expect(it.ref.table, it.key).toBeTruthy();
      expect(Object.keys(it.ref.key).length, it.key).toBeGreaterThan(0);
    }
    expect(item(x, "pe_ttm")!.ref).toMatchObject({ table: "factors_daily", key: { code: SH, date: x.dataDate } });
    expect(item(x, "flag_value_trap")!.value).toBe(true);
    expect(item(x, "flag_st")).toBeUndefined();
    expect(item(x, "corp_action:2024-05-20")).toMatchObject({ value: "每股派现 0.5", ref: { src: "em", ver: 4 } });
    // 带策略时只取策略的因子（外加为真的风险标记）
    const s = await securityDossier(wh, SH, "2024-06-03", { factorKeys: ["pb"] });
    expect(
      s.items.filter((i) => i.ref.table === "factors_daily" && i.group !== "events").map((i) => i.key),
    ).toEqual([
      "pb",
      "flag_value_trap",
    ]);
  });

  it("ST 判定档位：深市官方、沪市 2018 起每日简称，更早的沪市是近似", async () => {
    const x = await securityDossier(wh, SH, "2024-06-03");
    expect(item(x, "st_tier")!.ref.key.tier).toBe("em_daily");
    const sz = await securityDossier(wh, "000002.SZ", "2024-06-03");
    expect(item(sz, "st_tier")!.ref.key.tier).toBe("szse");
    await wh.run(
      `INSERT INTO factors_daily (code, date, market, close, pe_ttm) VALUES ($c, DATE '2017-06-01', 'A', 9, 7)`,
      { c: SH },
    );
    const old = await securityDossier(wh, SH, "2017-06-02");
    expect(old.dataDate).toBe("2017-06-01");
    expect(item(old, "st_tier")).toMatchObject({ value: "近似：最近两期年报都亏损算 ST", ref: { key: { tier: "approx" } } });
    await wh.run(`DELETE FROM factors_daily WHERE code = $c AND date = DATE '2017-06-01'`, { c: SH });
  });

  it("行业：首次快照之前写明用的是哪天的分类，之后写从哪天起记录", async () => {
    const pre = await securityDossier(wh, SH, "2024-05-10");
    expect(item(pre, "industry_l1")).toMatchObject({ label: "行业（用的是 2024-05-15 的分类）", value: "银行" });
    expect(pre.caveats.map((c) => c.id)).toContain("industry_pre_snapshot");
    const post = await securityDossier(wh, SH, "2024-06-03");
    expect(item(post, "industry_l1")).toMatchObject({
      label: "行业（2024-05-15 起记录）",
      ref: { table: "attr_history", src: "em", ver: 5 },
    });
    // 没有快照的股票用当前分类
    const sz = await securityDossier(wh, "000002.SZ", "2024-06-03");
    expect(item(sz, "industry_l1")).toMatchObject({ label: "行业（当前分类）", value: "医药" });
  });

  it("早于第一根 K 线：这只股票那天还没有数据；不认识的代码 404", async () => {
    await expect(securityDossier(wh, SH, "2020-01-01")).rejects.toMatchObject({
      status: 404,
      message: "这只股票那天还没有数据",
    });
    await expect(securityDossier(wh, "600999.SH", "2024-05-01")).rejects.toMatchObject({ status: 404 });
  });
});

describe("证据版本（D97）与「两融与筹码」组（证据第 2 版）", () => {
  const D = "2024-05-20";
  let v1Before: SecurityDossier;

  beforeAll(async () => {
    // 事件数据写进来之前算的第 1 版校验值（S07 时代存下的）
    v1Before = await securityDossier(wh, SH, D, { version: 1 });
    const i = calendar.indexOf(D);
    await wh.run(
      `UPDATE factors_daily SET margin_eligible = true, margin_ratio = 1.5, unlock_days = 12, unlock_ratio_30d = 3
       WHERE code = $c`,
      { c: SH },
    );
    await wh.run(
      `INSERT INTO margin_daily (code, date, avail_date, rzye, float_mcap, src, ver, batch) VALUES
       ($c, $d1::DATE, $d2::DATE, 1.723e10, 1e12, 'em', 7, 3),
       ($c, $d2::DATE, $d3::DATE, 1.8e10, 1e12, 'em', NULL, 4)`,
      { c: SH, d1: calendar[i - 1]!, d2: calendar[i]!, d3: calendar[i + 1]! },
    );
    await wh.run(
      `INSERT INTO holder_counts (code, end_date, notice_date, avail_date, holder_num, first_seen, last_seen, gone_from, src, ver, batch) VALUES
       ($c, DATE '2024-03-31', DATE '2024-04-20', DATE '2024-04-20', 48212, DATE '2024-04-20', DATE '2024-04-20', NULL, 'em', NULL, 2),
       ($c, DATE '2024-06-30', DATE '2024-05-25', DATE '2024-05-25', 47000, DATE '2024-05-25', DATE '2024-05-25', NULL, 'em', NULL, 2)`,
      { c: SH },
    );
    await wh.run(
      `INSERT INTO lockups (code, free_date, type, unlock_shares, ratio_float, avail_date, avail_rule, first_seen, last_seen, gone_from, src, ver, batch) VALUES
       ($c, DATE '2024-06-01', '定向增发机构配售股份', 2.5e7, 0.03, DATE '2024-05-28', 'notice_bound', DATE '2024-05-28', DATE '2024-05-28', NULL, 'em', NULL, 2),
       ($c, DATE '2024-07-01', '首发原股东限售股份', 1e8, 0.1, DATE '2024-01-02', 'ipo_terms', DATE '2024-01-02', DATE '2024-01-02', NULL, 'em', NULL, 2),
       ($c, DATE '2024-05-25', '股权激励限售股份', 1e6, 0.001, DATE '2024-04-01', 'notice_bound', DATE '2024-04-01', DATE '2024-04-01', DATE '2024-05-01', 'em', NULL, 2)`,
      { c: SH },
    );
    await wh.run(
      `INSERT INTO block_trades (code, trade_date, seq, avail_date, deal_price, close_price, premium, deal_volume, deal_amount, src, ver, batch) VALUES
       ($c, $t::DATE, 1, $a::DATE, 9, 10, -0.1, 1e6, 9e6, 'em', NULL, 5),
       ($c, $t::DATE, 2, $a::DATE, 10.2, 10, 0.02, 1e6, 1.02e7, 'em', NULL, 5),
       ($c, $a::DATE, 1, $n::DATE, 9, 10, -0.1, 1e6, 9e6, 'em', NULL, 5)`,
      { c: SH, t: calendar[i - 2]!, a: calendar[i - 1]!, n: calendar[i + 1]! },
    );
  });

  it("新生成的是第 2 版：带 evidenceVersion、factorKeys、options，校验值覆盖它们", async () => {
    const x = await securityDossier(wh, SH, D);
    expect(x.evidenceVersion).toBe(2);
    expect(x.options).toEqual({});
    expect(x.factorKeys).toContain("pe_ttm");
    const y = await securityDossier(wh, SH, D, { factorKeys: ["pb", "unlock_days"] });
    // 事件因子不进普通因子集，统一在「两融与筹码」组
    expect(y.factorKeys).toEqual(["pb"]);
    expect(y.hash).not.toBe(x.hash);
    await expect(securityDossier(wh, SH, D, { options: { trend: true } })).rejects.toMatchObject({ status: 400 });
    await expect(securityDossier(wh, SH, D, { version: 9 })).rejects.toMatchObject({ status: 400 });
  });

  it("第 1 版按原样重新生成：没有事件组、没有 margin_eligible；写入事件数据之前存的校验值不给版本也能复核（matchedVersion 1）", async () => {
    const v1 = await securityDossier(wh, SH, D, { version: 1, factorKeys: ["pb", "margin_eligible"] });
    expect(v1.items.some((i) => i.group === "events")).toBe(false);
    expect(v1.items.some((i) => i.key === "margin_eligible")).toBe(false);
    const again = await securityDossier(wh, SH, D, { version: 1 });
    expect(again.hash).toBe(v1Before.hash);
    expect(again.items).toEqual(v1Before.items);
    const r = await verifyDossier(wh, SH, D, v1Before.hash);
    expect(r).toMatchObject({ same: true, matchedVersion: 1 });
    // 给了版本就只按那一版
    expect(await verifyDossier(wh, SH, D, v1Before.hash, { evidenceVersion: 2 })).toMatchObject({
      same: false,
      matchedVersion: null,
    });
    const v2 = await securityDossier(wh, SH, D);
    expect(
      await verifyDossier(wh, SH, D, v2.hash, {
        evidenceVersion: 2,
        factorKeys: v2.factorKeys,
        options: v2.options,
      }),
    ).toMatchObject({ same: true, matchedVersion: 2 });
  });

  it("「两融与筹码」组：7 个事件因子 + 最近两融、户数、下一次解禁、近 20 日大宗，可得日都不晚于决策日，引用带 src、ver、batch", async () => {
    const x = await securityDossier(wh, SH, D);
    const ev = x.items.filter((i) => i.group === "events");
    expect(ev.slice(0, 7).map((i) => i.key)).toEqual([
      "margin_ratio",
      "margin_chg_20d",
      "margin_eligible",
      "holder_num_qoq",
      "unlock_days",
      "unlock_ratio_30d",
      "block_premium_20d",
    ]);
    expect(item(x, "margin_eligible")!.value).toBe(true);
    for (const it of ev) expect(it.availDate <= x.asOf, it.key).toBe(true);
    const i = calendar.indexOf(D);
    // D 当天的两融数据 D+1 才可得：用的是前一天那条
    expect(item(x, "margin.latest")).toMatchObject({
      label: `融资余额（${calendar[i - 1]}）`,
      unit: "亿",
      availDate: D,
      ref: { table: "margin_daily", src: "em", ver: 7, batch: 3 },
    });
    expect(item(x, "margin.latest")!.value).toBeCloseTo(172.3, 10);
    // 6-30 截至的那期 5-25 才公告
    expect(item(x, "holders.latest")).toMatchObject({
      label: "股东户数（截至 2024-03-31，2024-04-20 公告）",
      value: 48212,
      unit: "户",
      ref: { table: "holder_counts", batch: 2 },
    });
    // 6-1 那次 5-28 才可得；5-25 那次 5-1 撤下了：下一次已知的是 7-1 的首发
    expect(item(x, "lockup.next")).toMatchObject({
      label: "下一次已知解禁（2024-07-01，首发原股东限售股份）",
      value: 10000,
      unit: "万股",
      note: "首发限售，上市时已知",
    });
    // 大宗：可得日在近 20 个交易日内的两笔（第三笔 D+1 才可得）
    expect(item(x, "blocks.20d.count")!.value).toBe(2);
    expect(item(x, "blocks.20d.amount")!.value).toBeCloseTo(0.192, 10);
    expect(item(x, "blocks.20d.premium")!.value).toBeCloseTo(((-0.1 * 9e6 + 0.02 * 1.02e7) / 1.92e7) * 100, 10);

    const later = await securityDossier(wh, SH, "2024-05-29");
    expect(item(later, "lockup.next")).toMatchObject({
      label: "下一次已知解禁（2024-06-01，定向增发机构配售股份）",
      value: 2500,
      note: "按解禁前 3 个交易日的提示性公告推算可得日",
    });
    expect(item(later, "holders.latest")!.label).toBe("股东户数（截至 2024-06-30，2024-05-25 公告）");
  });

  it("撤下之前仍算已知", async () => {
    const x = await securityDossier(wh, SH, "2024-04-30");
    expect(item(x, "lockup.next")!.label).toBe("下一次已知解禁（2024-05-25，股权激励限售股份）");
  });

  it("港股没有事件组", async () => {
    const hk = await Warehouse.open(":memory:");
    await seedSyntheticMarket(hk, {
      market: "HK",
      start: "2024-04-01",
      days: 30,
      stocks: [{ code: "00700.HK", name: "腾讯", close: () => 300, factors: () => ({ pe_ttm: 20 }) }],
    });
    const x = await securityDossier(hk, "00700.HK", "2024-05-01");
    expect(x.evidenceVersion).toBe(2);
    expect(x.items.some((i) => i.group === "events")).toBe(false);
    hk.close();
  });
});

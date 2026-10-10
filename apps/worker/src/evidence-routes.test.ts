/**
 * 选股解释与个股证据的内部接口（D67）：/internal/screen 带数据版本与名单指纹；/internal/explain 与回测同一条 SQL、
 * 日期截到已提交的截至日并落到交易日；/internal/securities/:code/dossier 只读决策日当时可得的数据；/internal/calendar/prev 把成交日换成决策日。
 */
import { StrategySpecSchema } from "@ivan/core";
import { sha256Canonical } from "@ivan/core/node";
import { seedSyntheticMarket } from "@ivan/data/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInternalApp } from "./internal.ts";
import { makeTestEnv } from "./testing/harness.ts";

const spec = StrategySpecSchema.parse({
  name: "低估值",
  market: "A",
  filters: [{ factor: "roe_ttm", op: ">=", value: 10 }],
  rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 1 },
});

let t: Awaited<ReturnType<typeof makeTestEnv>>;
let calendar: string[];
let committed: string;
beforeEach(async () => {
  t = await makeTestEnv({ cfg: { internalSecret: "s" } });
  ({ calendar } = await seedSyntheticMarket(t.env.wh, {
    market: "A",
    start: "2026-03-02",
    days: 20,
    dataVersion: false,
    stocks: [
      {
        code: "600001.SH",
        name: "甲",
        close: (i) => 10 + i * 0.1,
        factors: () => ({ pe_ttm: 8, roe_ttm: 12 }),
      },
      {
        code: "600002.SH",
        name: "乙",
        close: (i) => 20 + i * 0.1,
        factors: () => ({ pe_ttm: 5, roe_ttm: 15 }),
      },
      {
        code: "600003.SH",
        name: "丙",
        close: () => 30,
        factors: () => ({ pe_ttm: 3, roe_ttm: 6 }),
      },
    ],
  }));
  committed = calendar.at(-3)!;
  await t.env.wh.run(
    `INSERT INTO data_versions (id, market, as_of, kind, status)
     VALUES (7, 'A', $d::DATE, 'daily', 'ok')`,
    { d: committed },
  );
});
afterEach(() => t.cleanup());

const req = (path: string, body?: unknown) =>
  createInternalApp().request(path, {
    method: body ? "POST" : "GET",
    headers: { "x-internal-secret": "s", "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

describe("选股解释与个股证据的内部接口（D67）", () => {
  it("/internal/screen 带数据版本与名单指纹", async () => {
    const res = await req("/internal/screen", { spec });
    const body = (await res.json()) as {
      date: string;
      rows: unknown[];
      dataVersion: { id: number; asOf: string };
      listHash: string;
    };
    expect(body.dataVersion).toEqual({ id: 7, asOf: committed });
    expect(body.listHash).toBe(sha256Canonical(body.rows));
    const again = (await (await req("/internal/screen", { spec })).json()) as { listHash: string };
    expect(again.listHash).toBe(body.listHash);
  });

  it("/internal/explain：默认日期 = 已提交的截至日（更晚的日期也截到这天），逐条判定指定代码", async () => {
    const res = await req("/internal/explain", {
      spec,
      date: calendar.at(-1),
      codes: ["600003", "600001.SH"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      date: string;
      limit: number;
      candidates: Array<{ code: string; rank: number }>;
      codes: Array<{ code: string; passed: boolean; failed: string[]; rank: number | null }>;
    };
    expect(body.date).toBe(committed);
    // 默认 limit = 前 top × buffer 名 + top
    expect(body.limit).toBe(Math.ceil(1 * 1.5) + 1);
    expect(body.candidates.map((c) => c.code)).toEqual(["600002.SH", "600001.SH"]);
    expect(body.codes[0]).toMatchObject({
      code: "600003.SH",
      passed: false,
      failed: ["没满足：ROE（TTM） ≥ 10%"],
    });
    expect(body.codes[1]).toMatchObject({ code: "600001.SH", passed: true, rank: 2 });
    const bad = await req("/internal/explain", { spec: { name: "x" } });
    expect(bad.status).toBe(400);
  });

  it("/internal/securities/:code/dossier：决策日之后的数据一律不读；早于第一根 K 线 404 中文", async () => {
    const asOf = calendar[5]!;
    const res = await req(
      `/internal/securities/600001/dossier?asOf=${asOf}&factors=pe_ttm,roe_ttm`,
    );
    expect(res.status).toBe(200);
    const d = (await res.json()) as {
      asOf: string;
      dataDate: string;
      hash: string;
      items: Array<{ key: string; availDate: string; value: unknown }>;
    };
    expect(d.asOf).toBe(asOf);
    expect(d.items.find((i) => i.key === "close")!.value).toBeCloseTo(10.5, 10);
    for (const it of d.items) expect(it.availDate <= asOf).toBe(true);
    // 不给日期：截到已提交的截至日，不读失败那晚写进来的
    const latest = (await (await req(`/internal/securities/600001.SH/dossier`)).json()) as {
      asOf: string;
    };
    expect(latest.asOf).toBe(committed);
    const early = await req(`/internal/securities/600001.SH/dossier?asOf=2020-01-01`);
    expect(early.status).toBe(404);
    expect(await early.json()).toEqual({ error: "这只股票那天还没有数据" });

    const v = (await (
      await req("/internal/dossier/verify", {
        code: "600001.SH",
        asOf,
        hash: d.hash,
        factorKeys: ["pe_ttm", "roe_ttm"],
      })
    ).json()) as { same: boolean };
    expect(v.same).toBe(true);
  });

  it("证据版本（D97）：按版本生成与复核；没给版本时先按第 1 版试；两融与筹码明细只有 A 股", async () => {
    const asOf = calendar[5]!;
    const v1 = (await (
      await req(`/internal/securities/600001/dossier?asOf=${asOf}&version=1`)
    ).json()) as {
      evidenceVersion: number;
      hash: string;
      items: Array<{ group: string }>;
    };
    expect(v1.evidenceVersion).toBe(1);
    expect(v1.items.some((i) => i.group === "events")).toBe(false);
    const v2 = (await (await req(`/internal/securities/600001/dossier?asOf=${asOf}`)).json()) as {
      evidenceVersion: number;
      factorKeys: string[];
      options: object;
      hash: string;
      items: Array<{ group: string }>;
    };
    expect(v2.evidenceVersion).toBe(2);
    expect(v2.items.some((i) => i.group === "events")).toBe(true);
    const legacy = await (
      await req("/internal/dossier/verify", { code: "600001.SH", asOf, hash: v1.hash })
    ).json();
    expect(legacy).toMatchObject({ same: true, matchedVersion: 1 });
    const cur = await (
      await req("/internal/dossier/verify", {
        code: "600001.SH",
        asOf,
        hash: v2.hash,
        evidenceVersion: 2,
        factorKeys: v2.factorKeys,
        options: v2.options,
      })
    ).json();
    expect(cur).toMatchObject({ same: true, matchedVersion: 2 });
    expect((await req(`/internal/securities/600001/dossier?asOf=${asOf}&version=7`)).status).toBe(
      400,
    );

    const ev = await req(`/internal/securities/600001/events?asOf=${asOf}&datasets=lockups,blocks`);
    expect(ev.status).toBe(200);
    const body = (await ev.json()) as {
      asOf: string;
      lockups: unknown[];
      margin: unknown[];
      coverage: object;
    };
    expect(body).toMatchObject({ asOf, lockups: [], margin: [] });
    expect(Object.keys(body.coverage)).toEqual(["lockups", "blocks"]);
    await t.env.wh.run(
      `INSERT INTO securities (code, market, name) VALUES ('00700.HK', 'HK', '腾讯')`,
    );
    const hk = await req(`/internal/securities/00700.HK/events`);
    expect(hk.status).toBe(404);
    expect(await hk.json()).toEqual({ error: "两融、股东户数、解禁、大宗交易目前只有 A 股" });
  });

  it("决策日是周末：解释与证据都落到前一个交易日，结果和直接问周五一样", async () => {
    // 2026-03-08 是周日，前一个交易日是 3 月 6 日（周五）
    const ask = async (date: string) =>
      (await (await req("/internal/explain", { spec, date, codes: ["600001.SH"] })).json()) as {
        date: string;
        candidates: Array<{ code: string }>;
        codes: Array<{ code: string; passed: boolean; failed: string[]; rank: number | null }>;
      };
    const sun = await ask("2026-03-08");
    const fri = await ask("2026-03-06");
    expect(sun.date).toBe("2026-03-06");
    expect(sun).toEqual(fri);
    expect(sun.codes[0]).toMatchObject({ code: "600001.SH", passed: true, rank: 2 });

    const d = (await (
      await req(`/internal/securities/600001.SH/dossier?asOf=2026-03-08`)
    ).json()) as {
      asOf: string;
      dataDate: string;
    };
    expect(d).toMatchObject({ asOf: "2026-03-06", dataDate: "2026-03-06" });
  });

  it("/internal/calendar/prev：成交日的前一个交易日（跨周末）", async () => {
    // 2026-03-09 是周一，前一个交易日是 3 月 6 日（周五）
    const body = (await (await req("/internal/calendar/prev?market=A&date=2026-03-09")).json()) as {
      prev: string | null;
    };
    expect(body.prev).toBe("2026-03-06");
    const none = (await (await req("/internal/calendar/prev?market=A&date=2026-03-02")).json()) as {
      prev: string | null;
    };
    expect(none.prev).toBeNull();
    expect((await req("/internal/calendar/prev?market=A&date=bad")).status).toBe(400);
  });
});

describe("计划结果回看（D79）", () => {
  it("/internal/plan-outcomes：次日开盘、5 天收益与超额；20 天没到（超过已提交的截至日）为 null；最多 50 条", async () => {
    const res = await req("/internal/plan-outcomes", {
      market: "A",
      benchSym: "csi300_tr",
      items: [
        {
          code: "600001",
          side: "buy",
          estPrice: 10.25,
          decisionDate: calendar[2],
          benchClose: 1000 * 1.0005 ** 2,
        },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      asOf: string;
      outcomes: Array<Record<string, number | string | null>>;
    };
    expect(body.asOf).toBe(committed);
    const o = body.outcomes[0]!;
    expect(o.code).toBe("600001.SH");
    expect(o.fillDate).toBe(calendar[3]);
    expect(o.fillOpen).toBeCloseTo(10.3, 10);
    expect(o.slipVsEst).toBeCloseTo(10.3 / 10.25 - 1, 10);
    expect(o.ret5).toBeCloseTo(10.7 / 10.3 - 1, 10);
    expect(o.excess5).toBeCloseTo(10.7 / 10.3 / 1.0005 ** 5 - 1, 10);
    expect(o.ret20).toBeNull();

    const many = Array.from({ length: 51 }, () => ({
      code: "600001",
      side: "buy",
      estPrice: null,
      decisionDate: calendar[2],
      benchClose: null,
    }));
    expect(
      (await req("/internal/plan-outcomes", { market: "A", benchSym: "csi300_tr", items: many }))
        .status,
    ).toBe(400);
    expect(
      (await req("/internal/plan-outcomes", { market: "A", benchSym: "x", items: [] })).status,
    ).toBe(400);
  });
});

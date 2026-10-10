/**
 * 个股证据卡（D67）：来源 Tag、数据日、数据版本、校验值与免责声明都在；名次与没满足的条件按策略块写出。
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SecurityEvents, SecurityEvidence } from "../lib/types.ts";
import { EventsBody, marginLine } from "./events-body.tsx";
import { EvidenceBody } from "./evidence-modal.tsx";

const evidence = (strategy: SecurityEvidence["strategy"]): SecurityEvidence => ({
  dossier: {
    evidenceVersion: 1,
    code: "600001.SH",
    name: "甲",
    market: "A",
    asOf: "2024-03-01",
    dataDate: "2024-03-01",
    dataVersion: { id: 812, asOf: "2024-06-28" },
    items: [
      {
        group: "valuation",
        key: "pe_ttm",
        label: "市盈率 TTM",
        value: 8.123,
        unit: "x",
        asOf: "2024-03-01",
        availDate: "2024-03-01",
        ref: { table: "factors_daily", key: { code: "600001.SH" }, src: "em", ver: 3 },
      },
      {
        group: "financial",
        key: "fin_np",
        label: "归母净利润",
        value: 10,
        unit: "亿",
        asOf: "2023-12-31",
        availDate: "2024-02-20",
        ref: { table: "financials_seen", key: { code: "600001.SH" }, src: "em", ver: 2 },
        note: "（之后被更正过）",
      },
      {
        group: "status",
        key: "industry_l1",
        label: "行业（当前分类）",
        value: null,
        asOf: "2024-03-01",
        availDate: "2024-03-01",
        ref: { table: "securities", key: { code: "600001.SH" }, src: null, ver: null },
      },
    ],
    caveats: [],
    hash: "3f9a1c2e".padEnd(64, "0"),
  },
  decision: { decisionDate: "2024-03-01", tradeDate: "2024-03-04" },
  strategy,
  caveats: [
    { id: "restated_possible", level: "info", title: "财报数值为最新版本，可能含事后更正" },
  ],
});

const render = (e: SecurityEvidence) =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(EvidenceBody, { e }),
    ),
  ).replace(/<[^>]+>/g, "");

const strategy = {
  source: "run" as const,
  versionId: "v1",
  name: "价值组合",
  date: "2024-03-01",
  regime: null,
  passed: true,
  failed: [],
  rank: 12,
  score: 0.8312,
  termPct: { pe_ttm: 0.83 },
  band: "buffer" as const,
  top: 10,
  hold: 15,
};

describe("个股证据卡", () => {
  it("抬头写决策日与成交日；每行有来源与数据日；底部有数据版本、校验值和免责声明；空值写 --", () => {
    const text = render(evidence(null));
    expect(text).toContain("决策日 2024-03-01（次日 2024-03-04 开盘成交）");
    expect(text).toContain("东方财富");
    expect(text).toContain("来源未记录");
    expect(text).toContain("数据日 2024-02-20");
    expect(text).toContain("（之后被更正过）");
    expect(text).toContain("财报数值为最新版本，可能含事后更正");
    expect(text).toContain("数据版本 #812 · 校验 3f9a1c2e");
    expect(text).toContain("仅供研究，不构成投资建议");
    expect(text).toContain("--");
  });

  it("带策略：排第几与得分，或者没满足的条件", () => {
    expect(render(evidence(strategy))).toContain("在「价值组合」里排第 12（得分 0.83）");
    const out = render(
      evidence({
        ...strategy,
        passed: false,
        rank: null,
        band: null,
        failed: ["没满足：ROE（TTM） ≥ 12%"],
      }),
    );
    expect(out).toContain("没进「价值组合」的股票池：没满足：ROE（TTM） ≥ 12%");
  });
});

describe("两融与筹码（S15b）", () => {
  it("证据第 2 版的「两融与筹码」组：户数、万股、笔数、天数按单位写", () => {
    const e = evidence(null);
    e.dossier.evidenceVersion = 2;
    const ev = (key: string, label: string, value: number | boolean, unit?: string) => ({
      group: "events" as const,
      key,
      label,
      value,
      ...(unit ? { unit } : {}),
      asOf: "2024-03-01",
      availDate: "2024-03-01",
      ref: { table: "holder_counts", key: { code: "600001.SH" }, src: "em", ver: null, batch: 3 },
    });
    e.dossier.items.push(
      ev("margin_eligible", "两融标的", true),
      ev("unlock_days", "距下次解禁", 181, "天"),
      ev("holders.latest", "股东户数（截至 2023-12-31，2024-01-20 公告）", 48212, "户"),
      ev("lockup.next", "下一次已知解禁（2024-07-01，首发原股东限售股份）", 2500, "万股"),
      ev("blocks.20d.count", "近 20 个交易日大宗交易", 2, "笔"),
    );
    const text = render(e);
    expect(text).toContain("两融与筹码");
    expect(text).toContain("两融标的是");
    expect(text).toContain("181 天");
    expect(text).toContain("48,212 户");
    expect(text).toContain("2,500 万股");
    expect(text).toContain("2 笔");
  });

  it("明细：抬头写截至日与「只含当时已公布的数据」；户数、解禁可得日依据、大宗折价与机构", () => {
    const e: SecurityEvents = {
      code: "600519.SH",
      name: "贵州茅台",
      asOf: "2026-09-30",
      dataVersion: { id: 812, asOf: "2026-09-30" },
      margin: Array.from({ length: 21 }, (_, i) => ({
        date: `2026-09-${String(i + 1).padStart(2, "0")}`,
        availDate: `2026-09-${String(i + 2).padStart(2, "0")}`,
        financingAmount: 1e10 * (1 + i / 100),
        shortAmount: 1e8,
        marginRatio: 1.0953,
      })),
      holders: [
        { endDate: "2026-06-30", noticeDate: "2026-08-01", holderNum: 48212, qoqPct: -9.75 },
      ],
      lockups: [
        {
          freeDate: "2026-10-15",
          type: "定向增发机构配售股份",
          unlockShares: 82_537_493,
          ratioFloatPct: 10.81,
          availDate: "2026-10-12",
          availRule: "notice_bound",
        },
      ],
      blocks: [
        {
          tradeDate: "2026-09-29",
          availDate: "2026-09-30",
          dealPrice: 11.84,
          closePrice: 13.13,
          premiumPct: -9.825,
          dealAmount: 1.2e7,
          buyerInst: true,
          sellerInst: false,
        },
      ],
      coverage: {},
      caveats: [],
      hash: "a1b2c3d4".padEnd(64, "0"),
    };
    const text = renderToStaticMarkup(createElement(EventsBody, { e })).replace(/<[^>]+>/g, "");
    expect(text).toContain("贵州茅台600519.SH · 截至 2026-09-30（只含当时已公布的数据）");
    expect(marginLine(e.margin)).toBe(
      "融资余额 120.00 亿（2026-09-21 的数据，2026-09-22 可得）· 占流通市值 1.1% · 20 日 +20.0%",
    );
    expect(text).toContain("48,212 户");
    expect(text).toContain("-9.8%");
    expect(text).toContain("8,253.75 万股");
    expect(text).toContain("按公告推算");
    expect(text).toContain("折价 9.8%");
    expect(text).toContain("机构");
    expect(text).toContain("数据版本 #812 · 校验 a1b2c3d4");
    expect(text).toContain("仅供研究，不构成投资建议");
    const empty = renderToStaticMarkup(
      createElement(EventsBody, { e: { ...e, margin: [], holders: [], lockups: [], blocks: [] } }),
    ).replace(/<[^>]+>/g, "");
    expect(empty).toContain("当时没有记录");
  });
});

/**
 * 个股证据卡（D67）：来源 Tag、数据日、数据版本、校验值与免责声明都在；名次与没满足的条件按策略块写出。
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SecurityEvidence } from "../lib/types.ts";
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

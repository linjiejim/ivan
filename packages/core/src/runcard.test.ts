import { describe, expect, it } from "vitest";
import type { SimResult } from "./backtest.ts";
import { LEGACY_EXEC } from "./exec.ts";
import { sha256Canonical } from "./node/hash.ts";
import { buildRunCard, type RunCard, resultHashes } from "./runcard.ts";

const parts = (): Omit<RunCard, "cardHash"> => ({
  schema: 1,
  kind: "backtest",
  spec: { versionId: "v_1", specHash: "0123456789abcdef" },
  params: { start: "2020-01-01", end: "2024-12-31", capital: 1e6, oosMonths: 12 },
  exec: LEGACY_EXEC,
  engine: { version: "1.2.0", rulesVersion: 1, metricsVersion: 1 },
  data: {
    market: "A",
    versionId: 3,
    asOf: "2024-12-31",
    factorRegistry: 1,
    warehouseSchema: 2,
    hashVersion: 1,
    inputHash: "a".repeat(64),
    selectionHash: "b".repeat(64),
    priceHash: "c".repeat(64),
    benchHash: "d".repeat(64),
    caveatsHash: "e".repeat(64),
  },
  seeds: { validation: null },
  outputs: { coreHash: "f".repeat(64), reportHash: "0".repeat(64) },
});

describe("运行卡（D57）", () => {
  it("cardHash 与键的顺序无关，不含 runId / createdAt", () => {
    const a = buildRunCard(parts(), sha256Canonical);
    const p = parts();
    const reordered = Object.fromEntries(Object.entries(p).reverse()) as typeof p;
    expect(buildRunCard(reordered, sha256Canonical).cardHash).toBe(a.cardHash);
    expect(a).not.toHaveProperty("runId");
    expect(a).not.toHaveProperty("createdAt");
    expect(a.cardHash).toHaveLength(64);
    // 同样的内容换一次运行（不同 runId、不同时间）仍是同一张卡
    expect(buildRunCard(parts(), sha256Canonical).cardHash).toBe(a.cardHash);
  });

  it("输入指纹变了 cardHash 就变", () => {
    const a = buildRunCard(parts(), sha256Canonical);
    const p = parts();
    p.data.inputHash = "9".repeat(64);
    expect(buildRunCard(p, sha256Canonical).cardHash).not.toBe(a.cardHash);
  });

  it("coreHash 不看检查项，reportHash 只看检查项", () => {
    const r = {
      engineVersion: "1.2.0",
      exec: LEGACY_EXEC,
      series: [{ date: "2024-01-02", nav: 1, bench: 1, cash: 0, positions: 1 }],
      trades: [],
      holdings: [],
      metrics: { totalReturn: 0.1 },
      segments: { inSample: {}, outOfSample: null },
      attribution: { byStock: [], byIndustry: [] },
      checks: [{ id: "x", level: "info", title: "t", detail: "d" }],
      final: { date: "2024-01-02", cash: 0, equity: 1, positions: [], pending: [] },
    } as unknown as SimResult;
    const h = resultHashes(r, sha256Canonical);
    const r2 = { ...r, checks: [{ ...r.checks[0]!, detail: "试错 3 次" }] };
    const h2 = resultHashes(r2, sha256Canonical);
    expect(h2.coreHash).toBe(h.coreHash);
    expect(h2.reportHash).not.toBe(h.reportHash);
    const r3 = { ...r, metrics: { ...r.metrics, totalReturn: 0.2 } };
    expect(resultHashes(r3, sha256Canonical).coreHash).not.toBe(h.coreHash);
    expect(resultHashes(r3, sha256Canonical).reportHash).toBe(h.reportHash);
  });
});

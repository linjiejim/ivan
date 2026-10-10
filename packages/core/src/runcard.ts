/**
 * 运行卡（D57）：一次回测的复现信息——策略、区间、成交假设、引擎、数据与输入指纹、结果指纹。
 * 纯类型与组装；哈希函数由调用方注入（sha256 只在 `@ivan/core/node`，D58），web 也能引入类型。
 *
 * 结果指纹分两部分：`coreHash` 覆盖成交与指标，「逐笔一致」只看它；`reportHash` 覆盖检查项——
 * 检查项里有从数据派生、K 线一根没变也会变的提示（数据问题、试错次数……），不能让它把一致的重跑说成不同。
 */
import type { DateStr } from "./dates.ts";
import type { ExecConfig } from "./exec.ts";
import type { Market } from "./market.ts";
import type { RunProvenance, SimResult } from "./backtest.ts";
import type { PitDatasetId } from "./pit.ts";

export type RunCardKind = "backtest" | "sweep_child" | "reproduce";

export interface RunCard {
  schema: 1;
  kind: RunCardKind;
  spec: { versionId: string; specHash: string };
  params: { start: DateStr; end: DateStr; capital: number; oosMonths: number };
  exec: ExecConfig;
  engine: { version: string; rulesVersion: number; metricsVersion: number };
  data: {
    market: Market;
    versionId: number | null;
    asOf: DateStr | null;
    factorRegistry: number;
    warehouseSchema: number;
    hashVersion: number;
    inputHash: string;
    selectionHash: string;
    priceHash: string;
    benchHash: string;
    caveatsHash: string;
    /** 行情来源占比、缺失与数据问题（S13）；S13 之前的运行没有 */
    provenance?: RunProvenance;
    /** 事件因子（S15b）：只在策略用到两融与筹码类因子时才有 */
    events?: RunCardEvents;
  };
  /** 可信度的自助法种子（S06，来自 inputHash） */
  seeds: { validation: number | null };
  outputs: { coreHash: string; reportHash: string };
  /** 覆盖卡片本身（不含 runId、createdAt） */
  cardHash: string;
}

/** 运行卡里的事件因子信息：口径版本、补算签名与批次、各数据集的覆盖起点与同步到哪天 */
export interface RunCardEvents {
  version: number;
  sig: string | null;
  batch: number | null;
  datasets: Partial<
    Record<
      PitDatasetId,
      { coveredFrom: DateStr | null; windowThrough: DateStr | null; syncedAt: DateStr | null }
    >
  >;
}

export type HashFn = (v: unknown) => string;

/** 组装运行卡：cardHash = hash(其余部分)。runId、createdAt 永远不进卡片。 */
export function buildRunCard(parts: Omit<RunCard, "cardHash">, hash: HashFn): RunCard {
  return { ...parts, cardHash: hash(parts) };
}

/** 结果指纹：coreHash 覆盖成交与指标（S05、S06 加的 diagnostics、validation 有就算进去），reportHash 覆盖检查项。 */
export function resultHashes(
  r: SimResult & { diagnostics?: unknown; validation?: unknown },
  hash: HashFn,
): { coreHash: string; reportHash: string } {
  return {
    coreHash: hash({
      series: r.series,
      trades: r.trades,
      holdings: r.holdings,
      metrics: r.metrics,
      segments: r.segments,
      attribution: r.attribution,
      final: r.final,
      diagnostics: r.diagnostics,
      validation: r.validation,
    }),
    reportHash: hash(r.checks),
  };
}

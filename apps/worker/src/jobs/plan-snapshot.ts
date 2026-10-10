/**
 * 计划快照（D68）：结算后把「明天买卖什么、为什么」连同当时的因子值、名次、估算与各维度指纹存成只追加的一版，
 * 并记一条账本。同一（跟踪, 决策日）内容指纹相同不写；不同就加一版，原因按 引擎 → 指纹口径 → 成交假设 → 数据 判断
 * （与漂移归因同一个 changeCause）。第 1 版就是用户当晚看到的，永不改写。
 *
 * 组装（buildPlan*）是 async 的、在写事务之外做；写入（writePlanSnapshot）是同步的，必须在结算的 IMMEDIATE 事务里调用，
 * 这样读上一版与账本链尾时已经拿着写锁。
 */
import {
  BENCHMARKS,
  benchmarkOf,
  type DateStr,
  FACTOR_REGISTRY_VERSION,
  type PlanCause,
  type PlanReasonDetail,
  type PendingOrder,
  type StrategySpec,
  type TradingDayBasis,
} from "@ivan/core";
import { sha256Canonical } from "@ivan/core/node";
import {
  type CandidateTrace,
  type CodeExplain,
  EXPLAIN_VERSION,
  type SelectionExplain,
} from "@ivan/data";
import {
  type AppDbHandle,
  appendLedger,
  newId,
  packJson,
  type PlanItemContent,
  planContentHash,
  planItems,
  planSnapshots,
  type PlanSnapshotContent,
} from "@ivan/db";
import { changeCause, type ChangeCause } from "@ivan/engine";
import { and, desc, eq } from "drizzle-orm";

/** 一版快照要写的全部内容（不含 id、版次、原因） */
export interface PlanDraft {
  content: PlanSnapshotContent;
  items: PlanItemContent[];
  userId: string;
  planDateBasis: TradingDayBasis;
  dataVersion: number | null;
  dataAsOf: string | null;
  engineVersion: string;
  execHash: string;
  inputHash: string | null;
  hashVersion: number;
  explainHash: string | null;
  band: number | null;
  benchSym: string;
  benchClose: number | null;
}

/** 解释指纹：喂给计划项与候选名单的那份解释（大盘状态、候选名单、各代码的因子值 / 分位 / 没满足的条件） */
export function explainHashOf(
  explain: Pick<SelectionExplain, "regime" | "codes">,
  candidates: readonly CandidateTrace[],
): string {
  return sha256Canonical({ regime: explain.regime, candidates, codes: explain.codes });
}

const finiteOrNull = (x: number | null | undefined) =>
  x === null || x === undefined || !Number.isFinite(x) ? null : x;

const DETAILS: ReadonlySet<string> = new Set<PlanReasonDetail>([
  "take_profit",
  "stop_loss",
  "max_hold",
  "delisted",
  "exposure",
  "entry",
  "signal",
]);

/** 卖出的细分原因：调出与不再满足条件按解释再分「掉出前 N 名」与「不再满足」 */
function detailOf(o: PendingOrder, c: CodeExplain | undefined): PlanReasonDetail {
  if (o.side === "sell" && (o.reason === "rebalance" || o.reason === "filtered")) {
    if (c) return c.passed && !c.cappedOut ? "ranked_out" : "failed_filter";
    return o.reason === "rebalance" ? "ranked_out" : "failed_filter";
  }
  return DETAILS.has(o.reason)
    ? (o.reason as PlanReasonDetail)
    : o.side === "buy"
      ? "entry"
      : "signal";
}

/** 结算重放的明日计划 → 计划项（名次、得分、分位、因子值来自解释；估算来自 S05 的 pending 估算） */
export function itemsFromPending(
  pending: readonly PendingOrder[],
  explain: SelectionExplain | null,
): PlanItemContent[] {
  const byCode = new Map((explain?.codes ?? []).map((c) => [c.code, c]));
  const cand = new Map((explain?.candidates ?? []).map((c) => [c.code, c]));
  return pending.map((o, i) => {
    const c = byCode.get(o.code);
    const k = cand.get(o.code);
    const sell = o.side === "sell";
    return {
      seq: i + 1,
      code: o.code,
      name: o.name ?? null,
      side: o.side,
      reason: o.reason,
      reasonDetail: detailOf(o, c),
      rank: (sell ? c?.rank : (k?.rank ?? c?.rank)) ?? null,
      score: finiteOrNull(sell ? c?.score : (k?.score ?? c?.score)),
      estPrice: finiteOrNull(o.estPrice),
      estShares: finiteOrNull(o.estShares),
      estWeight: finiteOrNull(o.estWeight),
      refClose: finiteOrNull(o.refClose),
      curWeight: finiteOrNull(o.curWeight),
      failedConditions: sell && c ? c.failed : null,
      factors: (k?.factors ?? c?.factors) ? { ...(k?.factors ?? c?.factors) } : null,
      termPct: (sell ? c?.termPct : (k?.termPct ?? c?.termPct)) ?? null,
    };
  });
}

/** 上线前的首日计划：选股解释的前 N 名，估算仓位 = min(1 / N, 单只上限)，其余估算为空 */
export function entryItems(
  spec: StrategySpec,
  candidates: readonly CandidateTrace[],
): PlanItemContent[] {
  const n = candidates.length;
  const w = n ? Math.min(1 / n, spec.sizing.maxWeight ?? 1) : null;
  return candidates.map((c, i) => ({
    seq: i + 1,
    code: c.code,
    name: c.name,
    side: "buy",
    reason: "entry",
    reasonDetail: "entry",
    rank: c.rank,
    score: finiteOrNull(c.score),
    estPrice: null,
    estShares: null,
    estWeight: w,
    refClose: finiteOrNull(c.close),
    curWeight: null,
    failedConditions: null,
    factors: { ...c.factors },
    termPct: c.termPct,
  }));
}

export function benchSymOf(spec: StrategySpec): string {
  return BENCHMARKS[benchmarkOf(spec)].sym;
}

/** 持有名次线（前 top × buffer 名）；信号模式没有 */
export function bandOf(spec: StrategySpec): number | null {
  return spec.mode === "rules" && spec.rank
    ? Math.ceil(spec.rank.top * spec.rebalance.buffer)
    : null;
}

const CAUSE: Record<ChangeCause, PlanCause> = {
  engine: "engine_change",
  unrecorded: "upgrade",
  exec: "exec_change",
  data: "data_revision",
  none: "rerun_same_inputs",
};

export interface WriteResult {
  snapshotId: string;
  /** 这次新写了一版（内容没变时沿用上一版，为 false） */
  written: boolean;
  edition: number;
  cause: PlanCause | null;
}

/**
 * 写一版快照（同步，必须在结算的 IMMEDIATE 事务里调用）：内容没变就沿用上一版；变了加一版、写计划项、记账本。
 */
export function writePlanSnapshot(
  h: AppDbHandle,
  d: PlanDraft,
  log: (m: string) => void,
): WriteResult {
  const { db } = h;
  const contentHash = planContentHash(d.content, d.items);
  const prev = db
    .select()
    .from(planSnapshots)
    .where(
      and(
        eq(planSnapshots.trackingId, d.content.trackingId),
        eq(planSnapshots.decisionDate, d.content.decisionDate),
      ),
    )
    .orderBy(desc(planSnapshots.edition))
    .get();
  if (prev && prev.contentHash === contentHash) {
    return { snapshotId: prev.id, written: false, edition: prev.edition, cause: null };
  }
  let cause: PlanCause = "initial";
  if (prev) {
    cause =
      CAUSE[
        changeCause(
          {
            engineVersion: prev.engineVersion,
            hashVersion: prev.hashVersion,
            execHash: prev.execHash,
            data: [prev.inputHash, prev.explainHash, prev.dataVersion],
          },
          {
            engineVersion: d.engineVersion,
            hashVersion: d.hashVersion,
            execHash: d.execHash,
            data: [d.inputHash, d.explainHash, d.dataVersion],
          },
        )
      ];
    if (cause === "rerun_same_inputs") {
      log(`计划快照内容变了但输入没变，属于程序问题：${d.content.trackingId}`);
    }
  }
  const edition = (prev?.edition ?? 0) + 1;
  const id = newId("ps_");
  db.insert(planSnapshots)
    .values({
      id,
      trackingId: d.content.trackingId,
      userId: d.userId,
      decisionDate: d.content.decisionDate,
      planDate: d.content.planDate,
      planDateBasis: d.planDateBasis,
      edition,
      cause,
      versionId: d.content.versionId,
      specHash: d.content.specHash,
      dataVersion: d.dataVersion,
      dataAsOf: d.dataAsOf,
      engineVersion: d.engineVersion,
      execHash: d.execHash,
      inputHash: d.inputHash,
      hashVersion: d.hashVersion,
      explainHash: d.explainHash,
      explainVersion: d.explainHash ? EXPLAIN_VERSION : null,
      factorRegistryVersion: FACTOR_REGISTRY_VERSION,
      regime: d.content.regime,
      exposureCurrent: d.content.exposureCurrent,
      exposureNext: d.content.exposureNext,
      equity: d.content.equity,
      cash: d.content.cash,
      band: d.band,
      benchSym: d.benchSym,
      benchClose: d.benchClose,
      positionsZ: packJson(d.content.positions),
      candidatesZ: packJson(d.content.candidates),
      contentHash,
      createdAt: Date.now(),
    })
    .run();
  for (const it of d.items)
    db.insert(planItems)
      .values({ ...it, snapshotId: id })
      .run();
  appendLedger(h, {
    userId: d.userId,
    kind: "plan",
    subjectType: "tracking",
    subjectId: d.content.trackingId,
    asOf: d.content.decisionDate,
    payloadTable: "plan_snapshots",
    payloadId: id,
    payloadHash: contentHash,
  });
  return { snapshotId: id, written: true, edition, cause };
}

/** 决策日的基准收盘（计划结果回看从这里起算，D79） */
export function benchCloseAt(
  calendar: readonly DateStr[],
  bench: ArrayLike<number>,
  date: DateStr,
): number | null {
  const i = calendar.indexOf(date);
  return i >= 0 ? finiteOrNull(bench[i]) : null;
}

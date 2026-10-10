/**
 * 给模型看的摘要（纯函数）：数字全部来自存档结果，四舍五入后交给模型；卡片另外展示完整内容。
 * server 的对话工具与 worker 的场景测试共用（验收 17：场景测试直接断言模型实际看到的东西）。
 */
import {
  type Check,
  COMPUTE_PAUSED_TEXT,
  type Confidence,
  describeExec,
  type ExecConfig,
  FACTOR_MAP,
  formatPlanReason,
  type Metrics,
  type PeriodMetrics,
  PLAN_CAUSE_TEXT,
  type PlanCause,
  type SimDiagnostics,
} from "@ivan/core";

export const r2 = (x: number | null | undefined, d = 4): number | null =>
  x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;

// ── 回测 ──

/** runForModel 用到的回测字段（server getRun 的返回值满足它） */
export interface RunModelInput {
  id: string;
  status: string;
  error: string | null;
  computePaused?: unknown;
  dataAsOf: string | null;
  engineVersion: string | null;
  cardHash: string | null;
  exec: ExecConfig | null;
  metrics: Metrics | null;
  segments: { inSample: PeriodMetrics; outOfSample: PeriodMetrics | null } | null;
  diagnostics: SimDiagnostics | null;
  validation: Confidence | null;
  checks: Check[];
}

/** 给模型看的回测摘要（数字全部来自存档结果） */
export function runForModel(r: RunModelInput) {
  const m = r.metrics;
  if (r.status !== "done" || !m) {
    return {
      runId: r.id,
      status: r.status,
      error: r.error,
      // 夜间更新写库期间回测暂停（D60）：告诉模型在等什么，别让它说「卡住了」
      ...(r.status === "queued" && r.computePaused ? { note: COMPUTE_PAUSED_TEXT } : {}),
    };
  }
  return {
    runId: r.id,
    status: r.status,
    period: `${m.start} ~ ${m.end}`,
    dataAsOf: r.dataAsOf,
    totalReturn: r2(m.totalReturn),
    cagr: r2(m.cagr),
    benchCagr: r2(m.benchCagr),
    excessCagr: r2(m.excessCagr),
    excessTotal: r2(m.excessTotal),
    maxDrawdown: r2(m.maxDrawdown),
    drawdown: m.drawdownPeak
      ? `${m.drawdownPeak} → ${m.drawdownTrough}${m.drawdownRecovery ? `，${m.drawdownRecovery} 修复` : "，尚未修复"}`
      : null,
    sharpe: r2(m.sharpe, 2),
    // 指标第 2 版（D63）才有；旧口径为 null
    ir: r2(m.risk?.infoRatio, 2),
    sortino: r2(m.risk?.sortino, 2),
    maxUnderwaterDays: m.risk?.maxUnderwaterDays ?? null,
    volatility: r2(m.volatility),
    winRate: r2(m.winRate),
    winRateBasis: (m.metricsVersion ?? 1) === 2 ? "按完整持仓" : "按每笔卖出",
    avgHoldDays: r2(m.avgHoldDays, 0),
    turnover: r2(m.turnover, 2),
    costDragPerYear: r2(m.costDrag),
    // 按流动性成交（D64）才有：费用拖累拆成费用与滑点两部分、容量估计
    ...(m.slipDrag !== undefined
      ? {
          feeDragPerYear: r2(m.feeDrag),
          slipDragPerYear: r2(m.slipDrag),
          capacityEstimate: r.diagnostics?.capacityEstimate ?? null,
        }
      : {}),
    buys: m.buys,
    yearly: m.yearly.map((y) => ({ year: y.year, ret: r2(y.ret), bench: r2(y.bench) })),
    inSample: r.segments?.inSample
      ? {
          period: `${r.segments.inSample.start} ~ ${r.segments.inSample.end}`,
          excessCagr: r2(r.segments.inSample.excessCagr),
        }
      : null,
    outOfSample: r.segments?.outOfSample
      ? {
          period: `${r.segments.outOfSample.start} ~ ${r.segments.outOfSample.end}`,
          excessCagr: r2(r.segments.outOfSample.excessCagr),
        }
      : null,
    // 可信度（D65）：只有指标第 2 版的新回测有。按历史重抽样的区间与「跑赢基准的把握」，不是概率、不是预测
    ...(r.validation
      ? {
          excessCagrCi: [r2(r.validation.excessCagr.lo), r2(r.validation.excessCagr.hi)],
          psrActive: r2(r.validation.psrActive, 2),
          confidenceNote: `按历史日收益成段重抽样 ${r.validation.B} 次的 95% 区间与跑赢基准的把握；是区间，不是预测`,
        }
      : {}),
    checks: r.checks.map((c) => ({ level: c.level, title: c.title, detail: c.detail })),
    // 复现信息（D57）：口径不同的回测先说口径
    card: {
      hash: r.cardHash ? r.cardHash.slice(0, 8) : null,
      engine: r.engineVersion,
      dataAsOf: r.dataAsOf,
      exec: r.exec ? describeExec(r.exec) : null,
    },
    note: "百分比字段都是小数（0.123 = 12.3%）。卡片已展示完整报告。",
  };
}

// ── 计划快照（D68） ──

/** planForModel 用到的快照字段（server 的快照视图与 worker 读库的行都满足它） */
export interface PlanSnapshotModelInput {
  id: string;
  decisionDate: string;
  planDate: string;
  planDateBasis: string;
  edition: number;
  cause: string;
  dataAsOf: string | null;
  dataVersion: number | null;
  band: number | null;
}

export interface PlanItemModelInput {
  code: string;
  name: string | null;
  side: string;
  reason: string;
  reasonDetail: string | null;
  rank: number | null;
  score: number | null;
  estWeight: number | null;
  failedConditions: string[] | null;
  factors: Record<string, number | string | boolean | null> | null;
  termPct: Record<string, number> | null;
}

/** 关键因子：分位最高的 3 个排序项（termPct 的键 = 因子名，同一因子第二次出现带 #序号） */
function keyFactors(i: PlanItemModelInput) {
  if (!i.termPct) return [];
  return Object.entries(i.termPct)
    .filter(([, p]) => Number.isFinite(p))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, p]) => {
      const key = k.split("#")[0]!;
      const f = FACTOR_MAP.get(key);
      const v = i.factors?.[key] ?? null;
      return {
        factor: f?.label ?? key,
        value: typeof v === "number" ? r2(v, 2) : v,
        unit: f?.unit ?? null,
        percentile: r2(p * 100, 0),
      };
    });
}

/** 给模型看的计划快照：方向、名称、原因文字、名次、得分、估算仓位、关键因子、没满足的条件；元信息带数据截至日与版次 */
export function planForModel(s: PlanSnapshotModelInput, items: readonly PlanItemModelInput[]) {
  return {
    snapshotId: s.id,
    decisionDate: s.decisionDate,
    planDate: s.planDate,
    planDateBasis: s.planDateBasis,
    edition: s.edition,
    cause: s.cause,
    causeText: PLAN_CAUSE_TEXT[s.cause as PlanCause] ?? s.cause,
    dataAsOf: s.dataAsOf,
    dataVersion: s.dataVersion,
    items: items.map((i) => ({
      side: i.side,
      code: i.code,
      name: i.name,
      reasonText: formatPlanReason(i, s.band),
      rank: i.rank,
      score: r2(i.score, 2),
      estWeight: r2(i.estWeight, 2),
      keyFactors: keyFactors(i),
      failedConditions: i.failedConditions ?? [],
    })),
    note:
      "按规则在决策日收盘后算出的模拟计划，仅供研究，不构成投资建议。estWeight 是小数（0.05 = 5%）；" +
      (s.planDateBasis === "weekday"
        ? "计划日按工作日推算，遇节假日顺延。"
        : "计划日按交易所休市安排推算。"),
  };
}

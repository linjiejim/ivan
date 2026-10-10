/**
 * 计划快照（D68）的共用定义：细分原因、版次原因，以及给人看的原因文字。
 * 网页（lib/format.ts 再导出）与给模型看的摘要（@ivan/ai planForModel）用同一张表，不会一边改了另一边没改。
 */

/** 计划项的细分原因：卖出分「掉出前 N 名」与「不再满足条件」，其余与成交原因相同 */
export type PlanReasonDetail =
  | "ranked_out"
  | "failed_filter"
  | "take_profit"
  | "stop_loss"
  | "max_hold"
  | "delisted"
  | "exposure"
  | "entry"
  | "signal";

/** 快照版次的原因：第 1 版 initial；之后按 引擎 → 指纹口径 → 成交假设 → 数据 判断 */
export type PlanCause =
  "initial" | "data_revision" | "engine_change" | "upgrade" | "exec_change" | "rerun_same_inputs";

/** 成交与计划的原因（回测交易明细、跟踪计划共用） */
export const REASON_TEXT: Record<string, string> = {
  entry: "建仓",
  rebalance: "调出",
  filtered: "不再满足条件",
  take_profit: "止盈",
  stop_loss: "止损",
  max_hold: "到期",
  signal: "信号",
  delisted: "退市",
  exposure: "仓位控制",
};

/** 细分原因的文字模板：{band} 持有名次线（前 top × buffer 名）、{rank} 名次、{conds} 没满足的条件 */
export const REASON_DETAIL_TEXT: Record<PlanReasonDetail, string> = {
  ranked_out: "掉出前 {band} 名（排第 {rank}）",
  failed_filter: "不再满足：{conds}",
  take_profit: "止盈",
  stop_loss: "止损",
  max_hold: "到期",
  delisted: "退市",
  exposure: "仓位控制",
  entry: "建仓",
  signal: "信号",
};

export const PLAN_CAUSE_TEXT: Record<PlanCause, string> = {
  initial: "当晚的计划",
  data_revision: "数据修订",
  engine_change: "引擎变更",
  upgrade: "程序升级（指纹口径变了）",
  exec_change: "成交假设变更",
  rerun_same_inputs: "原因不明（输入没变，属于程序问题）",
};

export interface PlanReasonInput {
  side: string;
  reason: string;
  reasonDetail: string | null;
  rank: number | null;
  failedConditions: string[] | null;
}

/**
 * 一条计划项的原因文字：「掉出前 15 名（排第 31）」「不再满足：ROE(TTM) ≥ 12%」「止盈」。
 * band 是持有名次线（前 top × buffer 名）；不知道名次或名次线时退回粗原因。
 */
export function formatPlanReason(item: PlanReasonInput, band: number | null): string {
  const d = item.reasonDetail as PlanReasonDetail | null;
  if (d === "ranked_out") {
    if (item.rank !== null && band !== null) {
      return REASON_DETAIL_TEXT.ranked_out
        .replace("{band}", String(band))
        .replace("{rank}", String(item.rank));
    }
    return band !== null ? `掉出前 ${band} 名` : "掉出持有名单";
  }
  if (d === "failed_filter") {
    // 选股解释里的条件文字带「没满足：」前缀，这里去掉，免得说两遍
    const conds = (item.failedConditions ?? [])
      .filter(Boolean)
      .map((c) => c.replace(/^没满足：/, ""));
    return conds.length
      ? REASON_DETAIL_TEXT.failed_filter.replace("{conds}", conds.join("、"))
      : (REASON_TEXT.filtered ?? "不再满足条件");
  }
  if (d && REASON_DETAIL_TEXT[d]) return REASON_DETAIL_TEXT[d];
  return REASON_TEXT[item.reason] ?? item.reason;
}

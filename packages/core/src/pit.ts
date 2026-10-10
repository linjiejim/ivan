/**
 * 点时事件数据集（D80、S15）：两融明细、股东户数、限售解禁、大宗交易。只有 A 股，按事件日期窗口整市场拉，
 * 每行存可得日 avail_date 与规则。纯常量与类型，web 也能用（管理页的数据集名、金丝雀状态的叫法）。
 */

export type PitDatasetId = "margin" | "holders" | "lockups" | "blocks";

/** 港股问两融与筹码时的回答（工具、接口、卡片同一句） */
export const EVENTS_A_ONLY_TEXT = "两融、股东户数、解禁、大宗交易目前只有 A 股";

/** 夜间与后台回填的顺序之外的「展示顺序」：管理页、completeness.datasets 都按这个 */
export const PIT_DATASET_IDS: readonly PitDatasetId[] = ["margin", "holders", "lockups", "blocks"];

export const PIT_DATASETS: Record<PitDatasetId, { label: string; short: string }> = {
  margin: { label: "两融明细", short: "两融" },
  holders: { label: "股东户数", short: "户数" },
  lockups: { label: "限售解禁", short: "解禁" },
  blocks: { label: "大宗交易", short: "大宗" },
};

/**
 * 解禁可得日的规则：
 * - ipo_terms：首发限售，上市时招股书就写明了，可得日 = 上市日；
 * - notice_bound：其他类型按解禁日前 LOCKUP_NOTICE_LEAD_TD 个交易日推算（交易日历或休市日表）；
 * - notice_bound:weekday：同上，但那一年没有交易日历也没有休市日表，按工作日数；
 * - first_seen：夜间同步首次见到它的日子早于规则日，以首次见到为准。
 */
export type LockupAvailRule = "ipo_terms" | "notice_bound" | "notice_bound:weekday" | "first_seen";

/**
 * 非首发解禁的提示性公告最晚在解禁日前几个交易日发布。上线前在巨潮资讯抽约 50 条公告实测（docs/probe-report.md）：
 * 少于 3 个交易日的占比 ≥ 5% 时改成实测的第 5 百分位（最少 1）。
 */
export const LOCKUP_NOTICE_LEAD_TD = 3;

/** 金丝雀的结果（D82）：ok / empty 才算通过 */
export type CanaryStatus = "ok" | "empty" | "schema_drift" | "unit_drift" | "blocked" | "error";

/** 管理页「接口」徽标的叫法 */
export const CANARY_STATUS_TEXT: Record<CanaryStatus, string> = {
  ok: "健康",
  empty: "健康",
  schema_drift: "字段变了",
  unit_drift: "单位异常",
  blocked: "被风控",
  error: "出错",
};

/** pit_sync.last_status：ok 全部成功 / partial 有没到齐或失败的块 / canary_failed 金丝雀没过 / failed 出错 / blocked 被风控 */
export type PitSyncStatus = "ok" | "partial" | "canary_failed" | "failed" | "blocked";

/** 回填分块的单位：两融按交易日、户数与大宗按月、解禁按年 */
export const PIT_CHUNK_UNIT: Record<PitDatasetId, string> = {
  margin: "天",
  holders: "月",
  lockups: "年",
  blocks: "月",
};

/** 回填进度一句话：「两融 812 / 3,330 天 · 户数 120 / 166 月」（只列给出的数据集） */
export function pitProgressText(
  progress: Partial<Record<PitDatasetId, { done: number; total: number }>>,
  sep = " · ",
): string {
  return PIT_DATASET_IDS.filter((id) => progress[id])
    .map((id) => {
      const p = progress[id]!;
      return `${PIT_DATASETS[id].short} ${p.done.toLocaleString("en-US")} / ${p.total.toLocaleString("en-US")} ${PIT_CHUNK_UNIT[id]}`;
    })
    .join(sep);
}

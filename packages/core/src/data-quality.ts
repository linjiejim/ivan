/**
 * 数据健康的叫法（D73、D74）：行情仓、管理页与模型摘要共用。
 */

/** 「失败沿用旧数据」的辅助步骤 */
export type SoftStep = "fx" | "securities" | "names_szse" | "names_em" | "fundamentals";

export const SOFT_STEP_LABEL: Record<SoftStep, string> = {
  fx: "汇率",
  securities: "证券表",
  names_szse: "深交所简称变更",
  names_em: "沪市每日简称",
  fundamentals: "财报与股本",
};

/** 辅助步骤连续失败多少晚才报出来（管理页横幅、stale_fundamentals 提示） */
export const SOFT_FAILING_ALERT = 3;

/** 数据问题的规则（日线体检 R1–R8、每周抽检、口径换算失败）在界面上的叫法 */
export const ISSUE_RULE_TEXT: Record<string, string> = {
  ohlc: "价格关系不对",
  volume: "成交量异常",
  calendar: "日期不是交易日",
  duplicate: "重复日期",
  limit_breach: "超过涨跌幅",
  adj_jump: "复权因子无故跳变",
  hk_jump: "港股单日涨跌超过 50%",
  stale_print: "和前一天完全相同",
  check_adj: "周检复权不一致",
  check_volume: "周检成交量不一致",
  caliber: "复权口径换算失败",
};

/** 行级来源代码在界面上的叫法（运行的「行情来源」一行；腾讯日 K 与腾讯报价合并成腾讯） */
export const BAR_SOURCE_TEXT: Record<string, string> = {
  em: "东方财富",
  tx: "腾讯",
  txq: "腾讯",
};

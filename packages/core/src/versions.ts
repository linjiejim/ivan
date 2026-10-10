/**
 * 行情仓一侧的算法版本号。定义在 @ivan/data 用得到、但 server 不依赖 @ivan/data（会带进 DuckDB）：
 * 决策回溯的导出清单（D71）要写出这两个版本，所以放在这里，@ivan/data 原样再导出。
 */

/**
 * 指纹口径版本（D57，`@ivan/data` 的 hashSimInput）。1 = R1（S02）；2 = R2（S04）：证券信息加上市日、resolveExec 多了 rules / metrics
 * （S05 的 adv / sigma 在同一批上线，一起算在 2 里）。组成或 resolveExec 的输出形状一变就加 1。
 */
export const HASH_VERSION = 2;

/** 选股解释的版本（D67，`@ivan/data` 的 explainSelection） */
export const EXPLAIN_VERSION = 1;

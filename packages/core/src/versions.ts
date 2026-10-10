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

/**
 * 证据的版本（D97，`@ivan/data` 的 securityDossier）：1 = S07 的条目（校验值只覆盖 items）；2 = S15b 加「两融与筹码」组（校验值覆盖
 * {evidenceVersion, factorKeys, options, items}）。以后的版本（S16b、S16c）在这里加 1，并保留按旧版本重新生成的分支。
 */
export const EVIDENCE_VERSION = 2;
export const EVIDENCE_VERSIONS = [1, 2] as const;

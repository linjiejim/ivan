# Specs

功能方案。文件名 `YYYYMMDD-<kebab-name>.md`（创建日期前缀），未成形的探索用 `_wip-<name>.md`。
状态：`draft`（草稿）→ `confirmed`（已确认，可开工）→ `done`（已落地）/ `abandoned`（放弃，附去向链接）。
状态流转由 Jim 决定；落地后只追加落地记录，不改写历史。

| Spec | 摘要 | 状态 |
|---|---|---|
| [20260928-ivan-mvp](20260928-ivan-mvp.md) | 首版 MVP：A 股 + 港股数据仓、策略 DSL、回测引擎、向前跟踪、对话 Agent、看板、邀请码账号 | confirmed |
| [20261005-vt-borrowing](20261005-vt-borrowing.md) | 借鉴 Vibe-Trading：数据源接口与完整性闸门、成交假设与运行卡、流动性成交、可信度区间、个股证据、决策账本与计划快照、数字核对、跟踪健康度、全收益基准与港股通股票池、两融与筹码事件数据（R1–R5），Tushare 可选数据源（R6）、持仓与风险透视（R7）；分 7 批上线，R1–R5 已在分支 `claude/vt-enhance` 实现、未合并 | draft |

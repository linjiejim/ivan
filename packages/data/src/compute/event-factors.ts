/**
 * 事件因子（S15b，D83、D84）：7 个两融与筹码因子不在逐股计算里算，而是一条 SQL 从点时事件表（S15）算出来，
 * 再 `UPDATE` 回暂存表（夜间，近 15 天）或正式表（按年补算，etl/event-columns.ts）。只碰这 7 列、只碰 A 股的行。
 *
 * 点时规则（决策日 d 只用 `avail_date ≤ d` 且 `gone_from` 为空或 > d 的行）：
 * - 两融：ASOF 连接取可得日 ≤ d 的最近一条；同一个窗口函数取 20 个交易日前那条（交易日历编号正好差 20 才算）；
 * - 股东户数：「状态时间线」——只看季末行，在每个变化点（各行的 avail_date 与 gone_from）t 上找 t 时可见的季末行，
 *   每个季度取 t 时可见的公告里最新的一条（与事件卡片、证据同一规则），再取截至日最大的季度和它的上一季末（也要在 t 时可见），决策日 ASOF 连接这条时间线。
 *   这样一季报先于年报公告时，年报公告后用的仍是一季报对年报（不会因为年报更晚可得就倒退）；
 * - 解禁、大宗：范围连接（解禁日在 (d, d+180]；大宗的可得日在 (20 个交易日前那天, d] 内——按日期范围，
 *   可得日落在非交易日的也算进下一个交易日起的窗口）。
 *
 * 「没有」与「不知道」分开（D84）：数据集的覆盖起点、同步到哪天来自 pit_sync，校验格式后作为字面量拼进 SQL；
 * 过期（两融窗口落后 5 个交易日以上、户数同步落后 30 天以上、解禁同步落后 3 天以上、大宗窗口没到前一交易日）就为空；
 * 解禁数据可用而没有已知解禁时 unlock_days = 181、unlock_ratio_30d = 0。
 */
import { type DateStr, EVENT_FACTOR_KEYS, type PitDatasetId } from "@ivan/core";
import type { Warehouse } from "../warehouse/db.ts";

/** 事件数据集的同步状态（pit_sync）：from = 覆盖起点（回填全部完成后才有，D81），过期判断用 windowThrough / syncedAt */
export interface EventSyncState {
  margin: { from: DateStr | null; windowThrough: DateStr | null };
  holders: { from: DateStr | null; syncedAt: DateStr | null };
  lockups: { from: DateStr | null; syncedAt: DateStr | null };
  blocks: { from: DateStr | null; windowThrough: DateStr | null };
}

export type EventTarget = "factors_stage" | "factors_daily";

/** 从 pit_sync 读同步状态（表还没有任何行时全为 null：事件因子全部为空） */
export async function loadEventSyncState(wh: Warehouse): Promise<EventSyncState> {
  const rows = await wh.all<{
    dataset: PitDatasetId;
    covered_from: string | null;
    window_through: string | null;
    synced_at: string | null;
  }>(
    `SELECT dataset, covered_from::VARCHAR AS covered_from, window_through::VARCHAR AS window_through,
            synced_at::VARCHAR AS synced_at FROM pit_sync`,
  );
  const get = (id: PitDatasetId) => rows.find((r) => r.dataset === id);
  return {
    margin: { from: get("margin")?.covered_from ?? null, windowThrough: get("margin")?.window_through ?? null },
    holders: { from: get("holders")?.covered_from ?? null, syncedAt: get("holders")?.synced_at ?? null },
    lockups: { from: get("lockups")?.covered_from ?? null, syncedAt: get("lockups")?.synced_at ?? null },
    blocks: { from: get("blocks")?.covered_from ?? null, windowThrough: get("blocks")?.window_through ?? null },
  };
}

/** 日期字面量：先校验格式（拼进 SQL），空 = NULL */
function lit(d: DateStr | null): string {
  if (d === null) return "CAST(NULL AS DATE)";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`非法日期 ${d}`);
  return `DATE '${d}'`;
}

function checked(d: DateStr): DateStr {
  lit(d);
  return d;
}

/** 某数据集「可用」的条件：from（或判断过期用的日期）为空时整个条件为 FALSE（这个数据集的因子全部为空） */
function okWhen(
  from: DateStr | null,
  cond: (from: string) => string,
  also: DateStr | null | undefined = undefined,
): string {
  return from === null || also === null ? "FALSE" : `(${cond(lit(from))})`;
}

/**
 * 每个事件因子的表达式（键 = EVENT_FACTOR_KEYS；有测试钉住二者一致）。
 * b = 目标行（带交易日历编号 i），m = ASOF 到的两融行，hs = ASOF 到的户数时间线，lk / bk = 解禁 / 大宗的聚合，st = 字面量。
 */
function expressions(s: EventSyncState): Record<string, string> {
  // 先校验全部字面量（有的条件会因为别的日期为空而短路成 FALSE，也不能放过格式不对的）
  for (const v of Object.values(s)) for (const d of Object.values(v)) lit(d as DateStr | null);
  const marginOk = okWhen(
    s.margin.from,
    (f) => `b.date >= ${f} + 7 AND b.i - st.margin_wi <= 5`,
    s.margin.windowThrough,
  );
  const marginRow = `m.code IS NOT NULL AND b.i - m.mi <= 5`;
  const holdersOk = okWhen(
    s.holders.from,
    (f) => `b.date >= ${f} AND b.date <= ${lit(s.holders.syncedAt)} + 30`,
    s.holders.syncedAt,
  );
  const lkOk = okWhen(
    s.lockups.from,
    (f) => `b.date >= ${f} AND b.date <= ${lit(s.lockups.syncedAt)} + 3`,
    s.lockups.syncedAt,
  );
  const blocksOk = okWhen(
    s.blocks.from,
    (f) => `b.date >= ${f} AND st.blocks_wi >= b.i - 1`,
    s.blocks.windowThrough,
  );
  return {
    margin_ratio: `CASE WHEN ${marginOk} AND ${marginRow} AND m.float_mcap > 0
      THEN m.rzye / m.float_mcap * 100 END`,
    margin_chg_20d: `CASE WHEN ${marginOk} AND ${marginRow} AND m.mi - m.mi_l20 = 20 AND m.rzye_l20 > 0
      THEN (m.rzye / m.rzye_l20 - 1) * 100 END`,
    margin_eligible: `CASE WHEN ${marginOk}
      THEN coalesce(${marginRow} AND m.rzye > 0, false) END`,
    holder_num_qoq: `CASE WHEN ${holdersOk} AND hs.holder_num IS NOT NULL
      AND date_diff('day', hs.cur_avail, b.date) <= 200 AND hs.prev_num > 0
      THEN (hs.holder_num / hs.prev_num - 1) * 100 END`,
    unlock_days: `CASE WHEN ${lkOk} THEN coalesce(date_diff('day', b.date, lk.next_free), 181) END`,
    // 30 天内有已知解禁、但其中有的缺比例：不知道（为空），不当成 0 或只加已知的那部分
    unlock_ratio_30d: `CASE WHEN ${lkOk} THEN CASE WHEN coalesce(lk.n30, 0) > coalesce(lk.k30, 0) THEN NULL
      ELSE coalesce(lk.r30, 0) * 100 END END`,
    block_premium_20d: `CASE WHEN ${blocksOk} THEN bk.prem * 100 END`,
  };
}

/** 生成的列名（测试用：必须与 EVENT_FACTOR_KEYS 一致、同序） */
export function eventFactorAliases(s: EventSyncState): string[] {
  return Object.keys(expressions(s));
}

const QUARTER_END = `strftime(end_date, '%m-%d') IN ('03-31', '06-30', '09-30', '12-31')`;

/**
 * 事件因子的 SELECT：目标表里 market = 'A'、日期在 [$from, $to] 的行 → (code, date, 7 个事件因子)。
 * 参数 $from / $to（DATE）；同步状态以校验过的字面量拼进来。
 */
export function eventFactorSelect(target: EventTarget, s: EventSyncState): string {
  if (target !== "factors_stage" && target !== "factors_daily") throw new Error(`非法的目标表 ${target}`);
  const ex = expressions(s);
  for (const k of EVENT_FACTOR_KEYS) if (!ex[k]) throw new Error(`事件因子 ${k} 没有 SQL 表达式`);
  const cols = EVENT_FACTOR_KEYS.map((k) => `${ex[k]} AS ${k}`).join(",\n  ");
  return `WITH cal AS (
  SELECT date, row_number() OVER (ORDER BY date) AS i, lag(date, 20) OVER (ORDER BY date) AS w_from
  FROM (SELECT DISTINCT date FROM trade_calendar WHERE market = 'A')
),
st AS (
  SELECT (SELECT max(i) FROM cal WHERE date <= ${lit(s.margin.windowThrough)}) AS margin_wi,
         (SELECT max(i) FROM cal WHERE date <= ${lit(s.blocks.windowThrough)}) AS blocks_wi
),
base AS (
  SELECT t.code, t.date, c.i, c.w_from FROM ${target} t JOIN cal c ON c.date = t.date
  WHERE t.market = 'A' AND t.date >= $from::DATE AND t.date <= $to::DATE
),
m AS (
  SELECT md.code, md.date, md.avail_date, md.rzye, md.float_mcap, c.i AS mi,
         lag(md.rzye, 20) OVER w AS rzye_l20, lag(c.i, 20) OVER w AS mi_l20
  FROM margin_daily md JOIN cal c ON c.date = md.date
  WHERE md.date >= $from::DATE - 70 AND md.date <= $to::DATE
  WINDOW w AS (PARTITION BY md.code ORDER BY md.date)
),
hv AS (
  SELECT code, end_date, notice_date, avail_date, holder_num, coalesce(gone_from, DATE '9999-12-31') AS gone
  FROM holder_counts WHERE ${QUARTER_END}
),
pts AS (
  SELECT code, avail_date AS t FROM hv
  UNION
  SELECT code, gone_from AS t FROM holder_counts WHERE gone_from IS NOT NULL AND ${QUARTER_END}
),
hc AS (
  SELECT code, t FROM pts WHERE t >= $from::DATE AND t <= $to::DATE
  UNION
  SELECT code, max(t) AS t FROM pts WHERE t < $from::DATE GROUP BY code
),
vis AS (
  SELECT hc.code, hc.t, hv.end_date, hv.avail_date, hv.holder_num
  FROM hc JOIN hv ON hv.code = hc.code AND hv.avail_date <= hc.t AND hv.gone > hc.t
  QUALIFY row_number() OVER (PARTITION BY hc.code, hc.t, hv.end_date ORDER BY hv.notice_date DESC, hv.avail_date DESC) = 1
),
cur AS (
  SELECT * FROM vis QUALIFY row_number() OVER (PARTITION BY code, t ORDER BY end_date DESC) = 1
),
hs AS (
  SELECT hc.code, hc.t, cur.avail_date AS cur_avail, cur.holder_num, p.holder_num AS prev_num
  FROM hc
  LEFT JOIN cur ON cur.code = hc.code AND cur.t = hc.t
  LEFT JOIN vis p ON p.code = cur.code AND p.t = cur.t
    AND p.end_date = last_day(cur.end_date - INTERVAL 3 MONTH)
),
lk AS (
  SELECT b.code, b.date, min(l.free_date) AS next_free,
         sum(l.ratio_float) FILTER (WHERE l.free_date <= b.date + 30) AS r30,
         count(*) FILTER (WHERE l.free_date <= b.date + 30) AS n30,
         count(l.ratio_float) FILTER (WHERE l.free_date <= b.date + 30) AS k30
  FROM base b JOIN lockups l ON l.code = b.code
    AND l.free_date > b.date AND l.free_date <= b.date + 180
    AND l.avail_date <= b.date AND (l.gone_from IS NULL OR l.gone_from > b.date)
  WHERE l.free_date > $from::DATE AND l.free_date <= $to::DATE + 180 AND l.avail_date <= $to::DATE
  GROUP BY b.code, b.date
),
bt AS (
  SELECT t.code, t.premium, t.deal_amount, t.avail_date
  FROM block_trades t
  WHERE t.avail_date >= $from::DATE - 60 AND t.avail_date <= $to::DATE
),
bk AS (
  SELECT b.code, b.date, sum(t.premium * t.deal_amount) / nullif(sum(t.deal_amount), 0) AS prem
  FROM base b JOIN bt t ON t.code = b.code AND t.avail_date <= b.date
    AND (b.w_from IS NULL OR t.avail_date > b.w_from)
  GROUP BY b.code, b.date
)
SELECT b.code, b.date,
  ${cols}
FROM base b
CROSS JOIN st
ASOF LEFT JOIN m ON m.code = b.code AND b.date >= m.avail_date
ASOF LEFT JOIN hs ON hs.code = b.code AND b.date >= hs.t
LEFT JOIN lk ON lk.code = b.code AND lk.date = b.date
LEFT JOIN bk ON bk.code = b.code AND bk.date = b.date`;
}

/**
 * 把 [from, to] 的事件列算好写回目标表（一条 UPDATE；只改 7 个事件列，核心列一个字节不动）。
 * 调用方负责放进 wh.exclusive（夜间在 computeFactors 的写库段里，补算按年各一段）。返回改了多少行。
 */
export async function fillEventColumns(
  wh: Warehouse,
  target: EventTarget,
  s: EventSyncState,
  from: DateStr,
  to: DateStr,
): Promise<number> {
  const set = EVENT_FACTOR_KEYS.map((k) => `${k} = e.${k}`).join(", ");
  const r = await wh.conn.run(
    `UPDATE ${target} AS t SET ${set}
     FROM (${eventFactorSelect(target, s)}) AS e
     WHERE t.code = e.code AND t.date = e.date`,
    { from: checked(from), to: checked(to) },
  );
  return Number(r.rowsChanged);
}

/** 填充失败时把暂存表里的事件列按正式表原样拷回来（今天的新行留空，D83） */
export async function restoreEventColumns(wh: Warehouse, from: DateStr): Promise<void> {
  const set = EVENT_FACTOR_KEYS.map((k) => `${k} = d.${k}`).join(", ");
  await wh.run(
    `UPDATE factors_stage AS s SET ${set} FROM factors_daily AS d
     WHERE s.code = d.code AND s.date = d.date AND s.market = 'A' AND d.market = 'A' AND d.date >= $f::DATE`,
    { f: from },
  );
}

/** 拷回也失败时的退路：暂存表里正式表最后一天之后的新行，事件列置空（D83：今天的新行留空） */
export async function clearNewEventColumns(wh: Warehouse): Promise<void> {
  const set = EVENT_FACTOR_KEYS.map((k) => `${k} = NULL`).join(", ");
  await wh.run(
    `UPDATE factors_stage SET ${set}
     WHERE market = 'A' AND date > coalesce((SELECT max(date) FROM factors_daily WHERE market = 'A'), DATE '0001-01-01')`,
  );
}

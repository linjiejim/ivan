/**
 * 事件列按年补算（S15b，D83）：注册表第 3 版的 7 个事件因子不触发全量重算，历史由这里按自然年一段一段 `UPDATE`
 * 回 factors_daily（每年约 130 万行），核心列一个字节不动。
 *
 * - 进度键 `event_cols:v{EVENT_FACTOR_VERSION}:{签名}`（etl_progress，键 = 年份），断点续跑；签名或事件因子版本变了就换一个键，从头补；
 * - 签名 = {EVENT_FACTOR_VERSION, 各数据集的 covered_from（按月）} 的指纹前 8 位。covered_from 只在 S15 的回填完成时设一次，
 *   个别缺口不会让签名来回变（不会触发 14 年重算）；
 * - **不开数据版本**（D81）：每次调用写一条 pit_batches(kind = event_cols)；
 * - 补完写 meta `event_factors:A = {v, sig, complete: true, batch}`。回测的「补完之前提前拒绝」看的就是它与当前签名、版本是否对得上。
 * - S15 的回填还没完成（有数据集没有 covered_from）时不补：否则会按不完整的签名补一遍、完成后再补一遍。
 */
import { type DateStr, EVENT_FACTOR_VERSION, PIT_DATASET_IDS } from "@ivan/core";
import { sha256Canonical } from "@ivan/core/node";
import {
  type EventSyncState,
  fillEventColumns,
  loadEventSyncState,
} from "../compute/event-factors.ts";
import { committedAsOf } from "../query/versions.ts";
import type { Warehouse } from "../warehouse/db.ts";
import { type EtlContext, doneKeys, errMsg, markDone, resetTask } from "./context.ts";
import { openPitBatch } from "./pit-runner.ts";

export const EVENT_FACTORS_META = "event_factors:A";

/** meta event_factors:A 的内容 */
export interface EventFactorsMeta {
  v: number;
  sig: string;
  complete: boolean;
  batch: number | null;
}

/** 补算签名：事件因子版本 + 各数据集的覆盖起点（按月） */
export function eventSig(s: EventSyncState): string {
  const ym = (d: DateStr | null) => (d ? d.slice(0, 7) : null);
  return sha256Canonical({
    v: EVENT_FACTOR_VERSION,
    from: {
      margin: ym(s.margin.from),
      holders: ym(s.holders.from),
      lockups: ym(s.lockups.from),
      blocks: ym(s.blocks.from),
    },
  }).slice(0, 8);
}

export const eventColsTask = (sig: string, v = EVENT_FACTOR_VERSION) => `event_cols:v${v}:${sig}`;

/** 夜间事件列最近一次算成功时暂存表的最后一天（S15b）：连续失败超过夜间重算的 15 天时，用它找出留空的那段 */
export const EVENT_FACTORS_OK_META = "event_factors_ok:A";

/**
 * 夜间事件步骤连续失败、留空的日子已经滑出夜间重算的范围（(after, before) 之间）时：清掉这几年的补算进度、
 * 完成标记改成未完成，夜间成功后的 enqueueEventColsIfNeeded 会排上按年重算（补完之前用到事件因子的回测按「还在补算」拒绝）。
 * 在 exclusive 里调用。返回重开的年份。
 */
export async function reopenEventYears(wh: Warehouse, after: DateStr, before: DateStr): Promise<number[]> {
  const st = await loadEventSyncState(wh);
  const years: number[] = [];
  for (let y = Number(after.slice(0, 4)); y <= Number(before.slice(0, 4)); y++) years.push(y);
  for (const y of years) {
    await wh.run(`DELETE FROM etl_progress WHERE task = $t AND key = $k`, { t: eventColsTask(eventSig(st)), k: String(y) });
  }
  const meta = await readEventFactorsMeta(wh);
  if (meta?.complete) await wh.setMeta(EVENT_FACTORS_META, JSON.stringify({ ...meta, complete: false }));
  return years;
}

export interface EventColumnsStatus {
  /** 当前的事件因子版本 */
  v: number;
  /** 当前的补算签名 */
  sig: string;
  /** 补算完成、且签名与版本都对得上（回测只认这个） */
  complete: boolean;
  doneYears: number;
  totalYears: number;
  /** 补算从哪天起（各数据集覆盖起点里最早的） */
  from: DateStr | null;
  /** S15 的回填全部完成（四个数据集都有覆盖起点） */
  backfillComplete: boolean;
  /** 还没补的年份（从早到晚） */
  pendingYears: number[];
  state: EventSyncState;
  meta: EventFactorsMeta | null;
}

export async function readEventFactorsMeta(wh: Warehouse): Promise<EventFactorsMeta | null> {
  const raw = await wh.meta(EVENT_FACTORS_META);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as EventFactorsMeta;
  } catch {
    return null;
  }
}

export async function eventColumnsStatus(wh: Warehouse): Promise<EventColumnsStatus> {
  const state = await loadEventSyncState(wh);
  const sig = eventSig(state);
  const froms = PIT_DATASET_IDS.map((id) => state[id].from).filter((d): d is DateStr => !!d);
  const backfillComplete = froms.length === PIT_DATASET_IDS.length;
  const from = froms.length ? froms.reduce((a, b) => (a < b ? a : b)) : null;
  const asOf = await committedAsOf(wh, "A");
  const years: number[] = [];
  if (from && asOf) {
    for (let y = Number(from.slice(0, 4)); y <= Number(asOf.slice(0, 4)); y++) years.push(y);
  }
  const done = await doneKeys(wh, eventColsTask(sig));
  const pendingYears = years.filter((y) => !done.has(String(y)));
  const meta = await readEventFactorsMeta(wh);
  return {
    v: EVENT_FACTOR_VERSION,
    sig,
    complete: !!meta && meta.complete && meta.v === EVENT_FACTOR_VERSION && meta.sig === sig,
    doneYears: years.length - pendingYears.length,
    totalYears: years.length,
    from,
    backfillComplete,
    pendingYears,
    state,
    meta,
  };
}

export interface EventColumnsResult {
  v: number;
  sig: string;
  /** 这次补了哪几年 */
  years: number[];
  rows: number;
  /** 还剩几年 */
  remaining: number;
  complete: boolean;
  batch: number | null;
  /** 没补的原因（S15 的回填还没完成） */
  skipped?: "backfill_incomplete";
}

/**
 * 补算还没补的年份（最多 maxYears 年，默认全部）。每年一段：在 wh.exclusive 里一条 UPDATE，然后记进度。
 * force：清掉当前签名的进度与完成标记，从头补。
 */
export async function backfillEventColumns(
  ctx: Pick<EtlContext, "wh" | "log">,
  market: "A",
  o: { maxYears?: number; force?: boolean } = {},
): Promise<EventColumnsResult> {
  if (market !== "A") throw new Error("事件因子只有 A 股");
  const { wh } = ctx;
  let st = await eventColumnsStatus(wh);
  if (!st.backfillComplete) {
    ctx.log("事件数据的历史回填还没完成，先不补算事件因子列");
    return {
      v: st.v,
      sig: st.sig,
      years: [],
      rows: 0,
      remaining: st.pendingYears.length,
      complete: false,
      batch: null,
      skipped: "backfill_incomplete",
    };
  }
  const task = eventColsTask(st.sig);
  if (o.force) {
    await wh.exclusive(async () => {
      await resetTask(wh, task);
      await wh.run(`DELETE FROM meta WHERE key = $k`, { k: EVENT_FACTORS_META });
    });
    st = await eventColumnsStatus(wh);
  }
  const todo = st.pendingYears.slice(0, o.maxYears ?? st.pendingYears.length);
  const batch = await openPitBatch({ wh }, "event_cols", PIT_DATASET_IDS, null);
  const years: number[] = [];
  let rows = 0;
  try {
    for (const y of todo) {
      const t0 = Date.now();
      const n = await wh.exclusive(async () => {
        const changed = await fillEventColumns(wh, "factors_daily", st.state, `${y}-01-01`, `${y}-12-31`);
        await markDone(wh, task, String(y), JSON.stringify({ rows: changed, batch }));
        return changed;
      });
      rows += n;
      years.push(y);
      ctx.log(`事件因子补算 ${y} 年：${n} 行，用时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
    }
    const remaining = st.pendingYears.length - years.length;
    if (remaining === 0) {
      const meta: EventFactorsMeta = { v: st.v, sig: st.sig, complete: true, batch };
      await wh.exclusive(() => wh.setMeta(EVENT_FACTORS_META, JSON.stringify(meta)));
    }
    await finishBatch(wh, batch, "ok", years.length, rows, `补算 ${years.join("、") || "无"}；还剩 ${remaining} 年`);
    return { v: st.v, sig: st.sig, years, rows, remaining, complete: remaining === 0, batch };
  } catch (e) {
    await finishBatch(wh, batch, "failed", years.length, rows, errMsg(e).slice(0, 300)).catch(() => undefined);
    throw e;
  }
}

async function finishBatch(
  wh: Warehouse,
  id: number,
  status: "ok" | "failed",
  chunks: number,
  rows: number,
  note: string,
): Promise<void> {
  await wh.exclusive(() =>
    wh.run(
      `UPDATE pit_batches SET finished_at = current_timestamp, status = $s, chunks = $c, rows = $r,
         requests = 0, note = $n WHERE id = $id`,
      { id, s: status, c: chunks, r: rows, n: note },
    ),
  );
}

/**
 * 四个点时事件数据集的规格（D80，与来源无关）：表、写法、窗口、分块、可得日规则与行的列序。
 * 来源的报表与列名不在这里（见 sources/adapters/eastmoney-events.ts），运行器只认这里与 PitFetcher。
 *
 * 可得日：
 * - 两融、大宗：日期之后的下一个交易日（T 日数据 T+1 才进因子；深市两融实测 T+1 才有）；
 * - 股东户数：公告日，绝不用截至日；
 * - 限售解禁：首发且上市日 ≤ 解禁日 → 上市日（ipo_terms）；其他 → 解禁日前 LOCKUP_NOTICE_LEAD_TD 个交易日（notice_bound，
 *   超出日历且没有休市日表时 notice_bound:weekday）；首次见到的日子更早时以首次见到为准（first_seen）。
 */
import {
  addDays,
  type DateStr,
  LOCKUP_NOTICE_LEAD_TD,
  type LockupAvailRule,
  type PitDatasetId,
} from "@ivan/core";
import type { BlockRow, HolderRow, LockupRow, MarginRow, PitChunk } from "../sources/types.ts";
import type { AvailEnv } from "./trading-days.ts";

export interface PitStamp {
  src: string | null;
  ver: number | null;
  batch: number;
  today: DateStr;
}

/** 合并写的表在库里已有的那一行（键相同） */
export interface ExistingRow {
  first_seen: DateStr;
  gone_from: DateStr | null;
}

export interface PitDataset<R> {
  id: PitDatasetId;
  table: string;
  /** replace：按块整窗替换；merge：新键追加、已有键更新、消失的键设 gone_from */
  write: "replace" | "merge";
  /** 窗口列（整窗替换删的范围、合并时判断「消失」的范围） */
  windowColumn: string;
  /** 键列（合并、数据问题的对比） */
  keyColumns: readonly string[];
  chunking: "trading_day" | "month" | "year";
  /** 有「数据到哪天」的数据集（两融、大宗）：window_through 记最后一个完整的数据日 */
  hasWindowThrough: boolean;
  nightly(env: AvailEnv): PitChunk[];
  check(env: AvailEnv): PitChunk[];
  backfill(env: AvailEnv, from: DateStr, to?: DateStr): PitChunk[];
  /** 写之前整块加工一次（大宗交易编块内序号）；不给就原样 */
  prepare?(rows: readonly unknown[]): R[];
  avail(r: R, env: AvailEnv, existing?: ExistingRow): { date: DateStr; rule: string };
  /** 行在窗口列上的日期 */
  dateOf(r: R): DateStr;
  codeOf(r: R): string;
  /** 键（与 keyColumns 同序，用 | 连起来）；整窗替换的表按块内排好的序号算 */
  key(r: R): string;
  /** 一行按表的列序给值 */
  toRow(r: R, avail: { date: DateStr; rule: string }, stamp: PitStamp, existing?: ExistingRow): unknown[];
}

const chunkOf = (prefix: string, from: DateStr, to: DateStr): PitChunk => ({
  id: from === to ? `${prefix}${from}` : `${prefix}${from}~${to}`,
  from,
  to,
});

/** [from, to] 按自然月切块（块 id = YYYY-MM） */
export function monthChunks(from: DateStr, to: DateStr): PitChunk[] {
  const out: PitChunk[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  for (;;) {
    const start = `${y}-${String(m).padStart(2, "0")}-01`;
    if (start > to) break;
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    const end = addDays(`${ny}-${String(nm).padStart(2, "0")}-01`, -1);
    out.push({ id: start.slice(0, 7), from: start < from ? from : start, to: end > to ? to : end });
    y = ny;
    m = nm;
  }
  return out;
}

/** [fromYear, toYear] 按自然年切块（块 id = YYYY） */
export function yearChunks(fromYear: number, toYear: number): PitChunk[] {
  const out: PitChunk[] = [];
  for (let y = fromYear; y <= toYear; y++) out.push({ id: String(y), from: `${y}-01-01`, to: `${y}-12-31` });
  return out;
}

/** 日期所在自然月的最后一天 */
function monthEndOf(d: DateStr): DateStr {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  return addDays(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`, -1);
}

/**
 * 按月回填的块总是整月：起点往前取到月初，带 to 时往后取到月末；只有含今天的那一块截到今天（之后的日子归夜间与周检）。
 * 块 id 只认月份，同一个 id 必须总是同一段：截短的块记成 done 之后，再从更早的起点（或不带 to）回填会把它当成做完跳过，
 * 缺的那段永远补不上，覆盖起点却照样前移。
 */
export function backfillMonths(env: AvailEnv, from: DateStr, to?: DateStr): PitChunk[] {
  const end = to && monthEndOf(to) < env.today ? monthEndOf(to) : env.today;
  return monthChunks(`${from.slice(0, 7)}-01`, end);
}

export const MARGIN: PitDataset<MarginRow> = {
  id: "margin",
  table: "margin_daily",
  write: "replace",
  windowColumn: "date",
  keyColumns: ["code", "date"],
  chunking: "trading_day",
  hasWindowThrough: true,
  // 前两个交易日（部分未到齐的日子由运行器另外加上）
  nightly(env) {
    const p1 = env.prevTd(env.today);
    const p2 = env.prevTd(p1);
    return [chunkOf("", p2, p2), chunkOf("", p1, p1)];
  },
  // 周检不另扫两融：未到齐的日子由夜间重取
  check: () => [],
  backfill(env, from, to) {
    const end = to ?? env.prevTd(env.today);
    return env.tradingDays(from, end).map((d) => chunkOf("", d, d));
  },
  avail: (r, env) => ({ date: env.nextTd(r.date), rule: "td+1" }),
  dateOf: (r) => r.date,
  codeOf: (r) => r.code,
  key: (r) => `${r.code}|${r.date}`,
  toRow: (r, a, s) => [
    r.code,
    r.date,
    a.date,
    r.rzye,
    r.rzmre,
    r.rzche,
    r.rqye,
    r.rqyl,
    r.floatMcap,
    r.rzyezb,
    s.src,
    s.ver,
    s.batch,
  ],
};

export const HOLDERS: PitDataset<HolderRow> = {
  id: "holders",
  table: "holder_counts",
  write: "merge",
  windowColumn: "notice_date",
  keyColumns: ["code", "end_date", "notice_date"],
  chunking: "month",
  hasWindowThrough: false,
  nightly: (env) => [chunkOf("", addDays(env.today, -14), env.today)],
  check: (env) => [chunkOf("", addDays(env.today, -120), env.today)],
  backfill: backfillMonths,
  // 可得日 = 公告日，绝不用截至日（截至 6 月 30 日、8 月 1 日公告的户数，7 月 31 日看不到）
  avail: (r) => ({ date: r.noticeDate, rule: "notice" }),
  dateOf: (r) => r.noticeDate,
  codeOf: (r) => r.code,
  key: (r) => `${r.code}|${r.endDate}|${r.noticeDate}`,
  toRow: (r, a, s, ex) => [
    r.code,
    r.endDate,
    r.noticeDate,
    a.date,
    r.holderNum,
    r.preHolderNum,
    r.preEndDate,
    ex?.first_seen ?? s.today,
    s.today,
    null,
    s.src,
    s.ver,
    s.batch,
  ],
};

/** 解禁的规则日（不看首次见到） */
export function lockupRuleDate(
  r: Pick<LockupRow, "code" | "freeDate" | "type">,
  env: AvailEnv,
): { date: DateStr; rule: LockupAvailRule } {
  const list = env.listDate(r.code);
  if (/^首发/.test(r.type) && list && list <= r.freeDate) return { date: list, rule: "ipo_terms" };
  const s = env.shiftTd(r.freeDate, -LOCKUP_NOTICE_LEAD_TD);
  return { date: s.date, rule: s.basis === "weekday" ? "notice_bound:weekday" : "notice_bound" };
}

export const LOCKUPS: PitDataset<LockupRow> = {
  id: "lockups",
  table: "lockups",
  write: "merge",
  windowColumn: "free_date",
  keyColumns: ["code", "free_date", "type"],
  chunking: "year",
  hasWindowThrough: false,
  nightly: (env) => [chunkOf("", addDays(env.today, -7), addDays(env.today, 180))],
  check: (env) => [chunkOf("", addDays(env.today, -30), addDays(env.today, 365))],
  // 整年（起点往前取到年初，理由同 backfillMonths）；不带 to 时多补明年（已排定的解禁）
  backfill: (env, from, to) =>
    yearChunks(Number(from.slice(0, 4)), Number((to ?? env.today).slice(0, 4)) + (to ? 0 : 1)),
  avail(r, env, existing) {
    const rule = lockupRuleDate(r, env);
    const firstSeen = existing?.first_seen ?? env.today;
    return firstSeen < rule.date ? { date: firstSeen, rule: "first_seen" } : rule;
  },
  dateOf: (r) => r.freeDate,
  codeOf: (r) => r.code,
  key: (r) => `${r.code}|${r.freeDate}|${r.type}`,
  toRow: (r, a, s, ex) => [
    r.code,
    r.freeDate,
    r.type,
    r.unlockShares,
    r.ableShares,
    r.floatAfter,
    r.ratioFloat,
    r.ratioTotal,
    a.date,
    a.rule,
    ex?.first_seen ?? s.today,
    s.today,
    null,
    s.src,
    s.ver,
    s.batch,
  ],
};

/** 大宗交易一笔带上块内序号 */
export type SeqBlockRow = BlockRow & { seq: number };

/**
 * 同一（代码, 成交日）里的序号：按成交额降序、成交价、数量、买方机构、卖方机构排，完全相同的几笔按出现顺序。
 * 结果与输入顺序无关（相同的笔数之间互换不改变写入的行）。
 */
export function sequenceBlocks(rows: readonly BlockRow[]): SeqBlockRow[] {
  const n = (v: number | null) => (v === null ? -Infinity : v);
  const sorted = [...rows].sort(
    (a, b) =>
      a.code.localeCompare(b.code) ||
      a.tradeDate.localeCompare(b.tradeDate) ||
      n(b.dealAmount) - n(a.dealAmount) ||
      n(a.dealPrice) - n(b.dealPrice) ||
      n(a.dealVolume) - n(b.dealVolume) ||
      Number(a.buyerInst) - Number(b.buyerInst) ||
      Number(a.sellerInst) - Number(b.sellerInst),
  );
  const out: SeqBlockRow[] = [];
  let prev = "";
  let seq = 0;
  for (const r of sorted) {
    const k = `${r.code}|${r.tradeDate}`;
    seq = k === prev ? seq + 1 : 1;
    prev = k;
    out.push({ ...r, seq });
  }
  return out;
}

export const BLOCKS: PitDataset<SeqBlockRow> = {
  id: "blocks",
  table: "block_trades",
  write: "replace",
  windowColumn: "trade_date",
  keyColumns: ["code", "trade_date", "seq"],
  chunking: "month",
  hasWindowThrough: true,
  nightly: (env) => [chunkOf("", addDays(env.today, -7), env.today)],
  check: (env) => [chunkOf("", addDays(env.today, -30), env.today)],
  backfill: backfillMonths,
  prepare: (rows) => sequenceBlocks(rows as BlockRow[]),
  avail: (r, env) => ({ date: env.nextTd(r.tradeDate), rule: "td+1" }),
  dateOf: (r) => r.tradeDate,
  codeOf: (r) => r.code,
  key: (r) => `${r.code}|${r.tradeDate}|${r.seq}`,
  toRow: (r, a, s) => [
    r.code,
    r.tradeDate,
    r.seq,
    a.date,
    r.dealPrice,
    r.closePrice,
    r.premium,
    r.dealVolume,
    r.dealAmount,
    r.buyerInst,
    r.sellerInst,
    s.src,
    s.ver,
    s.batch,
  ],
};

export const PIT_DATASET_SPECS: Record<PitDatasetId, PitDataset<unknown>> = {
  margin: MARGIN as PitDataset<unknown>,
  holders: HOLDERS as PitDataset<unknown>,
  lockups: LOCKUPS as PitDataset<unknown>,
  blocks: BLOCKS as PitDataset<unknown>,
};

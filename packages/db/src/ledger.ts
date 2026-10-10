/**
 * 决策账本（D68）：每个用户一条只追加的哈希链。
 *
 * - hash = sha256Canonical({seq, prevHash, kind, subjectType, subjectId, asOf, payloadHash, createdAt})，第一条的 prevHash 是 64 个 0；
 * - 追加在 IMMEDIATE 事务里读链尾、算哈希、插入：server 与 worker 两个进程同时追加也不会分叉；
 *   已经在事务里（结算的整段写入先用 IMMEDIATE 拿了写锁）时 better-sqlite3 自动用保存点；
 * - inline 条目的内容压缩存在本行（payload_z），payloadHash = sha256Canonical(内容)；指向别的表（计划快照）时
 *   payloadHash 是那一行的内容指纹，校验时按那张表重算。
 *
 * 单机自部署时管理员能改数据库文件：链证明的是「内部一致、改动能被发现」，不是第三方不可抵赖。
 */
import { sha256Canonical } from "@ivan/core/node";
import { asc, eq } from "drizzle-orm";
import type { AppDbHandle } from "./index.ts";
import { newId, packJson, unpackJson } from "./util.ts";
import { briefEditionHashOf } from "./briefs.ts";
import { planContentHashOf } from "./plans.ts";
import { ledgerEntries } from "./schema.ts";

export const GENESIS = "0".repeat(64);

export type LedgerKind =
  "plan" | "replay_drift" | "tracking_start" | "tracking_stop" | "health_transition" | "brief";

export type LedgerSubject = "tracking" | "user";

export type LedgerPayloadTable = "plan_snapshots" | "brief_editions" | "inline";

export interface RecordHashInput {
  seq: number;
  prevHash: string;
  kind: string;
  subjectType: string;
  subjectId: string;
  asOf: string | null;
  payloadHash: string;
  createdAt: number;
}

export function recordHash(e: RecordHashInput): string {
  return sha256Canonical({
    seq: e.seq,
    prevHash: e.prevHash,
    kind: e.kind,
    subjectType: e.subjectType,
    subjectId: e.subjectId,
    asOf: e.asOf,
    payloadHash: e.payloadHash,
    createdAt: e.createdAt,
  });
}

export interface AppendInput {
  userId: string;
  kind: LedgerKind;
  subjectType: LedgerSubject;
  subjectId: string;
  asOf: string | null;
  payloadTable: LedgerPayloadTable;
  payloadId?: string | null;
  /** inline 的内容 */
  payload?: unknown;
  /** 指向别的表时必须给（那一行的内容指纹） */
  payloadHash?: string;
}

/** 追加一条：单独调用时开 IMMEDIATE 事务；在已打开的事务里调用时是保存点 */
export function appendLedger(
  h: AppDbHandle,
  e: AppendInput,
): { id: string; seq: number; hash: string } {
  let payloadZ: Buffer | null = null;
  let payloadHash: string;
  if (e.payloadTable === "inline") {
    const payload = e.payload ?? null;
    payloadZ = packJson(payload);
    payloadHash = sha256Canonical(payload);
  } else {
    if (!e.payloadHash) throw new Error(`账本条目指向 ${e.payloadTable} 时必须给内容指纹`);
    payloadHash = e.payloadHash;
  }
  const run = h.sqlite.transaction(() => {
    const last = h.sqlite
      .prepare(`SELECT seq, hash FROM ledger_entries WHERE user_id = ? ORDER BY seq DESC LIMIT 1`)
      .get(e.userId) as { seq: number; hash: string } | undefined;
    const seq = (last?.seq ?? 0) + 1;
    const prevHash = last?.hash ?? GENESIS;
    const createdAt = Date.now();
    const hash = recordHash({
      seq,
      prevHash,
      kind: e.kind,
      subjectType: e.subjectType,
      subjectId: e.subjectId,
      asOf: e.asOf,
      payloadHash,
      createdAt,
    });
    const id = newId("le_");
    h.db
      .insert(ledgerEntries)
      .values({
        id,
        userId: e.userId,
        seq,
        kind: e.kind,
        subjectType: e.subjectType,
        subjectId: e.subjectId,
        asOf: e.asOf,
        payloadTable: e.payloadTable,
        payloadId: e.payloadId ?? null,
        payloadZ,
        payloadHash,
        prevHash,
        hash,
        createdAt,
      })
      .run();
    return { id, seq, hash };
  });
  // 已在事务里时 better-sqlite3 用 SAVEPOINT（immediate 只影响最外层的 BEGIN）
  return run.immediate();
}

export type LedgerRow = typeof ledgerEntries.$inferSelect;

export type ChainBreakReason =
  | "seq_gap"
  | "prev_hash_mismatch"
  | "record_hash_mismatch"
  | "payload_hash_mismatch"
  | "payload_missing";

export interface ChainBreak {
  seq: number;
  reason: ChainBreakReason;
}

export interface ChainVerdict {
  ok: boolean;
  checked: number;
  /** 最后一条的哈希（导出时带出去才能对外证明，S11）；没有条目时是 GENESIS */
  headHash: string;
  firstBreak?: ChainBreak;
}

/**
 * 校验一条链（按 seq 升序的行）：序号连续、前一哈希相符、记录哈希相符、内容指纹相符。
 * payloadOf 按行重算内容指纹；返回 null 表示内容找不到。
 */
export function verifyChain(
  rows: readonly LedgerRow[],
  payloadOf: (r: LedgerRow) => string | null,
): ChainVerdict {
  let prev = GENESIS;
  let checked = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const fail = (reason: ChainBreakReason): ChainVerdict => ({
      ok: false,
      checked,
      headHash: rows.at(-1)!.hash,
      firstBreak: { seq: r.seq, reason },
    });
    if (r.seq !== i + 1) return fail("seq_gap");
    if (r.prevHash !== prev) return fail("prev_hash_mismatch");
    const h = recordHash({
      seq: r.seq,
      prevHash: r.prevHash,
      kind: r.kind,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      asOf: r.asOf,
      payloadHash: r.payloadHash,
      createdAt: r.createdAt,
    });
    if (h !== r.hash) return fail("record_hash_mismatch");
    const p = payloadOf(r);
    if (p === null) return fail("payload_missing");
    if (p !== r.payloadHash) return fail("payload_hash_mismatch");
    prev = r.hash;
    checked++;
  }
  return { ok: true, checked, headHash: prev };
}

/** 按库里存的内容重算一条的内容指纹：inline 解压后哈希；计划快照按快照与计划项、简报按那一版重算内容指纹 */
export function storedPayloadHash(h: AppDbHandle, r: LedgerRow): string | null {
  if (r.payloadTable === "inline") {
    if (!r.payloadZ) return null;
    try {
      return sha256Canonical(unpackJson<unknown>(r.payloadZ));
    } catch {
      return null;
    }
  }
  if (r.payloadTable === "plan_snapshots" && r.payloadId) return planContentHashOf(h, r.payloadId);
  if (r.payloadTable === "brief_editions" && r.payloadId) return briefEditionHashOf(h, r.payloadId);
  return null;
}

/** 重算一个用户的整条链 */
export function verifyUserChain(h: AppDbHandle, userId: string): ChainVerdict {
  const rows = h.db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.userId, userId))
    .orderBy(asc(ledgerEntries.seq))
    .all();
  return verifyChain(rows, (r) => storedPayloadHash(h, r));
}

/**
 * 决策账本（D68、D71）给人看的文字：链校验断在哪里。网页（lib/format.ts 再导出）、`pnpm admin verify-bundle` 共用一张表。
 */

export type LedgerBreakReason =
  | "seq_gap"
  | "prev_hash_mismatch"
  | "record_hash_mismatch"
  | "payload_hash_mismatch"
  | "payload_missing"
  | "head_hash_mismatch"
  | "manifest_hash_mismatch"
  | "malformed";

export const LEDGER_BREAK_TEXT: Record<LedgerBreakReason, string> = {
  seq_gap: "序号断开",
  prev_hash_mismatch: "前一哈希不符",
  record_hash_mismatch: "记录哈希不符",
  payload_hash_mismatch: "内容哈希不符",
  payload_missing: "内容缺失",
  head_hash_mismatch: "链头哈希不符",
  manifest_hash_mismatch: "清单指纹不符",
  malformed: "文件格式不对",
};

/**
 * 复核 / 完整重跑的显示规则（纯函数，回测页用，单测覆盖）：结果不同的原因文案、徽标状态、轮询节奏，
 * 以及管理员额度编辑器「只提交改过的项」。
 */
import type { RunDetail, RunVerify } from "./types.ts";

/** 完整重跑结果不同的原因（和跟踪漂移归因同一个判断） */
export function reproReason(v: RunVerify): string {
  switch (v.cause) {
    case "data":
      return "数据已修订";
    case "engine":
      return "引擎不同";
    case "exec":
      return "成交假设不同";
    case "unrecorded":
      return v.sameInput === null || v.sameInput === undefined
        ? "原回测早于指纹记录，分不清是数据修订还是引擎不同"
        : "指纹口径升级过";
    default:
      return "原因不明（已记录，属于程序问题）";
  }
}

export type VerifyBadgeState =
  | { kind: "queued" }
  | { kind: "running" }
  | { kind: "failed"; error: string | null }
  | { kind: "full"; same: boolean; reason: string | null; reproRunId: string | null }
  | { kind: "unrecorded" }
  | { kind: "hashVersion" }
  | { kind: "input"; same: boolean };

/** 原运行上的复核结果该显示什么（null = 不显示） */
export function verifyBadgeState(v: RunVerify | null | undefined): VerifyBadgeState | null {
  if (!v) return null;
  if (v.status === "queued") return { kind: "queued" };
  if (v.status === "running") return { kind: "running" };
  if (v.status === "failed") return { kind: "failed", error: v.error ?? null };
  if (v.kind === "full")
    return {
      kind: "full",
      same: !!v.sameResult,
      reason: v.sameResult ? null : reproReason(v),
      reproRunId: v.reproRunId ?? null,
    };
  if (v.reason === "unrecorded") return { kind: "unrecorded" };
  if (v.hashVersionSame === false) return { kind: "hashVersion" };
  return { kind: "input", same: !!v.sameInput };
}

/** 复核或比对还在进行（排队 / 运行中） */
export function verifyInFlight(v: RunVerify | null | undefined): boolean {
  return v?.status === "queued" || v?.status === "running";
}

/** 重跑跑完后最多等比对结果这么久，超时就不再轮询（比对结果写不回来时不至于一直轮询） */
export const REPRO_COMPARE_WAIT_MS = 2 * 60_000;

/** 重跑页上「和原回测比」的结论：只认写给这次重跑的 full 结果 */
export function reproVerdict(r: Pick<RunDetail, "id" | "verify">): RunVerify | null {
  const v = r.verify;
  return v?.kind === "full" && (v.status === "failed" || v.reproRunId === r.id) ? v : null;
}

/** 暂停回测时给用户看的一句话（和 worker、对话工具同一句，D60） */
export const COMPUTE_PAUSED_TEXT = "行情正在更新，回测会在更新完成后开始";

/**
 * 排队中的回测或复核是不是在等夜间更新写完行情仓（D60）：是就返回提示文案，否则 null。
 * 只对还在排队的说；已经在跑的不受影响。
 */
export function computePausedNote(
  r: Pick<RunDetail, "status" | "verify" | "computePaused"> | undefined,
): string | null {
  if (!r?.computePaused) return null;
  return r.status === "queued" || r.verify?.status === "queued" ? COMPUTE_PAUSED_TEXT : null;
}

/** 回测页轮询间隔（毫秒，false = 不轮询） */
export function runPollInterval(
  d: Pick<RunDetail, "id" | "kind" | "status" | "verify" | "finishedAt"> | undefined,
  now = Date.now(),
): number | false {
  if (!d || (d.status !== "done" && d.status !== "failed")) return 1500;
  // 复核排队或进行中：每 2 秒看一次结果
  if (verifyInFlight(d.verify)) return 2000;
  // 重跑刚跑完、比对结果还没写回（有终态或等太久就停）
  if (
    d.kind === "reproduce" &&
    d.status === "done" &&
    !reproVerdict(d) &&
    (d.finishedAt === null || now - d.finishedAt < REPRO_COMPARE_WAIT_MS)
  )
    return 1500;
  return false;
}

/** 额度编辑器：只提交改过的项，没动的不会被钉成当前默认值 */
export function quotaPatch<K extends string>(
  initial: Record<K, string>,
  values: Record<K, string>,
): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const k of Object.keys(values) as K[]) {
    if (values[k] !== initial[k]) out[k] = Number(values[k]);
  }
  return out;
}

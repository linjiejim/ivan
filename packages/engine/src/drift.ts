/**
 * 漂移归因（D57，纯函数）：跟踪每晚重放与上一晚存下的历史不一致时，说清是哪一种原因。
 * 计划快照的版次原因（S08）也用 `changeCause`，两处只有一套判断顺序：
 * 没记录 → 引擎 → 指纹口径 → 成交假设 → 数据。引擎与成交假设只在部署或显式升级时变，同时发生时归给它们更准确。
 */
import type { ReplayCheck } from "./replay.ts";

export interface Fingerprint {
  engineVersion?: string | null;
  hashVersion?: number | null;
  execHash?: string | null;
  /** 数据指纹（按位比较）；跟踪漂移只有一个前缀指纹 */
  data?: Array<string | number | null> | null;
}

export type ChangeCause = "unrecorded" | "engine" | "exec" | "data" | "none";

export function changeCause(prev: Fingerprint, cur: Fingerprint): ChangeCause {
  if (!prev.engineVersion || !prev.data) return "unrecorded";
  if (prev.engineVersion !== cur.engineVersion) return "engine";
  if ((prev.hashVersion ?? null) !== (cur.hashVersion ?? null)) return "unrecorded";
  if ((prev.execHash ?? null) !== (cur.execHash ?? null)) return "exec";
  const a = prev.data;
  const b = cur.data ?? [];
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) return "data";
  return "none";
}

export type DriftCause = "none" | "unrecorded" | "engine" | "exec" | "data" | "unexplained";

export interface DriftPrev {
  engineVersion?: string | null;
  execHash?: string | null;
  prefixHash?: string | null;
  hashVersion?: number | null;
}

export interface DriftCur {
  engineVersion: string;
  execHash: string;
  /** 今晚按 cut = 上一晚的最后结算日、rule = executed 重算的前缀指纹（上一晚没有结算日时为 null） */
  prefixHash: string | null;
  hashVersion: number;
}

export function attributeDrift(
  prev: DriftPrev,
  cur: DriftCur,
  replay: ReplayCheck,
): { cause: DriftCause; text: string } {
  if (replay.navDrift + replay.benchDrift === 0) return { cause: "none", text: "与上次一致" };
  const cause = changeCause(
    {
      engineVersion: prev.engineVersion,
      hashVersion: prev.hashVersion,
      execHash: prev.execHash,
      data: prev.prefixHash ? [prev.prefixHash] : null,
    },
    {
      engineVersion: cur.engineVersion,
      hashVersion: cur.hashVersion,
      execHash: cur.execHash,
      data: [cur.prefixHash],
    },
  );
  switch (cause) {
    case "data":
      return { cause, text: `数据被修订过（${replay.firstDrift ?? "--"} 起）` };
    case "engine":
      return { cause, text: `引擎从 ${prev.engineVersion} 升级到 ${cur.engineVersion}` };
    case "exec":
      return { cause, text: "成交假设改过" };
    case "unrecorded":
      return {
        cause,
        text: "数据或引擎变过（上线早于指纹记录或指纹口径升级过，分不清是哪一种）",
      };
    case "none":
      return { cause: "unexplained", text: "原因不明（已记录，属于程序问题）" };
  }
}

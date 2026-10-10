/**
 * 决策回溯的导出文件（D71）：一个跟踪的决策记录，任何人拿到文件都能自己重算校验。
 *
 * - entries 是这个用户的整条账本链（从第 1 条到导出时的链尾）：本跟踪的条目给全部字段，内容放在 payloads[seq]；
 *   别的跟踪的条目、简报条目（简报事实覆盖用户的全部跟踪）只给 {seq, prevHash, hash, foreign: true}，不泄露内容与对象；
 * - 本跟踪的计划条目，内容 = 计划快照参与内容指纹的那部分（planContent）；inline 条目，内容 = 原样的 JSON；
 *   两种都是 payloadHash = sha256Canonical(payloads[seq])；
 * - manifest 是各算法版本，manifestHash = sha256Canonical(manifest)，不含时间戳（同一版程序导出的清单指纹相同）；
 * - verification 用中英文写清 canonicalJson 与每种哈希的输入，verifyBundle 是参考实现（`pnpm admin verify-bundle`）。
 */
import { LEDGER_BREAK_TEXT, type LedgerBreakReason } from "@ivan/core";
import { sha256Canonical } from "@ivan/core/node";
import { and, asc, eq } from "drizzle-orm";
import type { AppDbHandle } from "./index.ts";
import { GENESIS, recordHash, verifyUserChain } from "./ledger.ts";
import { planContent, planItemsOf, snapshotContentOf } from "./plans.ts";
import { ledgerEntries, planSnapshots, trackingHealth } from "./schema.ts";
import { unpackJson } from "./util.ts";

export const BUNDLE_VERSION = 1;

/** 本跟踪的条目：账本行的全部字段（内容在 payloads[String(seq)]） */
export interface OwnEntry {
  seq: number;
  kind: string;
  subjectType: string;
  subjectId: string;
  asOf: string | null;
  payloadTable: string;
  payloadId: string | null;
  payloadHash: string;
  prevHash: string;
  hash: string;
  createdAt: number;
}

/** 别的跟踪与简报的条目：只有序号与哈希，用来接上链 */
export interface ForeignEntry {
  seq: number;
  prevHash: string;
  hash: string;
  foreign: true;
}

export type BundleEntry = OwnEntry | ForeignEntry;

export interface BundleManifest {
  engineVersion: string;
  /** 注册表版本只是说明（第 3 版起不决定数值）；决定因子值的是下面两个 */
  factorRegistryVersion: number;
  explainVersion: number;
  groundingVersion: number;
  healthVersion: number;
  validationVersion: number;
  hashVersion: number;
  /** 核心因子的计算版本（之后导出的文件才有；旧文件没有这几个键，清单指纹按文件里写的重算，不受影响） */
  factorCoreVersion?: number;
  /** 事件因子（两融与筹码）SQL 的版本 */
  eventFactorVersion?: number;
  /** 证据的版本 */
  evidenceVersion?: number;
}

/** 计划快照里不进内容指纹的元信息：版次、原因与各维度的指纹（任何人都能据此重算版次原因）；不参与校验 */
export interface BundlePlanMeta {
  snapshotId: string;
  decisionDate: string;
  edition: number;
  cause: string;
  dataVersion: number | null;
  dataAsOf: string | null;
  engineVersion: string;
  execHash: string;
  inputHash: string | null;
  hashVersion: number;
  explainHash: string | null;
  explainVersion: number | null;
  factorRegistryVersion: number | null;
  band: number | null;
  benchSym: string | null;
  benchClose: number | null;
  contentHash: string;
}

export interface TraceBundle {
  bundleVersion: typeof BUNDLE_VERSION;
  generatedAt: string;
  tracking: {
    id: string;
    strategyName: string;
    versionId: string;
    specHash: string;
    spec: unknown;
    startDate: string;
    capital: number;
    exec: unknown;
  };
  baselineRun: { id: string; params: unknown; card: unknown } | null;
  entries: BundleEntry[];
  payloads: Record<string, unknown>;
  plans: Record<string, BundlePlanMeta>;
  health: Array<{ date: string; signal: string; state: string }>;
  chain: { ok: boolean; checked: number; headHash: string };
  manifest: BundleManifest;
  manifestHash: string;
  verification: { canonicalJson: string; hashes: Record<string, string> };
}

export const BUNDLE_VERIFICATION: TraceBundle["verification"] = {
  canonicalJson: [
    "canonicalJson(v)：对象的键按字符串排序（JavaScript 默认排序），值为 undefined 的键丢掉；数组保持原顺序；",
    "数字与字符串按 JSON.stringify 输出（NaN、Infinity 输出 null），不做舍入；没有空格。sha256 取 UTF-8 字节的十六进制小写，全长 64 位。",
    "canonicalJson(v): object keys sorted (JavaScript default string order), keys whose value is undefined dropped;",
    "arrays keep their order; numbers and strings exactly as JSON.stringify (NaN/Infinity become null), no rounding, no whitespace.",
    "sha256 is over the UTF-8 bytes, lower-case hex, 64 characters.",
  ].join("\n"),
  hashes: {
    recordHash: [
      "每条本跟踪条目：hash = sha256(canonicalJson({seq, prevHash, kind, subjectType, subjectId, asOf, payloadHash, createdAt}))；",
      "第 1 条的 prevHash 是 64 个 0，之后每条（包括 foreign 条目）的 prevHash 等于上一条的 hash，seq 从 1 起连续。",
      "Own entry: hash = sha256(canonicalJson({seq, prevHash, kind, subjectType, subjectId, asOf, payloadHash, createdAt})).",
      "The first prevHash is 64 zeros; every entry's prevHash (foreign ones included) equals the previous entry's hash; seq starts at 1 and is contiguous.",
    ].join("\n"),
    planPayload: [
      "计划条目（payloadTable = plan_snapshots）：payloadHash = sha256(canonicalJson(payloads[seq]))。payloads[seq] 是快照参与内容指纹的字段：",
      "{trackingId, decisionDate, planDate, versionId, specHash, regime, exposure: {current, next} | null, equity, cash, positions, candidates,",
      "items: [{seq, code, name, side, reason, reasonDetail, rank, score, estPrice, estShares, estWeight, refClose, curWeight, failedConditions, factors, termPct}]}",
      "（计划项按 seq 排，缺省值都是 null）。plans[payloadId] 里的版次、原因与指纹不参与校验。",
      "Plan entry: payloadHash = sha256(canonicalJson(payloads[seq])), where the payload is the snapshot's content fields listed above",
      "(items sorted by seq, missing values null). plans[payloadId] (edition, cause, fingerprints) is informational and not hashed.",
    ].join("\n"),
    inlinePayload: [
      "其余本跟踪条目（payloadTable = inline：上线、停止、重放差异、状态变化）：payloadHash = sha256(canonicalJson(payloads[seq]))。",
      "Inline entry (tracking_start, tracking_stop, replay_drift, health_transition): payloadHash = sha256(canonicalJson(payloads[seq])).",
    ].join("\n"),
    foreignEntry: [
      "foreign 条目（别的跟踪、简报）只有 {seq, prevHash, hash}：不能重算，但它们的 hash 被下一条的 prevHash 与记录哈希锁住。",
      "键必须正好是 {seq, prevHash, hash, foreign}（foreign 为 true），多一个键就算格式不对；本跟踪的条目也必须正好是上面列的那些键。",
      "payloads 的每个键都要是某条本跟踪条目的 seq，plans 的每个键都要是某条本跟踪计划条目的 payloadId：",
      "把本跟踪的条目改标成 foreign、却留着它的内容，校验不通过（内容没被哈希锁住，不能出现在文件里）。",
      "Foreign entries (other trackings, briefs) carry only {seq, prevHash, hash}; they cannot be recomputed but are pinned by the next entry's prevHash.",
      "A foreign entry must have exactly the keys {seq, prevHash, hash, foreign} (foreign = true); an own entry exactly the keys listed above.",
      "Every payloads key must be the seq of an own entry and every plans key the payloadId of an own plan entry,",
      "so re-labelling an own entry as foreign while keeping its content fails verification (unhashed content may not appear in the file).",
    ].join("\n"),
    headHash: [
      "chain.headHash 等于最后一条的 hash；把它记在别处（比如发给别人），以后就能证明这之前的记录没被改过。",
      "chain.headHash equals the last entry's hash; keep a copy elsewhere to prove later that nothing before it changed.",
    ].join("\n"),
    manifestHash: [
      "manifestHash = sha256(canonicalJson(manifest))，manifest 只有各算法的版本号，不含时间戳。",
      "manifestHash = sha256(canonicalJson(manifest)); the manifest holds algorithm versions only, no timestamps.",
    ].join("\n"),
  },
};

export interface BundleInput {
  userId: string;
  trackingId: string;
  tracking: TraceBundle["tracking"];
  baselineRun: TraceBundle["baselineRun"];
  manifest: BundleManifest;
  generatedAt?: string;
}

/**
 * 组装导出文件：整条链（本跟踪的条目带内容，其余只给哈希）、计划快照的元信息、健康读数、导出时的链校验。
 * 全部读在一个读事务里（WAL 快照）：worker 进程的夜间结算在中间追加条目时，导出的条目与链头仍是同一刻的，
 * 不会因为链头对不上被误报成篡改。
 */
export function buildTraceBundle(h: AppDbHandle, o: BundleInput): TraceBundle {
  return h.sqlite.transaction(() => buildTraceBundleAt(h, o))();
}

function buildTraceBundleAt(h: AppDbHandle, o: BundleInput): TraceBundle {
  const rows = h.db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.userId, o.userId))
    .orderBy(asc(ledgerEntries.seq))
    .all();
  const entries: BundleEntry[] = [];
  const payloads: Record<string, unknown> = {};
  const plans: Record<string, BundlePlanMeta> = {};
  for (const r of rows) {
    const own = r.subjectType === "tracking" && r.subjectId === o.trackingId;
    if (!own) {
      entries.push({ seq: r.seq, prevHash: r.prevHash, hash: r.hash, foreign: true });
      continue;
    }
    entries.push({
      seq: r.seq,
      kind: r.kind,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      asOf: r.asOf,
      payloadTable: r.payloadTable,
      payloadId: r.payloadId,
      payloadHash: r.payloadHash,
      prevHash: r.prevHash,
      hash: r.hash,
      createdAt: r.createdAt,
    });
    if (r.payloadTable === "inline") {
      if (r.payloadZ) payloads[String(r.seq)] = unpackJson<unknown>(r.payloadZ) ?? null;
    } else if (r.payloadTable === "plan_snapshots" && r.payloadId) {
      const s = h.db
        .select()
        .from(planSnapshots)
        .where(and(eq(planSnapshots.id, r.payloadId), eq(planSnapshots.trackingId, o.trackingId)))
        .get();
      if (!s) continue;
      payloads[String(r.seq)] = planContent(snapshotContentOf(s), planItemsOf(h, s.id));
      plans[s.id] = {
        snapshotId: s.id,
        decisionDate: s.decisionDate,
        edition: s.edition,
        cause: s.cause,
        dataVersion: s.dataVersion,
        dataAsOf: s.dataAsOf,
        engineVersion: s.engineVersion,
        execHash: s.execHash,
        inputHash: s.inputHash,
        hashVersion: s.hashVersion,
        explainHash: s.explainHash,
        explainVersion: s.explainVersion,
        factorRegistryVersion: s.factorRegistryVersion,
        band: s.band,
        benchSym: s.benchSym,
        benchClose: s.benchClose,
        contentHash: s.contentHash,
      };
    }
  }
  const health = h.db
    .select({
      date: trackingHealth.date,
      signal: trackingHealth.signal,
      state: trackingHealth.state,
    })
    .from(trackingHealth)
    .where(eq(trackingHealth.trackingId, o.trackingId))
    .orderBy(asc(trackingHealth.date))
    .all();
  const v = verifyUserChain(h, o.userId);
  return {
    bundleVersion: BUNDLE_VERSION,
    generatedAt: o.generatedAt ?? new Date().toISOString(),
    tracking: o.tracking,
    baselineRun: o.baselineRun,
    entries,
    payloads,
    plans,
    health,
    chain: { ok: v.ok, checked: v.checked, headHash: v.headHash },
    manifest: o.manifest,
    manifestHash: sha256Canonical(o.manifest),
    verification: BUNDLE_VERIFICATION,
  };
}

/** 链上的断点（ChainBreakReason）加上文件层面的：链头、清单指纹、格式 */
export type BundleBreakReason = LedgerBreakReason;

export interface BundleVerdict {
  ok: boolean;
  /** 校验过的条目数（foreign 条目只校验了序号与前一哈希） */
  checked: number;
  headHash: string;
  /** seq 为 null：问题不在某一条（清单指纹、文件格式） */
  firstBreak?: { seq: number | null; reason: BundleBreakReason };
}

/** 断点原因的文字（@ivan/core 的 LEDGER_BREAK_TEXT，网页与命令行同一张表） */
export const BUNDLE_BREAK_TEXT: Record<BundleBreakReason, string> = LEDGER_BREAK_TEXT;

const isObj = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);

const FOREIGN_KEYS = ["foreign", "hash", "prevHash", "seq"].join();
const OWN_KEYS = [
  "asOf",
  "createdAt",
  "hash",
  "kind",
  "payloadHash",
  "payloadId",
  "payloadTable",
  "prevHash",
  "seq",
  "subjectId",
  "subjectType",
].join();
const keysOf = (o: Record<string, unknown>) => Object.keys(o).sort().join();

/**
 * 离线校验一个导出文件（参考实现）：seq 连续、前一哈希接得上（foreign 条目也算）；本跟踪的条目重算记录哈希与内容哈希；
 * 条目的键集合固定（foreign 条目不能夹带内容）；payloads / plans 只能挂在本跟踪的条目上；
 * 链尾等于 chain.headHash；manifestHash 重算一致。只看文件本身，不读库。
 */
export function verifyBundle(input: unknown): BundleVerdict {
  const bad = (reason: BundleBreakReason, seq: number | null = null): BundleVerdict => ({
    ok: false,
    checked: 0,
    headHash: GENESIS,
    firstBreak: { seq, reason },
  });
  if (
    !isObj(input) ||
    !Array.isArray(input.entries) ||
    !isObj(input.payloads) ||
    !isObj(input.plans)
  ) {
    return bad("malformed");
  }
  const b = input as unknown as TraceBundle;
  let prev = GENESIS;
  let checked = 0;
  // 本跟踪条目的 seq、本跟踪计划条目的 payloadId：payloads / plans 只能挂在这些上面
  const ownSeqs = new Set<string>();
  const ownPlanIds = new Set<string>();
  for (let i = 0; i < b.entries.length; i++) {
    const e = b.entries[i]!;
    const fail = (reason: BundleBreakReason): BundleVerdict => ({
      ok: false,
      checked,
      headHash: prev,
      firstBreak: { seq: isObj(e) && typeof e.seq === "number" ? e.seq : null, reason },
    });
    if (!isObj(e)) return fail("malformed");
    if (e.seq !== i + 1) return fail("seq_gap");
    if (e.prevHash !== prev) return fail("prev_hash_mismatch");
    if ("foreign" in e) {
      // foreign 条目只能是 {seq, prevHash, hash, foreign: true}，也不能有内容：否则把本跟踪的条目改标成 foreign 就能绕过重算
      if (e.foreign !== true || keysOf(e) !== FOREIGN_KEYS || typeof e.hash !== "string") {
        return fail("malformed");
      }
      if (Object.prototype.hasOwnProperty.call(b.payloads, String(e.seq))) return fail("malformed");
    } else {
      if (keysOf(e) !== OWN_KEYS) return fail("malformed");
      const o = e as unknown as OwnEntry;
      const h = recordHash({
        seq: o.seq,
        prevHash: o.prevHash,
        kind: o.kind,
        subjectType: o.subjectType,
        subjectId: o.subjectId,
        asOf: o.asOf,
        payloadHash: o.payloadHash,
        createdAt: o.createdAt,
      });
      if (h !== o.hash) return fail("record_hash_mismatch");
      if (!Object.prototype.hasOwnProperty.call(b.payloads, String(o.seq))) {
        return fail("payload_missing");
      }
      if (sha256Canonical(b.payloads[String(o.seq)]) !== o.payloadHash) {
        return fail("payload_hash_mismatch");
      }
      ownSeqs.add(String(o.seq));
      if (o.payloadTable === "plan_snapshots" && typeof o.payloadId === "string") {
        ownPlanIds.add(o.payloadId);
      }
    }
    prev = e.hash as string;
    checked++;
  }
  if (!isObj(b.chain) || b.chain.headHash !== prev) {
    return {
      ok: false,
      checked,
      headHash: prev,
      firstBreak: { seq: null, reason: "head_hash_mismatch" },
    };
  }
  // 没挂在本跟踪条目上的内容与计划元信息：没被哈希锁住，不能出现在文件里
  const strayPayload = Object.keys(b.payloads).find((k) => !ownSeqs.has(k));
  if (strayPayload !== undefined) {
    const n = Number(strayPayload);
    return {
      ok: false,
      checked,
      headHash: prev,
      firstBreak: { seq: Number.isInteger(n) ? n : null, reason: "malformed" },
    };
  }
  if (Object.keys(b.plans).some((k) => !ownPlanIds.has(k))) {
    return { ok: false, checked, headHash: prev, firstBreak: { seq: null, reason: "malformed" } };
  }
  if (!isObj(b.manifest) || sha256Canonical(b.manifest) !== b.manifestHash) {
    return {
      ok: false,
      checked,
      headHash: prev,
      firstBreak: { seq: null, reason: "manifest_hash_mismatch" },
    };
  }
  return { ok: true, checked, headHash: prev };
}

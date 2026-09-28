/**
 * 策略、版本与草稿（D4，验收 6）。
 * LLM 与表单都只能「提议」：propose* 只写 drafts；只有用户点确认（confirmDraft）才生成版本或跟踪。
 */
import { createHash } from "node:crypto";
import {
  canonicalJson,
  describeSpec,
  type Market,
  PRESETS,
  type StrategySpec,
  validateSpec,
} from "@ivan/core";
import { drafts, newId, strategies, strategyVersions, trackings } from "@ivan/db";
import { and, desc, eq, inArray, max } from "drizzle-orm";
import { env } from "../env.ts";
import { AppError, notFound } from "../lib/errors.ts";
import { applyPatch, type PatchOp } from "../lib/jsonpatch.ts";

export interface VersionView {
  id: string;
  n: number;
  spec: StrategySpec;
  specHash: string;
  note: string | null;
  source: string;
  createdAt: number;
  describe: string[];
}

export interface StrategyView {
  id: string;
  name: string;
  market: Market;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  current: VersionView | null;
}

function specHash(spec: StrategySpec): string {
  return createHash("sha256").update(canonicalJson(spec)).digest("hex").slice(0, 16);
}

function toVersion(v: typeof strategyVersions.$inferSelect): VersionView {
  const spec = v.spec as unknown as StrategySpec;
  return {
    id: v.id,
    n: v.n,
    spec,
    specHash: v.specHash,
    note: v.note,
    source: v.source,
    createdAt: v.createdAt,
    describe: describeSpec(spec),
  };
}

export function listStrategies(userId: string, includeArchived = false): StrategyView[] {
  const { db } = env().app;
  const rows = db
    .select()
    .from(strategies)
    .where(
      includeArchived
        ? eq(strategies.userId, userId)
        : and(eq(strategies.userId, userId), eq(strategies.archived, false)),
    )
    .orderBy(desc(strategies.updatedAt))
    .all();
  const versionIds = rows.map((r) => r.currentVersionId).filter((x): x is string => !!x);
  const versions = versionIds.length
    ? db.select().from(strategyVersions).where(inArray(strategyVersions.id, versionIds)).all()
    : [];
  const byId = new Map(versions.map((v) => [v.id, toVersion(v)]));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    market: r.market as Market,
    archived: r.archived,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    current: r.currentVersionId ? (byId.get(r.currentVersionId) ?? null) : null,
  }));
}

export function getStrategy(userId: string, id: string) {
  const { db } = env().app;
  const s = db
    .select()
    .from(strategies)
    .where(and(eq(strategies.id, id), eq(strategies.userId, userId)))
    .get();
  if (!s) throw notFound("策略");
  const versions = db
    .select()
    .from(strategyVersions)
    .where(eq(strategyVersions.strategyId, id))
    .orderBy(desc(strategyVersions.n))
    .all()
    .map(toVersion);
  const current = versions.find((v) => v.id === s.currentVersionId) ?? versions[0] ?? null;
  return {
    id: s.id,
    name: s.name,
    market: s.market as Market,
    archived: s.archived,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    current,
    versions,
  };
}

export function getVersion(userId: string, versionId: string) {
  const { db } = env().app;
  const v = db.select().from(strategyVersions).where(eq(strategyVersions.id, versionId)).get();
  if (!v) throw notFound("策略版本");
  const s = db
    .select()
    .from(strategies)
    .where(and(eq(strategies.id, v.strategyId), eq(strategies.userId, userId)))
    .get();
  if (!s) throw notFound("策略版本");
  return { strategy: s, version: toVersion(v) };
}

/** 版本号（找不到或无权限时为 null） */
export function versionNOf(userId: string, versionId: string): number | null {
  try {
    return getVersion(userId, versionId).version.n;
  } catch {
    return null;
  }
}

/** 直接建策略（预设模板一键创建 / 确认草稿时用）。 */
export function createStrategyWithVersion(
  userId: string,
  spec: StrategySpec,
  source: string,
  note?: string,
): { strategyId: string; versionId: string } {
  const { db } = env().app;
  const strategyId = newId("s_");
  const versionId = newId("v_");
  db.transaction((tx) => {
    tx.insert(strategies)
      .values({
        id: strategyId,
        userId,
        name: spec.name,
        market: spec.market,
        currentVersionId: versionId,
      })
      .run();
    tx.insert(strategyVersions)
      .values({
        id: versionId,
        strategyId,
        n: 1,
        spec: spec as unknown as Record<string, unknown>,
        specHash: specHash(spec),
        note: note ?? null,
        source,
      })
      .run();
  });
  return { strategyId, versionId };
}

function addVersion(
  userId: string,
  strategyId: string,
  spec: StrategySpec,
  source: string,
  note?: string,
): string {
  const { db } = env().app;
  const s = db
    .select()
    .from(strategies)
    .where(and(eq(strategies.id, strategyId), eq(strategies.userId, userId)))
    .get();
  if (!s) throw notFound("策略");
  if (spec.market !== s.market) throw new AppError(400, "不能改策略的市场，请新建一个策略");
  const hash = specHash(spec);
  const cur = s.currentVersionId
    ? db.select().from(strategyVersions).where(eq(strategyVersions.id, s.currentVersionId)).get()
    : undefined;
  if (cur?.specHash === hash) return cur.id; // 没有实际变化，不新增版本
  const n =
    (db
      .select({ n: max(strategyVersions.n) })
      .from(strategyVersions)
      .where(eq(strategyVersions.strategyId, strategyId))
      .get()?.n ?? 0) + 1;
  const versionId = newId("v_");
  db.transaction((tx) => {
    tx.insert(strategyVersions)
      .values({
        id: versionId,
        strategyId,
        n,
        spec: spec as unknown as Record<string, unknown>,
        specHash: hash,
        note: note ?? null,
        source,
      })
      .run();
    tx.update(strategies)
      .set({ currentVersionId: versionId, name: spec.name, updatedAt: Date.now() })
      .where(eq(strategies.id, strategyId))
      .run();
  });
  return versionId;
}

export function createFromPreset(userId: string, presetId: string) {
  const p = PRESETS.find((x) => x.id === presetId);
  if (!p) throw notFound("预设模板");
  const v = validateSpec(p.spec);
  if (!v.spec) throw new AppError(500, `预设模板不合法：${v.errors.join("；")}`);
  return createStrategyWithVersion(userId, v.spec, "preset", p.title);
}

export function setArchived(userId: string, strategyId: string, archived: boolean): void {
  const { db } = env().app;
  const r = db
    .update(strategies)
    .set({ archived, updatedAt: Date.now() })
    .where(and(eq(strategies.id, strategyId), eq(strategies.userId, userId)))
    .run();
  if (!r.changes) throw notFound("策略");
}

// ── 草稿 ──

export interface SpecChange {
  label: string;
  before: string | null;
  after: string | null;
}

/** 两个版本的人话差异：按「股票池 / 条件 / 排序 / 调仓 / 仓位 / 基准」逐行比较。 */
export function diffSpecs(before: StrategySpec | null, after: StrategySpec): SpecChange[] {
  const split = (lines: string[]) =>
    new Map(
      lines.map((l) => {
        const i = l.indexOf("：");
        return [l.slice(0, i), l.slice(i + 1)] as const;
      }),
    );
  const a = before ? split(describeSpec(before)) : new Map<string, string>();
  const b = split(describeSpec(after));
  const out: SpecChange[] = [];
  if (before && before.name !== after.name)
    out.push({ label: "名称", before: before.name, after: after.name });
  for (const label of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(label) ?? null;
    const y = b.get(label) ?? null;
    if (x !== y) out.push({ label, before: x, after: y });
  }
  return out;
}

export interface ProposeStrategyInput {
  /** 改已有策略时给；新建时不给 */
  strategyId?: string;
  /** 完整策略（二选一） */
  spec?: unknown;
  /** 对当前版本的 JSON Patch（二选一） */
  patch?: PatchOp[];
  note?: string;
  threadId?: string;
}

export type ProposeResult =
  | {
      ok: true;
      draftId: string;
      strategyId: string | null;
      baseVersionId: string | null;
      spec: StrategySpec;
      describe: string[];
      changes: SpecChange[];
    }
  | { ok: false; errors: string[] };

/** 提议新建或修改策略：校验不过返回错误（给 LLM 改），过了只写一条待确认草稿。 */
export function proposeStrategy(userId: string, input: ProposeStrategyInput): ProposeResult {
  const { db } = env().app;
  let base: VersionView | null = null;
  if (input.strategyId) base = getStrategy(userId, input.strategyId).current;
  let candidate: unknown;
  try {
    if (input.patch?.length) {
      if (!base) return { ok: false, errors: ["补丁需要基于一个已有策略（strategyId）"] };
      candidate = applyPatch(base.spec, input.patch);
    } else if (input.spec !== undefined) {
      candidate = input.spec;
    } else {
      return { ok: false, errors: ["需要给出完整策略 spec 或补丁 patch"] };
    }
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
  }
  const v = validateSpec(candidate);
  if (!v.ok || !v.spec) return { ok: false, errors: v.errors };
  if (base && v.spec.market !== base.spec.market) {
    return { ok: false, errors: ["不能改已有策略的市场，请新建一个策略"] };
  }
  const changes = diffSpecs(base?.spec ?? null, v.spec);
  if (base && !changes.length) return { ok: false, errors: ["和当前版本相比没有任何变化"] };
  const draftId = newId("d_");
  db.insert(drafts)
    .values({
      id: draftId,
      userId,
      kind: "strategy",
      strategyId: input.strategyId ?? null,
      baseVersionId: base?.id ?? null,
      payload: { spec: v.spec, note: input.note ?? null } as unknown as Record<string, unknown>,
      summary: changes
        .map((c) => `${c.label}：${c.before ?? "（无）"} → ${c.after ?? "（无）"}`)
        .join("\n"),
      threadId: input.threadId ?? null,
    })
    .run();
  return {
    ok: true,
    draftId,
    strategyId: input.strategyId ?? null,
    baseVersionId: base?.id ?? null,
    spec: v.spec,
    describe: describeSpec(v.spec),
    changes,
  };
}

export function getDraft(userId: string, draftId: string) {
  const { db } = env().app;
  const d = db
    .select()
    .from(drafts)
    .where(and(eq(drafts.id, draftId), eq(drafts.userId, userId)))
    .get();
  if (!d) throw notFound("草稿");
  return d;
}

export type ConfirmResult =
  | { kind: "strategy"; strategyId: string; versionId: string }
  | { kind: "tracking"; trackingId: string };

/**
 * 用户确认草稿（只能经 POST /api/drafts/:id/confirm 调用，带用户 Cookie）。
 * 这是产生策略版本与跟踪的唯一入口。
 */
export function confirmDraft(userId: string, draftId: string): ConfirmResult {
  const { db } = env().app;
  const d = getDraft(userId, draftId);
  if (d.status !== "pending") throw new AppError(409, "这个草稿已经处理过了");
  let result: ConfirmResult;
  if (d.kind === "strategy") {
    const payload = d.payload as { spec: unknown; note?: string | null };
    const v = validateSpec(payload.spec);
    if (!v.spec) throw new AppError(400, `草稿里的策略不合法：${v.errors.join("；")}`);
    if (d.strategyId) {
      const cur = getStrategy(userId, d.strategyId).current;
      if (cur && d.baseVersionId && cur.id !== d.baseVersionId) {
        throw new AppError(409, "策略在这期间已经被改过，请基于最新版本重新提议");
      }
      const versionId = addVersion(
        userId,
        d.strategyId,
        v.spec,
        d.threadId ? "chat" : "form",
        payload.note ?? undefined,
      );
      result = { kind: "strategy", strategyId: d.strategyId, versionId };
    } else {
      const r = createStrategyWithVersion(
        userId,
        v.spec,
        d.threadId ? "chat" : "form",
        payload.note ?? undefined,
      );
      result = { kind: "strategy", ...r };
    }
  } else if (d.kind === "tracking") {
    const p = d.payload as {
      versionId: string;
      startDate: string;
      capital: number;
      baselineRunId?: string | null;
    };
    const { strategy, version } = getVersion(userId, p.versionId);
    const trackingId = newId("t_");
    db.insert(trackings)
      .values({
        id: trackingId,
        userId,
        strategyId: strategy.id,
        versionId: version.id,
        market: version.spec.market,
        startDate: p.startDate,
        capital: p.capital,
        baselineRunId: p.baselineRunId ?? null,
      })
      .run();
    result = { kind: "tracking", trackingId };
  } else {
    throw new AppError(400, `未知草稿类型 ${d.kind}`);
  }
  db.update(drafts)
    .set({
      status: "confirmed",
      resolvedAt: Date.now(),
      resultId: result.kind === "strategy" ? result.versionId : result.trackingId,
    })
    .where(eq(drafts.id, draftId))
    .run();
  return result;
}

export function discardDraft(userId: string, draftId: string): void {
  const { db } = env().app;
  const d = getDraft(userId, draftId);
  if (d.status !== "pending") throw new AppError(409, "这个草稿已经处理过了");
  db.update(drafts)
    .set({ status: "discarded", resolvedAt: Date.now() })
    .where(eq(drafts.id, draftId))
    .run();
}

/**
 * 计划版次对比（D71，纯函数）：同一个决策日的第 1 版（当晚看到的）与最新版差在哪。
 *
 * - 按代码对齐：只在后一版里的是新增，只在前一版里的是移除；
 * - 两版都有的逐项比方向、名次、估算仓位、细分原因；估算仓位相差不到 0.001（0.1 个百分点）不算变化，
 *   免得同一份计划只因为浮点误差或现金差几元就满屏「变化」；
 * - 输出按代码排，同一代码按「方向、名次、估算仓位、细分原因」排，顺序稳定。
 */

export interface PlanItemLite {
  code: string;
  name: string | null;
  side: string;
  rank: number | null;
  estWeight: number | null;
  reasonDetail: string | null;
}

export type PlanDiffField = "side" | "rank" | "estWeight" | "reasonDetail";

export interface PlanDiffChange {
  code: string;
  name: string | null;
  field: PlanDiffField;
  before: string | number | null;
  after: string | number | null;
}

export interface PlanDiff {
  added: PlanItemLite[];
  removed: PlanItemLite[];
  changed: PlanDiffChange[];
}

/** 估算仓位小于这个差不算变化 */
export const WEIGHT_EPS = 0.001;

const FIELDS: readonly PlanDiffField[] = ["side", "rank", "estWeight", "reasonDetail"];

const byCode = (a: { code: string }, b: { code: string }) =>
  a.code < b.code ? -1 : a.code > b.code ? 1 : 0;

function same(field: PlanDiffField, a: string | number | null, b: string | number | null) {
  if (field === "estWeight" && typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) < WEIGHT_EPS;
  }
  return (a ?? null) === (b ?? null);
}

export function diffPlans(a: readonly PlanItemLite[], b: readonly PlanItemLite[]): PlanDiff {
  const before = new Map(a.map((x) => [x.code, x]));
  const after = new Map(b.map((x) => [x.code, x]));
  const added = b.filter((x) => !before.has(x.code)).sort(byCode);
  const removed = a.filter((x) => !after.has(x.code)).sort(byCode);
  const changed: PlanDiffChange[] = [];
  for (const x of [...a].sort(byCode)) {
    const y = after.get(x.code);
    if (!y) continue;
    for (const f of FIELDS) {
      const u = x[f] ?? null;
      const v = y[f] ?? null;
      if (!same(f, u, v))
        changed.push({ code: x.code, name: y.name ?? x.name, field: f, before: u, after: v });
    }
  }
  return { added, removed, changed };
}

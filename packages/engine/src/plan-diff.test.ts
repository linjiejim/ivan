import { describe, expect, it } from "vitest";
import { diffPlans, type PlanItemLite } from "./plan-diff.ts";

const item = (code: string, o: Partial<PlanItemLite> = {}): PlanItemLite => ({
  code,
  name: `名${code}`,
  side: "buy",
  rank: 1,
  estWeight: 0.05,
  reasonDetail: "entry",
  ...o,
});

describe("diffPlans", () => {
  it("新增、移除、变化分开列出", () => {
    const a = [item("600002.SH"), item("600001.SH", { side: "sell", reasonDetail: "ranked_out" })];
    const b = [
      item("600003.SH"),
      item("600001.SH", { side: "sell", reasonDetail: "failed_filter" }),
    ];
    const d = diffPlans(a, b);
    expect(d.added.map((x) => x.code)).toEqual(["600003.SH"]);
    expect(d.removed.map((x) => x.code)).toEqual(["600002.SH"]);
    expect(d.changed).toEqual([
      {
        code: "600001.SH",
        name: "名600001.SH",
        field: "reasonDetail",
        before: "ranked_out",
        after: "failed_filter",
      },
    ]);
  });

  it("估算仓位相差不到 0.001 不算变化；空值与有值算变化", () => {
    const a = [item("A", { estWeight: 0.05 }), item("B", { estWeight: null })];
    const b = [item("A", { estWeight: 0.0509 }), item("B", { estWeight: 0.05 })];
    expect(diffPlans(a, b).changed).toEqual([
      { code: "B", name: "名B", field: "estWeight", before: null, after: 0.05 },
    ]);
    expect(
      diffPlans(a, [item("A", { estWeight: 0.052 }), b[1]!]).changed.map((c) => c.code),
    ).toEqual(["A", "B"]);
  });

  it("顺序稳定：按代码，同一代码按方向、名次、估算仓位、细分原因", () => {
    const a = [item("C"), item("A", { rank: 3 })];
    const b = [
      item("A", { side: "sell", rank: 5, estWeight: 0.02, reasonDetail: "ranked_out" }),
      item("C", { rank: 2 }),
    ];
    const d = diffPlans(a, b);
    expect(d.changed.map((c) => `${c.code}:${c.field}`)).toEqual([
      "A:side",
      "A:rank",
      "A:estWeight",
      "A:reasonDetail",
      "C:rank",
    ]);
    // 输入顺序打乱结果一样
    expect(diffPlans([...a].reverse(), [...b].reverse())).toEqual(d);
  });

  it("同一份计划没有差异", () => {
    const a = [item("A"), item("B")];
    expect(diffPlans(a, a)).toEqual({ added: [], removed: [], changed: [] });
  });
});

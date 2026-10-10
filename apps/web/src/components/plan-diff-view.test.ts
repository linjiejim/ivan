/**
 * 计划版次对比（D71）：新增 / 移除 / 变化逐行列出，值写成中文；除了买卖徽标不用红绿。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlanDiffView } from "./plan-diff-view.tsx";

const item = (code: string, side = "buy") => ({
  code,
  name: `名${code}`,
  side,
  rank: 2,
  estWeight: 0.05,
  reasonDetail: "entry",
});

describe("PlanDiffView", () => {
  it("新增、移除、变化各一行；变化写字段与前后值", () => {
    const html = renderToStaticMarkup(
      createElement(PlanDiffView, {
        diff: {
          added: [item("600003.SH")],
          removed: [item("600002.SH", "sell")],
          changed: [
            { code: "600001.SH", name: "甲", field: "rank", before: 3, after: 5 },
            {
              code: "600001.SH",
              name: "甲",
              field: "reasonDetail",
              before: "ranked_out",
              after: "failed_filter",
            },
          ],
        },
      }),
    );
    for (const s of [
      "新增",
      "移除",
      "变化",
      "名600003.SH",
      "名次",
      "第 3",
      "第 5",
      "掉出名次线",
      "不再满足条件",
      "估算仓位 5.0%",
    ]) {
      expect(html).toContain(s);
    }
    // 红绿只出现在买卖徽标上（新增的买、移除的卖各一个）
    expect(html.match(/text-up/g)).toHaveLength(1);
    expect(html.match(/text-down/g)).toHaveLength(1);
  });

  it("没有差异时一句话", () => {
    const html = renderToStaticMarkup(
      createElement(PlanDiffView, { diff: { added: [], removed: [], changed: [] } }),
    );
    expect(html).toContain("两版的计划项一样");
  });
});

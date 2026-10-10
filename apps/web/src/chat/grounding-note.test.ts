/**
 * 数字核对标注（D69）：全对上时什么都不显示；有对不上的数才在回复下面写一行，并列出最接近的工具数。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GroundingResult } from "../lib/types.ts";
import { GroundingNote } from "./cards.tsx";

const ok: GroundingResult = { version: 1, checked: 3, exempt: 2, unverified: [] };

describe("GroundingNote", () => {
  it("全部对上或没有核对结果时不显示", () => {
    expect(renderToStaticMarkup(createElement(GroundingNote, { g: ok }))).toBe("");
    expect(renderToStaticMarkup(createElement(GroundingNote, { g: undefined }))).toBe("");
  });

  it("有对不上的数：说清几个、是哪些，请以卡片为准", () => {
    const html = renderToStaticMarkup(
      createElement(GroundingNote, {
        g: {
          ...ok,
          unverified: [
            {
              raw: "+12.4%",
              value: 12.4,
              kind: "percent",
              reason: "no_match",
              nearest: { path: "get_run.excessCagr", value: 0.0731 },
            },
          ],
        },
      }),
    );
    expect(html).toContain("有 1 个数字没在工具结果里找到：+12.4%，请以卡片为准");
    expect(html).toContain("数字核对：说明");
  });
});

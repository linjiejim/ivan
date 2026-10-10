/**
 * 中证指数官网适配器（封禁风险 1）：只有全收益指数（如 H00300），走基准的专用路径，不在默认指数链里。
 */
import { csindexHistory } from "../csindex.ts";
import type { SourceAdapter } from "../types.ts";

export const csindexAdapter: SourceAdapter = {
  id: "csindex",
  label: "中证官网",
  hosts: { index: ["www.csindex.com.cn"] },
  banRisk: 1,
  capabilities: { index: ["A"] },
  indexBars(ctx, sym, from, to) {
    return csindexHistory(ctx.http, sym, from, to);
  },
};

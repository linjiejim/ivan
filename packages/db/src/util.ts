/** 应用库的小工具：压缩 JSON、生成 id（index、账本、计划快照共用，免得互相 import 成环） */
import { deflateSync, inflateSync } from "node:zlib";

/** 大 JSON（净值序列、持仓快照）压缩存储 */
export function packJson(v: unknown): Buffer {
  return deflateSync(Buffer.from(JSON.stringify(v)));
}

export function unpackJson<T>(b: Buffer | null | undefined): T | null {
  if (!b) return null;
  return JSON.parse(inflateSync(b).toString("utf8")) as T;
}

export function newId(prefix = ""): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${prefix}${t}${r}`;
}

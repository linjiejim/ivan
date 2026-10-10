/**
 * 哈希工具（D58，只在 Node 里用）：`@ivan/core/node` 子路径导出，主入口不引入 node:crypto（web 会打包主入口）。
 *
 * 规范：沿用 `canonicalJson`（键排序；数字按 JSON.stringify，NaN / ±∞ 输出 null；值为 undefined 的键丢掉），不做舍入。
 * 新哈希一律全长 64 位十六进制，界面显示前 8 位（`short`）；策略内容的指纹统一用 `specHashOf`（16 位，
 * 与历史的 strategy_versions.spec_hash 相同）。
 */
import { createHash, type Hash } from "node:crypto";
import { canonicalJson } from "../strategy.ts";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 规范化 JSON 的 sha256（全长 64 位）。 */
export function sha256Canonical(v: unknown): string {
  return sha256Hex(canonicalJson(v));
}

/** 流式 sha256：大块数据（价格面板等）分段喂入；TypedArray 按内存里的原始字节计算。 */
export class Sha256Stream {
  private readonly h: Hash = createHash("sha256");

  update(x: string | ArrayBufferView): this {
    if (typeof x === "string") this.h.update(x);
    else this.h.update(new Uint8Array(x.buffer, x.byteOffset, x.byteLength));
    return this;
  }

  digest(): string {
    return this.h.digest("hex");
  }
}

/** 界面显示用的短哈希（前 8 位）。 */
export const short = (h: string): string => h.slice(0, 8);

/** 策略内容指纹：规范化 JSON 的 sha256 前 16 位（strategy_versions.spec_hash、扫描、试错计数共用）。 */
export function specHashOf(spec: unknown): string {
  return sha256Hex(canonicalJson(spec)).slice(0, 16);
}

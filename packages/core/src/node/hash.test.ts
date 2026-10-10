import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson, StrategySpecSchema } from "../index.ts";
import { sha256Canonical, sha256Hex, Sha256Stream, short, specHashOf } from "./hash.ts";

describe("哈希工具（D58）", () => {
  it("规范化：键的顺序不影响指纹，undefined 键丢掉", () => {
    expect(sha256Canonical({ a: 1, b: [1, { y: 2, x: 3 }] })).toBe(
      sha256Canonical({ b: [1, { x: 3, y: 2 }], a: 1, c: undefined }),
    );
    expect(sha256Canonical({ a: 1 })).not.toBe(sha256Canonical({ a: 2 }));
    expect(sha256Canonical({ a: 1 })).toHaveLength(64);
  });

  it("NaN、±Infinity 与 null 同指纹（JSON.stringify 的口径），不做舍入", () => {
    const h = sha256Canonical({ v: null });
    expect(sha256Canonical({ v: NaN })).toBe(h);
    expect(sha256Canonical({ v: Infinity })).toBe(h);
    expect(sha256Canonical({ v: -Infinity })).toBe(h);
    expect(sha256Canonical({ v: 0.1 + 0.2 })).not.toBe(sha256Canonical({ v: 0.3 }));
  });

  it("流式：分段喂入等于整段计算；TypedArray 按原始字节", () => {
    const s = new Sha256Stream().update("ab").update("c").update("").digest();
    expect(s).toBe(sha256Hex("abc"));

    const buf = new Float64Array([1.5, NaN, -0, 3]);
    const bytes = new Uint8Array(buf.buffer);
    expect(new Sha256Stream().update(buf).digest()).toBe(sha256Hex(bytes));
    // 子视图只算自己那段字节
    const sub = buf.subarray(1, 3);
    expect(new Sha256Stream().update(sub).digest()).toBe(sha256Hex(bytes.subarray(8, 24)));
    // 字符串与字节混合喂入
    expect(
      new Sha256Stream()
        .update("x")
        .update(new Uint8Array([1, 2]))
        .digest(),
    ).toBe(
      createHash("sha256")
        .update("x")
        .update(new Uint8Array([1, 2]))
        .digest("hex"),
    );
  });

  it("specHashOf：16 位，与原来 strategies.ts 的 spec_hash 算法逐字节相同", () => {
    const spec = StrategySpecSchema.parse({
      name: "低估值",
      market: "A",
      filters: [{ factor: "pe_ttm", op: "between", value: [0, 20] }],
      rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 10 },
    });
    const legacy = createHash("sha256").update(canonicalJson(spec)).digest("hex").slice(0, 16);
    expect(specHashOf(spec)).toBe(legacy);
    expect(specHashOf(spec)).toHaveLength(16);
    expect(short(sha256Canonical(spec))).toBe(specHashOf(spec).slice(0, 8));
  });

  it("主入口（web 也引入）不引用 node:crypto，哈希只在 @ivan/core/node", () => {
    const dir = new URL("../", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files).toContain("index.ts");
    for (const f of files) {
      expect(readFileSync(new URL(f, dir), "utf8"), f).not.toMatch(/node:crypto|\.\/node\//);
    }
  });
});

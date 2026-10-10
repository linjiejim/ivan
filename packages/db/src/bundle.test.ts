/**
 * 决策回溯的导出文件（D71）：导出后离线校验通过；改一个计划项、删一条都能报出位置；别的跟踪与简报只给哈希；
 * 清单指纹不看导出时间；文件里有重算说明。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AppDbHandle,
  appendLedger,
  type BundleInput,
  buildTraceBundle,
  type OwnEntry,
  openAppDb,
  type TraceBundle,
  verifyBundle,
} from "./index.ts";
import { seedTrace } from "./testing/trace.ts";

let dir: string;
let h: AppDbHandle;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ivan-bundle-"));
  h = openAppDb(join(dir, "app.sqlite"));
  seedTrace(h, "u_1");
});
afterEach(() => {
  h.sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

const input = (generatedAt = "2026-03-24T00:00:00.000Z"): BundleInput => ({
  userId: "u_1",
  trackingId: "t_own",
  tracking: {
    id: "t_own",
    strategyName: "价值",
    versionId: "v_1",
    specHash: "abcd",
    spec: { market: "A" },
    startDate: "2026-03-02",
    capital: 1_000_000,
    exec: { v: 1 },
  },
  baselineRun: null,
  manifest: {
    engineVersion: "1.2.0",
    factorRegistryVersion: 2,
    explainVersion: 1,
    groundingVersion: 1,
    healthVersion: 1,
    validationVersion: 1,
    hashVersion: 2,
  },
  generatedAt,
});

/** 和真的文件一样：写成 JSON 再读回来 */
const roundTrip = (b: TraceBundle): TraceBundle => JSON.parse(JSON.stringify(b)) as TraceBundle;

describe("导出文件", () => {
  it("原样导出能离线校验通过；链头与库里一致", () => {
    const b = roundTrip(buildTraceBundle(h, input()));
    expect(b.entries).toHaveLength(7);
    expect(b.chain.ok).toBe(true);
    const v = verifyBundle(b);
    expect(v).toEqual({ ok: true, checked: 7, headHash: b.chain.headHash });
  });

  it("改一个计划项的名次 → 那一条内容哈希不符", () => {
    const b = roundTrip(buildTraceBundle(h, input()));
    const plan = b.entries.find((e) => "kind" in e && e.kind === "plan") as OwnEntry;
    const p = b.payloads[String(plan.seq)] as { items: Array<{ rank: number }> };
    p.items[0]!.rank = 7;
    expect(verifyBundle(b)).toMatchObject({
      ok: false,
      firstBreak: { seq: plan.seq, reason: "payload_hash_mismatch" },
    });
  });

  it("删掉一条 → 序号断开；删掉最后一条 → 链头不符；改清单 → 清单指纹不符", () => {
    const b = roundTrip(buildTraceBundle(h, input()));
    const dropped = { ...b, entries: b.entries.filter((e) => e.seq !== 4) };
    expect(verifyBundle(dropped).firstBreak).toEqual({ seq: 5, reason: "seq_gap" });
    const tail = { ...b, entries: b.entries.slice(0, -1) };
    expect(verifyBundle(tail).firstBreak).toEqual({ seq: null, reason: "head_hash_mismatch" });
    const m = { ...b, manifest: { ...b.manifest, engineVersion: "9.9.9" } };
    expect(verifyBundle(m).firstBreak).toEqual({ seq: null, reason: "manifest_hash_mismatch" });
    expect(verifyBundle({ hello: 1 }).firstBreak).toEqual({ seq: null, reason: "malformed" });
  });

  it("把本跟踪的条目改标成 foreign 绕不过重算：留着内容或改了内容都在那一条报格式不对", () => {
    const b = roundTrip(buildTraceBundle(h, input()));
    const plan = b.entries.find((e) => "kind" in e && e.kind === "plan") as OwnEntry;
    const key = String(plan.seq);
    // 留着全部字段、只加 foreign: true，再改内容
    const kept = roundTrip(b);
    const e1 = kept.entries[plan.seq - 1] as unknown as Record<string, unknown>;
    e1.foreign = true;
    (kept.payloads[key] as { items: Array<{ estWeight: number }> }).items[0]!.estWeight = 0.99;
    expect(verifyBundle(kept)).toMatchObject({
      ok: false,
      firstBreak: { seq: plan.seq, reason: "malformed" },
    });
    // 只留 {seq, prevHash, hash, foreign}，内容还在 payloads 里
    const stripped = roundTrip(b);
    stripped.entries[plan.seq - 1] = {
      seq: plan.seq,
      prevHash: plan.prevHash,
      hash: plan.hash,
      foreign: true,
    };
    (stripped.payloads[key] as { items: Array<{ estWeight: number }> }).items[0]!.estWeight = 0.99;
    expect(verifyBundle(stripped)).toMatchObject({
      ok: false,
      firstBreak: { seq: plan.seq, reason: "malformed" },
    });
    // 内容也删了，计划元信息还在：没被哈希锁住的元信息不能留
    delete stripped.payloads[key];
    expect(verifyBundle(stripped)).toMatchObject({
      ok: false,
      firstBreak: { seq: null, reason: "malformed" },
    });
    // 本跟踪的条目多一个键、payloads 里多一个不属于任何本跟踪条目的键
    const extra = roundTrip(b);
    (extra.entries[0] as unknown as Record<string, unknown>).note = "改过";
    expect(verifyBundle(extra).firstBreak).toEqual({ seq: 1, reason: "malformed" });
    const stray = roundTrip(b);
    stray.payloads["2"] = { text: "别的内容" };
    expect(verifyBundle(stray).firstBreak).toEqual({ seq: 2, reason: "malformed" });
    const stray99 = roundTrip(b);
    stray99.payloads["99"] = { text: "别的内容" };
    expect(verifyBundle(stray99).firstBreak).toEqual({ seq: 99, reason: "malformed" });
  });

  it("别的跟踪与简报的条目只有序号与哈希，内容与对象都不出现在文件里", () => {
    const b = buildTraceBundle(h, input());
    const foreign = b.entries.filter((e) => "foreign" in e);
    expect(foreign.map((e) => e.seq)).toEqual([2, 4]);
    for (const e of foreign)
      expect(Object.keys(e).sort()).toEqual(["foreign", "hash", "prevHash", "seq"]);
    expect(Object.keys(b.payloads).sort()).toEqual(["1", "3", "5", "6", "7"]);
    const text = JSON.stringify(b);
    expect(text).not.toContain("t_other");
    expect(text).not.toContain("别的跟踪的内容");
    expect(text).not.toContain("简报里的另一个跟踪");
    expect(text).not.toContain("简报正文");
    expect(text).not.toContain("u_1");
    // 计划快照的元信息（版次、原因）另放，不参与校验
    expect(Object.values(b.plans).map((p) => [p.edition, p.cause])).toEqual([
      [1, "initial"],
      [2, "data_revision"],
    ]);
  });

  it("导出读到一半时另一个连接（夜间结算）又记了一条：整份按同一个快照导出，校验通过、不误报链头不符", () => {
    const other = openAppDb(join(dir, "app.sqlite"), { migrate: false });
    const prepare = h.sqlite.prepare.bind(h.sqlite);
    let appended = false;
    // 账本已经读完、链校验还没做的时候（读健康读数那一步）插进一条
    h.sqlite.prepare = ((sql: string) => {
      if (!appended && sql.includes("tracking_health")) {
        appended = true;
        appendLedger(other, {
          userId: "u_1",
          kind: "tracking_start",
          subjectType: "user",
          subjectId: "u_1",
          asOf: "2026-03-25",
          payloadTable: "inline",
          payload: { note: "导出途中追加" },
        });
      }
      return prepare(sql);
    }) as typeof h.sqlite.prepare;
    let b: TraceBundle;
    try {
      b = roundTrip(buildTraceBundle(h, input()));
    } finally {
      h.sqlite.prepare = prepare;
      other.sqlite.close();
    }
    expect(appended).toBe(true);
    expect(b.entries).toHaveLength(7);
    expect(verifyBundle(b)).toEqual({ ok: true, checked: 7, headHash: b.chain.headHash });
    // 下一次导出带上新的那条
    const next = roundTrip(buildTraceBundle(h, input()));
    expect(next.entries).toHaveLength(8);
    expect(verifyBundle(next).ok).toBe(true);
  });

  it("清单指纹不看导出时间；文件带中英文的重算说明", () => {
    const a = buildTraceBundle(h, input("2026-03-24T00:00:00.000Z"));
    const b = buildTraceBundle(h, input("2027-01-01T08:00:00.000Z"));
    expect(a.manifestHash).toBe(b.manifestHash);
    expect(a.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.verification.canonicalJson).toMatch(/键按字符串排序/);
    expect(a.verification.canonicalJson).toMatch(/keys sorted/);
    expect(Object.keys(a.verification.hashes)).toEqual(
      expect.arrayContaining([
        "recordHash",
        "planPayload",
        "inlinePayload",
        "foreignEntry",
        "manifestHash",
      ]),
    );
  });
});

/**
 * 决策账本（D68）：两个连接交替追加不分叉；结算的 IMMEDIATE 事务里追加（保存点）时另一个进程的追加等锁后照常成功；
 * 只追加的触发器；校验能发现篡改与缺行。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AppDbHandle,
  appendLedger,
  GENESIS,
  ledgerEntries,
  type LedgerRow,
  openAppDb,
  packJson,
  storedPayloadHash,
  verifyChain,
  verifyUserChain,
} from "./index.ts";

let dir: string;
let path: string;
let a: AppDbHandle;
let b: AppDbHandle;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ivan-ledger-"));
  path = join(dir, "app.sqlite");
  a = openAppDb(path);
  b = openAppDb(path, { migrate: false });
});
afterEach(() => {
  a.sqlite.close();
  b.sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

const inline = (userId: string, payload: unknown) => ({
  userId,
  kind: "tracking_start" as const,
  subjectType: "user" as const,
  subjectId: userId,
  asOf: "2026-03-02",
  payloadTable: "inline" as const,
  payload,
});

const rowsOf = (h: AppDbHandle, userId: string): LedgerRow[] =>
  h.sqlite
    .prepare(`SELECT * FROM ledger_entries WHERE user_id = ? ORDER BY seq`)
    .all(userId)
    .map((r) => {
      const x = r as Record<string, unknown>;
      return {
        id: x.id,
        userId: x.user_id,
        seq: x.seq,
        kind: x.kind,
        subjectType: x.subject_type,
        subjectId: x.subject_id,
        asOf: x.as_of,
        payloadTable: x.payload_table,
        payloadId: x.payload_id,
        payloadZ: x.payload_z,
        payloadHash: x.payload_hash,
        prevHash: x.prev_hash,
        hash: x.hash,
        createdAt: x.created_at,
      } as LedgerRow;
    });

describe("决策账本", () => {
  it("两个连接交替追加 200 条：序号连续、链校验通过；每个用户一条链", () => {
    for (let i = 0; i < 200; i++) {
      appendLedger(i % 2 ? a : b, inline("u1", { i }));
      if (i % 10 === 0) appendLedger(i % 3 ? b : a, inline("u2", { i }));
    }
    const rows = rowsOf(a, "u1");
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    expect(rows[0]!.prevHash).toBe(GENESIS);
    const v = verifyUserChain(a, "u1");
    expect(v).toEqual({ ok: true, checked: 200, headHash: rows.at(-1)!.hash });
    expect(verifyUserChain(b, "u2")).toMatchObject({ ok: true, checked: 20 });
    expect(verifyUserChain(a, "nobody")).toEqual({ ok: true, checked: 0, headHash: GENESIS });
  });

  it("结算的 IMMEDIATE 事务里追加是保存点；另一个进程同时追加会等锁，之后照常成功、序号连续", async () => {
    appendLedger(a, inline("u1", { first: true }));
    const w = new Worker(new URL("./testing/ledger-appender.ts", import.meta.url), {
      execArgv: ["--import", "tsx"],
      workerData: { path, userId: "u1", n: 5, tag: "server" },
    });
    const messages: Array<Record<string, unknown>> = [];
    const ready = new Promise<void>((res) =>
      w.on("message", (m: Record<string, unknown>) => {
        messages.push(m);
        if (m.ready) res();
      }),
    );
    const done = new Promise<Record<string, unknown>>((res) =>
      w.on("message", (m: Record<string, unknown>) => {
        if (m.done || m.error) res(m);
      }),
    );
    await ready;
    // 「结算」：先拿写锁，里面追加两条（保存点），中间放另一个线程去追加并让它等一会儿锁
    a.sqlite
      .transaction(() => {
        appendLedger(a, inline("u1", { settle: 1 }));
        w.postMessage("go");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
        appendLedger(a, inline("u1", { settle: 2 }));
      })
      .immediate();
    const r = await done;
    await w.terminate();
    expect(r).toEqual({ done: true });
    const rows = rowsOf(a, "u1");
    expect(rows.map((x) => x.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(verifyUserChain(a, "u1")).toMatchObject({ ok: true, checked: 8 });
  });

  it("UPDATE 与 DELETE 都报 append-only", () => {
    appendLedger(a, inline("u1", { x: 1 }));
    expect(() => a.sqlite.prepare(`UPDATE ledger_entries SET kind = 'brief'`).run()).toThrow(
      /append-only/,
    );
    expect(() => a.sqlite.prepare(`DELETE FROM ledger_entries`).run()).toThrow(/append-only/);
    a.sqlite
      .prepare(
        `INSERT INTO plan_items (snapshot_id, seq, code, side, reason) VALUES ('ps_x', 1, '600001.SH', 'buy', 'entry')`,
      )
      .run();
    expect(() => a.sqlite.prepare(`UPDATE plan_items SET rank = 2`).run()).toThrow(/append-only/);
    expect(() => a.sqlite.prepare(`DELETE FROM plan_items`).run()).toThrow(/append-only/);
  });

  it("校验发现篡改：改内容 → 内容指纹不符；删一行 → 序号断开；改前一哈希 / 记录 → 各自的原因", () => {
    for (let i = 0; i < 5; i++) appendLedger(a, inline("u1", { i }));
    const rows = rowsOf(a, "u1");
    const payloadOf = (r: LedgerRow) => storedPayloadHash(a, r);
    expect(verifyChain(rows, payloadOf).ok).toBe(true);

    const tampered = rows.map((r) => (r.seq === 3 ? { ...r, payloadZ: packJson({ i: 99 }) } : r));
    expect(verifyChain(tampered, payloadOf)).toMatchObject({
      ok: false,
      checked: 2,
      firstBreak: { seq: 3, reason: "payload_hash_mismatch" },
    });
    expect(
      verifyChain(
        rows.filter((r) => r.seq !== 2),
        payloadOf,
      ).firstBreak,
    ).toEqual({
      seq: 3,
      reason: "seq_gap",
    });
    expect(
      verifyChain(
        rows.map((r) => (r.seq === 4 ? { ...r, prevHash: GENESIS } : r)),
        payloadOf,
      ).firstBreak,
    ).toEqual({ seq: 4, reason: "prev_hash_mismatch" });
    expect(
      verifyChain(
        rows.map((r) => (r.seq === 5 ? { ...r, asOf: "2026-01-01" } : r)),
        payloadOf,
      ).firstBreak,
    ).toEqual({ seq: 5, reason: "record_hash_mismatch" });
    expect(
      verifyChain(
        rows.map((r) => (r.seq === 1 ? { ...r, payloadZ: null } : r)),
        payloadOf,
      ).firstBreak,
    ).toEqual({ seq: 1, reason: "payload_missing" });

    // 真在库里改（管理员绕过触发器）：整条链校验报出位置
    a.sqlite.exec(`DROP TRIGGER ledger_entries_no_update`);
    a.db
      .update(ledgerEntries)
      .set({ payloadZ: packJson({ i: -1 }) })
      .run();
    expect(verifyUserChain(a, "u1").firstBreak).toEqual({
      seq: 1,
      reason: "payload_hash_mismatch",
    });
  });

  it("指向计划快照的条目必须给内容指纹", () => {
    expect(() =>
      appendLedger(a, {
        userId: "u1",
        kind: "plan",
        subjectType: "tracking",
        subjectId: "t_1",
        asOf: "2026-03-02",
        payloadTable: "plan_snapshots",
        payloadId: "ps_1",
      }),
    ).toThrow(/内容指纹/);
  });
});

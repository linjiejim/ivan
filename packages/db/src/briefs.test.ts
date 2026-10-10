/**
 * 简报版次与健康度读数只追加（D70）：每版记一条账本 brief，链校验按库里存的版次重算内容指纹。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AppDbHandle,
  briefEditions,
  briefs,
  openAppDb,
  verifyUserChain,
  writeBriefEdition,
} from "./index.ts";

let dir: string;
let h: AppDbHandle;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ivan-briefs-"));
  h = openAppDb(join(dir, "app.sqlite"));
});
afterEach(() => {
  h.sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

const edition = (content: string) => ({
  date: "2026-10-05",
  facts: { date: "2026-10-05", trackings: [{ name: "甲", excessTotal: 0.01, x: undefined }] },
  content,
  model: "template",
  grounding: null,
});

describe("简报版次", () => {
  it("同一天写两次：两版、当前版是第 2 版、两条 brief 账本、链校验通过", () => {
    const a = writeBriefEdition(h, "u1", edition("第一版"));
    const b = writeBriefEdition(h, "u1", edition("第二版"));
    expect([a.edition, b.edition]).toEqual([1, 2]);
    expect(h.db.select().from(briefEditions).all()).toHaveLength(2);
    const cur = h.db.select().from(briefs).all();
    expect(cur).toHaveLength(1);
    expect(cur[0]!.content).toBe("第二版");
    const kinds = h.sqlite
      .prepare(`SELECT kind, payload_table, payload_id FROM ledger_entries ORDER BY seq`)
      .all() as Array<{ kind: string; payload_table: string; payload_id: string }>;
    expect(kinds).toEqual([
      { kind: "brief", payload_table: "brief_editions", payload_id: a.id },
      { kind: "brief", payload_table: "brief_editions", payload_id: b.id },
    ]);
    expect(verifyUserChain(h, "u1")).toMatchObject({ ok: true, checked: 2 });
  });

  it("简报版次与健康度读数：UPDATE / DELETE 都报 append-only", () => {
    writeBriefEdition(h, "u1", edition("x"));
    expect(() => h.sqlite.prepare(`UPDATE brief_editions SET content = 'y'`).run()).toThrow(
      /append-only/,
    );
    expect(() => h.sqlite.prepare(`DELETE FROM brief_editions`).run()).toThrow(/append-only/);
    h.sqlite
      .prepare(
        `INSERT INTO tracking_health (tracking_id, date, signal, state, per_metric, inputs, version) VALUES ('t1', '2026-10-05', 'healthy', 'active', '{}', '{}', 1)`,
      )
      .run();
    expect(() => h.sqlite.prepare(`UPDATE tracking_health SET state = 'decayed'`).run()).toThrow(
      /append-only/,
    );
    expect(() => h.sqlite.prepare(`DELETE FROM tracking_health`).run()).toThrow(/append-only/);
  });

  it("版次的内容被绕过触发器改了：链校验报内容指纹不符", () => {
    writeBriefEdition(h, "u1", edition("原文"));
    h.sqlite.exec(`DROP TRIGGER brief_editions_no_update`);
    h.sqlite.prepare(`UPDATE brief_editions SET content = '改过'`).run();
    expect(verifyUserChain(h, "u1")).toMatchObject({
      ok: false,
      firstBreak: { seq: 1, reason: "payload_hash_mismatch" },
    });
  });
});

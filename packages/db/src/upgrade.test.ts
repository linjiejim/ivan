/**
 * 应用库从首版 R0（R1 之前，只有 0000_init）升级到当前：旧行原样、新列取默认值、只追加的触发器建好；
 * 两个进程同时迁移时后到的那个出错会重来（重新读进度），不会把启动搞挂。
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { migrateWithRetry, openAppDb } from "./index.ts";

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");

/** 只含 0000_init 的迁移目录（R0 那时的样子） */
function baseFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "ivan-mig-"));
  mkdirSync(join(dir, "meta"));
  copyFileSync(join(MIGRATIONS, "0000_init.sql"), join(dir, "0000_init.sql"));
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf8")) as {
    entries: unknown[];
  };
  writeFileSync(
    join(dir, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }),
  );
  return dir;
}

describe("应用库升级（0000 → 当前）", () => {
  it("旧的策略、运行（没有运行卡）、跟踪与任务原样；新列取默认值；只追加的触发器都在", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ivan-app-")), "app.sqlite");
    let h = openAppDb(path, { migrationsFolder: baseFolder() });
    h.sqlite.exec(`
      INSERT INTO strategies (id, user_id, name, market) VALUES ('s1', 'u1', '旧策略', 'A');
      INSERT INTO strategy_versions (id, strategy_id, n, spec, spec_hash) VALUES ('v1', 's1', 1, '{}', 'h');
      INSERT INTO runs (id, user_id, strategy_id, version_id, params, status, engine_version, final)
        VALUES ('r1', 'u1', 's1', 'v1', '{"start":"2020-01-01"}', 'done', '1.1.0', '{"pending":[]}');
      INSERT INTO trackings (id, user_id, strategy_id, version_id, market, start_date, capital, summary)
        VALUES ('t1', 'u1', 's1', 'v1', 'A', '2026-01-05', 1000000, '{"excess":0.01}');
      INSERT INTO jobs (id, kind, payload, status) VALUES ('j1', 'etl', '{}', 'done');
    `);
    const before = h.sqlite.prepare(`SELECT * FROM runs WHERE id = 'r1'`).get() as Record<
      string,
      unknown
    >;
    h.sqlite.close();

    h = openAppDb(path);
    const run = h.sqlite.prepare(`SELECT * FROM runs WHERE id = 'r1'`).get() as Record<
      string,
      unknown
    >;
    for (const [k, v] of Object.entries(before)) expect(run[k], k).toEqual(v);
    expect(run.card).toBeNull();
    const t = h.sqlite
      .prepare(`SELECT exec_config, summary FROM trackings WHERE id = 't1'`)
      .get() as {
      exec_config: string;
      summary: string;
    };
    expect(t).toEqual({ exec_config: '{"v":1}', summary: '{"excess":0.01}' });
    expect(
      (h.sqlite.prepare(`SELECT attempt FROM jobs WHERE id = 'j1'`).get() as { attempt: number })
        .attempt,
    ).toBe(0);
    const triggers = (
      h.sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(triggers).toContain("ledger_entries_no_update");
    expect(triggers).toContain("ledger_entries_no_delete");
    expect(triggers.length).toBeGreaterThanOrEqual(6);
    // 再开一次：什么都不用做
    h.sqlite.close();
    expect(() => openAppDb(path).sqlite.close()).not.toThrow();
  });

  it("两个进程同时迁移：后到的那个第一次出错（duplicate column）就重新读进度再来，不会启动失败", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ivan-app-")), "app.sqlite");
    const h = openAppDb(path, { migrate: false });
    let calls = 0;
    migrateWithRetry(h.db, MIGRATIONS, (db, cfg) => {
      calls++;
      // 模拟另一个进程刚做完迁移、这边按旧的读数又 ALTER 了一次
      if (calls === 1) {
        migrate(db, cfg);
        throw new Error("duplicate column name: card");
      }
      migrate(db, cfg);
    });
    expect(calls).toBe(2);
    expect(() => h.sqlite.prepare(`SELECT card FROM runs`).all()).not.toThrow();
    let n = 0;
    expect(() =>
      migrateWithRetry(h.db, MIGRATIONS, () => {
        n++;
        throw new Error("真的坏了");
      }),
    ).toThrow("真的坏了");
    expect(n).toBe(6);
  });
});

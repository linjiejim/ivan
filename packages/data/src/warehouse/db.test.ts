/**
 * 行情仓连接的内存与退出（D110）：流式读、空闲回收、退出时打断与 CHECKPOINT。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INTERRUPTED_TEXT, Warehouse } from "./db.ts";

const opened: Warehouse[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const w of opened.splice(0)) {
    try {
      w.close();
    } catch {
      // 测试里已经关过
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function open(path = ":memory:", memoryLimit = "256MB"): Promise<Warehouse> {
  const wh = await Warehouse.open(path, { memoryLimit, threads: 1 });
  opened.push(wh);
  return wh;
}

const limitOf = async (wh: Warehouse) =>
  wh.scalar<string>(`SELECT current_setting('memory_limit')`);

describe("streamColumns", () => {
  it("按块交给回调，列与 columns() 一样（BIGINT 转 number）；流读到一半时主连接照常查询", async () => {
    const wh = await open();
    const sql = `SELECT i AS n, 'c' || (i % 7) AS c, i * 0.5 AS x FROM range(5000) t(i) ORDER BY i`;
    const chunks: number[] = [];
    const n: unknown[] = [];
    const c: unknown[] = [];
    let mid: unknown;
    const total = await wh.streamColumns(sql, undefined, (cols, rows) => {
      chunks.push(rows);
      n.push(...cols.n!);
      c.push(...cols.c!);
      expect(cols.x).toHaveLength(rows);
    });
    // 流在单独的连接上：读流期间在主连接上查询不会打断它
    const total2 = await wh.streamColumns(sql, undefined, () => {
      mid ??= wh.scalar("SELECT 42");
    });
    expect(await mid).toBe(42);
    expect(total).toBe(5000);
    expect(total2).toBe(5000);
    expect(chunks.length).toBeGreaterThan(1);
    const ref = await wh.columns(sql);
    expect(n).toEqual(ref.n);
    expect(c).toEqual(ref.c);
    expect(typeof n[0]).toBe("number");
  });

  it("带参数；回调抛错时错误照常抛出、连接收好", async () => {
    const wh = await open();
    const seen: unknown[] = [];
    await wh.streamColumns(`SELECT i FROM range(10) t(i) WHERE i >= $a ORDER BY i`, { a: 7 }, (cols) =>
      seen.push(...cols.i!),
    );
    expect(seen).toEqual([7, 8, 9]);
    await expect(
      wh.streamColumns(`SELECT i FROM range(10000) t(i)`, undefined, () => {
        throw new Error("太多了");
      }),
    ).rejects.toThrow("太多了");
    expect(await wh.scalar("SELECT 1")).toBe(1);
  });
});

describe("trimMemory", () => {
  it("回收后内存上限恢复成打开时的值；有读写在执行时不动", async () => {
    const wh = await open(":memory:", "256MB");
    const before = await limitOf(wh);
    expect(await wh.trimMemory()).toBe(true);
    expect(await limitOf(wh)).toBe(before);
    // 一个读在执行：这次不回收
    const slow = wh.scalar(`SELECT count(*) FROM range(3000000) a, range(3) b`);
    expect(await wh.trimMemory()).toBe(false);
    await slow;
    expect(await limitOf(wh)).toBe(before);
  });

  it("回收进行中来的读等它结束，在原上限下执行", async () => {
    const wh = await open(":memory:", "256MB");
    const before = await limitOf(wh);
    const trim = wh.trimMemory();
    const during = limitOf(wh);
    await trim;
    expect(await during).toBe(before);
  });
});

describe("退出（interrupt / closeGracefully）", () => {
  it("interrupt 之后读写都报「worker 重启」", async () => {
    const wh = await open();
    wh.interrupt();
    await expect(wh.scalar("SELECT 1")).rejects.toThrow(INTERRUPTED_TEXT);
    await expect(wh.streamColumns("SELECT 1", undefined, () => {})).rejects.toThrow(INTERRUPTED_TEXT);
  });

  it("closeGracefully 把 WAL 并回主文件：下次打开不用重放", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ivan-wh-"));
    dirs.push(dir);
    const path = join(dir, "market.duckdb");
    const wh = await Warehouse.open(path, { memoryLimit: "128MB", threads: 1 });
    await wh.run(`CREATE TABLE t AS SELECT i FROM range(1000) r(i)`);
    await wh.run(`INSERT INTO t SELECT i FROM range(10) r(i)`);
    expect(existsSync(`${path}.wal`)).toBe(true);
    wh.interrupt();
    await wh.closeGracefully();
    expect(existsSync(`${path}.wal`)).toBe(false);
    const again = await open(path, "128MB");
    expect(await again.scalar("SELECT count(*) FROM t")).toBe(1010);
  });
});

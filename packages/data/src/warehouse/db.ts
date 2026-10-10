/**
 * 行情仓（DuckDB 文件）。worker 进程是唯一持有者；大表不建主键索引（列存 + zonemap 足够，
 * 也避免 ART 索引在 512MB 内存上限下吃内存），幂等靠「先删后写」。
 */
import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from "@duckdb/node-api";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DATA_FIXES, SCHEMA_SQL, SCHEMA_VERSION } from "./schema.ts";

export interface WarehouseOptions {
  memoryLimit?: string;
  threads?: number;
  readOnly?: boolean;
  /**
   * 升级方式（D76）：auto（默认）照常升级；light（worker 启动时用）遇到要改大表的升级不做，
   * 进入维护状态（wh.maintenance），等 scripts/migrate.sh 停掉 worker 后用 auto 升级。
   */
  migrate?: "auto" | "light";
}

/** 维护状态的说明（数据横幅、/internal/health 显示） */
export const MAINTENANCE_V3 = "行情仓需要升级到第 3 版，请运行 scripts/migrate.sh";

type Params = DuckDBValue[] | Record<string, DuckDBValue>;
export type Row = Record<string, unknown>;

/** DuckDB 的 BIGINT/HUGEINT 会以 bigint 返回，统一转成 number；DATE 用 SQL 转成字符串再取。 */
function normalize(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v;
}

export class Warehouse {
  private writeChain: Promise<unknown> = Promise.resolve();
  private columnTypes = new Map<string, Array<{ name: string; type: string }>>();
  /** 非空 = 维护状态：行情仓还没升级，worker 不排任务、不认领、读行情仓的接口返回 503 */
  maintenance: string | null = null;

  private constructor(
    readonly path: string,
    private readonly instance: DuckDBInstance,
    readonly conn: DuckDBConnection,
  ) {}

  static async open(path: string, opts: WarehouseOptions = {}): Promise<Warehouse> {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const options: Record<string, string> = {
      memory_limit: opts.memoryLimit ?? "512MB",
      threads: String(opts.threads ?? 2),
      preserve_insertion_order: "false",
    };
    if (opts.readOnly) options.access_mode = "READ_ONLY";
    const instance = await DuckDBInstance.create(path, options);
    const conn = await instance.connect();
    const wh = new Warehouse(path, instance, conn);
    if (!opts.readOnly) await wh.migrate(opts.migrate ?? "auto");
    return wh;
  }

  /**
   * 需要改大表的升级还没做：bars_daily 已存在、却没有第 3 版的 src 列。看的是列在不在、不是 meta 里的版本号——
   * 回滚到旧代码会把版本号写回 2，但列还在，再部署新代码时不该再进维护状态。
   */
  async pendingHeavyMigration(): Promise<boolean> {
    const cols = await this.all<{ name: string }>(
      `SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'bars_daily'`,
    );
    return cols.length > 0 && !cols.some((c) => c.name === "src");
  }

  private async migrate(mode: "auto" | "light"): Promise<void> {
    await this.conn.run(`CREATE TABLE IF NOT EXISTS meta (key VARCHAR PRIMARY KEY, value VARCHAR)`);
    if (mode === "light" && (await this.pendingHeavyMigration())) {
      this.maintenance = MAINTENANCE_V3;
      return;
    }
    const cur = await this.meta("schema_version");
    if (cur !== String(SCHEMA_VERSION)) {
      for (const stmt of SCHEMA_SQL) await this.conn.run(stmt);
      await this.setMeta("schema_version", String(SCHEMA_VERSION));
    }
    // 一次性数据修正（按 meta 键只跑一次）
    for (const fix of DATA_FIXES) {
      if (await this.meta(`fix:${fix.id}`)) continue;
      for (const stmt of fix.sql) await this.conn.run(stmt);
      await this.setMeta(`fix:${fix.id}`, new Date().toISOString());
    }
  }

  async run(sql: string, params?: Params): Promise<void> {
    await this.conn.run(sql, params);
  }

  async all<T = Row>(sql: string, params?: Params): Promise<T[]> {
    const reader = await this.conn.runAndReadAll(sql, params);
    const rows = reader.getRowObjectsJS();
    return rows.map((r) => {
      const o: Row = {};
      for (const [k, v] of Object.entries(r)) o[k] = normalize(v);
      return o as T;
    });
  }

  async one<T = Row>(sql: string, params?: Params): Promise<T | undefined> {
    return (await this.all<T>(sql, params))[0];
  }

  async scalar<T = unknown>(sql: string, params?: Params): Promise<T | undefined> {
    const row = await this.one(sql, params);
    return row ? (Object.values(row)[0] as T) : undefined;
  }

  /** 列式读取：每列一个数组，适合把一只股票的日线装进 TypedArray。 */
  async columns(sql: string, params?: Params): Promise<Record<string, unknown[]>> {
    const reader = await this.conn.runAndReadAll(sql, params);
    const cols = reader.getColumnsObjectJS();
    const out: Record<string, unknown[]> = {};
    for (const [k, arr] of Object.entries(cols)) out[k] = arr.map(normalize);
    return out;
  }

  /** 串行化写操作：ETL 里并发的抓取任务共用一个连接写库。 */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(fn, fn);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  private async typesOf(table: string) {
    let t = this.columnTypes.get(table);
    if (!t) {
      const rows = await this.all<{ name: string; type: string }>(
        `SELECT column_name AS name, data_type AS type FROM information_schema.columns
         WHERE table_name = $t ORDER BY ordinal_position`,
        { t: table },
      );
      if (!rows.length) throw new Error(`行情仓没有表 ${table}`);
      t = rows;
      this.columnTypes.set(table, t);
    }
    return t;
  }

  /**
   * 批量追加（Appender）。rows 的每一行按表的列顺序给值；缺的列补 NULL。
   * 调用方负责幂等（先删同一范围再追加），并放在 exclusive() 里。
   */
  async append(table: string, rows: readonly unknown[][]): Promise<void> {
    if (!rows.length) return;
    const types = await this.typesOf(table);
    const ap = await this.conn.createAppender(table);
    try {
      for (const row of rows) {
        for (let i = 0; i < types.length; i++) {
          const v = row[i];
          if (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))) {
            ap.appendNull();
            continue;
          }
          const t = types[i]!.type;
          if (t === "DOUBLE" || t === "FLOAT") ap.appendDouble(Number(v));
          else if (t === "INTEGER") ap.appendInteger(Math.trunc(Number(v)));
          else if (t === "BIGINT") ap.appendBigInt(BigInt(Math.trunc(Number(v))));
          else if (t === "BOOLEAN") ap.appendBoolean(Boolean(v));
          else ap.appendVarchar(String(v));
        }
        ap.endRow();
      }
      ap.flushSync();
    } finally {
      ap.closeSync();
    }
  }

  async meta(key: string): Promise<string | undefined> {
    const r = await this.one<{ value: string }>(`SELECT value FROM meta WHERE key = $k`, { k: key });
    return r?.value;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.run(`INSERT OR REPLACE INTO meta VALUES ($k, $v)`, { k: key, v: value });
  }

  async checkpoint(): Promise<void> {
    await this.run("CHECKPOINT");
  }

  close(): void {
    this.conn.closeSync();
    this.instance.closeSync();
  }
}

/** SQL 里内联日期列表前做校验（DuckDB 的列表参数需要显式类型，内联更简单）。 */
export function sqlDateList(dates: readonly string[]): string {
  for (const d of dates) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`非法日期 ${d}`);
  return dates.length ? dates.map((d) => `DATE '${d}'`).join(",") : "NULL";
}

/** SQL 里内联代码列表前做校验。 */
export function sqlCodeList(codes: readonly string[]): string {
  for (const c of codes) if (!/^\d{5,6}\.(SH|SZ|BJ|HK)$/.test(c)) throw new Error(`非法代码 ${c}`);
  return codes.length ? codes.map((c) => `'${c}'`).join(",") : "NULL";
}

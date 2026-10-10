/**
 * 合成市场（测试专用）：一次写入小型行情仓——交易日历、证券、日线、因子、指数、数据版本。
 * 每条 INSERT 都写明列名（表尾以后会加列，不能按位置追加）。
 */
import { addDays, type DateStr, FACTOR_MAP, type Market, weekday } from "@ivan/core";
import type { Warehouse } from "../warehouse/db.ts";

export interface SeedStock {
  code: string;
  name: string;
  board?: string;
  industry_l1?: string;
  industry?: string;
  listDate?: DateStr;
  delistDate?: DateStr | null;
  lotSize?: number;
  /** 第 i 个交易日的收盘价；NaN = 这天没有行情（停牌 / 未上市 / 已退市） */
  close: (i: number) => number;
  open?: (i: number) => number;
  adj?: (i: number) => number;
  volume?: (i: number) => number;
  /** 第 i 个交易日的因子值（键必须在因子注册表里）；可覆盖板块、行业 */
  factors?: (i: number) => Record<string, number | boolean | string | null>;
}

export interface SeedOptions {
  market: Market;
  start: DateStr;
  /** 从 start 起取多少个工作日（再去掉 skipDates） */
  days: number;
  stocks: SeedStock[];
  /** 不开市的工作日（模拟节假日） */
  skipDates?: DateStr[];
  /** 指数收盘：默认 A 股 csi300_tr / csi300 / sse，港股 hsi_tr / hsi，都是 1000 × 1.0005^i */
  index?: Record<string, (i: number) => number>;
  /** 是否写一条数据版本（默认写，as_of = 最后一个交易日，kind = backfill，status = ok） */
  dataVersion?: boolean;
}

type Lit = number | string | boolean | null | undefined;

function sqlLit(v: Lit, kind: "number" | "string" | "bool" | "date" = "string"): string {
  if (v === null || v === undefined) return "NULL";
  if (kind === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new Error(`非法日期 ${v}`);
    return `DATE '${v}'`;
  }
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  return `'${String(v).replaceAll("'", "''")}'`;
}

/** 按列名批量插入（每批 500 行）。 */
async function insertRows(
  wh: Warehouse,
  table: string,
  cols: readonly string[],
  rows: readonly string[][],
): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await wh.run(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES ${chunk.map((r) => `(${r.join(", ")})`).join(",\n")}`,
    );
  }
}

/** 从 start 起 days 个工作日，去掉 skipDates。 */
export function syntheticCalendar(start: DateStr, days: number, skipDates: DateStr[] = []): DateStr[] {
  const out: DateStr[] = [];
  for (let d = start, n = 0; n < days; d = addDays(d, 1)) {
    const w = weekday(d);
    if (w === 0 || w === 6) continue;
    n++;
    if (!skipDates.includes(d)) out.push(d);
  }
  return out;
}

const DEFAULT_INDEX: Record<Market, string[]> = {
  A: ["csi300_tr", "csi300", "sse"],
  HK: ["hsi_tr", "hsi"],
};

export async function seedSyntheticMarket(
  wh: Warehouse,
  o: SeedOptions,
): Promise<{ calendar: DateStr[] }> {
  const calendar = syntheticCalendar(o.start, o.days, o.skipDates);
  if (!calendar.length) throw new Error("合成市场的交易日历是空的");
  const m = o.market;

  await insertRows(
    wh,
    "trade_calendar",
    ["market", "date"],
    calendar.map((d) => [sqlLit(m), sqlLit(d, "date")]),
  );

  await insertRows(
    wh,
    "securities",
    [
      "code",
      "market",
      "name",
      "board",
      "list_date",
      "delist_date",
      "lot_size",
      "industry_l1",
      "industry",
    ],
    o.stocks.map((s) => [
      sqlLit(s.code),
      sqlLit(m),
      sqlLit(s.name),
      sqlLit(s.board ?? (m === "A" ? "main" : "hk_main")),
      sqlLit(s.listDate ?? null, "date"),
      sqlLit(s.delistDate ?? null, "date"),
      sqlLit(s.lotSize ?? 100),
      sqlLit(s.industry_l1 ?? null),
      sqlLit(s.industry ?? null),
    ]),
  );

  const bars: string[][] = [];
  const factorRows: Array<{ base: string[]; f: Record<string, Lit> }> = [];
  const factorKeys = new Set<string>(["board", "industry", "industry_l1"]);
  for (const s of o.stocks) {
    for (let i = 0; i < calendar.length; i++) {
      const close = s.close(i);
      if (!Number.isFinite(close)) continue;
      const d = calendar[i]!;
      const open = s.open?.(i) ?? close;
      const volume = s.volume?.(i) ?? 1e6;
      bars.push([
        sqlLit(s.code),
        sqlLit(d, "date"),
        sqlLit(open),
        sqlLit(Math.max(open, close)),
        sqlLit(Math.min(open, close)),
        sqlLit(close),
        sqlLit(volume),
        sqlLit(close * volume),
        sqlLit(s.adj?.(i) ?? 1),
      ]);
      // 选股 SQL 按 factors_daily 的板块、行业筛选与分组：默认把证券表的值抄到每一行
      const f: Record<string, Lit> = {
        board: s.board ?? (m === "A" ? "main" : "hk_main"),
        industry: s.industry ?? null,
        industry_l1: s.industry_l1 ?? null,
        ...s.factors?.(i),
      };
      for (const k of Object.keys(f)) {
        if (!FACTOR_MAP.has(k)) throw new Error(`合成市场：因子「${k}」不在注册表里`);
        factorKeys.add(k);
      }
      factorRows.push({ base: [sqlLit(s.code), sqlLit(d, "date"), sqlLit(m), sqlLit(close)], f });
    }
  }
  await insertRows(
    wh,
    "bars_daily",
    ["code", "date", "open", "high", "low", "close", "volume", "amount", "adj"],
    bars,
  );

  const keys = [...factorKeys];
  const kindOf = (k: string) => {
    const kind = FACTOR_MAP.get(k)!.kind;
    return kind === "bool" ? "bool" : kind === "category" ? "string" : "number";
  };
  await insertRows(
    wh,
    "factors_daily",
    ["code", "date", "market", "close", ...keys],
    factorRows.map((r) => [...r.base, ...keys.map((k) => sqlLit(r.f[k], kindOf(k)))]),
  );

  const index =
    o.index ??
    Object.fromEntries(DEFAULT_INDEX[m].map((sym) => [sym, (i: number) => 1000 * 1.0005 ** i]));
  for (const [sym, closeAt] of Object.entries(index)) {
    await insertRows(
      wh,
      "index_bars",
      ["sym", "date", "close", "provisional"],
      calendar.map((d, i) => [sqlLit(sym), sqlLit(d, "date"), sqlLit(closeAt(i)), "false"]),
    );
  }

  if (o.dataVersion !== false) {
    await wh.run(
      `INSERT INTO data_versions (id, market, as_of, kind, status)
       VALUES (nextval('data_version_seq'), $m, $d::DATE, 'backfill', 'ok')`,
      { m, d: calendar.at(-1)! },
    );
  }
  return { calendar };
}

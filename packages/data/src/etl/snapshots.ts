/**
 * 点时属性快照（D61，本轮只采集，不改因子）：行业、每手股数、深港通标记这类「只有当前值」的属性，
 * 每晚证券表刷新时和库里的当前区间比一次，变了就关旧区间、开新区间，攒出「某天当时是什么」。
 *
 * - 区间是 [valid_from, valid_to)，valid_to 为空 = 当前值；
 * - 第一次快照从当天起算，绝不回填（之前的日子读到的是「首次名单」，preSnapshot = true）；
 * - 同一天重跑幂等；一天里超过 massChangeGuard（默认 30%）的代码同时变化时整批不记（多半是数据源改了名），
 *   记进 meta `snapshot_skip:{attr}:{market}`，管理页显示成一行警示。
 */
import { addDays, type DateStr, type Market } from "@ivan/core";
import { sqlCodeList, type Warehouse } from "../warehouse/db.ts";

/** 每个市场采集的属性 */
export const CAPTURE_ATTRS: Record<Market, readonly string[]> = {
  A: ["industry_l1", "industry"],
  HK: ["industry_l1", "lot_size", "hk_connect_sz"],
};

/** 属性的中文名（日志、管理页用） */
export const ATTR_LABEL: Record<string, string> = {
  industry_l1: "一级行业",
  industry: "行业",
  lot_size: "每手股数",
  hk_connect_sz: "深港通名单",
};

/** attr_history 没有市场列：按代码后缀区分 */
function marketWhere(market: Market, col = "code"): string {
  return market === "HK" ? `${col} LIKE '%.HK'` : `${col} NOT LIKE '%.HK'`;
}

export interface SnapshotResult {
  opened: number;
  closed: number;
  skipped: boolean;
  /** 变化（值变了或从名单里消失）的代码占当前区间数的比例 */
  changedPct: number;
}

export async function upsertSnapshot(
  wh: Warehouse,
  attr: string,
  current: Map<string, string | null>,
  date: DateStr,
  src: string,
  ver: number | null,
  opts: { market: Market; massChangeGuard?: number },
): Promise<SnapshotResult> {
  const guard = opts.massChangeGuard ?? 0.3;
  return wh.exclusive(async () => {
    const open = new Map(
      (
        await wh.all<{ code: string; value: string | null; valid_from: string }>(
          `SELECT code, value, valid_from::VARCHAR AS valid_from FROM attr_history
           WHERE attr = $a AND valid_to IS NULL AND ${marketWhere(opts.market)}`,
          { a: attr },
        )
      ).map((r) => [r.code, r]),
    );
    const changed: string[] = [];
    const added: string[] = [];
    const gone: string[] = [];
    for (const [code, value] of current) {
      const o = open.get(code);
      if (!o) added.push(code);
      else if ((o.value ?? null) !== (value ?? null)) changed.push(code);
    }
    for (const code of open.keys()) if (!current.has(code)) gone.push(code);
    const changedPct = open.size ? (changed.length + gone.length) / open.size : 0;
    if (open.size && changed.length + gone.length > guard * open.size) {
      await wh.setMeta(
        `snapshot_skip:${attr}:${opts.market}`,
        JSON.stringify({ date, pct: changedPct }),
      );
      return { opened: 0, closed: 0, skipped: true, changedPct };
    }

    let opened = 0;
    let closed = 0;
    const toClose: string[] = [];
    const toOpen: unknown[][] = [];
    // 值变了：今天开的区间直接改值（同一天重跑）；否则关旧区间、开新区间
    for (const code of changed) {
      const o = open.get(code)!;
      const value = current.get(code) ?? null;
      if (o.valid_from === date) {
        // 同一天先变过去、又变回来：并回前一个区间，不留两段相同的值
        const prev = await wh.one<{ value: string | null }>(
          `SELECT value FROM attr_history WHERE attr = $a AND code = $c AND valid_to = $d::DATE`,
          { a: attr, c: code, d: date },
        );
        if (prev && (prev.value ?? null) === value) {
          await wh.run(
            `DELETE FROM attr_history WHERE attr = $a AND code = $c AND valid_from = $d::DATE AND valid_to IS NULL`,
            { a: attr, c: code, d: date },
          );
          await wh.run(
            `UPDATE attr_history SET valid_to = NULL WHERE attr = $a AND code = $c AND valid_to = $d::DATE`,
            { a: attr, c: code, d: date },
          );
        } else {
          await wh.run(
            `UPDATE attr_history SET value = $v, src = $s, ver = $ver
             WHERE attr = $a AND code = $c AND valid_from = $d::DATE AND valid_to IS NULL`,
            { a: attr, c: code, d: date, v: value, s: src, ver },
          );
        }
        continue;
      }
      toClose.push(code);
      toOpen.push([code, attr, value, date, null, src, ver]);
    }
    // 从名单里消失：关区间（今天才开的区间直接删掉，不留空区间）
    for (const code of gone) {
      if (open.get(code)!.valid_from === date) {
        await wh.run(
          `DELETE FROM attr_history WHERE attr = $a AND code = $c AND valid_from = $d::DATE AND valid_to IS NULL`,
          { a: attr, c: code, d: date },
        );
        closed++;
      } else toClose.push(code);
    }
    for (const code of added) toOpen.push([code, attr, current.get(code) ?? null, date, null, src, ver]);
    if (toClose.length) {
      await wh.run(
        `UPDATE attr_history SET valid_to = $d::DATE
         WHERE attr = $a AND valid_to IS NULL AND code IN (${sqlCodeList(toClose)})`,
        { a: attr, d: date },
      );
      closed += toClose.length;
    }
    await wh.append("attr_history", toOpen);
    opened += toOpen.length;
    return { opened, closed, skipped: false, changedPct };
  });
}

/**
 * 某只股票某天的属性值（点时）。早于这个属性的首次快照日时，返回这只股票最早的一段（首次名单）并标 preSnapshot；
 * 快照开始以后不在任何区间里（当时不在名单上）返回 null。
 */
export async function attrAsOf(
  wh: Warehouse,
  attr: string,
  code: string,
  d: DateStr,
): Promise<{ value: string | null; from: DateStr; preSnapshot: boolean } | null> {
  const hit = await wh.one<{ value: string | null; from: string }>(
    `SELECT value, valid_from::VARCHAR AS "from" FROM attr_history
     WHERE attr = $a AND code = $c AND valid_from <= $d::DATE AND (valid_to IS NULL OR $d::DATE < valid_to)
     ORDER BY valid_from DESC LIMIT 1`,
    { a: attr, c: code, d },
  );
  if (hit) return { value: hit.value ?? null, from: hit.from, preSnapshot: false };
  const market: Market = code.endsWith(".HK") ? "HK" : "A";
  const first = await attrFirstDate(wh, attr, market);
  if (!first || d >= first) return null;
  const earliest = await wh.one<{ value: string | null; from: string }>(
    `SELECT value, valid_from::VARCHAR AS "from" FROM attr_history
     WHERE attr = $a AND code = $c ORDER BY valid_from LIMIT 1`,
    { a: attr, c: code },
  );
  if (!earliest || earliest.from !== first) return null;
  return { value: earliest.value ?? null, from: earliest.from, preSnapshot: true };
}

/** 属性的首次快照日（这一天起才算点时） */
export async function attrFirstDate(
  wh: Warehouse,
  attr: string,
  market: Market,
): Promise<DateStr | null> {
  return (
    (await wh.scalar<string>(
      `SELECT min(valid_from)::VARCHAR FROM attr_history WHERE attr = $a AND ${marketWhere(market)}`,
      { a: attr },
    )) ?? null
  );
}

export interface AttrCapture {
  attr: string;
  firstDate: DateStr | null;
  openRows: number;
  /** 近 7 天变化的代码数（不含首次快照那天） */
  changes7d: number;
  /** 最近一次被跳过的整批变化 */
  lastSkipped: { date: DateStr; pct: number } | null;
}

export interface CaptureStatus {
  attrs: AttrCapture[];
  financialsSeen: { rows: number; new7d: number };
}

/** 采集看得见（/internal/data-status 的 capture）：各属性的首次记录日、当前区间数、近 7 天变化、跳过记录 */
export async function captureStatus(
  wh: Warehouse,
  market: Market,
  today: DateStr,
): Promise<CaptureStatus> {
  const since = addDays(today, -7);
  const attrs: AttrCapture[] = [];
  for (const attr of CAPTURE_ATTRS[market]) {
    const firstDate = await attrFirstDate(wh, attr, market);
    const openRows = Number(
      (await wh.scalar(
        `SELECT count(*) FROM attr_history WHERE attr = $a AND valid_to IS NULL AND ${marketWhere(market)}`,
        { a: attr },
      )) ?? 0,
    );
    const changes7d = firstDate
      ? Number(
          (await wh.scalar(
            `SELECT count(DISTINCT code) FROM attr_history
             WHERE attr = $a AND ${marketWhere(market)}
               AND ((valid_from >= $s::DATE AND valid_from > $f::DATE) OR valid_to >= $s::DATE)`,
            { a: attr, s: since, f: firstDate },
          )) ?? 0,
        )
      : 0;
    const raw = await wh.meta(`snapshot_skip:${attr}:${market}`);
    let lastSkipped: AttrCapture["lastSkipped"];
    try {
      lastSkipped = raw ? (JSON.parse(raw) as AttrCapture["lastSkipped"]) : null;
    } catch {
      lastSkipped = null;
    }
    attrs.push({ attr, firstDate, openRows, changes7d, lastSkipped });
  }
  const fin = await wh.one<{ rows: number; new7d: number }>(
    `SELECT count(*) AS rows, count(*) FILTER (WHERE first_seen >= $s::DATE) AS new7d
     FROM financials_seen WHERE ${marketWhere(market)}`,
    { s: since },
  );
  return { attrs, financialsSeen: { rows: Number(fin?.rows ?? 0), new7d: Number(fin?.new7d ?? 0) } };
}

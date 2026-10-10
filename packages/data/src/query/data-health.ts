/**
 * 数据健康（D73、D74）：辅助步骤的连续失败、数据质量卡、管理员标记已核对、一次运行的行情来源与数据提示。
 */
import {
  type DateStr,
  type Market,
  type RunProvenance,
  SOFT_FAILING_ALERT,
  SOFT_STEP_LABEL,
  type SimInput,
  type SoftStep,
} from "@ivan/core";
import type { Completeness, SoftOutcome, SoftStepStatus } from "../etl/completeness.ts";
import { sqlCodeList, type Warehouse } from "../warehouse/db.ts";

/** 数据版本里存的完整性 JSON（夜间增量写；date 是那一晚） */
type StoredCompleteness = Partial<Completeness> & { date?: DateStr };

async function recentCompleteness(
  wh: Warehouse,
  market: string,
  limit = 20,
  o: { nightsOnly?: boolean } = {},
): Promise<Array<{ id: number; status: string; c: StoredCompleteness }>> {
  // nightsOnly：不要周检的版本（只记了事件数据补扫，不是一晚的日线），免得占掉 LIMIT 的名额
  const rows = await wh.all<{ id: number; status: string; c: string; d: string | null }>(
    `SELECT id, status, completeness AS c, started_at::DATE::VARCHAR AS d FROM data_versions
     WHERE market = $m AND status IN ('ok', 'incomplete') AND completeness IS NOT NULL
       ${o.nightsOnly ? "AND coalesce(kind, '') <> 'check'" : ""}
     ORDER BY id DESC LIMIT ${Math.max(1, Math.floor(limit))}`,
    { m: market },
  );
  const out: Array<{ id: number; status: string; c: StoredCompleteness }> = [];
  for (const r of rows) {
    try {
      const c = JSON.parse(r.c) as StoredCompleteness;
      out.push({ id: r.id, status: r.status, c: { ...c, date: c.date ?? r.d ?? undefined } });
    } catch {
      // 读不懂的旧行跳过
    }
  }
  return out;
}

/**
 * 各辅助步骤的近况（近 20 个 ok / incomplete 版本）：最近一次成功的日子、连续失败的晚数（同一晚重跑算一晚，
 * 那晚有一次成功就算成功）、这串失败的第一晚。没跑到这一步的版本（闸门没过）不算。
 */
export async function softStepStatus(wh: Warehouse, market: string): Promise<SoftStepStatus[]> {
  const versions = await recentCompleteness(wh, market);
  // 每一步按晚汇总：date -> 这晚有没有成功过（版本从新到旧）
  const nights = new Map<SoftStep, Array<{ date: DateStr; ok: boolean }>>();
  for (const v of versions) {
    for (const o of (v.c.soft ?? []) as SoftOutcome[]) {
      const list = nights.get(o.step) ?? [];
      const date = v.c.date ?? "";
      const same = list.find((n) => n.date === date);
      if (same) same.ok ||= o.ok;
      else list.push({ date, ok: o.ok });
      nights.set(o.step, list);
    }
  }
  const out: SoftStepStatus[] = [];
  for (const step of Object.keys(SOFT_STEP_LABEL) as SoftStep[]) {
    const list = nights.get(step);
    if (!list) continue;
    let failingNights = 0;
    let firstFailDate: DateStr | null = null;
    for (const n of list) {
      if (n.ok) break;
      failingNights++;
      firstFailDate = n.date || null;
    }
    out.push({
      step,
      lastOkDate: list.find((n) => n.ok)?.date || null,
      failingNights,
      firstFailDate,
    });
  }
  return out;
}

export interface DataIssueRow {
  id: number;
  code: string;
  name: string | null;
  date: DateStr;
  rule: string;
  severity: string;
  detail: string | null;
}

export interface DataQuality {
  days: number;
  /** 近 N 天新出现的问题：按规则与级别计，open = 其中还没解决的 */
  byRule: Array<{ rule: string; severity: string; n: number; open: number }>;
  /** 近 N 天问题最多的代码 */
  topCodes: Array<{ code: string; name: string | null; n: number }>;
  /** 最新 50 条未解决的问题 */
  open: DataIssueRow[];
  /** 最近几晚的完整性 */
  lastVersions: Array<{
    id: number;
    market: string;
    status: string;
    date: DateStr | null;
    expected: number | null;
    updated: number | null;
    noTrade: number | null;
    missing: number;
    missingCritical: number;
    accepted: number;
    reasons: string[];
  }>;
}

/** 管理页「数据质量」卡 */
export async function dataQuality(wh: Warehouse, days = 7): Promise<DataQuality> {
  const d = Math.min(Math.max(Math.floor(days) || 7, 1), 90);
  const since = `current_timestamp - INTERVAL ${d} DAY`;
  const byRule = await wh.all<{ rule: string; severity: string; n: number; open: number }>(
    `SELECT rule, severity, count(*)::INTEGER AS n,
            count(*) FILTER (WHERE resolved_ver IS NULL AND resolved_by IS NULL)::INTEGER AS open
     FROM data_issues WHERE created_at >= ${since}
     GROUP BY rule, severity ORDER BY n DESC, rule`,
  );
  const topCodes = await wh.all<{ code: string; name: string | null; n: number }>(
    `SELECT i.code, any_value(s.name) AS name, count(*)::INTEGER AS n
     FROM data_issues i LEFT JOIN securities s ON s.code = i.code
     WHERE i.created_at >= ${since} AND i.code IS NOT NULL
     GROUP BY i.code ORDER BY n DESC, i.code LIMIT 10`,
  );
  const open = await wh.all<DataIssueRow>(
    // 两融没到齐（partial_exchange）是整天的问题，没有代码：写 --
    `SELECT i.id, coalesce(i.code, '--') AS code, s.name, i.date::VARCHAR AS date, i.rule, i.severity, i.detail
     FROM data_issues i LEFT JOIN securities s ON s.code = i.code
     WHERE i.resolved_ver IS NULL AND i.resolved_by IS NULL
     ORDER BY i.id DESC LIMIT 50`,
  );
  const lastVersions: DataQuality["lastVersions"] = [];
  for (const m of ["A", "HK"]) {
    for (const v of await recentCompleteness(wh, m, 5, { nightsOnly: true })) {
      // 周检的版本只记了事件数据补扫（S15），不是一晚的日线
      if (v.c.expected === undefined) continue;
      lastVersions.push({
        id: v.id,
        market: m,
        status: v.status,
        date: v.c.date ?? null,
        expected: v.c.expected ?? null,
        updated: v.c.updated ?? null,
        noTrade: v.c.noTrade ?? null,
        // 存下的缺失名单最多 200 只：按原因计数加总才是真实的只数
        missing:
          Object.values(v.c.missingReasons ?? {}).reduce((a, b) => a + b, 0) || (v.c.missing?.length ?? 0),
        missingCritical: v.c.missingCritical?.length ?? 0,
        accepted: v.c.accepted?.length ?? 0,
        reasons: v.c.reasons ?? [],
      });
    }
  }
  return {
    days: d,
    byRule,
    topCodes,
    open: open.map((r) => ({ ...r, id: Number(r.id) })),
    lastVersions,
  };
}

/**
 * 管理员把一条数据问题标为已核对（resolved_by = admin，resolved_ver = 这个市场当前提交的版本）。
 * 没有这条返回 null；已经解决的原样返回。
 */
export async function resolveDataIssue(
  wh: Warehouse,
  id: number,
): Promise<{ id: number; resolvedVer: number | null; resolvedBy: string } | null> {
  return wh.exclusive(async () => {
    const row = await wh.one<{ code: string | null; resolved_ver: number | null; resolved_by: string | null }>(
      `SELECT code, resolved_ver, resolved_by FROM data_issues WHERE id = $id`,
      { id },
    );
    if (!row) return null;
    if (row.resolved_by) {
      return { id, resolvedVer: row.resolved_ver, resolvedBy: row.resolved_by };
    }
    // 点时事件数据（S15）的问题只有 A 股，两融没到齐的那条没有代码
    const market: Market = (row.code ?? "").endsWith(".HK") ? "HK" : "A";
    // 当前提交的版本（与 latestDataVersion 同一口径；这里不引它，免得和 backtest.ts 互相引用）
    const ver =
      (await wh.scalar<number>(
        `SELECT id FROM data_versions WHERE market = $m AND coalesce(status, 'ok') = 'ok'
         ORDER BY id DESC LIMIT 1`,
        { m: market },
      )) ?? null;
    await wh.run(
      `UPDATE data_issues SET resolved_ver = $v, resolved_by = 'admin' WHERE id = $id`,
      { v: ver, id },
    );
    return { id, resolvedVer: ver, resolvedBy: "admin" };
  });
}

type Caveat = NonNullable<SimInput["dataCaveats"]>[number];

/**
 * 一次运行的行情来源与数据提示（S13）：面板代码在 [from, to] 里各来源的行数、缺失天数、入选过的股票的未解决数据问题，
 * 以及财报与股本久未更新。提示只进 reportHash（检查项），不进输入指纹。
 */
export async function runProvenance(
  wh: Warehouse,
  market: string,
  codes: readonly string[],
  from: DateStr,
  to: DateStr,
): Promise<{ provenance: RunProvenance; caveats: Caveat[] }> {
  const provenance: RunProvenance = {
    bySource: {},
    total: 0,
    unknownRows: 0,
    gapDays: 0,
    gapCodes: 0,
    issues: { reject: 0, flag: 0 },
    accepted: [],
  };
  const caveats: Caveat[] = [];
  if (codes.length) {
    const list = sqlCodeList(codes);
    const p = { a: from, b: to };
    for (const r of await wh.all<{ src: string; n: number }>(
      `SELECT coalesce(src, 'unknown') AS src, count(*)::INTEGER AS n FROM bars_daily
       WHERE code IN (${list}) AND date BETWEEN $a::DATE AND $b::DATE GROUP BY 1 ORDER BY 1`,
      p,
    )) {
      provenance.bySource[r.src] = r.n;
      provenance.total += r.n;
    }
    provenance.unknownRows = provenance.bySource.unknown ?? 0;
    const gap = await wh.one<{ n: number; c: number }>(
      `SELECT count(*)::INTEGER AS n, count(DISTINCT code)::INTEGER AS c FROM bar_status
       WHERE status = 'missing' AND code IN (${list}) AND date BETWEEN $a::DATE AND $b::DATE`,
      p,
    );
    provenance.gapDays = gap?.n ?? 0;
    provenance.gapCodes = gap?.c ?? 0;
    for (const r of await wh.all<{ severity: string; n: number }>(
      `SELECT severity, count(*)::INTEGER AS n FROM data_issues
       WHERE dataset = 'bars' AND resolved_ver IS NULL AND resolved_by IS NULL
         AND code IN (${list}) AND date BETWEEN $a::DATE AND $b::DATE
       GROUP BY severity`,
      p,
    )) {
      if (r.severity === "reject") provenance.issues.reject += r.n;
      else provenance.issues.flag += r.n;
    }
    // ETL_ACCEPT_MISSING 放行过的面板代码（区间里的夜间版本记下的）
    const panel = new Set(codes);
    const accepted = new Set<string>();
    for (const v of await recentCompleteness(wh, market, 1000)) {
      if (!v.c.date || v.c.date < from || v.c.date > to) continue;
      for (const c of v.c.accepted ?? []) if (panel.has(c)) accepted.add(c);
    }
    provenance.accepted = [...accepted].sort();
  }
  if (provenance.gapDays > 0) {
    caveats.push({
      id: "data_gap",
      level: "warn",
      title: "有数据缺口",
      detail: `有 ${provenance.gapCodes} 只股票共 ${provenance.gapDays} 天的日线没拿到，回测把这些天当成停牌处理。`,
    });
  }
  const { reject, flag } = provenance.issues;
  if (reject + flag > 0) {
    caveats.push({
      id: "data_issue",
      level: reject > 0 ? "warn" : "info",
      title: "数据问题",
      detail: `回测区间里入选过的股票有 ${reject + flag} 处数据问题（${reject} 处被拦下），详情见管理页「数据质量」。`,
    });
  }
  const fund = (await softStepStatus(wh, market)).find((s) => s.step === "fundamentals");
  if (
    fund &&
    fund.failingNights >= SOFT_FAILING_ALERT &&
    fund.firstFailDate &&
    to >= fund.firstFailDate
  ) {
    caveats.push({
      id: "stale_fundamentals",
      level: "warn",
      title: "财报与股本久未更新",
      detail: `财报与股本已经 ${fund.failingNights} 个交易日没更新成功，估值、ROE、市值可能是旧的。`,
    });
  }
  return { provenance, caveats };
}

/**
 * 最新提交版本那一晚缺日线的持仓 / 计划代码（completeness.missingCritical）。管理员单独重跑结算时用，
 * 让「数据未更新」不因重跑消失；最新提交的不是那晚的夜间增量（比如抽检）时为空。
 */
export async function committedMissingCritical(wh: Warehouse, market: string): Promise<string[]> {
  const r = await wh.one<{ kind: string | null; c: string | null }>(
    `SELECT kind, completeness AS c FROM data_versions
     WHERE market = $m AND coalesce(status, 'ok') = 'ok' ORDER BY id DESC LIMIT 1`,
    { m: market },
  );
  if (!r?.c || r.kind !== "daily") return [];
  try {
    return (JSON.parse(r.c) as Partial<Completeness>).missingCritical ?? [];
  } catch {
    return [];
  }
}

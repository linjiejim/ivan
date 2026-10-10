/**
 * 点时事件数据集运行器（D81）：与来源无关、可续跑、失败就关。只认 PitFetcher（fetchChunk + canary）与 datasets.ts 的规格，
 * 不认任何来源的报表、列名与过滤串。
 *
 * 一次同步：
 * 1. 金丝雀：链上第一个 ok / empty 的来源负责这一次；没有一家通过 → 这个数据集这次不删不写，pit_sync 记 canary_failed；
 * 2. 分块：回填跳过 etl_progress 里 `pit:<id>` 已 done 的块（--force 除外）；夜间与周检窗口从不写这些进度键；
 *    超过 budgetMs 就在下一块之前停下；
 * 3. 每块：整块取完（来源负责核对行数与重复行）→ 两融到齐检查 → 算可得日 → 先追加进临时表，再用一次调用执行整段事务
 *    （整窗替换，或合并：已有键更新、新键追加、消失的键设 gone_from）→ 记进度；
 * 4. 更新 pit_sync；夜间把结果记进取数台账（data_versions.sources）。
 *
 * 不开数据版本：行上的 ver 是调用方给的 ctx.ver（夜间、周检有，后台回填为空），batch 是 pit_batches.id（D81）。
 */
import {
  CANARY_STATUS_TEXT,
  type DateStr,
  PIT_DATASETS,
  type PitDatasetId,
  type PitSyncStatus,
} from "@ivan/core";
import { BlockedError } from "../http.ts";
import { ADAPTERS, resolveEventChain } from "../sources/registry.ts";
import {
  type CanaryResult,
  isSchemaDrift,
  type PitChunk,
  type PitFetcher,
  type PitFetchResult,
  type SourceCtx,
  type SourceId,
  srcCode,
} from "../sources/types.ts";
import { sqlDateList } from "../warehouse/db.ts";
import { doneKeys, type EtlContext, errMsg, markDone, markFailed, markPartial } from "./context.ts";
import { type ExistingRow, PIT_DATASET_SPECS, type PitDataset, type PitStamp } from "./datasets.ts";
import { type AvailEnv, buildAvailEnv } from "./trading-days.ts";

/** 回填默认从哪天起（和行情一样留出 5 年给分位） */
export const PIT_DEFAULT_SINCE: DateStr = "2013-01-01";

/** 两融未到齐的日子在夜间重取多少个交易日，之后记数据问题 partial_exchange */
export const MARGIN_PARTIAL_SESSIONS = 20;

/** 两融到齐：原始行数不少于上一个完整交易日的这个比例 */
export const MARGIN_COMPLETE_RATIO = 0.8;

/** 两融每天到齐情况的进度任务名（夜间、周检、回填都写；和回填完成判断用的 pit:<id> 分开） */
const MARGIN_DAYS_TASK = "pit_days:margin";

export type PitMode = "nightly" | "backfill" | "check";

export interface PitSource {
  source: SourceId;
  fetcher: PitFetcher<unknown>;
}

export interface PitSyncOptions {
  mode: PitMode;
  from?: DateStr;
  to?: DateStr;
  budgetMs?: number;
  force?: boolean;
  /** pit_batches.id：每行都盖上 */
  batch: number;
  /** 替换来源链（测试用假的非东财实现；不给就按 resolveEventChain） */
  chain?: PitSource[];
  /** 复用已建好的可得日环境（夜间四个数据集共用一份） */
  env?: AvailEnv;
  /** 计时（测试注入） */
  now?: () => number;
}

export interface PitSyncResult {
  id: PitDatasetId;
  ok: boolean;
  canary: CanaryResult | null;
  servedBy: SourceId | null;
  /** 这次要处理的块数（回填已跳过 done 的） */
  chunks: number;
  done: number;
  /** 写入了但不算完成的块（两融只拿到一个交易所） */
  partial: string[];
  failed: string[];
  /** 没处理到的块（预算用完、结构变了、被风控） */
  remaining: number;
  rows: number;
  requests: number;
  /** 周检：这次新找到的行数 */
  lateRows?: number;
  stoppedForBudget: boolean;
  blocked: boolean;
  status: PitSyncStatus;
  /** 一句中文（管理页、日志、soft 步骤的错误） */
  detail: string;
}

const sourceLabel = (s: SourceId) => ADAPTERS[s]?.label ?? s;

function chainOf(id: PitDatasetId, ctx: EtlContext): PitSource[] {
  return resolveEventChain(id, process.env, ctx.log).adapters.map((a) => ({
    source: a.id,
    fetcher: a.events![id]!,
  }));
}

// ── pit_sync ──

interface PitSyncRow {
  dataset: string;
  backfill_from: string | null;
  covered_from: string | null;
  window_through: string | null;
  synced_at: string | null;
  nightly_since: string | null;
  last_ok_at: string | null;
  last_status: string | null;
  last_detail: string | null;
  canary: string | null;
}

export async function readPitSync(
  wh: EtlContext["wh"],
): Promise<Map<string, PitSyncRow>> {
  const rows = await wh.all<PitSyncRow>(
    `SELECT dataset, backfill_from::VARCHAR AS backfill_from, covered_from::VARCHAR AS covered_from,
            window_through::VARCHAR AS window_through, synced_at::VARCHAR AS synced_at,
            nightly_since::VARCHAR AS nightly_since, strftime(last_ok_at, '%Y-%m-%dT%H:%M:%S') AS last_ok_at,
            last_status, last_detail, canary
     FROM pit_sync`,
  );
  return new Map(rows.map((r) => [r.dataset, r]));
}

async function upsertPitSync(
  ctx: EtlContext,
  id: PitDatasetId,
  patch: Partial<Omit<PitSyncRow, "dataset" | "last_ok_at">> & { okNow?: boolean },
): Promise<void> {
  await ctx.wh.exclusive(async () => {
    const cur = (await readPitSync(ctx.wh)).get(id);
    const next = { ...cur, ...patch };
    await ctx.wh.run(
      `INSERT OR REPLACE INTO pit_sync (dataset, backfill_from, covered_from, window_through, synced_at,
         nightly_since, last_ok_at, last_status, last_detail, canary)
       VALUES ($id, $bf::DATE, $cf::DATE, $wt::DATE, $sa::DATE, $ns::DATE,
         ${patch.okNow ? "current_timestamp" : "$lo::TIMESTAMP"}, $st, $de, $ca)`,
      {
        id,
        bf: next.backfill_from ?? null,
        cf: next.covered_from ?? null,
        wt: next.window_through ?? null,
        sa: next.synced_at ?? null,
        ns: next.nightly_since ?? null,
        ...(patch.okNow ? {} : { lo: cur?.last_ok_at ?? null }),
        st: next.last_status ?? null,
        de: next.last_detail ?? null,
        ca: next.canary ?? null,
      },
    );
  });
}

// ── pit_batches ──

/** 开一批（夜间、周检、回填、S15b 的补算各一批）；返回 id，每行盖上它 */
export async function openPitBatch(
  ctx: Pick<EtlContext, "wh">,
  kind: "nightly" | "backfill" | "check" | "event_cols",
  datasets: readonly PitDatasetId[],
  dataVersion: number | null,
): Promise<number> {
  return ctx.wh.exclusive(async () => {
    const id = Number(await ctx.wh.scalar(`SELECT nextval('pit_batch_seq')`));
    await ctx.wh.run(
      `INSERT INTO pit_batches (id, kind, datasets, data_version, started_at, status, chunks, rows, requests)
       VALUES ($id, $k, $d, $v, current_timestamp, 'running', 0, 0, 0)`,
      { id, k: kind, d: datasets.join(","), v: dataVersion },
    );
    return id;
  });
}

export async function finishPitBatch(
  ctx: Pick<EtlContext, "wh">,
  id: number,
  results: readonly PitSyncResult[],
  note?: string,
): Promise<void> {
  const failed = results.some((r) => !r.ok);
  const partial = results.some((r) => r.partial.length || r.remaining);
  await ctx.wh.exclusive(() =>
    ctx.wh.run(
      `UPDATE pit_batches SET finished_at = current_timestamp, status = $s, chunks = $c, rows = $r,
         requests = $q, note = $n WHERE id = $id`,
      {
        id,
        s: failed ? "failed" : partial ? "partial" : "ok",
        c: results.reduce((a, r) => a + r.done + r.partial.length, 0),
        r: results.reduce((a, r) => a + r.rows, 0),
        q: results.reduce((a, r) => a + r.requests, 0),
        n: note ?? null,
      },
    ),
  );
}

// ── 两融到齐 ──

interface MarginDay {
  rows: number;
  sh: number;
  sz: number;
}

/** d 之前最近一个完整交易日的原始行数（没有记录为 null） */
async function prevCompleteMargin(ctx: EtlContext, d: DateStr): Promise<number | null> {
  const r = await ctx.wh.scalar<string>(
    `SELECT detail FROM etl_progress WHERE task = $t AND status = 'done' AND key < $d
     ORDER BY key DESC LIMIT 1`,
    { t: MARGIN_DAYS_TASK, d },
  );
  if (!r) return null;
  try {
    const n = (JSON.parse(r) as Partial<MarginDay>).rows;
    return typeof n === "number" ? n : null;
  } catch {
    return null;
  }
}

/**
 * 两融这一天到齐了没有：沪深都有、且不少于上一个完整交易日的 80%；没到齐返回说明。
 * 两市都是空的多半是还没公布（T 日的两融下一个交易日早上才有，周末、开盘前补齐时最后一天是空的）：
 * 和只到一个交易所一样记 partial——不算失败、数据窗口停在前一天、之后的夜里再取。
 */
function marginGap(res: PitFetchResult<unknown>, prev: number | null): string | null {
  const ex = res.byExchange ?? { sh: 0, sz: 0 };
  if (ex.sh > 0 && ex.sz === 0) return `只拿到沪市 ${ex.sh} 行`;
  if (ex.sz > 0 && ex.sh === 0) return `只拿到深市 ${ex.sz} 行`;
  if (ex.sh === 0 && ex.sz === 0) return "沪深两市都还没有数据";
  if (prev !== null && res.rawCount < MARGIN_COMPLETE_RATIO * prev) {
    return `只拿到 ${res.rawCount} 行，不到上一个完整交易日（${prev} 行）的 ${MARGIN_COMPLETE_RATIO * 100}%`;
  }
  return null;
}

/**
 * 夜间要补的两融日子：近 20 个交易日里记成 partial 的；更早还没到齐的记一条数据问题 partial_exchange（只记一次）。
 */
async function marginPartialDays(ctx: EtlContext, env: AvailEnv): Promise<DateStr[]> {
  const rows = await ctx.wh.all<{ key: string; detail: string | null }>(
    `SELECT key, detail FROM etl_progress WHERE task = $t AND status = 'partial' ORDER BY key`,
    { t: MARGIN_DAYS_TASK },
  );
  const oldest = env.shiftTd(env.today, -MARGIN_PARTIAL_SESSIONS).date;
  const out: DateStr[] = [];
  for (const r of rows) {
    if (r.key >= oldest) {
      out.push(r.key);
      continue;
    }
    await ctx.wh.exclusive(async () => {
      await ctx.wh.run(
        `INSERT INTO data_issues (ver, dataset, code, date, rule, severity, detail, src)
         VALUES ($v, 'margin', NULL, $d::DATE, 'partial_exchange', 'flag', $de, NULL)`,
        {
          v: ctx.ver ?? null,
          d: r.key,
          de: `${MARGIN_PARTIAL_SESSIONS} 个交易日后两融仍没到齐：${r.detail ?? ""}`.slice(0, 500),
        },
      );
      // 记过一次就不再重取、不再记
      await ctx.wh.run(
        `UPDATE etl_progress SET status = 'stale_partial', updated_at = current_timestamp
         WHERE task = $t AND key = $k`,
        { t: MARGIN_DAYS_TASK, k: r.key },
      );
    });
  }
  return out;
}

// ── 写一块 ──

const sqlStr = (s: string) => `'${s.replaceAll("'", "''")}'`;

interface ChunkWrite {
  written: boolean;
  rows: number;
  /** 这块里库里原来没有的行 */
  late: number;
}

async function writeChunk(
  ctx: EtlContext,
  spec: PitDataset<unknown>,
  chunk: PitChunk,
  fetched: readonly unknown[],
  env: AvailEnv,
  stamp: PitStamp,
  o: { partial: boolean },
): Promise<ChunkWrite> {
  const [from, to] = [chunk.from, chunk.to];
  sqlDateList([from, to, stamp.today]);
  if (stamp.src !== null && !/^[a-z]+$/.test(stamp.src)) throw new Error(`非法来源代码 ${stamp.src}`);
  const prepared = (spec.prepare ? spec.prepare(fetched) : [...fetched]).filter((r) => {
    const d = spec.dateOf(r);
    // 不在证券表里的代码（ETF、基金）丢弃；来源多给的窗口外的行不写
    return env.isASecurity(spec.codeOf(r)) && d >= from && d <= to;
  });
  // 同一键只留最后一行（来源偶尔重复给）
  const byKey = new Map<string, unknown>();
  for (const r of prepared) byKey.set(spec.key(r), r);
  const stage = `pit_stage_${spec.id}`;
  const issueStage = `pit_issue_stage_${spec.id}`;
  const t = spec.table;
  const w = spec.windowColumn;
  const keyEq = (a: string, b: string) => spec.keyColumns.map((k) => `${a}.${k} = ${b}.${k}`).join(" AND ");
  const out: ChunkWrite = { written: false, rows: 0, late: 0 };
  let skip = false;
  const written = await ctx.wh.swap(
    [stage, issueStage],
    () => {
      if (skip) return null;
      const between = `${w} BETWEEN DATE '${from}' AND DATE '${to}'`;
      const issues = `INSERT INTO data_issues (ver, dataset, code, date, rule, severity, detail, src)
        SELECT ${stamp.ver ?? "NULL"}, ${sqlStr(spec.id)}, code, date, rule, 'flag', detail,
          ${stamp.src ? sqlStr(stamp.src) : "NULL"} FROM temp.${issueStage};`;
      if (spec.write === "replace") {
        return `BEGIN TRANSACTION;
          DELETE FROM ${t} WHERE ${between};
          INSERT INTO ${t} SELECT * FROM temp.${stage};
          ${issues}
          COMMIT;`;
      }
      return `BEGIN TRANSACTION;
        UPDATE ${t} SET gone_from = DATE '${stamp.today}'
          WHERE ${between} AND gone_from IS NULL
            AND NOT EXISTS (SELECT 1 FROM temp.${stage} s WHERE ${keyEq("s", t)});
        DELETE FROM ${t} WHERE EXISTS (SELECT 1 FROM temp.${stage} s WHERE ${keyEq("s", t)});
        INSERT INTO ${t} SELECT * FROM temp.${stage};
        ${issues}
        COMMIT;`;
    },
    async () => {
      // 库里这个窗口原来的行（合并要用首次见到的日子、对比消失与重现）
      const existing = await ctx.wh.all<Record<string, unknown>>(
        `SELECT * FROM ${t} WHERE ${w} BETWEEN DATE '${from}' AND DATE '${to}'`,
      );
      const keyOf = (r: Record<string, unknown>) => spec.keyColumns.map((k) => String(r[k])).join("|");
      const old = new Map(existing.map((r) => [keyOf(r), r]));
      const live = existing.filter((r) => r.gone_from === null || r.gone_from === undefined).length;
      // 一行都没取到、库里却有：多半是来源这次抽风，不当成「全部撤下」（不删不写）
      if (byKey.size === 0 && live > 0) {
        ctx.log(`${PIT_DATASETS[spec.id].label} ${chunk.id} 一行都没取到，库里有 ${live} 行，先不动`);
        skip = true;
        return;
      }
      // 两融没到齐、而且比库里的少：保留库里的（之后的夜里再取）
      if (spec.write === "replace" && o.partial && byKey.size < existing.length) {
        ctx.log(`${PIT_DATASETS[spec.id].label} ${chunk.id} 没到齐且比库里少，先保留库里的 ${existing.length} 行`);
        skip = true;
        return;
      }
      const rows: unknown[][] = [];
      const issues: unknown[][] = [];
      for (const [k, r] of byKey) {
        const ex = old.get(k) as (Record<string, unknown> & ExistingRow) | undefined;
        const existingRow: ExistingRow | undefined = ex
          ? { first_seen: String(ex.first_seen), gone_from: (ex.gone_from as string | null) ?? null }
          : undefined;
        const avail = spec.avail(r, env, spec.write === "merge" ? existingRow : undefined);
        rows.push(spec.toRow(r, avail, stamp, spec.write === "merge" ? existingRow : undefined));
        if (!ex) out.late++;
        else if (spec.write === "merge" && existingRow?.gone_from) {
          issues.push([spec.codeOf(r), spec.dateOf(r), "row_returned", `${existingRow.gone_from} 撤下后又出现了`]);
        }
      }
      if (spec.write === "replace") out.late = Math.max(0, byKey.size - existing.length);
      if (spec.write === "merge") {
        for (const [k, r] of old) {
          if (byKey.has(k) || (r.gone_from !== null && r.gone_from !== undefined)) continue;
          issues.push([String(r.code), String(r[w]), "row_removed", JSON.stringify(r).slice(0, 1000)]);
        }
      }
      await ctx.wh.run(`CREATE OR REPLACE TEMP TABLE ${stage} AS SELECT * FROM ${t} LIMIT 0`);
      await ctx.wh.append(stage, rows, { temp: true });
      await ctx.wh.run(
        `CREATE OR REPLACE TEMP TABLE ${issueStage} (code VARCHAR, date DATE, rule VARCHAR, detail VARCHAR)`,
      );
      if (spec.id === "holders") {
        // 同一（代码, 截至日）出现了新的公告日：追加一行（键不同），记 avail_moved
        const moved = await ctx.wh.all<{ code: string; d: string; nd: string; old: string }>(
          `SELECT s.code, s.end_date::VARCHAR AS d, s.notice_date::VARCHAR AS nd,
                  string_agg(DISTINCT h.notice_date::VARCHAR, ',') AS old
           FROM temp.${stage} s JOIN ${t} h ON h.code = s.code AND h.end_date = s.end_date
             AND h.notice_date <> s.notice_date
           WHERE NOT EXISTS (SELECT 1 FROM ${t} x WHERE ${keyEq("x", "s")})
           GROUP BY 1, 2, 3`,
        );
        for (const m of moved) {
          issues.push([m.code, m.nd, "avail_moved", `截至 ${m.d} 的户数公告日从 ${m.old} 变成 ${m.nd}`]);
        }
      }
      await ctx.wh.append(issueStage, issues, { temp: true });
      out.rows = rows.length;
    },
  );
  out.written = written;
  if (!written) out.late = 0;
  return out;
}

// ── 同步一个数据集 ──

function failText(label: string, source: SourceId, c: CanaryResult, when: string): string {
  return `${sourceLabel(source)}「${label}」接口${CANARY_STATUS_TEXT[c.status]}：${c.detail}，${when}没更新`;
}

export async function syncPitDataset(
  ctx: EtlContext,
  id: PitDatasetId,
  o: PitSyncOptions,
): Promise<PitSyncResult> {
  const spec = PIT_DATASET_SPECS[id];
  const label = PIT_DATASETS[id].label;
  const now = o.now ?? Date.now;
  const t0 = now();
  const env = o.env ?? (await buildAvailEnv(ctx.wh, ctx.today));
  const chain = o.chain ?? chainOf(id, ctx);
  const sctx: SourceCtx = { http: ctx.http, today: ctx.today, log: ctx.log };
  const when = o.mode === "nightly" ? "今晚" : "这次";
  const result: PitSyncResult = {
    id,
    ok: false,
    canary: null,
    servedBy: null,
    chunks: 0,
    done: 0,
    partial: [],
    failed: [],
    remaining: 0,
    rows: 0,
    requests: 0,
    stoppedForBudget: false,
    blocked: false,
    status: "failed",
    detail: "",
    ...(o.mode === "check" ? { lateRows: 0 } : {}),
  };

  // 1. 金丝雀
  let served: PitSource | null = null;
  for (const c of chain) {
    const r = await c.fetcher.canary(sctx, ctx.today, env.prevTd(ctx.today));
    result.requests++;
    result.canary ??= r;
    if (r.status === "ok" || r.status === "empty") {
      served = c;
      result.canary = r;
      break;
    }
  }
  if (!served) {
    const c = result.canary;
    result.status = c?.status === "blocked" ? "blocked" : "canary_failed";
    result.blocked = c?.status === "blocked";
    result.detail = c ? failText(label, c.source, c, when) : `「${label}」没有可用的数据源，${when}没更新`;
    ctx.log(result.detail);
    await upsertPitSync(ctx, id, {
      last_status: result.status,
      last_detail: result.detail,
      canary: c ? JSON.stringify(c) : null,
    });
    return result;
  }
  result.servedBy = served.source;

  // 2. 分块
  const task = `pit:${id}`;
  const backfillFrom = o.from ?? PIT_DEFAULT_SINCE;
  let all: PitChunk[] =
    o.mode === "nightly" ? spec.nightly(env) : o.mode === "check" ? spec.check(env) : spec.backfill(env, backfillFrom, o.to);
  if (id === "margin" && o.mode === "nightly") {
    const have = new Set(all.map((c) => c.id));
    for (const d of await marginPartialDays(ctx, env)) {
      if (!have.has(d)) all.push({ id: d, from: d, to: d });
    }
    all = all.sort((a, b) => a.from.localeCompare(b.from));
  }
  const done = o.mode === "backfill" && !o.force ? await doneKeys(ctx.wh, task) : new Set<string>();
  const todo = all.filter((c) => !done.has(c.id));
  result.chunks = todo.length;
  const stamp: PitStamp = {
    src: srcCode(served.source, "events"),
    ver: o.mode === "backfill" ? null : (ctx.ver ?? null),
    batch: o.batch,
    today: ctx.today,
  };
  let windowThrough: DateStr | null = null;
  const capThrough = env.prevTd(ctx.today);
  let aborted: string | null = null;
  let partialDetail: string | null = null;
  let processed = 0;

  // 3. 每块
  for (const chunk of todo) {
    if (o.budgetMs !== undefined && now() - t0 >= o.budgetMs) {
      result.stoppedForBudget = true;
      break;
    }
    processed++;
    let res: PitFetchResult<unknown>;
    try {
      res = await served.fetcher.fetchChunk(sctx, chunk);
    } catch (e) {
      if (isSchemaDrift(e)) {
        aborted = `${sourceLabel(served.source)}「${label}」接口字段变了：${errMsg(e)}，${when}没更新`;
        processed--;
        break;
      }
      if (e instanceof BlockedError) {
        result.blocked = true;
        aborted = `${sourceLabel(served.source)}「${label}」接口${CANARY_STATUS_TEXT.blocked}：${errMsg(e)}，之后接着补`;
        processed--;
        break;
      }
      // 翻页对不上（来源已经重取过一次）或其他错误：这一块失败，不写
      result.failed.push(chunk.id);
      ctx.log(`${label} ${chunk.id} 失败：${errMsg(e)}`);
      if (o.mode === "backfill") await markFailed(ctx.wh, task, chunk.id, errMsg(e));
      continue;
    }
    result.requests += res.requests;
    let gap: string | null = null;
    if (id === "margin") gap = marginGap(res, await prevCompleteMargin(ctx, chunk.from));
    const w = await writeChunk(ctx, spec, chunk, res.rows, env, stamp, { partial: gap !== null });
    result.rows += w.rows;
    if (result.lateRows !== undefined) result.lateRows += w.late;
    const detail = JSON.stringify(
      id === "margin" ? { rows: res.rawCount, ...(res.byExchange ?? { sh: 0, sz: 0 }) } : { rows: res.rawCount },
    );
    if (id === "margin") {
      await (gap ? markPartial : markDone)(ctx.wh, MARGIN_DAYS_TASK, chunk.from, detail);
    }
    if (o.mode === "backfill") await (gap ? markPartial : markDone)(ctx.wh, task, chunk.id, detail);
    if (gap) {
      result.partial.push(chunk.id);
      partialDetail = `${chunk.id} ${gap}`;
      ctx.log(`${label} ${partialDetail}，先写入，之后的夜里再取`);
    } else {
      result.done++;
      if (spec.hasWindowThrough) {
        const d = chunk.to > capThrough ? capThrough : chunk.to;
        if (!windowThrough || d > windowThrough) windowThrough = d;
      }
    }
    ctx.progress?.(processed / Math.max(1, todo.length), `${label} ${chunk.id}`);
  }
  result.remaining = todo.length - processed;

  // 4. pit_sync
  result.ok = !aborted && result.failed.length === 0;
  result.status = result.blocked
    ? "blocked"
    : aborted
      ? "failed"
      : result.partial.length || result.failed.length
        ? "partial"
        : "ok";
  const touched = result.done + result.partial.length > 0;
  result.detail =
    aborted ??
    (result.failed.length
      ? `${result.failed.length} 块没取成（${result.failed.slice(0, 3).join("、")}${result.failed.length > 3 ? " 等" : ""}），之后重试`
      : partialDetail
        ? `${partialDetail}，之后的夜里再取`
        : result.stoppedForBudget
          ? `这一段写了 ${result.done} 块，还剩 ${result.remaining} 块`
          : `写入 ${result.rows.toLocaleString("en-US")} 行`);
  const cur = (await readPitSync(ctx.wh)).get(id);
  const patch: Parameters<typeof upsertPitSync>[2] = {
    last_status: result.status,
    last_detail: result.detail,
    canary: JSON.stringify(result.canary),
    okNow: result.ok,
  };
  if (touched) patch.synced_at = ctx.today;
  if (windowThrough && (!cur?.window_through || windowThrough > cur.window_through)) {
    patch.window_through = windowThrough;
  }
  if (o.mode === "nightly" && result.ok) patch.nightly_since = cur?.nightly_since ?? ctx.today;
  if (o.mode === "backfill") {
    patch.backfill_from = backfillFrom;
    // 回填全部块 done 或 partial 后才设覆盖起点（之后个别缺口只记数据问题，不移动它）。
    // 按「从 backfillFrom 到今天」的完整块清单判断：带 --to 的有界回填做完了也不算覆盖，否则 to 之后的空档会被当成有数据。
    const st = await ctx.wh.all<{ key: string; status: string }>(
      `SELECT key, status FROM etl_progress WHERE task = $t`,
      { t: task },
    );
    const ok = new Set(st.filter((r) => r.status === "done" || r.status === "partial").map((r) => r.key));
    const full = o.to === undefined ? all : spec.backfill(env, backfillFrom);
    const complete = full.every((c) => ok.has(c.id));
    if (complete && (!cur?.covered_from || backfillFrom < cur.covered_from)) {
      patch.covered_from = backfillFrom;
    }
  }
  await upsertPitSync(ctx, id, patch);

  // 5. 夜间进取数台账（data_versions.sources）；后台回填不记
  if (o.mode === "nightly") {
    ctx.ledger?.recordDataset(id, {
      servedBy: result.servedBy,
      requests: result.requests,
      rows: result.rows,
    });
  }
  ctx.log(`${label}（${o.mode}）：${result.detail}`);
  return result;
}

// ── 状态与估算 ──

export interface PitDatasetStatus {
  label: string;
  backfillFrom: DateStr | null;
  coveredFrom: DateStr | null;
  windowThrough: DateStr | null;
  syncedAt: DateStr | null;
  nightlySince: DateStr | null;
  lastOkAt: string | null;
  lastStatus: string | null;
  lastDetail: string | null;
  canary: CanaryResult | null;
  rows: number;
}

/** 各数据集的同步状态；rows 给了就不再 count(*)（调用方按批次缓存） */
export async function pitDatasetStatus(
  wh: EtlContext["wh"],
  rows?: Partial<Record<PitDatasetId, number>>,
): Promise<Record<PitDatasetId, PitDatasetStatus>> {
  const sync = await readPitSync(wh);
  const out = {} as Record<PitDatasetId, PitDatasetStatus>;
  for (const id of Object.keys(PIT_DATASET_SPECS) as PitDatasetId[]) {
    const s = sync.get(id);
    let canary: CanaryResult | null;
    try {
      canary = s?.canary ? (JSON.parse(s.canary) as CanaryResult) : null;
    } catch {
      canary = null;
    }
    out[id] = {
      label: PIT_DATASETS[id].label,
      backfillFrom: s?.backfill_from ?? null,
      coveredFrom: s?.covered_from ?? null,
      windowThrough: s?.window_through ?? null,
      syncedAt: s?.synced_at ?? null,
      nightlySince: s?.nightly_since ?? null,
      lastOkAt: s?.last_ok_at ?? null,
      lastStatus: s?.last_status ?? null,
      lastDetail: s?.last_detail ?? null,
      canary,
      rows: rows?.[id] ?? Number(await wh.scalar(`SELECT count(*) FROM ${PIT_DATASET_SPECS[id].table}`)),
    };
  }
  return out;
}

/** 回填进度：各数据集 done / partial 的块数与全部块数（从 backfill_from 或默认起点算） */
export async function pitBackfillProgress(
  wh: EtlContext["wh"],
  today: DateStr,
  since?: DateStr,
): Promise<Record<PitDatasetId, { done: number; total: number }>> {
  const env = await buildAvailEnv(wh, today);
  const sync = await readPitSync(wh);
  const out = {} as Record<PitDatasetId, { done: number; total: number }>;
  for (const id of Object.keys(PIT_DATASET_SPECS) as PitDatasetId[]) {
    const from = since ?? sync.get(id)?.backfill_from ?? PIT_DEFAULT_SINCE;
    const chunks = PIT_DATASET_SPECS[id].backfill(env, from);
    const keys = new Set(
      (
        await wh.all<{ key: string }>(
          `SELECT key FROM etl_progress WHERE task = $t AND status IN ('done', 'partial')`,
          { t: `pit:${id}` },
        )
      ).map((r) => r.key),
    );
    out[id] = { done: chunks.filter((c) => keys.has(c.id)).length, total: chunks.length };
  }
  return out;
}

export interface PitEstimate {
  id: PitDatasetId;
  label: string;
  rows: number;
  chunks: number;
  requestsLow: number;
  requestsHigh: number;
  minutesLow: number;
  minutesHigh: number;
  line: string;
}

/** 估算按东财数据中心直连约 0.6 秒 / 次 */
export const PIT_SECONDS_PER_REQUEST = 0.6;

const rowsText = (n: number) =>
  n >= 1e4 ? `约 ${Math.round(n / 1e4).toLocaleString("en-US")} 万行` : `约 ${n.toLocaleString("en-US")} 行`;

/** 「约 9-10 分钟」「约 2.1-2.5 小时」；两头一样时只写一个（「约 1 分钟」） */
function durationText(lo: number, hi: number): string {
  const range = (a: string, b: string) => (a === b ? a : `${a}-${b}`);
  if (hi < 60) return `约 ${range(String(Math.max(1, Math.round(lo))), String(Math.max(1, Math.round(hi))))} 分钟`;
  return `约 ${range((lo / 60).toFixed(1), (hi / 60).toFixed(1))} 小时`;
}

/**
 * 回填估算（`pnpm ivan events --estimate`、管理页确认框）：每个数据集一次计数请求（带同一份列清单），
 * 请求数下限 = ⌈行数 ÷ 500⌉，上限再加上块数（每块最后一页不满）；时长按 0.6 秒 / 次。
 */
export async function estimatePitBackfill(
  ctx: EtlContext,
  ids: readonly PitDatasetId[],
  from: DateStr = PIT_DEFAULT_SINCE,
  to?: DateStr,
  opts: { chain?: Partial<Record<PitDatasetId, PitSource[]>> } = {},
): Promise<{ datasets: PitEstimate[]; requests: number; lines: string[] }> {
  const env = await buildAvailEnv(ctx.wh, ctx.today);
  const sctx: SourceCtx = { http: ctx.http, today: ctx.today, log: ctx.log };
  const out: PitEstimate[] = [];
  let requests = 0;
  for (const id of ids) {
    const spec = PIT_DATASET_SPECS[id];
    const chunks = spec.backfill(env, from, to);
    const src = (opts.chain?.[id] ?? chainOf(id, ctx)).find((c) => c.fetcher.estimateRows);
    if (!src || !chunks.length) continue;
    const rows = await src.fetcher.estimateRows!(sctx, chunks[0]!.from, chunks.at(-1)!.to);
    requests++;
    const requestsLow = Math.ceil(rows / 500);
    const requestsHigh = requestsLow + chunks.length;
    const minutesLow = (requestsLow * PIT_SECONDS_PER_REQUEST) / 60;
    const minutesHigh = (requestsHigh * PIT_SECONDS_PER_REQUEST) / 60;
    const label = PIT_DATASETS[id].label;
    out.push({
      id,
      label,
      rows,
      chunks: chunks.length,
      requestsLow,
      requestsHigh,
      minutesLow,
      minutesHigh,
      line: `${label}：${rowsText(rows)}，${requestsLow.toLocaleString("en-US")}-${requestsHigh.toLocaleString("en-US")} 次请求，按 ${PIT_SECONDS_PER_REQUEST} 秒 / 次，${durationText(minutesLow, minutesHigh)}`,
    });
  }
  const lo = out.reduce((a, e) => a + e.requestsLow, 0);
  const hi = out.reduce((a, e) => a + e.requestsHigh, 0);
  const lines = out.map((e) => e.line);
  if (out.length > 1) {
    lines.push(
      `合计：${lo.toLocaleString("en-US")}-${hi.toLocaleString("en-US")} 次请求，${durationText(
        (lo * PIT_SECONDS_PER_REQUEST) / 60,
        (hi * PIT_SECONDS_PER_REQUEST) / 60,
      )}`,
    );
  }
  return { datasets: out, requests, lines };
}

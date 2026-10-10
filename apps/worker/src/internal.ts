/**
 * worker 内部接口（只监听 127.0.0.1，带共享密钥）：server 所有行情查询都经这里（D3）。
 */
import {
  BENCHMARKS,
  EVENT_FACTOR_KEYS,
  eventCoverageFrom,
  FACTOR_MAP,
  isDateStr,
  type Market,
  PIT_DATASET_IDS,
  type PitDatasetId,
  toCode,
  validateSpec,
} from "@ivan/core";
import { sha256Canonical } from "@ivan/core/node";
import {
  benchFirstDates,
  captureStatus,
  committedAsOf,
  dataQuality,
  dataVersionState,
  estimatePitBackfill,
  eventColumnsStatus,
  EvidenceError,
  type EvidenceItem,
  explainSelection,
  FACTOR_COLUMNS,
  lastFetchSources,
  lastTradingDay,
  latestDataVersion,
  loadHkConnect,
  pitBackfillProgress,
  pitDatasetStatus,
  PIT_DEFAULT_SINCE,
  resolveDataIssue,
  screenOn,
  securityDossier,
  securityEvents,
  SelectionDataError,
  softStepStatus,
  sqlCodeList,
  verifyDossier,
  type Warehouse,
  weakRegimeDates,
} from "@ivan/data";
import { computeBlocked, jobs } from "@ivan/db";
import { evaluatePlanItem } from "@ivan/engine";
import { and, desc, eq, like } from "drizzle-orm";
import { Hono } from "hono";
import { env, etlContext, todayOf } from "./env.ts";
import { eventsJobActive, eventsPayload } from "./jobs/events.ts";
import { marketDayStatus } from "./market-day.ts";
import { enqueue, wake } from "./runner.ts";

interface BenchStatus {
  benchFirstDates: Record<string, string | null>;
  hkConnect: { attrs: string[]; firstDate: string } | null;
}

/** 各基准首个数据日与港股通名单（D75、D77）：按（行情仓, 市场）缓存，提交了新版本才重算 */
const benchCache = new WeakMap<
  Warehouse,
  Map<Market, { ver: number | null; value: BenchStatus }>
>();

async function benchStatus(
  wh: Warehouse,
  market: Market,
  ver: number | null,
): Promise<BenchStatus> {
  let byMarket = benchCache.get(wh);
  if (!byMarket) benchCache.set(wh, (byMarket = new Map()));
  const hit = byMarket.get(market);
  if (hit && hit.ver === ver) return hit.value;
  const hk = market === "HK" ? await loadHkConnect(wh) : null;
  const value: BenchStatus = {
    benchFirstDates: await benchFirstDates(wh, market),
    hkConnect: hk ? { attrs: hk.attrs, firstDate: hk.first } : null,
  };
  byMarket.set(market, { ver, value });
  return value;
}

/** 事件表的行数：按最近一个结束的批次缓存（管理页每 5 秒轮询一次数据状态） */
const eventRowsCache = new WeakMap<Warehouse, { batch: number; rows: Record<string, number> }>();

/**
 * 点时事件数据（S15，只有 A 股）：各数据集的同步状态与连续失败晚数、后台回填的进度与最近一批。
 */
async function eventsStatus(wh: Warehouse) {
  const lastFinished = Number(
    (await wh.scalar(`SELECT max(id) FROM pit_batches WHERE finished_at IS NOT NULL`)) ?? 0,
  );
  const hit = eventRowsCache.get(wh);
  const status = await pitDatasetStatus(wh, hit?.batch === lastFinished ? hit.rows : undefined);
  const rows = Object.fromEntries(PIT_DATASET_IDS.map((id) => [id, status[id].rows]));
  eventRowsCache.set(wh, { batch: lastFinished, rows });
  const soft = await softStepStatus(wh, "A");
  const datasets = Object.fromEntries(
    PIT_DATASET_IDS.map((id) => [
      id,
      {
        ...status[id],
        rows: rows[id] ?? 0,
        failingNights: soft.find((s) => s.step === id)?.failingNights ?? 0,
      },
    ]),
  );
  const job = eventsJobActive();
  const last = await wh.one<{
    id: number;
    startedAt: string | null;
    finishedAt: string | null;
    status: string | null;
    note: string | null;
    rows: number | null;
    requests: number | null;
  }>(
    `SELECT id, strftime(started_at, '%Y-%m-%dT%H:%M:%S') AS startedAt,
            strftime(finished_at, '%Y-%m-%dT%H:%M:%S') AS finishedAt, status, note, rows, requests
     FROM pit_batches WHERE kind = 'backfill' ORDER BY id DESC LIMIT 1`,
  );
  return {
    datasets,
    backfill: {
      status: job ? job.status : "idle",
      notBefore: job?.notBefore ?? null,
      progress: await pitBackfillProgress(wh, todayOf()),
      lastBatch: last ?? null,
    },
  };
}

/**
 * 事件因子（S15b）的补算进度与各因子的数据起点：server 提交回测前校验（补完之前、起点早于数据起点直接 400，不扣额度），
 * 编辑器与 list_factors 显示「自 {from}」/「补算中」。ready = 补算完成且签名、版本都对得上。
 */
async function eventFactorStatus(wh: Warehouse) {
  const st = await eventColumnsStatus(wh);
  const factorCoverage = Object.fromEntries(
    EVENT_FACTOR_KEYS.map((k) => {
      const def = FACTOR_MAP.get(k)!;
      return [k, { from: eventCoverageFrom(def, st.state[def.dataset!].from), ready: st.complete }];
    }),
  );
  return {
    factorCoverage,
    eventFactors: {
      v: st.v,
      sig: st.sig,
      complete: st.complete,
      doneYears: st.doneYears,
      totalYears: st.totalYears,
      backfillComplete: st.backfillComplete,
    },
  };
}

/** 回填估算按起点缓存 1 小时（每次 4 个计数请求） */
const estimateCache = new Map<string, { at: number; value: unknown }>();

/** 格式对、而且是真实存在的日子（2024-13-45 这种格式对的也挡掉，不让 DuckDB 的转换错误原文传出去） */
function isCalendarDate(d: unknown): d is string {
  return (
    isDateStr(d) && !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d
  );
}

export const ESTIMATE_TTL_MS = 3_600_000;

export function createInternalApp() {
  const app = new Hono();

  app.use("/internal/*", async (c, next) => {
    if (c.req.header("x-internal-secret") !== env().cfg.internalSecret) {
      return c.json({ error: "forbidden" }, 403);
    }
    return next();
  });
  app.onError((err, c) => {
    // 证据读不到（没这只股票、那天还没有数据）：给调用方中文原因与 4xx，不算 worker 出错
    if (err instanceof EvidenceError) return c.json({ error: err.message }, err.status);
    // 选股要的数据还没有（港股通名单没有记录，D77）
    if (err instanceof SelectionDataError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  // 维护状态（行情仓还没升级到第 3 版，D76）：读行情仓的接口一律 503；健康检查、数据状态、唤醒照常
  const maintenanceSafe = new Set([
    "/internal/health",
    "/internal/jobs/kick",
    "/internal/data-status",
  ]);
  app.use("/internal/*", async (c, next) => {
    const m = env().wh.maintenance;
    if (m && !maintenanceSafe.has(c.req.path)) return c.json({ error: m }, 503);
    return next();
  });

  // 部署健康检查只看 200：维护状态也是「活着」，带上说明
  app.get("/internal/health", (c) => c.json({ ok: true, maintenance: env().wh.maintenance }));

  app.post("/internal/jobs/kick", (c) => {
    wake();
    return c.json({ ok: true });
  });

  app.get("/internal/data-status", async (c) => {
    const { wh, app: db } = env();
    const blocked = computeBlocked(db.sqlite);
    const computePaused = blocked ? { reason: blocked.kind, since: blocked.since } : null;
    if (wh.maintenance) return c.json({ markets: [], maintenance: wh.maintenance, computePaused });
    const markets = [];
    for (const m of ["A", "HK"] as Market[]) {
      const v = await latestDataVersion(wh, m);
      const recent = db.db
        .select({
          status: jobs.status,
          finishedAt: jobs.finishedAt,
          error: jobs.error,
          notBefore: jobs.notBefore,
          attempt: jobs.attempt,
        })
        .from(jobs)
        .where(and(eq(jobs.kind, "etl"), like(jobs.payload, `%"market":"${m}"%`)))
        .orderBy(desc(jobs.createdAt))
        .limit(5)
        .all();
      const last = recent[0];
      // 排着队等自动重跑（D73）：带上重跑时间、第几次，原因取上一次失败的错误
      const waitingRetry = last?.status === "queued" && last.attempt > 0;
      const lastEtl = last
        ? {
            status: last.status,
            finishedAt: last.finishedAt,
            error: waitingRetry
              ? (recent.find((j) => j.status === "failed")?.error ?? null)
              : last.error,
            attempt: last.attempt,
            retryAt: waitingRetry ? (last.notBefore ?? null) : null,
          }
        : null;
      markets.push({
        market: m,
        asOf: v.asOf,
        dataVersion: v.id,
        lastEtl,
        // 今天的状态（D78）：已更新 / 休市 / 没更新 / 进行中
        day: await marketDayStatus(m),
        // 正在写的版本、上一个版本的结果（D60）
        ...(await dataVersionState(wh, m)),
        // 点时数据的采集情况（D61）
        capture: await captureStatus(wh, m, todayOf()),
        // 最近一晚各来源服务了多少只、回退几次（D72）
        sources: await lastFetchSources(wh, m),
        // 辅助数据（汇率、证券表、简称、财报）最近成功的日子与连续失败的晚数（D73）
        soft: await softStepStatus(wh, m),
        // 各基准首个数据日、港股通名单（D75、D77）：server 提交回测前校验，不排任务、不扣额度
        ...(await benchStatus(wh, m, v.id)),
      });
    }
    return c.json({
      markets,
      maintenance: null,
      computePaused,
      events: await eventsStatus(wh),
      ...(await eventFactorStatus(wh)),
    });
  });

  /** 排一次点时事件数据的后台回填（S15）：已经有一个在排队或运行时 409 */
  app.post("/internal/events/backfill", async (c) => {
    const raw: unknown = await c.req.json().catch(() => ({}));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
      return c.json({ error: "请求体要是一个对象" }, 400);
    const p = eventsPayload(raw as { datasets?: unknown; since?: unknown });
    if (typeof p === "string") return c.json({ error: p }, 400);
    if (eventsJobActive()) return c.json({ error: "已经有一个事件数据回填在排队或运行" }, 409);
    const jobId = enqueue("events", { ...p }, null);
    return c.json({ jobId });
  });

  /** 回填估算（4 个计数请求，按起点缓存 1 小时） */
  app.get("/internal/events/estimate", async (c) => {
    const since = c.req.query("since") || PIT_DEFAULT_SINCE;
    if (!isDateStr(since)) return c.json({ error: "日期格式要是 YYYY-MM-DD" }, 400);
    const hit = estimateCache.get(since);
    if (hit && Date.now() - hit.at < ESTIMATE_TTL_MS) return c.json(hit.value);
    const ids: PitDatasetId[] = [...PIT_DATASET_IDS];
    const value = {
      since,
      ...(await estimatePitBackfill(
        etlContext(() => {}),
        ids,
        since,
      )),
    };
    estimateCache.set(since, { at: Date.now(), value });
    return c.json(value);
  });

  /** 数据质量（D74）：近 N 天按规则统计的拦截与标记、问题最多的代码、未解决的问题、最近几晚的完整性 */
  app.get("/internal/data-quality", async (c) => {
    const days = Number(c.req.query("days") ?? 7);
    return c.json(await dataQuality(env().wh, Number.isFinite(days) ? days : 7));
  });

  /** 管理员把一条数据问题标为已核对（resolved_by = admin） */
  app.post("/internal/data-issues/:id/resolve", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "数据问题编号不对" }, 400);
    const r = await resolveDataIssue(env().wh, id);
    if (!r) return c.json({ error: `没有编号 ${id} 的数据问题` }, 404);
    return c.json(r);
  });

  app.post("/internal/screen", async (c) => {
    const b = (await c.req.json()) as { spec: unknown; date?: string; limit?: number };
    const v = validateSpec(b.spec);
    if (!v.spec) return c.json({ error: v.errors.join("；") }, 400);
    if (b.date !== undefined && !isCalendarDate(b.date))
      return c.json({ error: "日期格式要是 YYYY-MM-DD" }, 400);
    const { wh } = env();
    // 默认选最新的已提交交易日（D60），不读还没提交的数据：给了日期也截到已提交的截至日，再落到交易日
    // （名单旁边写的数据版本是已提交的那个，不能配一份读了未提交行的名单）
    const committed = await committedAsOf(wh, v.spec.market);
    if (!committed) return c.json({ error: "行情仓还没有数据" }, 400);
    const date = await lastTradingDay(
      wh,
      v.spec.market,
      b.date && b.date < committed ? b.date : committed,
    );
    const rows = await screenOn(wh, v.spec, date, Math.min(Math.max(b.limit ?? 30, 1), 100));
    // 按大盘状态切换排序的策略（D53）：告诉前端这天用的是哪套排序
    const regime = v.spec.rank?.regime
      ? (await weakRegimeDates(wh, v.spec.market, [date], v.spec.rank.regime.ma)).has(date)
        ? "weak"
        : "strong"
      : null;
    // 今日选股可追溯（D67）：读的是哪个数据版本、名单的指纹
    const dataVersion = await latestDataVersion(wh, v.spec.market);
    return c.json({ date, rows, regime, dataVersion, listHash: sha256Canonical(rows) });
  });

  /**
   * 选股解释（D67）：和回测同一条 SQL。date 默认并截到已提交的截至日，再落到交易日；limit 默认回测用的名单长度
   * （前 top × buffer 名 + top），最多 200。
   */
  app.post("/internal/explain", async (c) => {
    const b = (await c.req.json()) as {
      spec: unknown;
      date?: string;
      codes?: string[];
      limit?: number;
    };
    const v = validateSpec(b.spec);
    if (!v.spec) return c.json({ error: v.errors.join("；") }, 400);
    if (v.spec.mode !== "rules" || !v.spec.rank) {
      return c.json({ error: "信号模式的策略没有选股排名" }, 400);
    }
    if (b.date && !isDateStr(b.date)) return c.json({ error: "日期格式要是 YYYY-MM-DD" }, 400);
    const { wh } = env();
    const committed = await committedAsOf(wh, v.spec.market);
    if (!committed) return c.json({ error: "行情仓还没有数据" }, 400);
    // 落到交易日：周末、节假日按前一个交易日解释（回测只在交易日决策）
    const date = await lastTradingDay(
      wh,
      v.spec.market,
      b.date && b.date < committed ? b.date : committed,
    );
    const rank = v.spec.rank;
    const limit = Math.min(
      Math.max(b.limit ?? Math.ceil(rank.top * v.spec.rebalance.buffer) + rank.top, 1),
      200,
    );
    let codes: string[];
    try {
      codes = (b.codes ?? []).slice(0, 50).map((x) => toCode(x, v.spec!.market));
    } catch {
      return c.json({ error: "代码不对" }, 400);
    }
    return c.json(await explainSelection(wh, v.spec, date, { limit, codes }));
  });

  /** 个股证据（D67）：唯一的点时读取器；asOf 是决策日，默认并截到已提交的截至日，再落到交易日 */
  app.get("/internal/securities/:code/dossier", async (c) => {
    let code: string;
    try {
      code = toCode(c.req.param("code"));
    } catch {
      return c.json({ error: "代码不对" }, 400);
    }
    const asOf = c.req.query("asOf") || undefined;
    const factors = (c.req.query("factors") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    // 证据版本（D97）：不给就是当前版本；给了按那一版的条目集合重新生成
    const version = c.req.query("version") ? Number(c.req.query("version")) : undefined;
    return c.json(
      await securityDossier(env().wh, code, asOf, {
        ...(factors.length ? { factorKeys: factors } : {}),
        ...(version !== undefined ? { version } : {}),
      }),
    );
  });

  /**
   * 个股的两融与筹码明细（S15b）：只读 asOf 当时可得且没撤下的行；asOf 默认并截到已提交的截至日。只有 A 股
   * （港股 404「两融、股东户数、解禁、大宗交易目前只有 A 股」）。datasets=margin,holders 只取其中几组。
   */
  app.get("/internal/securities/:code/events", async (c) => {
    let code: string;
    try {
      code = toCode(c.req.param("code"));
    } catch {
      return c.json({ error: "代码不对" }, 400);
    }
    const datasets = (c.req.query("datasets") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean) as PitDatasetId[];
    return c.json(
      await securityEvents(
        env().wh,
        code,
        c.req.query("asOf") || undefined,
        datasets.length ? datasets : undefined,
      ),
    );
  });

  /**
   * 复核个股证据（D97）：按同样的代码、决策日、版本、因子集与选项重新生成，比校验值；带上原来的条目时列出变了的项。
   * 没给版本（S07 时代存下的）先按第 1 版、再按当前版本试；返回 {same, hash, matchedVersion, changed}。
   */
  app.post("/internal/dossier/verify", async (c) => {
    const b = (await c.req.json()) as {
      code: string;
      asOf: string;
      hash: string;
      evidenceVersion?: number;
      factorKeys?: string[];
      options?: Record<string, unknown>;
      items?: EvidenceItem[];
    };
    if (!b.code || !b.asOf || !b.hash) return c.json({ error: "需要 code、asOf 与 hash" }, 400);
    let code: string;
    try {
      code = toCode(b.code);
    } catch {
      return c.json({ error: "代码不对" }, 400);
    }
    return c.json(
      await verifyDossier(env().wh, code, b.asOf, b.hash, {
        factorKeys: b.factorKeys,
        items: b.items,
        ...(b.evidenceVersion !== undefined ? { evidenceVersion: Number(b.evidenceVersion) } : {}),
        ...(b.options ? { options: b.options } : {}),
      }),
    );
  });

  /**
   * 计划结果回看（D79）：每条计划项的次日开盘成交、与估算价之差、之后 5 / 20 个交易日的收益与超额。
   * 只用已提交的数据；最多 50 条（只有跟踪的主人能看，量有上限，不计额度）。
   */
  app.post("/internal/plan-outcomes", async (c) => {
    const b = (await c.req.json()) as {
      market?: string;
      benchSym?: string;
      items?: Array<{
        code: string;
        side: string;
        estPrice: number | null;
        decisionDate: string;
        benchClose: number | null;
      }>;
    };
    const market: Market = b.market === "HK" ? "HK" : "A";
    const items = b.items ?? [];
    if (items.length > 50) return c.json({ error: "一次最多 50 条" }, 400);
    const syms = new Set<string>(Object.values(BENCHMARKS).map((x) => x.sym));
    if (!b.benchSym || !syms.has(b.benchSym)) return c.json({ error: "基准不对" }, 400);
    let codes: string[];
    try {
      codes = items.map((i) => toCode(i.code, market));
    } catch {
      return c.json({ error: "代码不对" }, 400);
    }
    if (items.some((i) => !isDateStr(i.decisionDate))) {
      return c.json({ error: "日期格式要是 YYYY-MM-DD" }, 400);
    }
    const { wh } = env();
    const asOf = await committedAsOf(wh, market);
    if (!asOf || !items.length) return c.json({ asOf, outcomes: [] });
    const from = items.map((i) => i.decisionDate).sort()[0]!;
    const bars = await wh.all<{
      code: string;
      d: string;
      open: number;
      close: number;
      adj: number;
    }>(
      `SELECT code, date::VARCHAR AS d, open, close, adj FROM bars_daily
       WHERE code IN (${sqlCodeList([...new Set(codes)])}) AND date > $a::DATE AND date <= $b::DATE
       ORDER BY code, date`,
      { a: from, b: asOf },
    );
    const bench = await wh.all<{ d: string; close: number }>(
      `SELECT date::VARCHAR AS d, close FROM index_bars
       WHERE sym = $s AND date > $a::DATE AND date <= $b::DATE ORDER BY date`,
      { s: b.benchSym, a: from, b: asOf },
    );
    const benchSeries = { dates: bench.map((r) => r.d), close: bench.map((r) => r.close) };
    const byCode = new Map<string, typeof bars>();
    for (const r of bars) {
      const list = byCode.get(r.code) ?? [];
      list.push(r);
      byCode.set(r.code, list);
    }
    const outcomes = items.map((it, k) => {
      const rows = (byCode.get(codes[k]!) ?? []).filter((r) => r.d > it.decisionDate);
      return evaluatePlanItem(
        { code: codes[k]!, side: it.side, estPrice: it.estPrice ?? null },
        { decisionDate: it.decisionDate, benchClose: it.benchClose ?? null },
        {
          dates: rows.map((r) => r.d),
          open: rows.map((r) => r.open),
          close: rows.map((r) => r.close),
          adj: rows.map((r) => r.adj),
        },
        benchSeries,
      );
    });
    return c.json({ asOf, outcomes });
  });

  /** 交易日历上 date 之前的最后一个交易日（成交日 → 决策日）；没有时为 null */
  app.get("/internal/calendar/prev", async (c) => {
    const market = c.req.query("market") === "HK" ? "HK" : "A";
    const date = c.req.query("date") ?? "";
    if (!isDateStr(date)) return c.json({ error: "日期格式要是 YYYY-MM-DD" }, 400);
    const prev = await env().wh.scalar<string>(
      `SELECT max(date)::VARCHAR FROM trade_calendar WHERE market = $m AND date < $d::DATE`,
      { m: market, d: date },
    );
    return c.json({ market, date, prev: prev ?? null });
  });

  app.get("/internal/securities/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    const market = c.req.query("market");
    if (!q) return c.json([]);
    const { wh } = env();
    const rows = await wh.all(
      `SELECT code, name, market, board, industry, list_date::VARCHAR AS list_date, delist_date::VARCHAR AS delist_date
       FROM securities
       WHERE (code ILIKE $q OR name ILIKE $q) ${market === "A" || market === "HK" ? "AND market = $m" : ""}
       ORDER BY delist_date IS NOT NULL, code LIMIT 20`,
      market === "A" || market === "HK" ? { q: `%${q}%`, m: market } : { q: `%${q}%` },
    );
    return c.json(rows);
  });

  /** 个股卡：最新因子 + 最近几期财报 + 最近的分红送转 */
  app.get("/internal/securities/:code", async (c) => {
    let code: string;
    try {
      code = toCode(c.req.param("code"));
    } catch {
      return c.json({ error: "代码不对" }, 400);
    }
    const { wh } = env();
    const sec = await wh.one(
      `SELECT code, name, market, board, industry_l1, industry, lot_size,
              list_date::VARCHAR AS list_date, delist_date::VARCHAR AS delist_date
       FROM securities WHERE code = $c`,
      { c: code },
    );
    if (!sec) return c.json({ error: `找不到 ${code}` }, 404);
    // 只读已提交的数据（D60）：失败那晚写进来的因子行不给；还没有提交过的版本时没有因子
    const asOf = await committedAsOf(wh, (sec as { market: string }).market);
    const factors = asOf
      ? await wh.one(
          `SELECT date::VARCHAR AS date, close, ${FACTOR_COLUMNS.join(", ")}
           FROM factors_daily WHERE code IN (${sqlCodeList([code])}) AND date <= $a::DATE ORDER BY date DESC LIMIT 1`,
          { a: asOf },
        )
      : null;
    const financials = await wh.all(
      `SELECT report_date::VARCHAR AS report_date, period, eff_date::VARCHAR AS eff_date, currency,
              revenue, np, deducted_np, revenue_yoy, np_yoy, deducted_np_yoy, roe, gross_margin, debt_ratio
       FROM financials WHERE code = $c ORDER BY report_date DESC LIMIT 8`,
      { c: code },
    );
    const actions = await wh.all(
      `SELECT date::VARCHAR AS date, prev_close, ref_price, cash, split
       FROM corp_actions WHERE code = $c ORDER BY date DESC LIMIT 6`,
      { c: code },
    );
    return c.json({ security: sec, factors: factors ?? null, financials, actions });
  });

  return app;
}

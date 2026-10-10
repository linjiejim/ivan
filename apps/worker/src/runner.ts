/**
 * 任务执行器：从应用库 jobs 表按先后认领（原子 UPDATE … RETURNING），分两条道：
 * - compute：回测、扫描、复核数据（并发 = BACKTEST_POOL_SIZE，三者共用名额）
 * - etl：夜间 ETL、结算、简报（并发 1，互不重叠）
 * 进度写回 jobs 表，server 读它推给前端。
 *
 * 行情仓写库期间不跑回测（D60）：etl / check / event_cols 排队或在跑时 compute 道不认领；etl 道轮到它们时
 * 先等正在跑的 compute 任务结束（compute 道这时已经不再认领，不会饿死）。行情仓在维护状态（还没升级）时两条道都不认领。
 *
 * 自动重跑（D73）：任务可以带 not_before（毫秒），没到时间不认领、也不挡回测；attempt 记第几次重跑。
 */
import { computeBlocked, type jobs, WAREHOUSE_WRITERS } from "@ivan/db";
import { env } from "./env.ts";
import { backtestJob, sweepJob } from "./jobs/backtest.ts";
import { briefJob } from "./jobs/brief.ts";
import { checkJob } from "./jobs/check.ts";
import { etlJob } from "./jobs/etl.ts";
import { eventColsJob } from "./jobs/event-cols.ts";
import { eventsJob } from "./jobs/events.ts";
import { settleJob } from "./jobs/settle.ts";
import { verifyJob } from "./jobs/verify.ts";

type JobRow = typeof jobs.$inferSelect;

export interface JobContext {
  job: JobRow;
  progress: (fraction: number, note?: string) => void;
  log: (msg: string) => void;
}

type Handler = (ctx: JobContext) => Promise<Record<string, unknown>>;

const HANDLERS: Record<string, { lane: "compute" | "etl"; run: Handler }> = {
  backtest: { lane: "compute", run: backtestJob },
  sweep: { lane: "compute", run: sweepJob },
  verify: { lane: "compute", run: verifyJob },
  etl: { lane: "etl", run: etlJob },
  settle: { lane: "etl", run: settleJob },
  brief: { lane: "etl", run: briefJob },
  check: { lane: "etl", run: checkJob },
  // 点时事件数据的后台分段回填（S15）：只写事件表、不开数据版本，不算写行情仓的任务（回测不读事件表）
  events: { lane: "etl", run: eventsJob },
  // 事件因子列按年补算（S15b）：改 factors_daily，算写行情仓的任务（WAREHOUSE_WRITERS），排队与运行时回测暂停
  event_cols: { lane: "etl", run: eventColsJob },
};

const running = { compute: 0, etl: 0 };
let wakeUp: (() => void) | null = null;
let stopped = false;

export function wake(): void {
  wakeUp?.();
}

export function stopRunner(): void {
  stopped = true;
  wake();
}

/** 启动时把上次没跑完的任务标成失败（D3：worker 重启不自动重跑） */
export function recoverStale(): number {
  const { sqlite } = env().app;
  const r = sqlite
    .prepare(
      `UPDATE jobs SET status = 'failed', error = 'worker 重启', finished_at = ? WHERE status = 'running'`,
    )
    .run(Date.now());
  sqlite
    .prepare(
      `UPDATE runs SET status = 'failed', error = 'worker 重启' WHERE status IN ('running', 'queued')
      AND id NOT IN (SELECT json_extract(payload, '$.runId') FROM jobs WHERE status = 'queued')`,
    )
    .run();
  // 没跑完的复核：原运行上的 verify 状态也要收尾，否则回测页会一直显示「复核中」
  sqlite
    .prepare(
      `UPDATE runs SET verify = json_set(verify, '$.status', 'failed', '$.error', 'worker 重启')
       WHERE json_extract(verify, '$.status') IN ('queued', 'running')
      AND id NOT IN (SELECT json_extract(payload, '$.runId') FROM jobs WHERE status = 'queued' AND kind = 'verify')`,
    )
    .run();
  return r.changes;
}

export function enqueue(
  kind: string,
  payload: Record<string, unknown>,
  userId: string | null = null,
  opts: { notBefore?: number; attempt?: number } = {},
): string {
  const { sqlite } = env().app;
  const id = `j_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  sqlite
    .prepare(
      `INSERT INTO jobs (id, kind, user_id, payload, status, progress, created_at, not_before, attempt)
       VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
    )
    .run(
      id,
      kind,
      userId,
      JSON.stringify(payload),
      Date.now(),
      opts.notBefore ?? null,
      opts.attempt ?? 0,
    );
  wake();
  return id;
}

export { computeBlocked, WAREHOUSE_WRITERS };

type Lane = "compute" | "etl";

/**
 * 这条道现在该不该等（纯函数，单测覆盖）：
 * - 维护状态：两条道都等；
 * - compute：有写库任务排队或在跑就等；
 * - etl：下一个要认领的是写库任务、且还有 compute 任务在跑就等。
 */
export function shouldWait(
  lane: Lane,
  nextKind: string | null,
  state: { maintenance: boolean; blocked: boolean; computeRunning: number },
): boolean {
  if (state.maintenance) return true;
  if (lane === "compute") return state.blocked;
  return nextKind !== null && WAREHOUSE_WRITERS.has(nextKind) && state.computeRunning > 0;
}

function laneKinds(lane: Lane): string {
  return Object.entries(HANDLERS)
    .filter(([, h]) => h.lane === lane)
    .map(([k]) => `'${k}'`)
    .join(",");
}

/** 认领这条道上最早的、已经到时间的排队任务（导出给测试） */
export function claim(lane: Lane, now: number = Date.now()): JobRow | undefined {
  const { sqlite } = env().app;
  const kinds = laneKinds(lane);
  const ready = `status = 'queued' AND kind IN (${kinds}) AND (not_before IS NULL OR not_before <= ?)`;
  const next =
    lane === "etl"
      ? ((
          sqlite
            .prepare(`SELECT kind FROM jobs WHERE ${ready} ORDER BY created_at LIMIT 1`)
            .get(now) as { kind: string } | undefined
        )?.kind ?? null)
      : null;
  const wait = shouldWait(lane, next, {
    maintenance: !!env().wh.maintenance,
    blocked: lane === "compute" && computeBlocked(sqlite, now) !== null,
    computeRunning: running.compute,
  });
  if (wait) return undefined;
  const row = sqlite
    .prepare(
      `UPDATE jobs SET status = 'running', started_at = ?
       WHERE id = (SELECT id FROM jobs WHERE ${ready} ORDER BY created_at LIMIT 1)
       RETURNING *`,
    )
    .get(now, now) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: row.id as string,
    kind: row.kind as string,
    userId: (row.user_id as string) ?? null,
    payload: JSON.parse(row.payload as string),
    status: "running",
    progress: 0,
    note: null,
    result: null,
    error: null,
    createdAt: row.created_at as number,
    startedAt: row.started_at as number,
    finishedAt: null,
    notBefore: (row.not_before as number | null) ?? null,
    attempt: (row.attempt as number | null) ?? 0,
  };
}

async function execute(job: JobRow): Promise<void> {
  const { sqlite } = env().app;
  const setProgress = sqlite.prepare(`UPDATE jobs SET progress = ?, note = ? WHERE id = ?`);
  const setNote = sqlite.prepare(`UPDATE jobs SET note = ? WHERE id = ?`);
  let lastWrite = 0;
  const ctx: JobContext = {
    job,
    progress: (f, note) => {
      const now = Date.now();
      if (now - lastWrite < 300 && f < 1) return;
      lastWrite = now;
      setProgress.run(Math.max(0, Math.min(1, f)), note ?? null, job.id);
    },
    log: (msg) => {
      console.log(`[${job.kind} ${job.id}] ${msg}`);
      setNote.run(msg.slice(0, 200), job.id);
    },
  };
  const t0 = Date.now();
  try {
    const result = await HANDLERS[job.kind]!.run(ctx);
    sqlite
      .prepare(
        `UPDATE jobs SET status = 'done', progress = 1, result = ?, finished_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(result), Date.now(), job.id);
    console.log(`[${job.kind} ${job.id}] 完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[${job.kind} ${job.id}] 失败：${msg}`);
    sqlite
      .prepare(`UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
      .run(msg.slice(0, 1000), Date.now(), job.id);
  }
}

export async function runLoop(poolSize: number): Promise<void> {
  const limits = { compute: Math.max(1, poolSize), etl: 1 };
  while (!stopped) {
    let started = false;
    for (const lane of ["etl", "compute"] as const) {
      while (running[lane] < limits[lane]) {
        const job = claim(lane);
        if (!job) break;
        if (!HANDLERS[job.kind]) continue;
        started = true;
        running[lane]++;
        void execute(job).finally(() => {
          running[lane]--;
          wake();
        });
      }
    }
    if (!started) {
      await new Promise<void>((r) => {
        wakeUp = r;
        setTimeout(r, 1000);
      });
      wakeUp = null;
    }
  }
}

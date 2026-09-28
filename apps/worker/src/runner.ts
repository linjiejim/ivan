/**
 * 任务执行器：从应用库 jobs 表按先后认领（原子 UPDATE … RETURNING），分两条道：
 * - compute：回测、扫描（并发 = BACKTEST_POOL_SIZE）
 * - etl：夜间 ETL、结算、简报（并发 1，互不重叠）
 * 进度写回 jobs 表，server 读它推给前端。
 */
import type { jobs } from "@ivan/db";
import { env } from "./env.ts";
import { backtestJob, sweepJob } from "./jobs/backtest.ts";
import { briefJob } from "./jobs/brief.ts";
import { checkJob } from "./jobs/check.ts";
import { etlJob } from "./jobs/etl.ts";
import { settleJob } from "./jobs/settle.ts";

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
  etl: { lane: "etl", run: etlJob },
  settle: { lane: "etl", run: settleJob },
  brief: { lane: "etl", run: briefJob },
  check: { lane: "etl", run: checkJob },
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
  return r.changes;
}

export function enqueue(
  kind: string,
  payload: Record<string, unknown>,
  userId: string | null = null,
): string {
  const { sqlite } = env().app;
  const id = `j_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  sqlite
    .prepare(
      `INSERT INTO jobs (id, kind, user_id, payload, status, progress, created_at) VALUES (?, ?, ?, ?, 'queued', 0, ?)`,
    )
    .run(id, kind, userId, JSON.stringify(payload), Date.now());
  wake();
  return id;
}

function claim(lane: "compute" | "etl"): JobRow | undefined {
  const { sqlite } = env().app;
  const kinds = Object.entries(HANDLERS)
    .filter(([, h]) => h.lane === lane)
    .map(([k]) => `'${k}'`)
    .join(",");
  const row = sqlite
    .prepare(
      `UPDATE jobs SET status = 'running', started_at = ?
       WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND kind IN (${kinds}) ORDER BY created_at LIMIT 1)
       RETURNING *`,
    )
    .get(Date.now()) as Record<string, unknown> | undefined;
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

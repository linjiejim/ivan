/**
 * 事件因子列按年补算（S15b，D83）：etl 道的 event_cols 任务，每次只补一年（etl/event-columns.ts）。
 *
 * - **不开数据版本**（D81）：每段写一条 pit_batches(kind = event_cols)；
 * - 算「写行情仓的任务」（WAREHOUSE_WRITERS）：排队与运行时回测暂停；年与年之间隔 15 秒（下一段带 not_before，
 *   没到时间不挡回测），让排队的回测先跑；
 * - 北京时间 16:30–21:00 不开新的一年（顺延到 21:00，把夜间更新让出来）；
 * - 什么时候排：S15 的回填完成时（jobs/events.ts）；夜间更新成功后发现签名或事件因子版本变了（jobs/etl.ts）；
 *   命令行 `pnpm ivan event-cols --market A [--force]` 直接补（worker 要先停）。
 */
import { backfillEventColumns, eventColumnsStatus } from "@ivan/data";
import { env, etlContext } from "../env.ts";
import { enqueue, type JobContext } from "../runner.ts";
import { inEventsPause, nextAllowed } from "./events.ts";

/** 年与年之间隔多久 */
export const EVENT_COLS_GAP_MS = 15_000;

let clock: () => number = () => Date.now();

/** 测试用：换掉任务里的时钟（不传就恢复） */
export function setEventColsClockForTest(f?: () => number): void {
  clock = f ?? (() => Date.now());
}

/** 已经有一个补算在排队或运行 */
export function eventColsJobActive(): { id: string; status: string } | null {
  const row = env()
    .app.sqlite.prepare(
      `SELECT id, status FROM jobs WHERE kind = 'event_cols' AND status IN ('queued', 'running')
       ORDER BY created_at LIMIT 1`,
    )
    .get() as { id: string; status: string } | undefined;
  return row ?? null;
}

/**
 * 需要补算就排一个（没有在排队或运行的才排）：S15 的回填已完成，而完成标记和当前签名、版本对不上。
 * 返回排了的任务 id；不需要或已经有了返回 null。出错只记日志（不让调用它的夜间任务失败）。
 */
export async function enqueueEventColsIfNeeded(log: (m: string) => void): Promise<string | null> {
  try {
    const st = await eventColumnsStatus(env().wh);
    if (!st.backfillComplete || st.complete || eventColsJobActive()) return null;
    const id = enqueue("event_cols", { market: "A" }, null);
    log(
      st.meta
        ? `事件因子的补算签名或版本变了（${st.meta.sig} v${st.meta.v} → ${st.sig} v${st.v}），排上按年补算`
        : "事件数据的历史已补齐，排上事件因子按年补算",
    );
    return id;
  } catch (e) {
    log(`检查事件因子补算时出错，先跳过：${e instanceof Error ? e.message : e}`);
    return null;
  }
}

export async function eventColsJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const force = (ctx.job.payload as { force?: unknown }).force === true;
  const start = clock();
  if (inEventsPause(start)) {
    const notBefore = nextAllowed(start);
    enqueue("event_cols", { market: "A", ...(force ? { force } : {}) }, null, { notBefore });
    ctx.log("北京时间 16:30–21:00 让给夜间更新，21:00 再接着补算");
    return { deferred: true, notBefore };
  }
  const etl = etlContext(ctx.log, ctx.progress);
  const r = await backfillEventColumns(etl, "A", { maxYears: 1, force });
  let notBefore: number | null = null;
  if (!r.skipped && r.remaining > 0) {
    notBefore = nextAllowed(clock() + EVENT_COLS_GAP_MS);
    enqueue("event_cols", { market: "A" }, null, { notBefore });
  }
  if (r.complete) ctx.log(`事件因子补算完成（第 ${r.v} 版，签名 ${r.sig}）`);
  return { ...r, notBefore };
}

/**
 * 点时事件数据的后台分段回填（S15，D81）：管理页「补齐历史数据」排一个 etl 道的 events 任务。
 *
 * - **不开数据版本**：每段只写一条 pit_batches（kind = backfill），行上盖 batch、ver 为空；committedAsOf、
 *   S13 的连续失败晚数与无成交中位数都不受影响（一晚因子写了一半后失败，接着跑一段回填，committedAsOf 仍是前一天）；
 * - 每段最多 EVENTS_JOB_BUDGET_MS（默认 10 分钟），按解禁、户数、大宗、两融的顺序分剩下的预算；没做完就 1 分钟后再排一段；
 * - 北京时间 16:30–21:00 不开新段（把夜间更新让出来），落在这段里的下一段推到 21:00；
 * - 不算「写行情仓的任务」（回测不读事件表），回测照常跑；
 * - 全部做完（每个数据集都设上了覆盖起点）自动排 S15b 的事件因子列补算（jobs/event-cols.ts）。
 */
import {
  type DateStr,
  isDateStr,
  nowHmCN,
  PIT_DATASET_IDS,
  type PitDatasetId,
  pitProgressText,
} from "@ivan/core";
import { pitBackfillProgress, pitDatasetStatus, PIT_DEFAULT_SINCE, runPitSyncs } from "@ivan/data";
import { env, etlContext, todayOf } from "../env.ts";
import { enqueue, type JobContext } from "../runner.ts";
import { enqueueEventColsIfNeeded } from "./event-cols.ts";

/** 每段最多多久（毫秒） */
export function eventsJobBudgetMs(e: Record<string, string | undefined> = process.env): number {
  const n = Number(e.EVENTS_JOB_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : 600_000;
}

/** 没做完时隔多久再排下一段 */
export const EVENTS_REQUEUE_DELAY_MS = 60_000;

/** 回填的顺序：小的先做完（解禁约 75 次请求、户数约 1,050、大宗约 1,470、两融约 1.5 万） */
export const EVENTS_ORDER: readonly PitDatasetId[] = ["lockups", "holders", "blocks", "margin"];

const HOUR = 3_600_000;
const PAUSE_FROM = 16.5 * HOUR;
const PAUSE_TO = 21 * HOUR;
const CST = 8 * HOUR;

/** 北京时间 16:30–21:00 之间（夜间更新的时段）不开新段 */
export function inEventsPause(ms: number): boolean {
  const t = (((ms + CST) % (24 * HOUR)) + 24 * HOUR) % (24 * HOUR);
  return t >= PAUSE_FROM && t < PAUSE_TO;
}

/** 下一段最早什么时候开：落在 16:30–21:00 里的推到当天 21:00（北京时间） */
export function nextAllowed(ms: number): number {
  if (!inEventsPause(ms)) return ms;
  const t = (((ms + CST) % (24 * HOUR)) + 24 * HOUR) % (24 * HOUR);
  return ms - t + PAUSE_TO;
}

export interface EventsPayload {
  market: "A";
  datasets?: PitDatasetId[];
  since?: DateStr;
}

/** 校验并规范化任务参数（内部接口与任务共用） */
export function eventsPayload(b: { datasets?: unknown; since?: unknown }): EventsPayload | string {
  const out: EventsPayload = { market: "A" };
  if (b.datasets !== undefined && b.datasets !== null) {
    if (
      !Array.isArray(b.datasets) ||
      !b.datasets.length ||
      b.datasets.some((d) => !PIT_DATASET_IDS.includes(d as PitDatasetId))
    ) {
      return `数据集只能是 ${PIT_DATASET_IDS.join("、")}`;
    }
    out.datasets = [...new Set(b.datasets as PitDatasetId[])];
  }
  if (b.since !== undefined && b.since !== null && b.since !== "") {
    if (!isDateStr(b.since) || b.since < "2010-01-01")
      return "起始日期格式要是 YYYY-MM-DD（2010 年以后）";
    out.since = b.since;
  }
  return out;
}

let clock: () => number = () => Date.now();

/** 测试用：换掉任务里的时钟（不传就恢复） */
export function setEventsClockForTest(f?: () => number): void {
  clock = f ?? (() => Date.now());
}

/** 已经有一个事件数据回填在排队或运行 */
export function eventsJobActive(): { id: string; status: string; notBefore: number | null } | null {
  const row = env()
    .app.sqlite.prepare(
      `SELECT id, status, not_before AS notBefore FROM jobs
       WHERE kind = 'events' AND status IN ('queued', 'running') ORDER BY created_at LIMIT 1`,
    )
    .get() as { id: string; status: string; notBefore: number | null } | undefined;
  return row ?? null;
}

export async function eventsJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const parsed = eventsPayload(ctx.job.payload as Record<string, unknown>);
  if (typeof parsed === "string") throw new Error(parsed);
  const payload = parsed;
  const ids = EVENTS_ORDER.filter((id) => !payload.datasets || payload.datasets.includes(id));
  const start = clock();
  if (inEventsPause(start)) {
    const notBefore = nextAllowed(start);
    enqueue("events", { ...payload }, null, { notBefore });
    ctx.log("北京时间 16:30–21:00 让给夜间更新，21:00 再接着补");
    return { deferred: true, notBefore };
  }
  const etl = etlContext(ctx.log, ctx.progress);
  const since = payload.since ?? PIT_DEFAULT_SINCE;
  const { results, skipped } = await runPitSyncs(etl, "backfill", ids, null, {
    from: since,
    budgetMs: eventsJobBudgetMs(),
    now: clock,
    note: async () => pitProgressText(await pitBackfillProgress(etl.wh, todayOf(), since)),
  });
  // 预算用完、或被风控（等解封）：过一会儿接着补；金丝雀没过、接口字段变了、个别块失败不自动重排
  const again = skipped.length > 0 || results.some((r) => r.stoppedForBudget || r.blocked);
  const failed = results.flatMap((r) => r.failed.map((k) => `${r.id}:${k}`));
  // 金丝雀没过或中途结构变了：整个数据集停下，没有失败块、也不是预算或风控（运行器的 detail 写了哪个接口怎么了）
  const broken = results.filter(
    (r) => !r.ok && !r.blocked && !r.stoppedForBudget && !r.failed.length,
  );
  // 完成 = 每个要补的数据集都跑了、全部块 done 或 partial，并且设上了覆盖起点（S15b 只在这时排补算）
  // 只要覆盖起点：行数给 0，省掉每个表的 count(*)
  const status = await pitDatasetStatus(etl.wh, Object.fromEntries(ids.map((id) => [id, 0])));
  const complete =
    !again &&
    ids.every((id) => {
      const r = results.find((x) => x.id === id);
      const covered = status[id].coveredFrom;
      return !!r && r.ok && r.remaining === 0 && !r.failed.length && !!covered && covered <= since;
    });
  let notBefore: number | null = null;
  let eventCols: string | null = null;
  if (again) {
    notBefore = nextAllowed(clock() + EVENTS_REQUEUE_DELAY_MS);
    enqueue("events", { ...payload }, null, { notBefore });
    ctx.log(`这一段先到这里，北京时间 ${nowHmCN(new Date(notBefore))} 接着补`);
  } else if (broken.length) {
    ctx.log(
      `事件数据回填停下：${broken.map((r) => r.detail).join("；")}。接口修好后再点一次「补齐历史数据」接着补`,
    );
  } else if (failed.length) {
    ctx.log(`事件数据回填结束，有 ${failed.length} 块没取成，再点一次「补齐历史数据」重试`);
  } else if (!complete) {
    ctx.log("事件数据回填没做完（还有数据集没补到起始日），再点一次「补齐历史数据」接着补");
  } else {
    ctx.log("事件数据回填完成");
    // 四个数据集都有覆盖起点、补算标记对不上时才排（只补了部分数据集时不排）
    eventCols = await enqueueEventColsIfNeeded(ctx.log);
  }
  return {
    datasets: results.map((r) => ({
      id: r.id,
      status: r.status,
      done: r.done,
      partial: r.partial.length,
      failed: r.failed.length,
      remaining: r.remaining,
      rows: r.rows,
      requests: r.requests,
    })),
    skipped,
    again,
    complete,
    broken: broken.map((r) => r.id),
    notBefore,
    eventCols,
  };
}

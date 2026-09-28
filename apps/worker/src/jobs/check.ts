/**
 * 每周抽检任务（spec §8）：两个市场各抽 50 只，发现数据被修订就重写并重算因子。
 */
import { weeklyCheck } from "@ivan/data";
import { etlContext } from "../env.ts";
import type { JobContext } from "../runner.ts";

export async function checkJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const etl = etlContext(ctx.log);
  const a = await weeklyCheck(etl, "A");
  ctx.progress(0.5, "港股抽检");
  const hk = await weeklyCheck(etl, "HK");
  return { A: a, HK: hk };
}

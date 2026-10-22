/**
 * 每周抽检任务（spec §8）：两个市场各抽 50 只，发现数据被修订就重写并重算因子。
 * 两个市场共用一份等风控的预算（D108）：被封时不为了抽检一挂几个小时（10-11 那次港股抽检等了 39 分钟）。
 */
import { weeklyCheck } from "@ivan/data";
import { boundedEtlContext } from "../env.ts";
import type { JobContext } from "../runner.ts";

export async function checkJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const etl = boundedEtlContext(ctx.log);
  const a = await weeklyCheck(etl, "A");
  ctx.progress(0.5, "港股抽检");
  const hk = await weeklyCheck(etl, "HK");
  return { A: a, HK: hk };
}

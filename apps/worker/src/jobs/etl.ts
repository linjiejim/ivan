/**
 * 夜间 ETL（spec §8）：增量更新行情仓 → 交易日才结算该市场的跟踪。失败则中止后续步骤并记录。
 */
import type { Market } from "@ivan/core";
import { daily } from "@ivan/data";
import { etlContext } from "../env.ts";
import type { JobContext } from "../runner.ts";
import { settleMarket } from "./settle.ts";

export async function etlJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const market = (ctx.job.payload.market === "HK" ? "HK" : "A") as Market;
  const etl = etlContext(ctx.log, (f, note) => ctx.progress(f * 0.8, note));
  const r = await daily(etl, market);
  if (!r.tradingDay) return { market, tradingDay: false, latest: r.latest };
  ctx.progress(0.85, "结算跟踪");
  const s = await settleMarket(market, ctx);
  return { market, tradingDay: true, latest: r.latest, dataVersion: r.dataVersion, ...s };
}

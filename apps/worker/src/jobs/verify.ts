/**
 * 复核数据（D57，compute 道）：按原参数（含截到的终点）重新组装输入、算输入指纹，和运行卡记下的比。
 * 只比输入、从不模拟，所以便宜；和回测共用线程池名额，不会在夜间更新时被多个一起撑爆内存。
 * 结果写进原运行的 verify 列，回测页轮询直到完成。
 */
import { ENGINE_VERSION } from "@ivan/engine";
import { HASH_VERSION, hashSimInput } from "@ivan/data";
import type { RunCard } from "@ivan/core";
import { runs } from "@ivan/db";
import { eq } from "drizzle-orm";
import { env } from "../env.ts";
import type { JobContext } from "../runner.ts";
import { rebuildInput } from "./backtest.ts";

export async function verifyJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const { db } = env().app;
  const runId = String(ctx.job.payload.runId);
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run) throw new Error(`回测 ${runId} 不存在`);
  const setVerify = (v: Record<string, unknown>) =>
    db.update(runs).set({ verify: v }).where(eq(runs.id, runId)).run();
  const requestedAt = (run.verify as { requestedAt?: number } | null)?.requestedAt ?? null;
  setVerify({ status: "running", kind: "input", requestedAt });
  try {
    const card = run.card as unknown as RunCard | null;
    if (!run.inputHash || !card) {
      const v = {
        status: "done",
        kind: "input",
        at: Date.now(),
        sameInput: null,
        reason: "unrecorded",
      };
      setVerify(v);
      return { runId, sameInput: null, reason: "unrecorded" };
    }
    ctx.progress(0.2, "重新组装输入");
    // 终点取运行卡记下的（截到数据截至日后的）那天，和回测时算指纹的 cut 相同；之后新增的交易日不进窗口
    const built = await rebuildInput(run, undefined, card.params.end);
    const h = hashSimInput(built.input);
    const sameInput = h.inputHash === run.inputHash;
    setVerify({
      status: "done",
      kind: "input",
      at: Date.now(),
      sameInput,
      inputHash: h.inputHash,
      recordedInputHash: run.inputHash,
      engineSame: card.engine.version === ENGINE_VERSION,
      hashVersionSame: card.data.hashVersion === HASH_VERSION,
      dataVersionThen: run.dataVersion,
      dataVersionNow: built.dataVersion.id,
    });
    ctx.log(`复核 ${runId}：${sameInput ? "输入一致" : "输入不同"}`);
    return { runId, sameInput };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    setVerify({ status: "failed", kind: "input", at: Date.now(), error });
    throw e;
  }
}

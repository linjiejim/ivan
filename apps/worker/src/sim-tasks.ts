/**
 * 回测线程里跑的一次任务：模拟，再按需算可信度（D65）。线程、主线程退路、CLI 共用这一个函数，三处不会走样。
 * 可信度只对指标第 2 版的回测算（旧口径重跑要和当初逐字节一致）；跟踪结算不请求它。
 */
import type { SimInput, SimResult, ValidationResult } from "@ivan/core";
import { sha256Canonical } from "@ivan/core/node";
import { runValidation, simulate, VALIDATION_VERSION, validationChecks } from "@ivan/engine";

export type SimTask = "validation";

export interface SimTaskOptions {
  tasks?: SimTask[];
  /** 可信度的自助法种子（validationSeed(inputHash)）；请求 validation 时必须给 */
  seed?: number;
}

export interface SimOutput {
  result: SimResult;
  validation?: ValidationResult;
}

/**
 * 可信度的种子：输入指纹 + 方法版本的前 8 位十六进制。来自这次回测实际读到的输入，不来自每晚都涨的数据版本号——
 * 输入没变，第二天重跑也是同一个种子、同样的区间。
 */
export function validationSeed(inputHash: string): number {
  return Number.parseInt(sha256Canonical({ inputHash, v: VALIDATION_VERSION }).slice(0, 8), 16);
}

export function runSimTasks(input: SimInput, opts: SimTaskOptions = {}): SimOutput {
  const result = simulate(input);
  if (!opts.tasks?.includes("validation") || result.exec.metrics !== 2) return { result };
  if (opts.seed === undefined) throw new Error("算可信度要给种子");
  const validation = runValidation(result, input.spec, opts.seed);
  if (!validation) return { result };
  result.checks.push(...validationChecks(validation.confidence, result.metrics));
  return { result, validation };
}

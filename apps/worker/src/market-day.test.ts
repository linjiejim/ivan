import { describe, expect, it } from "vitest";
import { classifyMarketDay, type EtlJobToday } from "./market-day.ts";

// 2026-10-05 是周一，2026-10-03 是周六
const MON = "2026-10-05";
const t = (h: number) => Date.parse(`${MON}T${String(h).padStart(2, "0")}:00:00+08:00`);
const job = (
  status: string,
  h: number,
  result: Record<string, unknown> | null = null,
  attempt?: number,
): EtlJobToday => ({
  status,
  result,
  createdAt: t(h),
  ...(attempt !== undefined ? { attempt } : {}),
});
const day = (
  etlJobsToday: EtlJobToday[],
  committedAsOf: string | null = "2026-09-30",
  today = MON,
) => classifyMarketDay({ today, committedAsOf, etlJobsToday });

describe("市场当日状态（D78）", () => {
  it.each([
    ["数据版本就是今天 → 已更新", day([job("failed", 17)], MON), "traded"],
    ["周六 → 休市", day([], "2026-10-02", "2026-10-03"), "closed"],
    ["周日 → 休市", day([], "2026-10-02", "2026-10-04"), "closed"],
    ["etl 完成且不是交易日 → 休市", day([job("done", 17, { tradingDay: false })]), "closed"],
    ["etl 失败 → 没更新", day([job("failed", 17)]), "stale"],
    ["失败后手动重跑还在排队 → 仍是没更新", day([job("failed", 17), job("queued", 18)]), "stale"],
    [
      "失败后重跑成功 → 不再算没更新",
      day([job("failed", 17), job("done", 18, { tradingDay: true })]),
      "pending",
    ],
    ["没有任务 → 进行中", day([]), "pending"],
    ["正在跑 → 进行中", day([job("running", 17)]), "pending"],
    ["排着队 → 进行中", day([job("queued", 17)]), "pending"],
    // S13 起「排队等自动重跑（attempt > 0）」才算没更新；本切片还是进行中
    ["排队等自动重跑（attempt 1）→ 本切片仍是进行中", day([job("queued", 17, null, 1)]), "pending"],
    ["没有数据版本也不会因为日历里没今天就说休市", day([job("failed", 17, null)], null), "stale"],
  ])("%s", (_name, got, want) => {
    expect(got).toBe(want);
  });

  it("任务顺序不影响结果（按创建时间判断「之后」）", () => {
    expect(day([job("done", 18, { tradingDay: true }), job("failed", 17)])).toBe("pending");
    expect(day([job("failed", 19), job("done", 18, { tradingDay: true })])).toBe("stale");
  });
});

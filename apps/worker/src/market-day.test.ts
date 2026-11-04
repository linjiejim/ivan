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
    // 补数据中（D111）：任务完成了，截至日只提交到之前齐全的那天
    [
      "补数据的任务完成 → 没更新",
      day([job("done", 18, { tradingDay: true, catchUp: { asOf: "2026-09-30" } })]),
      "stale",
    ],
    ["正在跑 → 进行中", day([job("running", 17)]), "pending"],
    ["排着队 → 进行中", day([job("queued", 17)]), "pending"],
    // 排队等自动重跑（attempt > 0，D73）算没更新
    ["排队等自动重跑（attempt 1）→ 没更新", day([job("queued", 17, null, 1)]), "stale"],
    [
      "失败 + 排队等第 1 次自动重跑 → 没更新，不说休市",
      day([job("failed", 17), job("queued", 18, null, 1)]),
      "stale",
    ],
    [
      "第 2 次自动重跑成功 → 不再算没更新",
      day([
        job("failed", 17),
        job("failed", 18, null, 1),
        job("done", 19, { tradingDay: true }, 2),
      ]),
      "pending",
    ],
    ["没有数据版本也不会因为日历里没今天就说休市", day([job("failed", 17, null)], null), "stale"],
  ])("%s", (_name, got, want) => {
    expect(got).toBe(want);
  });

  it("任务顺序不影响结果（按创建时间判断「之后」）", () => {
    expect(day([job("done", 18, { tradingDay: true }), job("failed", 17)])).toBe("pending");
    expect(day([job("failed", 19), job("done", 18, { tradingDay: true })])).toBe("stale");
  });
});

describe("marketDayStatus 读 jobs 表", () => {
  it("失败的 etl + 排队等自动重跑（attempt 1、not_before 在未来）→ 没更新", async () => {
    const { jobs, newId } = await import("@ivan/db");
    const { todayCN } = await import("@ivan/core");
    const { makeTestEnv } = await import("./testing/harness.ts");
    const { marketDayStatus } = await import("./market-day.ts");
    const t = await makeTestEnv({ today: "2026-10-09" });
    try {
      const now = Date.parse("2026-10-09T17:40:00+08:00");
      expect(todayCN(new Date(now))).toBe("2026-10-09");
      const add = (
        status: string,
        createdAt: number,
        attempt = 0,
        notBefore: number | null = null,
      ) =>
        t.env.app.db
          .insert(jobs)
          .values({
            id: newId("j_"),
            kind: "etl",
            payload: { market: "A" },
            status,
            createdAt,
            attempt,
            notBefore,
          })
          .run();
      add("failed", now - 10 * 60_000);
      expect(await marketDayStatus("A", "2026-10-09")).toBe("stale");
      add("queued", now, 1, now + 45 * 60_000);
      expect(await marketDayStatus("A", "2026-10-09")).toBe("stale");
      // 别的市场不受影响
      expect(await marketDayStatus("HK", "2026-10-09")).toBe("pending");
    } finally {
      await t.cleanup();
    }
  });
});

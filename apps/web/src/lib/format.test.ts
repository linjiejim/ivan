import { describe, expect, it } from "vitest";
import {
  formatPlanReason,
  pctile,
  planDateNote,
  REASON_DETAIL_TEXT,
  REASON_TEXT,
} from "./format.ts";

const item = (o: Partial<Parameters<typeof formatPlanReason>[0]>) => ({
  side: "sell",
  reason: "rebalance",
  reasonDetail: null,
  rank: null,
  failedConditions: null,
  ...o,
});

describe("计划原因文字（D68）", () => {
  it("细分原因的模板", () => {
    expect(REASON_DETAIL_TEXT).toMatchObject({
      ranked_out: "掉出前 {band} 名（排第 {rank}）",
      failed_filter: "不再满足：{conds}",
      take_profit: "止盈",
      stop_loss: "止损",
      max_hold: "到期",
      delisted: "退市",
      exposure: "仓位控制",
      entry: "建仓",
      signal: "信号",
    });
    expect(REASON_TEXT.rebalance).toBe("调出");
  });

  it("掉出前 N 名带名次；不再满足带条件（去掉重复的「没满足：」）；其余照表", () => {
    expect(formatPlanReason(item({ reasonDetail: "ranked_out", rank: 31 }), 15)).toBe(
      "掉出前 15 名（排第 31）",
    );
    expect(formatPlanReason(item({ reasonDetail: "ranked_out" }), 15)).toBe("掉出前 15 名");
    expect(
      formatPlanReason(
        item({
          reason: "filtered",
          reasonDetail: "failed_filter",
          failedConditions: ["没满足：ROE(TTM) ≥ 12%", "是 ST"],
        }),
        15,
      ),
    ).toBe("不再满足：ROE(TTM) ≥ 12%、是 ST");
    expect(formatPlanReason(item({ reason: "filtered", reasonDetail: "failed_filter" }), 15)).toBe(
      "不再满足条件",
    );
    expect(formatPlanReason(item({ reason: "stop_loss", reasonDetail: "stop_loss" }), 15)).toBe(
      "止损",
    );
    expect(
      formatPlanReason(item({ side: "buy", reason: "entry", reasonDetail: "entry" }), 15),
    ).toBe("建仓");
    // 早于账本的计划只有粗原因
    expect(formatPlanReason(item({ reason: "take_profit" }), null)).toBe("止盈");
  });

  it("计划日旁注与分位", () => {
    expect(planDateNote("holiday_table")).toBe("（按交易所休市安排推算）");
    expect(planDateNote("weekday")).toBe("（按工作日推算，遇节假日顺延）");
    expect(planDateNote(null)).toBe("（按工作日推算，遇节假日顺延）");
    expect(pctile(0.834)).toBe("83 分位");
    expect(pctile(null)).toBe("--");
  });
});

import { describe, expect, it } from "vitest";
import {
  formatPlanReason,
  LEDGER_BREAK_TEXT,
  ledgerKindText,
  outcomeText,
  reasonDetailShort,
  replayLine,
  pctile,
  planDateNote,
  REASON_DETAIL_TEXT,
  REASON_TEXT,
  VERDICT_TEXT,
  VERDICT_TONE,
  verdictInfoRows,
  verdictNote,
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

describe("跟踪判词（D70）", () => {
  it("颜色按设计系统：正常 down；偏离、可能失效、数据未更新、结算失败 warn；观察期 neutral", () => {
    expect(VERDICT_TONE).toEqual({
      ON_TRACK: "down",
      DRIFTING: "warn",
      DECAYED: "warn",
      WARMING_UP: "neutral",
      STALE_DATA: "warn",
      SETTLE_FAILED: "warn",
    });
    expect(VERDICT_TEXT).toEqual({
      ON_TRACK: "正常",
      DRIFTING: "偏离",
      DECAYED: "可能失效",
      WARMING_UP: "观察期",
      STALE_DATA: "数据未更新",
      SETTLE_FAILED: "结算失败",
    });
  });

  it("ⓘ 的各行：指标的值与阈值，再是读数与状态；没有读数时为空", () => {
    expect(
      verdictInfoRows({
        state: "monitoring",
        signal: "warning",
        perMetric: {
          beatBacktestPct: { value: 3, signal: "warning" },
          ddRatio: { value: 1.234, signal: "warning" },
        },
      }),
    ).toEqual([
      ["跑赢回测同期", "3（正常 ≥ 5，注意 ≥ 1）"],
      ["回撤比", "1.23 倍（正常 ≤ 1.2，注意 ≤ 1.5）"],
      ["这一晚的读数", "注意"],
      ["状态", "偏离"],
    ]);
    expect(verdictInfoRows(null)).toEqual([]);
  });

  it("可能失效的说明只建议复核，不说停止或卖出", () => {
    expect(verdictNote("DECAYED")).toContain("建议复核规则是否仍然有效");
    expect(verdictNote("DECAYED")).not.toMatch(/卖出|停止跟踪/);
    expect(verdictNote("STALE_DATA", "2026-09-30")).toContain("还是 2026-09-30 的结果");
  });
});

describe("决策回溯的文字（D71）", () => {
  const r = (o: Partial<Parameters<typeof replayLine>[0] & object>) => ({
    side: "buy",
    outcome: "filled",
    price: 12.3149,
    rejectReason: null,
    ...o,
  });

  it("按现在的数据重放：成交价、没买到 / 没卖出（原因）、没有执行、计划日还没结算", () => {
    expect(replayLine(r({}))).toBe("按现在的数据重放：成交 12.31");
    expect(replayLine(r({ rejectReason: "capacity" }))).toBe(
      "按现在的数据重放：成交 12.31（部分没成交：超过成交额上限）",
    );
    expect(replayLine(r({ outcome: "rejected", price: null, rejectReason: "limit_up" }))).toBe(
      "按现在的数据重放：没买到（涨停开盘）",
    );
    expect(
      replayLine(r({ side: "sell", outcome: "rejected", price: null, rejectReason: "suspended" })),
    ).toBe("按现在的数据重放：没卖出（停牌）");
    expect(replayLine(r({ outcome: "not_executed", price: null }))).toBe(
      "按现在的数据重放：没有执行",
    );
    expect(replayLine(null)).toBe("按现在的数据重放：计划日还没结算");
  });

  it("后来怎么样：20 天优先，不满 20 天用 5 天并注明；卖出写卖出后；没到时间写 --", () => {
    const o = { side: "buy", ret5: 0.012, ret20: 0.031, excess5: -0.004, excess20: 0.012 };
    expect(outcomeText(o)).toBe("+3.1%，跑赢基准 +1.2%");
    expect(outcomeText({ ...o, ret20: null, excess20: null })).toBe(
      "+1.2%，跑赢基准 -0.4%（5 天）",
    );
    expect(outcomeText({ ...o, side: "sell" })).toBe("卖出后 +3.1%，跑赢基准 +1.2%");
    expect(outcomeText({ ...o, excess20: null })).toBe("+3.1%");
    expect(outcomeText({ ...o, ret5: null, ret20: null })).toBe("--");
    expect(outcomeText(null)).toBe("--");
  });

  it("时间线徽标、细分原因短文字、断点原因", () => {
    expect(ledgerKindText("plan", 1)).toBe("计划");
    expect(ledgerKindText("plan", 2)).toBe("修订");
    expect(
      ["replay_drift", "health_transition", "brief", "tracking_start", "tracking_stop"].map((k) =>
        ledgerKindText(k),
      ),
    ).toEqual(["重放差异", "状态变化", "简报", "上线", "停止"]);
    expect(reasonDetailShort("ranked_out")).toBe("掉出名次线");
    expect(reasonDetailShort("take_profit")).toBe("止盈");
    expect(reasonDetailShort(null)).toBe("--");
    expect(LEDGER_BREAK_TEXT.payload_hash_mismatch).toBe("内容哈希不符");
  });
});

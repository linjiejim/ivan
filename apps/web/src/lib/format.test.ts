import { describe, expect, it } from "vitest";
import {
  nearestValueText,
  eventFactorOption,
  eventFactorsText,
  fmtFactor,
  formatPlanReason,
  holdersText,
  LEDGER_BREAK_TEXT,
  LOCKUP_RULE_TAG,
  lockupRuleText,
  pctPoints,
  premiumText,
  sharesText,
  ledgerKindText,
  outcomeText,
  reasonDetailShort,
  replayLine,
  pctile,
  planDateNote,
  REASON_DETAIL_TEXT,
  REASON_TEXT,
  slippageError,
  slippageFromInput,
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
    expect(verdictNote("DECAYED")).not.toMatch(/卖出|停止/);
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
    expect(outcomeText({ ...o, ret20: null, excess20: null })).toBe("+1.2%，跑输基准 0.4%（5 天）");
    expect(outcomeText({ ...o, side: "sell" })).toBe("卖出后 +3.1%，相对基准 +1.2%");
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

describe("两融与筹码的格式（S15b）", () => {
  it("解禁可得日依据：Tag 文字与说明", () => {
    expect(LOCKUP_RULE_TAG.ipo_terms).toBe("上市时已知");
    expect(LOCKUP_RULE_TAG.notice_bound).toBe("按公告推算");
    expect(LOCKUP_RULE_TAG["notice_bound:weekday"]).toBe("按工作日推算");
    expect(LOCKUP_RULE_TAG.first_seen).toBe("首次记录");
    expect(lockupRuleText("notice_bound")).toBe("按解禁前 3 个交易日的提示性公告推算可得日");
    expect(lockupRuleText("ipo_terms")).toBe("首发限售，上市时招股书就写明了");
  });

  it("折溢价不靠正负号：负数是折价、正数是溢价", () => {
    expect(premiumText(-9.825)).toBe("折价 9.8%");
    expect(premiumText(2)).toBe("溢价 2.0%");
    expect(premiumText(0.01)).toBe("平价");
    expect(premiumText(null)).toBe("--");
    expect(pctPoints(-9.75)).toBe("-9.8%");
    expect(pctPoints(1.0953, 2)).toBe("+1.10%");
  });

  it("编辑器里事件因子的后缀：补算中禁用；补完写数据起点；普通因子不加", () => {
    expect(eventFactorOption({ dataset: "margin", from: "2013-02-13", ready: false })).toEqual({
      suffix: "（补算中）",
      disabled: true,
    });
    expect(eventFactorOption({ dataset: "margin", from: "2013-02-13", ready: true })).toEqual({
      suffix: " 自 2013-02-13",
      disabled: false,
    });
    expect(eventFactorOption({ dataset: "margin", from: null, ready: null })).toEqual({
      suffix: "",
      disabled: false,
    });
    expect(eventFactorOption({})).toEqual({ suffix: "", disabled: false });
  });

  it("管理页的事件因子一行", () => {
    expect(eventFactorsText({ v: 1, complete: false, doneYears: 7, totalYears: 14 })).toBe(
      "事件因子：补算中（7 / 14 年）",
    );
    expect(eventFactorsText({ v: 1, complete: true, doneYears: 14, totalYears: 14 })).toBe(
      "事件因子：已补算（第 1 版）",
    );
    expect(
      eventFactorsText({
        v: 1,
        complete: false,
        doneYears: 0,
        totalYears: 0,
        backfillComplete: false,
      }),
    ).toBe("事件因子：等事件数据的历史补齐后再补算");
    expect(eventFactorsText(undefined)).toBeNull();
  });

  it("股数写成万股，户数加千分位；天数是整数", () => {
    expect(sharesText(82_537_493)).toBe("8,253.75 万股");
    expect(sharesText(25_000_000)).toBe("2,500 万股");
    expect(sharesText(5_000)).toBe("5,000 股");
    expect(holdersText(48212)).toBe("48,212 户");
    expect(fmtFactor(181, "天")).toBe("181 天");
  });
});

describe("数字核对 ⓘ 的最接近的工具数", () => {
  it("按证据种类排版：比率写成百分数、百分数照写、金额写万 / 亿；旧结果保留 4 位有效数字", () => {
    expect(nearestValueText({ value: 0.0812, kind: "ratio" }, "percent")).toBe("+8.12%");
    expect(nearestValueText({ value: 4.25, kind: "points" }, "percent")).toBe("4.25%");
    expect(nearestValueText({ value: 1.7233e10, kind: "money" }, "money")).toBe("172.33 亿");
    expect(nearestValueText({ value: 48212, kind: "count" }, "count")).toBe("48,212");
    expect(nearestValueText({ value: 0.081234567 }, "percent")).toBe("0.08123");
  });
});

describe("回测对话框的单边滑点", () => {
  it("清空输入框是「没填」，不当成 0 bp；没填或超出 0–200 bp 都给提示（「开始回测」不能点）", () => {
    expect(slippageFromInput("")).toBeNaN();
    expect(slippageFromInput("  ")).toBeNaN();
    expect(slippageFromInput("0")).toBe(0);
    expect(slippageFromInput("12.5")).toBe(12.5);
    expect(slippageError(slippageFromInput(""))).toBe("请填单边滑点（不计滑点填 0）");
    expect(slippageError(0)).toBeNull();
    expect(slippageError(200)).toBeNull();
    expect(slippageError(200.5)).toBe("单边滑点要在 0–200 bp 之间");
    expect(slippageError(-1)).toBe("单边滑点要在 0–200 bp 之间");
    expect(slippageError(Number.POSITIVE_INFINITY)).toBe("单边滑点要在 0–200 bp 之间");
  });
});

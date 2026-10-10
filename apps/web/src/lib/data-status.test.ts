import { describe, expect, it } from "vitest";
import { captureLines, openVersionText, versionStatusBadge } from "./data-status.ts";

describe("versionStatusBadge", () => {
  it("四种结束状态", () => {
    expect(versionStatusBadge("ok")).toEqual({ text: "完整", tone: "neutral" });
    expect(versionStatusBadge("incomplete")).toEqual({ text: "不完整", tone: "warn" });
    expect(versionStatusBadge("failed")).toEqual({ text: "失败", tone: "warn" });
    expect(versionStatusBadge("skipped")).toEqual({ text: "休市", tone: "neutral" });
    expect(versionStatusBadge(null)).toBeNull();
  });
});

describe("openVersionText", () => {
  it("带版本号；有开始时间时写上", () => {
    expect(openVersionText({ id: 12, startedAt: null })).toBe("正在更新（版本 #12）");
    expect(openVersionText({ id: 12, startedAt: new Date(2026, 9, 20, 17, 30).getTime() })).toMatch(
      /^正在更新（版本 #12，.*17:30 开始）$/,
    );
  });
});

describe("captureLines", () => {
  it("各属性自哪天起、近 7 天变化；近 7 天被跳过的整批变化是 warn；最后是财报首见留底", () => {
    const lines = captureLines(
      {
        attrs: [
          {
            attr: "industry_l1",
            firstDate: "2026-10-12",
            openRows: 2600,
            changes7d: 12,
            lastSkipped: { date: "2026-10-19", pct: 0.42 },
          },
          {
            attr: "lot_size",
            firstDate: "2026-10-12",
            openRows: 2600,
            changes7d: 0,
            lastSkipped: { date: "2026-09-01", pct: 0.5 },
          },
          { attr: "hk_connect_sz", firstDate: null, openRows: 0, changes7d: 0, lastSkipped: null },
        ],
        financialsSeen: { rows: 1200, new7d: 30 },
      },
      "2026-10-20",
    );
    expect(lines).toEqual([
      { text: "一级行业快照自 2026-10-12 起 · 近 7 天变化 12", tone: "neutral" },
      {
        text: "一级行业快照在 2026-10-19 一天变了 42%，可能是数据源改了名，先没有记录，请核对",
        tone: "warn",
      },
      { text: "每手股数快照自 2026-10-12 起 · 近 7 天变化 0", tone: "neutral" },
      { text: "深港通名单还没有开始记录", tone: "neutral" },
      { text: "财报首见留底 1200 条，近 7 天新增 30", tone: "neutral" },
    ]);
  });
});

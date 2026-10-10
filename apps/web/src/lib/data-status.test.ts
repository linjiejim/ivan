import { describe, expect, it } from "vitest";
import {
  canaryBadge,
  canaryInfoText,
  captureLines,
  eventDatasetLine,
  eventsBackfillText,
  openVersionText,
  provenanceText,
  qualitySentence,
  retryBannerText,
  softAlerts,
  sourcesLines,
  versionStatusBadge,
} from "./data-status.ts";
import type { DataQuality, DataStatus, EventDatasetStatus } from "./types.ts";

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

describe("sourcesLines", () => {
  const base = {
    versionId: 7,
    status: "ok",
    date: "2026-10-20",
    served: { em: 120, tx: 3, txq: 5227 },
    fallbacks: 3,
    failed: 0,
    empty: 0,
    index: { sse: "em" },
  };

  it("今晚：东财 N 只、腾讯 M 只（含批量报价）与回退次数，批量报价另起一行", () => {
    expect(sourcesLines(base, "2026-10-20")).toEqual([
      { text: "今晚东财 120 只、腾讯 5230 只（回退 3 次）", tone: "neutral" },
      { text: "腾讯里 5227 只来自批量报价", tone: "neutral" },
    ]);
  });

  it("不是今天的写上日期；有没拿到的股票时单列成 warn；没有台账时不显示", () => {
    const lines = sourcesLines(
      { ...base, served: { em: 3 }, fallbacks: 0, failed: 2 },
      "2026-10-21",
    );
    expect(lines).toEqual([
      { text: "2026-10-20 那晚东财 3 只、腾讯 0 只（回退 0 次）", tone: "neutral" },
      { text: "2 只日线所有数据源都没拿到", tone: "warn" },
    ]);
    expect(sourcesLines(null, "2026-10-21")).toEqual([]);
    expect(sourcesLines(undefined, "2026-10-21")).toEqual([]);
  });
});

const market = (o: Partial<DataStatus["markets"][number]>): DataStatus["markets"][number] => ({
  market: "A",
  asOf: "2026-10-08",
  dataVersion: 9,
  lastEtl: null,
  ...o,
});

describe("retryBannerText（D73）", () => {
  it("排着队等自动重跑：原因、北京时间几点、第几次", () => {
    const m = market({
      lastEtl: {
        status: "queued",
        finishedAt: null,
        error: "A 股有 12 只股票今天的日线没拿到，已停止更新，以免被当成停牌",
        attempt: 1,
        retryAt: Date.parse("2026-10-09T18:15:00+08:00"),
      },
    });
    expect(retryBannerText(m)).toBe(
      "A 股今天的数据没更新完整：A 股有 12 只股票今天的日线没拿到，已停止更新，以免被当成停牌。18:15 自动重试（第 1/2 次）",
    );
    expect(
      retryBannerText(market({ lastEtl: { status: "failed", finishedAt: 1, error: "x" } })),
    ).toBeNull();
  });
});

describe("softAlerts（D73）", () => {
  it("连续失败 3 晚以上才提示", () => {
    const m = market({
      market: "HK",
      soft: [
        {
          step: "fundamentals",
          lastOkDate: "2026-10-05",
          failingNights: 3,
          firstFailDate: "2026-10-06",
        },
        { step: "fx", lastOkDate: "2026-10-07", failingNights: 2, firstFailDate: "2026-10-08" },
      ],
    });
    expect(softAlerts(m)).toEqual(["港股「财报与股本」已经连续 3 晚没更新成功，沿用的是旧数据"]);
  });
});

describe("qualitySentence（D74）", () => {
  const q = (byRule: DataQuality["byRule"]): DataQuality => ({
    days: 7,
    byRule,
    topCodes: [],
    open: [],
    lastVersions: [],
  });
  it("拦下按规则分列，标记只数待核的", () => {
    expect(
      qualitySentence(
        q([
          { rule: "ohlc", severity: "reject", n: 2, open: 2 },
          { rule: "calendar", severity: "reject", n: 1, open: 0 },
          { rule: "limit_breach", severity: "flag", n: 9, open: 8 },
          { rule: "stale_print", severity: "flag", n: 3, open: 3 },
        ]),
      ),
    ).toBe("近 7 天拦下 3 根异常日线（价格关系不对 2、日期不是交易日 1），标记 11 处待核");
    expect(qualitySentence(q([{ rule: "adj_jump", severity: "flag", n: 1, open: 1 }]))).toBe(
      "近 7 天没有拦下异常日线，标记 1 处待核",
    );
    expect(qualitySentence(q([]))).toBe("近 7 天没有发现数据问题");
  });
});

describe("provenanceText（S13）", () => {
  it("东方财富、腾讯（日 K 与报价合并）占比；来源未记录只在有时写；缺失天数", () => {
    const base = { gapDays: 0, gapCodes: 0, issues: { reject: 0, flag: 0 }, accepted: [] };
    expect(
      provenanceText({
        ...base,
        bySource: { em: 971, tx: 9, txq: 20 },
        total: 1000,
        unknownRows: 0,
      }),
    ).toBe("行情来源：东方财富 97.1%、腾讯 2.9%；缺失 0 天");
    expect(
      provenanceText({
        ...base,
        bySource: { em: 500, unknown: 500 },
        total: 1000,
        unknownRows: 500,
        gapDays: 3,
      }),
    ).toBe("行情来源：东方财富 50%（来源未记录 50%）；缺失 3 天");
  });
});

describe("两融与筹码数据（S15）", () => {
  const d = (o: Partial<EventDatasetStatus> = {}): EventDatasetStatus => ({
    label: "两融明细",
    backfillFrom: "2013-01-01",
    coveredFrom: null,
    windowThrough: null,
    syncedAt: null,
    nightlySince: null,
    lastOkAt: null,
    lastStatus: null,
    lastDetail: null,
    canary: null,
    rows: 0,
    failingNights: 0,
    ...o,
  });

  it("每个数据集一行：覆盖起点（没补完写「补齐中」）与数据日", () => {
    expect(eventDatasetLine(d({ coveredFrom: "2013-01-04", windowThrough: "2026-09-29" }))).toBe(
      "两融明细：自 2013-01-04 · 数据到 2026-09-29",
    );
    expect(eventDatasetLine(d({ label: "限售解禁", syncedAt: "2026-10-09" }))).toBe(
      "限售解禁：自 补齐中 · 数据到 2026-10-09",
    );
    expect(eventDatasetLine(d())).toBe("两融明细：自 补齐中 · 数据到 --");
  });

  it("接口徽标：健康 / 字段变了 / 单位异常 / 被风控 / 出错", () => {
    const c = (status: string) => ({
      status,
      source: "eastmoney",
      at: "2026-10-09T09:30:00Z",
      detail: "x",
    });
    expect(canaryBadge(null)).toBeNull();
    expect(canaryBadge(c("ok"))).toEqual({ text: "健康", tone: "down" });
    expect(canaryBadge(c("empty"))).toEqual({ text: "健康", tone: "down" });
    expect(canaryBadge(c("schema_drift"))).toEqual({ text: "字段变了", tone: "warn" });
    expect(canaryBadge(c("unit_drift"))).toEqual({ text: "单位异常", tone: "warn" });
    expect(canaryBadge(c("blocked"))).toEqual({ text: "被风控", tone: "warn" });
    expect(canaryBadge(c("error"))).toEqual({ text: "出错", tone: "warn" });
  });

  it("ⓘ 写自检详情与时间；没更新时写原因", () => {
    const text = canaryInfoText(
      d({
        canary: {
          status: "schema_drift",
          source: "eastmoney",
          at: "2026-10-09T09:30:00Z",
          detail: "字段不存在",
        },
        lastStatus: "canary_failed",
        lastDetail: "东财「两融明细」接口字段变了：字段不存在，今晚没更新",
      }),
    );
    expect(text).toMatch(/^接口自检（.+）：字段不存在。最近一次：东财「两融明细」接口字段变了/);
    expect(canaryInfoText(d())).toBe("还没有跑过接口自检");
  });

  it("后台补齐进度：只在排队或运行时显示", () => {
    const b = {
      status: "running",
      notBefore: null,
      progress: { margin: { done: 812, total: 3330 }, lockups: { done: 15, total: 15 } },
      lastBatch: null,
    };
    expect(eventsBackfillText(b)).toBe("后台补齐中：两融 812 / 3,330 天 · 解禁 15 / 15 年");
    expect(eventsBackfillText({ ...b, status: "idle" })).toBeNull();
    expect(eventsBackfillText(undefined)).toBeNull();
  });
});

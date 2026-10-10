/**
 * 管理页数据卡的显示规则（纯函数，单测覆盖）：上一个数据版本的状态徽标、正在更新的版本、
 * 点时数据的采集情况、最近一晚的取数来源（D60、D61、D72）；自动重跑横幅、辅助数据连续失败、
 * 数据质量一句话、运行的行情来源（D73、D74）。
 */
import {
  addDays,
  BAR_SOURCE_TEXT,
  CANARY_STATUS_TEXT,
  type CanaryStatus,
  type DateStr,
  ISSUE_RULE_TEXT,
  nowHmCN,
  PIT_DATASET_IDS,
  pitProgressText,
  type RunProvenance,
  SOFT_FAILING_ALERT,
  SOFT_STEP_LABEL,
} from "@ivan/core";
import { dateTime, MARKET_TEXT } from "./format.ts";
import type {
  DataCapture,
  DataQuality,
  DataSources,
  DataStatus,
  EventDatasetStatus,
  EventsStatus,
} from "./types.ts";

/** 上一个结束的数据版本：完整 / 不完整 / 失败 / 休市 */
export function versionStatusBadge(
  status: string | null | undefined,
): { text: string; tone: "neutral" | "warn" } | null {
  switch (status) {
    case "ok":
      return { text: "完整", tone: "neutral" };
    case "incomplete":
      return { text: "不完整", tone: "warn" };
    case "failed":
      return { text: "失败", tone: "warn" };
    case "skipped":
      return { text: "休市", tone: "neutral" };
    default:
      return null;
  }
}

/** 「正在更新（版本 #12，10/20 17:30 开始）」 */
export function openVersionText(v: { id: number; startedAt: number | null }): string {
  return v.startedAt
    ? `正在更新（版本 #${v.id}，${dateTime(v.startedAt)} 开始）`
    : `正在更新（版本 #${v.id}）`;
}

/** 属性在管理页上的叫法 */
const CAPTURE_NAME: Record<string, string> = {
  industry_l1: "一级行业快照",
  industry: "行业快照",
  lot_size: "每手股数快照",
  hk_connect_sz: "深港通名单",
};

export interface CaptureLine {
  text: string;
  tone: "neutral" | "warn";
}

/**
 * 采集情况的几行字：各属性自哪天起记录、近 7 天变化；近 7 天里被跳过的整批变化显示成 warn；
 * 最后一行是财报首见留底。today 用来判断「近 7 天」。
 */
export function captureLines(capture: DataCapture, today: DateStr): CaptureLine[] {
  const out: CaptureLine[] = [];
  const recent = addDays(today, -7);
  for (const a of capture.attrs) {
    const name = CAPTURE_NAME[a.attr] ?? a.attr;
    out.push({
      text: a.firstDate
        ? `${name}自 ${a.firstDate} 起 · 近 7 天变化 ${a.changes7d}`
        : `${name}还没有开始记录`,
      tone: "neutral",
    });
    if (a.lastSkipped && a.lastSkipped.date >= recent) {
      out.push({
        text: `${name}在 ${a.lastSkipped.date} 一天变了 ${Math.round(a.lastSkipped.pct * 100)}%，可能是数据源改了名，先没有记录，请核对`,
        tone: "warn",
      });
    }
  }
  out.push({
    text: `财报首见留底 ${capture.financialsSeen.rows} 条，近 7 天新增 ${capture.financialsSeen.new7d}`,
    tone: "neutral",
  });
  return out;
}

/**
 * 最近一晚的取数来源：「今晚东财 120 只、腾讯 5230 只（回退 3 次）」；不是今天的写上日期。
 * 腾讯 = 腾讯日 K + 批量报价，批量报价另起一行细注；整条链都没拿到的只数单列成 warn。
 */
export function sourcesLines(s: DataSources | null | undefined, today: DateStr): CaptureLine[] {
  if (!s) return [];
  const em = s.served.em ?? 0;
  const txq = s.served.txq ?? 0;
  const tx = (s.served.tx ?? 0) + txq;
  const when = s.date === today || !s.date ? "今晚" : `${s.date} 那晚`;
  const out: CaptureLine[] = [
    { text: `${when}东财 ${em} 只、腾讯 ${tx} 只（回退 ${s.fallbacks} 次）`, tone: "neutral" },
  ];
  if (txq) out.push({ text: `腾讯里 ${txq} 只来自批量报价`, tone: "neutral" });
  if (s.failed) out.push({ text: `${s.failed} 只日线所有数据源都没拿到`, tone: "warn" });
  return out;
}

type MarketStatus = DataStatus["markets"][number];

/**
 * 排着队等自动重跑（D73）时的横幅：「A 股今天的数据没更新完整：…。18:15 自动重试（第 1/2 次）」；
 * 不在等重跑时为 null。
 */
export function retryBannerText(m: MarketStatus): string | null {
  const e = m.lastEtl;
  if (!e || e.status !== "queued" || !e.retryAt) return null;
  const reason = (e.error ?? "").replace(/[。.]$/, "");
  return (
    `${MARKET_TEXT[m.market] ?? m.market}今天的数据没更新完整${reason ? `：${reason}` : ""}。` +
    `${nowHmCN(new Date(e.retryAt))} 自动重试（第 ${e.attempt ?? 1}/2 次）`
  );
}

/** 辅助数据连续失败（≥ 3 晚）的提示：「A 股「财报与股本」已经连续 3 晚没更新成功，沿用的是旧数据」 */
export function softAlerts(m: MarketStatus): string[] {
  return (m.soft ?? [])
    .filter((s) => s.failingNights >= SOFT_FAILING_ALERT)
    .map(
      (s) =>
        `${MARKET_TEXT[m.market] ?? m.market}「${SOFT_STEP_LABEL[s.step as keyof typeof SOFT_STEP_LABEL] ?? s.step}」已经连续 ${s.failingNights} 晚没更新成功，沿用的是旧数据`,
    );
}

export const issueRuleText = (rule: string) => ISSUE_RULE_TEXT[rule] ?? rule;

/**
 * 数据质量一句话：「近 7 天拦下 3 根异常日线（价格关系不对 2、日期不是交易日 1），标记 11 处待核」。
 * 拦下 = 近 N 天被拒收的；待核 = 近 N 天标记里还没解决的。
 */
export function qualitySentence(q: DataQuality): string {
  const rejects = q.byRule.filter((r) => r.severity === "reject");
  const nReject = rejects.reduce((a, r) => a + r.n, 0);
  const nFlag = q.byRule.filter((r) => r.severity !== "reject").reduce((a, r) => a + r.open, 0);
  if (!nReject && !nFlag) return `近 ${q.days} 天没有发现数据问题`;
  const parts = [
    nReject
      ? `拦下 ${nReject} 根异常日线（${rejects.map((r) => `${issueRuleText(r.rule)} ${r.n}`).join("、")}）`
      : "没有拦下异常日线",
  ];
  if (nFlag) parts.push(`标记 ${nFlag} 处待核`);
  return `近 ${q.days} 天${parts.join("，")}`;
}

const pctText = (x: number) => `${(x * 100).toFixed(1).replace(/\.0$/, "")}%`;

/**
 * 运行的行情来源（复现信息 ⓘ）：「行情来源：东方财富 97.1%、腾讯 2.9%（来源未记录 0.3%）；缺失 0 天」。
 * 腾讯日 K 与腾讯报价合并；来源未记录的只在有时写。
 */
export function provenanceText(p: RunProvenance): string {
  return `行情来源：${provenanceValue(p)}`;
}

/** 同上，不带「行情来源：」（复现信息里作为一行的值） */
export function provenanceValue(p: RunProvenance): string {
  if (!p.total) return `没有读到日线；缺失 ${p.gapDays} 天`;
  const rows = new Map<string, number>();
  for (const [src, n] of Object.entries(p.bySource)) {
    if (src === "unknown") continue;
    const name = BAR_SOURCE_TEXT[src] ?? src;
    rows.set(name, (rows.get(name) ?? 0) + n);
  }
  const known = [...rows].map(([name, n]) => `${name} ${pctText(n / p.total)}`).join("、");
  const unknown = p.unknownRows ? `来源未记录 ${pctText(p.unknownRows / p.total)}` : "";
  const head = known ? (unknown ? `${known}（${unknown}）` : known) : unknown;
  return `${head}；缺失 ${p.gapDays} 天`;
}

// ── 两融与筹码数据（S15，D81、D82） ──

/** 「接口」徽标：健康 / 字段变了 / 单位异常 / 被风控 / 出错；还没跑过金丝雀为 null */
export function canaryBadge(
  c: EventDatasetStatus["canary"],
): { text: string; tone: "down" | "warn" } | null {
  if (!c) return null;
  const text = CANARY_STATUS_TEXT[c.status as CanaryStatus] ?? c.status;
  return { text, tone: c.status === "ok" || c.status === "empty" ? "down" : "warn" };
}

/** 一个数据集一行：「两融明细：自 2013-01-04 · 数据到 2026-09-29」（回填没完成写「补齐中」，空值写 --） */
export function eventDatasetLine(d: EventDatasetStatus): string {
  return `${d.label}：自 ${d.coveredFrom ?? "补齐中"} · 数据到 ${d.windowThrough ?? d.syncedAt ?? "--"}`;
}

/** 金丝雀 ⓘ 的说明：详情 + 时间；最近一次没更新时再写原因 */
export function canaryInfoText(d: EventDatasetStatus): string {
  const parts: string[] = [];
  if (d.canary) parts.push(`接口自检（${dateTime(Date.parse(d.canary.at))}）：${d.canary.detail}`);
  else parts.push("还没有跑过接口自检");
  if (d.lastStatus && d.lastStatus !== "ok" && d.lastDetail)
    parts.push(`最近一次：${d.lastDetail}`);
  return parts.join("。");
}

/** 后台回填进行中：「后台补齐中：两融 812 / 3,330 天 · 户数 120 / 166 月」；没有在跑或排队时为 null */
export function eventsBackfillText(b: EventsStatus["backfill"] | undefined): string | null {
  if (!b || (b.status !== "queued" && b.status !== "running")) return null;
  const progress = Object.fromEntries(
    PIT_DATASET_IDS.flatMap((id) => (b.progress[id] ? [[id, b.progress[id]!]] : [])),
  );
  const text = pitProgressText(progress);
  const wait =
    b.status === "queued" && b.notBefore && b.notBefore > Date.now()
      ? `，北京时间 ${nowHmCN(new Date(b.notBefore))} 接着补`
      : "";
  return `后台补齐中${text ? `：${text}` : ""}${wait}`;
}

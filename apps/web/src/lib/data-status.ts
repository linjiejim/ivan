/**
 * 管理页数据卡的显示规则（纯函数，单测覆盖）：上一个数据版本的状态徽标、正在更新的版本、
 * 点时数据的采集情况（D60、D61）。
 */
import { addDays, type DateStr } from "@ivan/core";
import { dateTime } from "./format.ts";
import type { DataCapture } from "./types.ts";

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

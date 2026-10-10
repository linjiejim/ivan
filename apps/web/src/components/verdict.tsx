/**
 * 跟踪判词（D70）：徽标 + ⓘ。看板的跟踪列表、跟踪页抬头、对话里的跟踪卡用同一套。
 * 判词由引擎确定性算出；徽标始终有字，「可能失效」另配实心警示图标。
 */
import type { TrackingHealth, Verdict } from "@ivan/core";
import {
  HEALTH_HONESTY,
  VERDICT_TEXT,
  VERDICT_TONE,
  verdictInfoRows,
  verdictNote,
} from "../lib/format.ts";
import { IconWarn } from "./icons.tsx";
import { Badge, Info, InfoRows } from "./ui.tsx";

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return (
    <Badge
      tone={VERDICT_TONE[verdict]}
      icon={verdict === "DECAYED" ? IconWarn : undefined}
      iconWeight="fill"
    >
      {VERDICT_TEXT[verdict]}
    </Badge>
  );
}

/** 判词的 ⓘ：一句说明、各指标的值与阈值、诚实说明（健康度是提醒，不是检验） */
export function VerdictInfo({
  verdict,
  health,
  lastError,
  lastDate,
}: {
  verdict: Verdict;
  health: Pick<TrackingHealth, "state" | "signal" | "perMetric"> | null | undefined;
  lastError?: { date: string; message: string } | null;
  lastDate?: string | null;
}) {
  const rows = verdictInfoRows(health);
  return (
    <Info label="判词：说明" width={300}>
      <p>{verdictNote(verdict, lastDate)}</p>
      {verdict === "SETTLE_FAILED" && lastError && (
        <p className="mt-1 text-warn">
          {lastError.date}：{lastError.message}
        </p>
      )}
      {rows.length > 0 && (
        <div className="mt-1.5 border-t border-line pt-1.5">
          <InfoRows rows={rows} />
        </div>
      )}
      <p className="mt-1.5 border-t border-line pt-1.5 text-muted">{HEALTH_HONESTY}。</p>
    </Info>
  );
}

/** 徽标 + ⓘ 并排 */
export function TrackingVerdict({
  verdict,
  health,
  lastError,
  lastDate,
}: {
  verdict: Verdict;
  health: Pick<TrackingHealth, "state" | "signal" | "perMetric"> | null | undefined;
  lastError?: { date: string; message: string } | null;
  lastDate?: string | null;
}) {
  return (
    <span className="inline-flex items-center gap-0.5">
      <VerdictBadge verdict={verdict} />
      <VerdictInfo verdict={verdict} health={health} lastError={lastError} lastDate={lastDate} />
    </span>
  );
}

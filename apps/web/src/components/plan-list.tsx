/**
 * 明日计划（D68）：每项「买 / 卖 + 名称 + 原因文字」，ⓘ 里是排名、得分、因子分位、没满足的条件与估算；
 * 「证据」按钮按快照的决策日取数。跟踪页与对话里的计划卡共用。
 */
import type { FactorDef } from "@ivan/core";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import { NA, num, pct, pctile, planDateNote } from "../lib/format.ts";
import type { PlanItem, PlanSnapshot } from "../lib/types.ts";
import { EvidenceButton } from "./evidence-modal.tsx";
import { Badge, Info, InfoRows } from "./ui.tsx";

function useFactorLabels(market: string) {
  const q = useQuery({
    queryKey: ["factors", market],
    queryFn: () => api.get<{ factors: FactorDef[] }>(`/api/factors?market=${market}`),
    staleTime: Infinity,
  });
  return (k: string) => q.data?.factors.find((f) => f.key === k.split("#")[0])?.label ?? k;
}

function ItemInfo({ it, label }: { it: PlanItem; label: (k: string) => string }) {
  const rows: Array<[string, string]> = [
    ["排名", it.rank === null ? NA : `第 ${it.rank}`],
    ["得分", it.score === null ? NA : it.score.toFixed(2)],
  ];
  for (const [k, p] of Object.entries(it.termPct ?? {})) rows.push([label(k), pctile(p)]);
  if (it.failedConditions?.length) {
    rows.push([
      "没满足的条件",
      it.failedConditions.map((c) => c.replace(/^没满足：/, "")).join("、"),
    ]);
  }
  rows.push(["估算仓位", pct(it.estWeight, 1, false)]);
  if (it.side === "sell") rows.push(["当前仓位", pct(it.curWeight, 1, false)]);
  rows.push(["估算股数", it.estShares === null ? NA : num(it.estShares, 0)]);
  rows.push(["参考收盘", it.refClose === null ? NA : it.refClose.toFixed(2)]);
  return (
    <Info label="计划依据" width={300}>
      <InfoRows rows={rows} />
      <p className="mt-1.5 text-muted">估算按决策日收盘价和同一套成交规则算，不是真实成交。</p>
    </Info>
  );
}

/** 计划日与依据、数据截至日、版次 */
export function PlanMeta({ plan }: { plan: PlanSnapshot }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span>
        <span className="font-mono">{plan.planDate}</span> 开盘{planDateNote(plan.planDateBasis)}
      </span>
      {plan.dataAsOf && (
        <span>
          · 数据截至 <span className="font-mono">{plan.dataAsOf}</span>
        </span>
      )}
      {plan.edition > 1 && (
        <>
          <Badge tone="warn">已修订</Badge>
          <Info label="为什么修订">
            {`这是决策日 ${plan.decisionDate} 的第 ${plan.edition} 版计划，原因：${plan.causeText}。`}
            第 1 版是当晚看到的，原样保留。
          </Info>
        </>
      )}
    </span>
  );
}

export function PlanItems({
  plan,
  trackingId,
  market,
}: {
  plan: PlanSnapshot;
  trackingId: string;
  market: string;
}) {
  const label = useFactorLabels(market);
  return (
    <ul>
      {plan.items.map((it) => (
        <li
          key={it.seq}
          className="flex items-center gap-2 border-b border-line py-1.5 text-xs last:border-0"
        >
          <Badge tone={it.side === "buy" ? "up" : "down"}>{it.side === "buy" ? "买" : "卖"}</Badge>
          <span className="min-w-0 truncate text-ink">{it.name ?? it.code}</span>
          <span className="min-w-0 flex-1 truncate text-muted">{it.reasonText}</span>
          <ItemInfo it={it} label={label} />
          <EvidenceButton code={it.code} decisionDate={plan.decisionDate} trackingId={trackingId} />
        </li>
      ))}
    </ul>
  );
}

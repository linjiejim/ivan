/**
 * 个股证据（D67）：决策日当时可得的数据，每行带来源与数据日，底部是数据版本与校验值。
 * 对话里的「个股证据」卡与回测页、跟踪页的「证据」弹窗渲染同一个 EvidenceBody。
 */
import type { FactorDef } from "@ivan/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api.ts";
import { fmtFactor, NA } from "../lib/format.ts";
import type { EvidenceItem, SecurityEvidence } from "../lib/types.ts";
import { IconEvidence } from "./icons.tsx";
import { Callout, cx, ErrorNote, IconButton, Modal, Skeleton, Tag } from "./ui.tsx";

/** 行级来源（D60）→ 来源 Tag；空 = 来源未记录 */
const SOURCE_TAG: Record<string, string> = {
  em: "东方财富",
  tx: "腾讯",
  txq: "腾讯",
  csi: "中证",
  szse: "深交所",
  prov: "临时补齐",
};

const GROUPS: Array<[string, Array<EvidenceItem["group"]>]> = [
  ["估值与价格", ["valuation", "price"]],
  ["质量与成长", ["quality"]],
  ["财报", ["financial"]],
  ["数据状态", ["status"]],
];

const BAND_TEXT = {
  top: (top: number) => `在前 ${top} 名，会买入`,
  buffer: (_: number, hold: number) => `在前 ${hold} 名的缓冲区内，已持有就继续拿`,
  out: (_: number, hold: number) => `在前 ${hold} 名之外，不会买入，持有的会卖出`,
} as const;

function valueText(it: EvidenceItem): string {
  const v = it.value;
  if (typeof v === "number") {
    if (it.unit === "天" || it.unit === "条") return `${v} ${it.unit}`;
    if (it.unit === "元" || it.unit === "港元") return `${v.toFixed(2)} ${it.unit}`;
    if (it.key === "adj") return v.toFixed(4);
  }
  return fmtFactor(v, it.unit);
}

function ItemRow({ it }: { it: EvidenceItem }) {
  return (
    <li className="border-b border-line py-1.5 last:border-0">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-ink-2">{it.label}</span>
        <span className="tabular shrink-0 font-medium text-ink">{valueText(it)}</span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs text-muted">
        <Tag className="h-4 px-1 text-[10px]">
          {it.ref.src ? (SOURCE_TAG[it.ref.src] ?? it.ref.src) : "来源未记录"}
        </Tag>
        <span className="font-mono">数据日 {it.availDate}</span>
        {it.note && <span className={cx(it.note.includes("更正") && "text-warn")}>{it.note}</span>}
      </div>
    </li>
  );
}

/** 各排序项的分位：细条 + 数字（越好越接近 100） */
function TermBars({ termPct, market }: { termPct: Record<string, number>; market: string }) {
  const factors = useQuery({
    queryKey: ["factors", market],
    queryFn: () => api.get<{ factors: FactorDef[] }>(`/api/factors?market=${market}`),
  });
  const label = (k: string) =>
    factors.data?.factors.find((f) => f.key === k.split("#")[0])?.label ?? k;
  return (
    <ul className="mt-2 space-y-1">
      {Object.entries(termPct).map(([k, p]) => (
        <li key={k} className="flex items-center gap-2 text-2xs">
          <span className="w-24 shrink-0 truncate text-muted">{label(k)}</span>
          <span className="h-1 flex-1 overflow-hidden rounded-full bg-surface-2">
            <span
              className="block h-full rounded-full bg-accent"
              style={{ width: `${Math.max(Math.round(p * 100), 2)}%` }}
            />
          </span>
          <span className="tabular w-12 shrink-0 text-right text-ink-2">
            {Math.round(p * 100)} 分位
          </span>
        </li>
      ))}
    </ul>
  );
}

export function EvidenceBody({ e }: { e: SecurityEvidence }) {
  const d = e.dossier;
  const s = e.strategy;
  // 跟踪那晚有计划快照时（D68）：先给第 1 版计划里的记录，下面的证据是补充
  const p = e.planRecord ?? null;
  return (
    <div className="space-y-3 text-xs">
      <p className="text-ink">
        <span className="font-medium">{d.name ?? d.code}</span>
        <span className="ml-1.5 font-mono text-[11px] text-muted">{d.code}</span>
        <span className="text-muted"> · 决策日 </span>
        <span className="font-mono">{e.decision.decisionDate}</span>
        {e.decision.tradeDate && (
          <span className="text-muted">
            （次日 <span className="font-mono">{e.decision.tradeDate}</span> 开盘成交）
          </span>
        )}
      </p>
      {e.caveats.length > 0 && (
        <Callout
          tone={e.caveats.some((c) => c.level === "warn") ? "warn" : "info"}
          className="text-xs leading-5"
        >
          <ul className="space-y-0.5">
            {e.caveats.map((c) => (
              <li key={c.id}>{c.title}</li>
            ))}
          </ul>
        </Callout>
      )}
      {p && (
        <div className="rounded-lg bg-surface-2/60 px-3 py-2.5">
          <p className="text-ink">
            {p.inPlan ? (
              <>
                那晚的计划：
                <span className={cx("font-medium", p.side === "buy" ? "text-up" : "text-down")}>
                  {p.side === "buy" ? "买入" : "卖出"}
                </span>
                ，{p.reasonText}
              </>
            ) : (
              <>那晚的计划：{p.reasonText}</>
            )}
            {p.rank !== null && p.inPlan && p.reasonDetail !== "ranked_out" && (
              <span className="text-muted">，排第 {p.rank}</span>
            )}
          </p>
          <p className="mt-0.5 text-2xs text-muted">
            第 {p.edition} 版计划（当晚看到的）· 决策日{" "}
            <span className="font-mono">{p.decisionDate}</span>
            {p.dataAsOf && (
              <>
                {" "}
                · 数据截至 <span className="font-mono">{p.dataAsOf}</span>
              </>
            )}
            {p.estWeight !== null && <> · 估算仓位 {(p.estWeight * 100).toFixed(1)}%</>}
          </p>
          {p.termPct && <TermBars termPct={p.termPct} market={d.market} />}
        </div>
      )}
      {s && (
        <div className="rounded-lg bg-surface-2/60 px-3 py-2.5">
          {s.passed && s.rank !== null ? (
            <p className="text-ink">
              在「{s.name}」里排第 <span className="tabular font-medium">{s.rank}</span>
              （得分 <span className="tabular">{s.score === null ? NA : s.score.toFixed(2)}</span>）
              {s.band && <span className="text-muted">，{BAND_TEXT[s.band](s.top, s.hold)}</span>}
            </p>
          ) : (
            <p className="text-ink">
              没进「{s.name}」的股票池：{s.failed.length ? s.failed.join("；") : NA}
            </p>
          )}
          {s.regime && (
            <p className="mt-0.5 text-2xs text-muted">
              这天大盘
              {s.regime === "weak" ? "在均线下方，用弱势时的排序" : "在均线上方，用平时的排序"}
            </p>
          )}
          {s.termPct && <TermBars termPct={s.termPct} market={d.market} />}
        </div>
      )}
      {GROUPS.map(([title, groups]) => {
        const items = d.items.filter((i) => groups.includes(i.group));
        if (!items.length) return null;
        return (
          <section key={title}>
            <h4 className="mb-0.5 text-2xs font-medium text-muted">{title}</h4>
            <ul>
              {items.map((it) => (
                <ItemRow key={it.key} it={it} />
              ))}
            </ul>
          </section>
        );
      })}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-line pt-2 text-2xs text-muted">
        <span className="font-mono">
          数据版本 #{d.dataVersion.id ?? NA} · 校验 {d.hash.slice(0, 8)}
        </span>
        <span className="ml-auto">仅供研究，不构成投资建议</span>
      </div>
    </div>
  );
}

export interface EvidenceTarget {
  code: string;
  /** 决策日（计划快照的决策日）；和成交日只给一个 */
  decisionDate?: string;
  /** 成交日（成交记录上的日期）；决策日取它的前一个交易日 */
  tradeDate?: string;
  runId?: string;
  trackingId?: string;
}

/** 弹窗：每次打开读一次（计入数据查询额度），同一只同一天在本页内不重复读 */
export function EvidenceModal({
  open,
  onClose,
  target,
}: {
  open: boolean;
  onClose: () => void;
  target: EvidenceTarget;
}) {
  const params = new URLSearchParams();
  if (target.decisionDate) params.set("decisionDate", target.decisionDate);
  if (target.tradeDate) params.set("tradeDate", target.tradeDate);
  if (target.runId) params.set("runId", target.runId);
  if (target.trackingId) params.set("trackingId", target.trackingId);
  const q = useQuery({
    queryKey: ["evidence", target.code, params.toString()],
    queryFn: () =>
      api.get<SecurityEvidence>(
        `/api/securities/${encodeURIComponent(target.code)}/evidence?${params}`,
      ),
    enabled: open,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return (
    <Modal open={open} onClose={onClose} title="个股证据" icon={IconEvidence}>
      {q.data ? (
        <EvidenceBody e={q.data} />
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : (
        <div className="space-y-2.5 py-1">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      )}
    </Modal>
  );
}

/** 表格行里的「证据」按钮：点开弹窗 */
export function EvidenceButton(target: EvidenceTarget) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton icon={IconEvidence} label="证据" size="sm" onClick={() => setOpen(true)} />
      <EvidenceModal open={open} onClose={() => setOpen(false)} target={target} />
    </>
  );
}

/**
 * 跟踪页「回溯」分页（D71）：时间线、那天看到的计划（第 1 版对最新版、按现在的数据重放、后来怎么样）、链校验、导出。
 * 只有主人能看（接口按归属 404）。
 */
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PlanItems } from "../components/plan-list.tsx";
import { PlanDiffView } from "../components/plan-diff-view.tsx";
import { IconChain, IconDownload, IconPlan, IconTrace } from "../components/icons.tsx";
import {
  Badge,
  Button,
  Callout,
  Card,
  ErrorNote,
  Info,
  Input,
  ListSkeleton,
  type Tone,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import {
  LEDGER_BREAK_TEXT,
  ledgerKindText,
  outcomeText,
  planDateNote,
  replayLine,
} from "../lib/format.ts";
import type { LedgerEntry, LedgerPage, LedgerVerify, PlanOn } from "../lib/types.ts";

const LEDGER_HONESTY =
  "账本只能追加，每条记录都带着上一条的指纹；在你自己部署的实例上，这能证明记录内部一致、改动能被发现，但不等于第三方不可抵赖。管理员可用 pnpm admin verify-bundle 校验，任何人也可按文件里的说明重算。";

/** 修订与重放差异用 warn（和明日计划的「已修订」一致），上线与状态变化用花青，其余中性 */
function kindTone(e: LedgerEntry): Tone {
  if (e.kind === "replay_drift" || (e.kind === "plan" && (e.edition ?? 1) > 1)) return "warn";
  if (e.kind === "tracking_start" || e.kind === "health_transition") return "accent";
  return "neutral";
}

export function TracePanel({
  trackingId,
  market,
  latestDecisionDate,
}: {
  trackingId: string;
  market: string;
  latestDecisionDate: string | null;
}) {
  return (
    <div className="space-y-5">
      <Toolbar trackingId={trackingId} />
      <PlanOnCard trackingId={trackingId} market={market} latestDecisionDate={latestDecisionDate} />
      <Timeline trackingId={trackingId} />
    </div>
  );
}

function Toolbar({ trackingId }: { trackingId: string }) {
  const verify = useMutation({ mutationFn: () => api.post<LedgerVerify>("/api/ledger/verify") });
  const v = verify.data;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          icon={IconChain}
          loading={verify.isPending}
          onClick={() => verify.mutate()}
        >
          校验
        </Button>
        <Button
          variant="ghost"
          icon={IconDownload}
          // 服务端用 Content-Disposition: attachment 返回，浏览器直接下载、不离开页面
          onClick={() => window.location.assign(`/api/trackings/${trackingId}/export`)}
        >
          导出（JSON）
        </Button>
        {v?.ok && (
          <Badge tone="down">
            已校验 · 共 <span className="tabular">{v.checked}</span> 条
          </Badge>
        )}
        <Info label="账本说明" width={320}>
          {LEDGER_HONESTY}
        </Info>
      </div>
      {v && !v.ok && v.firstBreak && (
        <Callout tone="warn" title="账本校验没通过">
          第 <span className="tabular">{v.firstBreak.seq}</span> 条：
          {LEDGER_BREAK_TEXT[v.firstBreak.reason as keyof typeof LEDGER_BREAK_TEXT] ??
            v.firstBreak.reason}
          。这条之前的 <span className="tabular">{v.checked}</span> 条是一致的。
        </Callout>
      )}
      <ErrorNote error={verify.error} />
    </div>
  );
}

function PlanOnCard({
  trackingId,
  market,
  latestDecisionDate,
}: {
  trackingId: string;
  market: string;
  latestDecisionDate: string | null;
}) {
  const [date, setDate] = useState(latestDecisionDate ?? "");
  const q = useQuery({
    queryKey: ["plan-on", trackingId, date],
    queryFn: () =>
      api.get<PlanOn | null>(
        `/api/trackings/${trackingId}/plan-on${date ? `?date=${encodeURIComponent(date)}` : ""}`,
      ),
  });
  const p = q.data;
  return (
    <Card
      title="那天看到的计划"
      icon={IconPlan}
      info="左边是那晚第 1 版计划（当晚看到的，永不改写），右边是同一晚的最新一版。之后的数据修订大多不加新版次，它们改写的是重放，所以每一项都对照按现在的数据重放的执行结果。"
      action={
        <label className="flex items-center gap-2 text-xs text-muted">
          决策日
          <Input
            type="date"
            value={date}
            max={latestDecisionDate ?? undefined}
            onChange={(e) => setDate(e.target.value)}
            className="h-8 w-40 font-mono text-xs"
          />
        </label>
      }
    >
      {q.isLoading ? (
        <ListSkeleton rows={3} />
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : !p ? (
        <p className="text-sm text-muted">这天和之前都没有计划记录。</p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <span>
              决策日 <span className="font-mono">{p.decisionDate}</span>，计划{" "}
              <span className="font-mono">{p.planDate}</span> 开盘
              {planDateNote(p.edition1.planDateBasis)}
            </span>
            {p.revisedAfter && (
              <>
                <Badge tone="warn">这晚之后数据修订过</Badge>
                <Info label="数据修订">
                  这晚之后某次结算发现数据被修订过，且最早影响的日子不晚于计划日；下面「按现在的数据重放」已经是修订后的结果，
                  第 1 版仍是当晚看到的。
                </Info>
              </>
            )}
          </div>
          <div className="grid gap-5 @3xl:grid-cols-2">
            <section className="min-w-0">
              <h3 className="mb-1.5 flex items-center justify-between text-xs font-medium text-ink-2">
                <span>第 1 版（当晚看到的）</span>
                <span className="text-muted">后来怎么样</span>
              </h3>
              {p.edition1.items.length ? (
                <ul>
                  {p.edition1.items.map((it, k) => {
                    // 重放结果与回看结果都按第 1 版计划项的顺序一一对应
                    const r = p.replay?.[k] ?? null;
                    const o = p.outcomes?.[k];
                    return (
                      <li
                        key={it.seq}
                        className="border-b border-line py-1.5 text-xs last:border-0"
                      >
                        <div className="flex items-center gap-2">
                          <Badge tone={it.side === "buy" ? "up" : "down"}>
                            {it.side === "buy" ? "买" : "卖"}
                          </Badge>
                          <span className="min-w-0 truncate text-ink">{it.name ?? it.code}</span>
                          <span className="min-w-0 flex-1 truncate text-muted">
                            {it.reasonText}
                          </span>
                          <span className="tabular shrink-0 text-ink-2">{outcomeText(o)}</span>
                        </div>
                        <p className="mt-0.5 pl-8 text-2xs text-muted">{replayLine(r)}</p>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-muted">没有计划中的买卖。</p>
              )}
            </section>
            <section className="min-w-0">
              <h3 className="mb-1.5 text-xs font-medium text-ink-2">
                最新版（第 <span className="tabular">{p.latest.edition}</span> 版）
              </h3>
              {p.latest.edition === 1 ? (
                <p className="text-sm text-muted">没有修订过，最新版就是第 1 版。</p>
              ) : p.latest.items.length ? (
                <PlanItems plan={p.latest} trackingId={trackingId} market={market} />
              ) : (
                <p className="text-sm text-muted">没有计划中的买卖。</p>
              )}
            </section>
          </div>
          {p.latest.edition > 1 && (
            <section>
              <h3 className="mb-1.5 text-xs font-medium text-ink-2">
                两版的差异 <span className="font-normal text-muted">· 原因：{p.causeText}</span>
              </h3>
              <PlanDiffView diff={p.diff} />
            </section>
          )}
          <p className="text-2xs text-muted">
            「后来怎么样」用决策日之后的数据评估（买入从次日开盘起算、基准从决策日收盘起算），满 5
            个交易日才有；仅供研究，不构成投资建议。
          </p>
        </div>
      )}
    </Card>
  );
}

function Timeline({ trackingId }: { trackingId: string }) {
  const q = useInfiniteQuery({
    queryKey: ["ledger", trackingId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.get<LedgerPage>(
        `/api/trackings/${trackingId}/ledger${pageParam ? `?to=${pageParam}` : ""}`,
      ),
    getNextPageParam: (last, _all, lastParam) => {
      const oldest = last.entries.at(-1)?.asOf;
      // 同一天的条目可能跨页：下一页从最早那天再取一次，按 seq 去重；没有更早的了就停
      return last.hasMore && oldest && oldest !== lastParam ? oldest : undefined;
    },
  });
  const seen = new Set<number>();
  const entries: LedgerEntry[] = [];
  for (const page of q.data?.pages ?? []) {
    for (const e of page.entries) {
      if (seen.has(e.seq)) continue;
      seen.add(e.seq);
      entries.push(e);
    }
  }
  return (
    <Card
      title="时间线"
      icon={IconTrace}
      info="这个跟踪的计划、修订、重放差异、状态变化、上线与停止，以及跟踪期间的简报；按日期倒序，每条带账本哈希的前 8 位。"
      flush
    >
      {q.isLoading ? (
        <div className="px-4 pb-3">
          <ListSkeleton rows={4} />
        </div>
      ) : q.error ? (
        <ErrorNote error={q.error} className="mx-4 mb-3" />
      ) : entries.length ? (
        <>
          <ul>
            {entries.map((e) => (
              <li
                key={e.seq}
                className="flex items-center gap-3 border-b border-line px-4 py-2 text-xs last:border-0"
              >
                <span className="w-24 shrink-0 font-mono text-muted">{e.asOf ?? "--"}</span>
                <Badge tone={kindTone(e)} className="shrink-0">
                  {ledgerKindText(e.kind, e.edition)}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-ink-2">{e.summary}</span>
                <span
                  className="shrink-0 font-mono text-[11px] text-faint"
                  title={`第 ${e.seq} 条`}
                >
                  {e.hash8}
                </span>
              </li>
            ))}
          </ul>
          {q.hasNextPage && (
            <div className="px-4 pt-2 pb-1">
              <Button
                variant="ghost"
                size="sm"
                loading={q.isFetchingNextPage}
                onClick={() => void q.fetchNextPage()}
              >
                加载更早的
              </Button>
            </div>
          )}
        </>
      ) : (
        <p className="px-4 pb-3 text-sm text-muted">
          还没有记录：上线确认后的计划、状态变化都会记在这里。
        </p>
      )}
    </Card>
  );
}

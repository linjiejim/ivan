/**
 * 表单式策略编辑器（spec §11）：和对话改的是同一个对象。保存 = 提交草稿 → 看差异 → 确认后才生成新版本。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import type { Condition, FactorDef, Market, StrategySpec } from "@ivan/core";
import { api } from "../lib/api.ts";
import type { ProposeResult } from "../lib/types.ts";
import { DiffView } from "./diff-view.tsx";
import { Button, ErrorNote, Field, Input, Modal, Select } from "./ui.tsx";

const BOARDS: Record<Market, Array<[string, string]>> = {
  A: [
    ["main", "主板"],
    ["gem", "创业板"],
    ["star", "科创板"],
  ],
  HK: [
    ["hk_main", "港股主板"],
    ["hk_gem", "港股创业板"],
  ],
};

const BENCH: Record<Market, Array<[string, string]>> = {
  A: [
    ["csi300", "沪深300全收益"],
    ["sse", "上证指数（不含分红）"],
  ],
  HK: [
    ["hsi", "恒指（含分红）"],
    ["hscei", "国企指数（含分红）"],
  ],
};

function blank(market: Market): StrategySpec {
  return {
    schema: 1,
    name: "新策略",
    market,
    mode: "rules",
    universe: { exclude: ["st", "new_listing", "loss"], minMcap: 50 },
    filters: [{ factor: "roe_ttm", op: ">=", value: 10 }],
    rank: { terms: [{ factor: "pe_ttm", weight: 1, better: "low" }], top: 15 },
    rebalance: { every: "month", buffer: 1.5 },
    sizing: { method: "equal" },
    exits: { dropWhenFiltered: true },
  } as StrategySpec;
}

function numOrUndef(v: string): number | undefined {
  const n = Number(v);
  return v.trim() === "" || !Number.isFinite(n) ? undefined : n;
}

export function SpecEditor({
  strategyId,
  initial,
  onDone,
}: {
  strategyId?: string;
  initial?: StrategySpec;
  onDone?: () => void;
}) {
  const [spec, setSpec] = useState<StrategySpec>(() => structuredClone(initial ?? blank("A")));
  const factors = useQuery({
    queryKey: ["factors", spec.market],
    queryFn: () => api.get<{ factors: FactorDef[] }>(`/api/factors?market=${spec.market}`),
  });
  const [proposal, setProposal] = useState<Extract<ProposeResult, { ok: true }> | null>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const byKey = useMemo(
    () => new Map((factors.data?.factors ?? []).map((f) => [f.key, f])),
    [factors.data],
  );
  const numeric = (factors.data?.factors ?? []).filter((f) => f.kind === "number");

  const propose = useMutation({
    mutationFn: () => api.post<ProposeResult>("/api/drafts", { strategyId, spec }),
    onSuccess: (r) => r.ok && setProposal(r),
  });
  const confirm = useMutation({
    mutationFn: (draftId: string) =>
      api.post<{ strategyId: string; versionId: string }>(`/api/drafts/${draftId}/confirm`),
    onSuccess: async (r) => {
      setProposal(null);
      await qc.invalidateQueries({ queryKey: ["strategies"] });
      await qc.invalidateQueries({ queryKey: ["strategy", r.strategyId] });
      onDone?.();
      navigate(`/strategies/${r.strategyId}`);
    },
  });

  const up = (fn: (s: StrategySpec) => void) =>
    setSpec((s) => {
      const n = structuredClone(s);
      fn(n);
      return n;
    });

  const factorOptions = (list: FactorDef[]) => {
    const groups = new Map<string, FactorDef[]>();
    for (const f of list) groups.set(f.group, [...(groups.get(f.group) ?? []), f]);
    const label: Record<string, string> = {
      valuation: "估值",
      quality: "质量",
      growth: "成长",
      size: "规模",
      technical: "技术",
      category: "分类",
      flag: "标记",
    };
    return [...groups.entries()].map(([g, fs]) => (
      <optgroup key={g} label={label[g] ?? g}>
        {fs.map((f) => (
          <option key={f.key} value={f.key}>
            {f.label}
            {f.unit ? `（${f.unit}）` : ""}
          </option>
        ))}
      </optgroup>
    ));
  };

  const condRow = (c: Condition, i: number) => {
    const f = byKey.get(c.factor);
    const setCond = (next: Condition) => up((s) => void (s.filters[i] = next));
    return (
      <div key={i} className="flex flex-wrap items-center gap-2">
        <Select
          value={c.factor}
          onChange={(e) => {
            const nf = byKey.get(e.target.value);
            if (!nf) return;
            if (nf.kind === "bool") setCond({ factor: nf.key, op: "not" });
            else if (nf.kind === "category") setCond({ factor: nf.key, op: "in", value: [""] });
            else setCond({ factor: nf.key, op: ">=", value: 0 });
          }}
          className="w-48"
        >
          {factorOptions(factors.data?.factors ?? [])}
        </Select>
        {f?.kind === "bool" && (
          <Select
            value={c.op}
            onChange={(e) => setCond({ factor: c.factor, op: e.target.value as "is" | "not" })}
          >
            <option value="is">是</option>
            <option value="not">不是</option>
          </Select>
        )}
        {f?.kind === "category" && "value" in c && Array.isArray(c.value) && c.op !== "between" && (
          <>
            <Select
              value={c.op}
              onChange={(e) =>
                setCond({
                  factor: c.factor,
                  op: e.target.value as "in" | "not_in",
                  value: c.value as string[],
                })
              }
            >
              <option value="in">属于</option>
              <option value="not_in">不属于</option>
            </Select>
            <Input
              className="w-56"
              placeholder="用顿号或逗号分隔，如 银行、保险"
              value={(c.value as string[]).join("、")}
              onChange={(e) =>
                setCond({
                  factor: c.factor,
                  op: c.op as "in" | "not_in",
                  value: e.target.value.split(/[、,，]/).map((x) => x.trim()),
                })
              }
            />
          </>
        )}
        {f?.kind === "number" && (
          <>
            <Select
              value={c.op}
              onChange={(e) => {
                const op = e.target.value;
                if (op === "between") setCond({ factor: c.factor, op: "between", value: [0, 10] });
                else {
                  const prev = (c as { value?: unknown }).value;
                  setCond({
                    factor: c.factor,
                    op: op as ">",
                    value: typeof prev === "number" ? prev : 0,
                  });
                }
              }}
            >
              {[">=", ">", "<=", "<", "between"].map((o) => (
                <option key={o} value={o}>
                  {o === "between" ? "介于" : o.replace(">=", "≥").replace("<=", "≤")}
                </option>
              ))}
            </Select>
            {c.op === "between" ? (
              <>
                <Input
                  className="w-24"
                  type="number"
                  value={c.value[0]}
                  onChange={(e) => setCond({ ...c, value: [Number(e.target.value), c.value[1]] })}
                />
                <span className="text-xs text-muted">到</span>
                <Input
                  className="w-24"
                  type="number"
                  value={c.value[1]}
                  onChange={(e) => setCond({ ...c, value: [c.value[0], Number(e.target.value)] })}
                />
              </>
            ) : (
              <Input
                className="w-24"
                type="number"
                value={
                  typeof (c as { value?: unknown }).value === "number"
                    ? (c as { value: number }).value
                    : 0
                }
                onChange={(e) =>
                  setCond({ factor: c.factor, op: c.op as ">", value: Number(e.target.value) })
                }
              />
            )}
            {f.unit && <span className="text-xs text-muted">{f.unit}</span>}
          </>
        )}
        <button
          className="rounded p-1 text-muted hover:text-up"
          onClick={() => up((s) => void s.filters.splice(i, 1))}
          aria-label="删除条件"
        >
          <Trash2 className="size-4" />
        </button>
        {f && <p className="w-full text-[11px] text-muted">{f.describe}</p>}
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="名称">
          <Input value={spec.name} onChange={(e) => up((s) => void (s.name = e.target.value))} />
        </Field>
        <Field label="市场" hint={strategyId ? "已有策略不能改市场" : undefined}>
          <Select
            disabled={!!strategyId}
            value={spec.market}
            onChange={(e) => setSpec({ ...blank(e.target.value as Market), name: spec.name })}
            className="w-full"
          >
            <option value="A">A 股</option>
            <option value="HK">港股</option>
          </Select>
        </Field>
        <Field label="基准">
          <Select
            value={spec.benchmark ?? ""}
            onChange={(e) =>
              up(
                (s) =>
                  void (s.benchmark = (e.target.value || undefined) as StrategySpec["benchmark"]),
              )
            }
            className="w-full"
          >
            <option value="">默认（{BENCH[spec.market][0]![1]}）</option>
            {BENCH[spec.market].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <section>
        <h3 className="mb-2 text-sm font-semibold">股票池</h3>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <div className="flex gap-3">
            {BOARDS[spec.market].map(([v, l]) => (
              <label key={v} className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={!spec.universe.boards || spec.universe.boards.includes(v)}
                  onChange={(e) =>
                    up((s) => {
                      const all = BOARDS[s.market].map((b) => b[0]);
                      const cur = new Set(s.universe.boards ?? all);
                      if (e.target.checked) cur.add(v);
                      else cur.delete(v);
                      s.universe.boards = cur.size === all.length ? undefined : [...cur];
                    })
                  }
                />
                {l}
              </label>
            ))}
          </div>
          <div className="flex gap-3">
            {(
              [
                ["st", "排除 ST"],
                ["new_listing", "排除次新"],
                ["loss", "排除亏损"],
              ] as const
            ).map(([v, l]) =>
              spec.market === "HK" && v === "st" ? null : (
                <label key={v} className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={spec.universe.exclude.includes(v)}
                    onChange={(e) =>
                      up((s) => {
                        const set = new Set(s.universe.exclude);
                        if (e.target.checked) set.add(v);
                        else set.delete(v);
                        s.universe.exclude = [...set];
                      })
                    }
                  />
                  {l}
                </label>
              ),
            )}
          </div>
          <label className="inline-flex items-center gap-1.5 whitespace-nowrap">
            市值 ≥
            <Input
              className="w-20"
              type="number"
              value={spec.universe.minMcap ?? ""}
              onChange={(e) => up((s) => void (s.universe.minMcap = numOrUndef(e.target.value)))}
            />
            亿
          </label>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">条件（全部满足）</h3>
        <div className="space-y-2">{spec.filters.map(condRow)}</div>
        <Button
          size="sm"
          variant="ghost"
          className="mt-2"
          onClick={() => up((s) => void s.filters.push({ factor: "pe_ttm", op: "<=", value: 30 }))}
        >
          <Plus className="size-3.5" />
          加条件
        </Button>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">排序（横截面百分位加权）</h3>
        <div className="space-y-2">
          {spec.rank?.terms.map((t, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Select
                value={t.factor}
                onChange={(e) => up((s) => void (s.rank!.terms[i]!.factor = e.target.value))}
                className="w-48"
              >
                {factorOptions(numeric)}
              </Select>
              <Select
                value={t.better}
                onChange={(e) =>
                  up((s) => void (s.rank!.terms[i]!.better = e.target.value as "high" | "low"))
                }
              >
                <option value="high">越高越好</option>
                <option value="low">越低越好</option>
              </Select>
              <span className="text-xs text-muted">权重</span>
              <Input
                className="w-20"
                type="number"
                min={0.1}
                step={0.5}
                value={t.weight}
                onChange={(e) =>
                  up((s) => void (s.rank!.terms[i]!.weight = Number(e.target.value) || 1))
                }
              />
              {(spec.rank?.terms.length ?? 0) > 1 && (
                <button
                  className="rounded p-1 text-muted hover:text-up"
                  onClick={() => up((s) => void s.rank!.terms.splice(i, 1))}
                  aria-label="删除排序项"
                >
                  <Trash2 className="size-4" />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              up((s) => void s.rank!.terms.push({ factor: "roe_ttm", weight: 1, better: "high" }))
            }
          >
            <Plus className="size-3.5" />
            加排序项
          </Button>
          <label className="inline-flex items-center gap-1.5 whitespace-nowrap">
            持有前
            <Input
              className="w-16"
              type="number"
              min={1}
              max={100}
              value={spec.rank?.top ?? 10}
              onChange={(e) =>
                up((s) => void (s.rank!.top = Math.max(1, Math.trunc(Number(e.target.value) || 1))))
              }
            />
            只
          </label>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">调仓与卖出</h3>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <label className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <Select
              value={spec.rebalance.every}
              onChange={(e) => up((s) => void (s.rebalance.every = e.target.value as "week"))}
            >
              <option value="week">每周</option>
              <option value="month">每月</option>
              <option value="quarter">每季</option>
            </Select>
            第一个交易日调仓
          </label>
          <label
            className="inline-flex items-center gap-1.5 whitespace-nowrap"
            title="持仓掉出前 top × 缓冲 名才卖，降低换手"
          >
            缓冲
            <Input
              className="w-16"
              type="number"
              min={1}
              max={5}
              step={0.5}
              value={spec.rebalance.buffer}
              onChange={(e) =>
                up((s) => void (s.rebalance.buffer = Math.max(1, Number(e.target.value) || 1)))
              }
            />
            倍
          </label>
          <label className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <input
              type="checkbox"
              checked={spec.exits.dropWhenFiltered}
              onChange={(e) => up((s) => void (s.exits.dropWhenFiltered = e.target.checked))}
            />
            掉出名单就卖
          </label>
          <label className="inline-flex items-center gap-1.5 whitespace-nowrap">
            止盈
            <Input
              className="w-16"
              type="number"
              value={spec.exits.takeProfit ? spec.exits.takeProfit * 100 : ""}
              onChange={(e) =>
                up(
                  (s) =>
                    void (s.exits.takeProfit = numOrUndef(e.target.value)
                      ? Number(e.target.value) / 100
                      : undefined),
                )
              }
            />
            %
          </label>
          <label className="inline-flex items-center gap-1.5 whitespace-nowrap">
            止损
            <Input
              className="w-16"
              type="number"
              value={spec.exits.stopLoss ? spec.exits.stopLoss * 100 : ""}
              onChange={(e) =>
                up(
                  (s) =>
                    void (s.exits.stopLoss = numOrUndef(e.target.value)
                      ? Number(e.target.value) / 100
                      : undefined),
                )
              }
            />
            %
          </label>
          <label className="inline-flex items-center gap-1.5 whitespace-nowrap">
            最长持有
            <Input
              className="w-20"
              type="number"
              value={spec.exits.maxHoldDays ?? ""}
              onChange={(e) => up((s) => void (s.exits.maxHoldDays = numOrUndef(e.target.value)))}
            />
            个交易日
          </label>
          <label className="inline-flex items-center gap-1.5 whitespace-nowrap">
            单只上限
            <Input
              className="w-16"
              type="number"
              value={spec.sizing.maxWeight ? spec.sizing.maxWeight * 100 : ""}
              onChange={(e) =>
                up(
                  (s) =>
                    void (s.sizing.maxWeight = numOrUndef(e.target.value)
                      ? Number(e.target.value) / 100
                      : undefined),
                )
              }
            />
            %
          </label>
        </div>
      </section>

      <ErrorNote error={propose.error} />
      {propose.data && !propose.data.ok && (
        <ErrorNote error={new Error(propose.data.errors.join("\n"))} />
      )}
      <div className="flex justify-end gap-2">
        {onDone && <Button onClick={onDone}>取消</Button>}
        <Button variant="primary" loading={propose.isPending} onClick={() => propose.mutate()}>
          {strategyId ? "保存为新版本…" : "创建…"}
        </Button>
      </div>

      <Modal
        open={!!proposal}
        onClose={() => setProposal(null)}
        title={strategyId ? "确认这些修改？" : "确认创建这个策略？"}
        footer={
          <>
            <Button onClick={() => setProposal(null)}>再改改</Button>
            <Button
              variant="primary"
              loading={confirm.isPending}
              onClick={() => proposal && confirm.mutate(proposal.draftId)}
            >
              确认
            </Button>
          </>
        }
      >
        {proposal && (
          <DiffView
            changes={proposal.changes}
            describe={strategyId ? undefined : proposal.describe}
          />
        )}
        <ErrorNote error={confirm.error} />
      </Modal>
    </div>
  );
}

/**
 * 表单式策略编辑器（spec §11）：和对话改的是同一个对象。保存 = 提交草稿 → 看差异 → 确认后才生成新版本。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  BENCHMARKS,
  benchmarkOf,
  benchmarksOf,
  type Condition,
  type FactorDef,
  type Market,
  type RankTerm,
  type StrategySpec,
} from "@ivan/core";
import { api } from "../lib/api.ts";
import type { ProposeResult } from "../lib/types.ts";
import { DiffView } from "./diff-view.tsx";
import { IconAdd, IconCheck, IconDelete, IconEdit } from "./icons.tsx";
import {
  Button,
  Checkbox,
  cx,
  ErrorNote,
  Field,
  IconButton,
  Input,
  Modal,
  Select,
  Tag,
} from "./ui.tsx";

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

/** 表单分区：标题 + 一句说明，和上一区之间一条细线 */
function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="border-t border-line pt-5">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/** 行内的「文字 + 输入框 + 单位」 */
function Inline({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <label
      title={title}
      className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap text-ink-2"
    >
      {children}
    </label>
  );
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

  /** 一组排序项的编辑行（普通排序与「大盘走弱时」的排序共用） */
  const termRows = (get: (sp: StrategySpec) => RankTerm[]) => (
    <div className="space-y-2">
      {get(spec).map((t, i) => (
        <div
          key={i}
          className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2/70 px-3 py-2.5"
        >
          <Select
            aria-label="排序因子"
            value={t.factor}
            onChange={(e) => up((s) => void (get(s)[i]!.factor = e.target.value))}
            className="w-52"
          >
            {factorOptions(numeric)}
          </Select>
          <Select
            aria-label="方向"
            value={t.better}
            onChange={(e) => up((s) => void (get(s)[i]!.better = e.target.value as "high" | "low"))}
          >
            <option value="high">越高越好</option>
            <option value="low">越低越好</option>
          </Select>
          <Inline>
            权重
            <Input
              className="w-20"
              type="number"
              min={0.1}
              step={0.5}
              value={t.weight}
              onChange={(e) => up((s) => void (get(s)[i]!.weight = Number(e.target.value) || 1))}
            />
          </Inline>
          <Checkbox
            label="行业内比"
            title="只和同一行业的公司比（比如 PE 跟同行比，不跟银行比）"
            checked={t.neutral ?? false}
            onChange={(e) => up((s) => void (get(s)[i]!.neutral = e.target.checked || undefined))}
          />
          {get(spec).length > 1 && (
            <IconButton
              icon={IconDelete}
              label="删除排序项"
              size="sm"
              className="ml-auto hover:text-danger"
              onClick={() => up((s) => void get(s).splice(i, 1))}
            />
          )}
        </div>
      ))}
    </div>
  );

  const condRow = (c: Condition, i: number) => {
    const f = byKey.get(c.factor);
    const setCond = (next: Condition) => up((s) => void (s.filters[i] = next));
    return (
      <div key={i} className="rounded-lg bg-surface-2/70 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="因子"
            value={c.factor}
            onChange={(e) => {
              const nf = byKey.get(e.target.value);
              if (!nf) return;
              if (nf.kind === "bool") setCond({ factor: nf.key, op: "not" });
              else if (nf.kind === "category") setCond({ factor: nf.key, op: "in", value: [""] });
              else setCond({ factor: nf.key, op: ">=", value: 0 });
            }}
            className="w-52"
          >
            {factorOptions(factors.data?.factors ?? [])}
          </Select>
          {f?.kind === "bool" && (
            <Select
              aria-label="条件"
              value={c.op}
              onChange={(e) => setCond({ factor: c.factor, op: e.target.value as "is" | "not" })}
            >
              <option value="is">是</option>
              <option value="not">不是</option>
            </Select>
          )}
          {f?.kind === "category" &&
            "value" in c &&
            Array.isArray(c.value) &&
            c.op !== "between" && (
              <>
                <Select
                  aria-label="条件"
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
                  aria-label="取值"
                  className="w-60"
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
                aria-label="比较"
                value={c.op}
                onChange={(e) => {
                  const op = e.target.value;
                  if (op === "between")
                    setCond({ factor: c.factor, op: "between", value: [0, 10] });
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
                    aria-label="下限"
                    className="w-24"
                    type="number"
                    value={c.value[0]}
                    onChange={(e) => setCond({ ...c, value: [Number(e.target.value), c.value[1]] })}
                  />
                  <span className="text-xs text-muted">到</span>
                  <Input
                    aria-label="上限"
                    className="w-24"
                    type="number"
                    value={c.value[1]}
                    onChange={(e) => setCond({ ...c, value: [c.value[0], Number(e.target.value)] })}
                  />
                </>
              ) : (
                <Input
                  aria-label="取值"
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
          <IconButton
            icon={IconDelete}
            label="删除条件"
            size="sm"
            className="ml-auto hover:text-danger"
            onClick={() => up((s) => void s.filters.splice(i, 1))}
          />
        </div>
        {f && <p className="mt-1.5 text-2xs leading-4 text-muted">{f.describe}</p>}
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
        <Field
          label="基准"
          hint={BENCHMARKS[benchmarkOf(spec)].withDividends ? <Tag>含分红</Tag> : "不含分红"}
        >
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
            <option value="">默认（{BENCHMARKS[benchmarksOf(spec.market)[0]!].label}）</option>
            {benchmarksOf(spec.market).map((k) => (
              <option key={k} value={k}>
                {BENCHMARKS[k].label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Section title="股票池" hint="先圈定范围，下面的条件只在这里面挑">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {BOARDS[spec.market].map(([v, l]) => (
              <Checkbox
                key={v}
                label={l}
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
            ))}
          </div>
          <span aria-hidden className="h-4 w-px bg-line-strong max-sm:hidden" />
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {(
              [
                ["st", "排除 ST"],
                ["new_listing", "排除次新"],
                ["loss", "排除亏损"],
              ] as const
            ).map(([v, l]) =>
              spec.market === "HK" && v === "st" ? null : (
                <Checkbox
                  key={v}
                  label={l}
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
              ),
            )}
          </div>
          {spec.market === "HK" && (
            <>
              <span aria-hidden className="h-4 w-px bg-line-strong max-sm:hidden" />
              <Checkbox
                label="只选港股通标的（内地投资者能买到的）"
                checked={!!spec.universe.hkConnect}
                onChange={(e) =>
                  up((s) => void (s.universe.hkConnect = e.target.checked ? true : undefined))
                }
              />
            </>
          )}
          <span aria-hidden className="h-4 w-px bg-line-strong max-sm:hidden" />
          <Inline>
            市值 ≥
            <Input
              className="w-20"
              type="number"
              value={spec.universe.minMcap ?? ""}
              onChange={(e) => up((s) => void (s.universe.minMcap = numOrUndef(e.target.value)))}
            />
            亿
          </Inline>
        </div>
      </Section>

      <Section title="条件" hint="全部满足才入选">
        <div className="space-y-2">{spec.filters.map(condRow)}</div>
        <Button
          size="sm"
          variant="ghost"
          icon={IconAdd}
          className="mt-2"
          onClick={() => up((s) => void s.filters.push({ factor: "pe_ttm", op: "<=", value: 30 }))}
        >
          加条件
        </Button>
      </Section>

      <Section title="排序" hint="按横截面百分位加权打分，取前 N 只">
        {termRows((sp) => sp.rank!.terms)}
        <div className="mt-2 flex flex-wrap items-center gap-4">
          <Button
            size="sm"
            variant="ghost"
            icon={IconAdd}
            onClick={() =>
              up((s) => void s.rank!.terms.push({ factor: "roe_ttm", weight: 1, better: "high" }))
            }
          >
            加排序项
          </Button>
          <Inline>
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
          </Inline>
          <Inline title="每个一级行业最多入选几只，不填就不限">
            同一行业最多
            <Input
              className="w-16"
              type="number"
              min={1}
              max={50}
              placeholder="不限"
              value={spec.rank?.maxPerIndustry ?? ""}
              onChange={(e) =>
                up((s) => {
                  const n = numOrUndef(e.target.value);
                  s.rank!.maxPerIndustry = n ? Math.max(1, Math.trunc(n)) : undefined;
                })
              }
            />
            只
          </Inline>
        </div>
        <div className="mt-4 border-t border-line pt-3">
          <Checkbox
            label={`大盘走弱时换一组排序（实验）`}
            title="决策日沪深300（港股看恒指）收盘在均线下方时，改用下面这组排序"
            checked={!!spec.rank?.regime}
            onChange={(e) =>
              up((s) => {
                s.rank!.regime = e.target.checked
                  ? { ma: 200, weak: { terms: structuredClone(s.rank!.terms) } }
                  : undefined;
              })
            }
          />
          {spec.rank?.regime && (
            <div className="mt-3 space-y-2">
              <Inline title="指数收盘低于最近这么多个交易日的均价，就算走弱">
                {spec.market === "A" ? "沪深300" : "恒指"}低于
                <Input
                  className="w-16"
                  type="number"
                  min={20}
                  max={250}
                  value={spec.rank.regime.ma}
                  onChange={(e) =>
                    up(
                      (s) =>
                        void (s.rank!.regime!.ma = Math.min(
                          250,
                          Math.max(20, Math.trunc(Number(e.target.value) || 200)),
                        )),
                    )
                  }
                />
                日均线时，用这组排序：
              </Inline>
              {termRows((sp) => sp.rank!.regime!.weak.terms)}
              <Button
                size="sm"
                variant="ghost"
                icon={IconAdd}
                onClick={() =>
                  up(
                    (s) =>
                      void s.rank!.regime!.weak.terms.push({
                        factor: "roe_ttm",
                        weight: 1,
                        better: "high",
                      }),
                  )
                }
              >
                加排序项
              </Button>
            </div>
          )}
        </div>
      </Section>

      <Section title="调仓与卖出" hint="多久调一次、什么时候卖、单只最多买多少">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <Inline>
            <Select
              aria-label="调仓频率"
              value={spec.rebalance.every}
              onChange={(e) => up((s) => void (s.rebalance.every = e.target.value as "week"))}
            >
              <option value="week">每周</option>
              <option value="month">每月</option>
              <option value="quarter">每季</option>
            </Select>
            第一个交易日调仓
          </Inline>
          <Inline title="持仓掉出前 top × 缓冲 名才卖，降低换手">
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
          </Inline>
          <Checkbox
            label="掉出名单就卖"
            checked={spec.exits.dropWhenFiltered}
            onChange={(e) => up((s) => void (s.exits.dropWhenFiltered = e.target.checked))}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Inline>
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
          </Inline>
          <Inline>
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
          </Inline>
          <Inline>
            最长持有
            <Input
              className="w-20"
              type="number"
              value={spec.exits.maxHoldDays ?? ""}
              onChange={(e) => up((s) => void (s.exits.maxHoldDays = numOrUndef(e.target.value)))}
            />
            个交易日
          </Inline>
          <Inline>
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
          </Inline>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Checkbox
            label="按波动控制仓位"
            title="每周五收盘看持仓近 60 个交易日的年化波动，超过目标就在下周一开盘按比例减仓，回落再加回；空出来的钱不计利息"
            checked={!!spec.exposure}
            onChange={(e) =>
              up((s) => {
                s.exposure = e.target.checked ? { volTarget: 0.18, lookback: 60 } : undefined;
              })
            }
          />
          {spec.exposure && (
            <Inline title="组合年化波动超过这个值时，仓位按「目标 ÷ 实际波动」缩小，按 10% 取整">
              目标年化波动
              <Input
                className="w-16"
                type="number"
                min={5}
                max={100}
                step={1}
                value={Math.round(spec.exposure.volTarget * 100)}
                onChange={(e) =>
                  up(
                    (s) =>
                      void (s.exposure!.volTarget = Math.min(
                        1,
                        Math.max(0.05, (Number(e.target.value) || 18) / 100),
                      )),
                  )
                }
              />
              %
            </Inline>
          )}
        </div>
      </Section>

      <ErrorNote error={propose.error} />
      {propose.data && !propose.data.ok && (
        <ErrorNote error={new Error(propose.data.errors.join("\n"))} />
      )}
      <div
        className={cx(
          "flex items-center justify-end gap-2 border-t border-line pt-4",
          !onDone && "sticky bottom-0 bg-surface",
        )}
      >
        <span className="mr-auto text-xs text-muted">保存后先看差异，确认了才生成新版本</span>
        {onDone && <Button onClick={onDone}>取消</Button>}
        <Button
          variant="primary"
          icon={IconEdit}
          loading={propose.isPending}
          onClick={() => propose.mutate()}
        >
          {strategyId ? "保存为新版本…" : "创建…"}
        </Button>
      </div>

      <Modal
        open={!!proposal}
        onClose={() => setProposal(null)}
        title={strategyId ? "确认这些修改？" : "确认创建这个策略？"}
        icon={IconCheck}
        footer={
          <>
            <Button onClick={() => setProposal(null)}>再改改</Button>
            <Button
              variant="primary"
              icon={IconCheck}
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

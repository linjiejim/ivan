/**
 * 信号集（spec §11）：导入「日期,代码」列表，只测买卖与仓位规则（信号模式策略的输入）。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { IconImport, IconSignals } from "../components/icons.tsx";
import {
  Button,
  Callout,
  Card,
  Empty,
  ErrorNote,
  Field,
  Input,
  ListSkeleton,
  PageHeader,
  Select,
  Tag,
  Textarea,
} from "../components/ui.tsx";
import { api, ApiError } from "../lib/api.ts";
import { dateTime, MARKET_TEXT } from "../lib/format.ts";
import { usePageTitle } from "../lib/title.ts";

interface Dataset {
  id: string;
  name: string;
  market: string;
  count: number;
  createdAt: number;
}

export function SignalsPage() {
  usePageTitle("信号集");
  const q = useQuery({ queryKey: ["signals"], queryFn: () => api.get<Dataset[]>("/api/signals") });
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [market, setMarket] = useState("A");
  const [csv, setCsv] = useState("");
  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string; count: number }>("/api/signals", { name, market, csv }),
    onSuccess: () => {
      setName("");
      setCsv("");
      void qc.invalidateQueries({ queryKey: ["signals"] });
    },
  });
  const errors =
    create.error instanceof ApiError
      ? ((create.error.body as { errors?: string[] })?.errors ?? null)
      : null;
  const lines = csv.split("\n").filter((l) => l.trim()).length;
  return (
    <div className="space-y-6">
      <PageHeader
        back={{ to: "/strategies", label: "策略" }}
        title="信号集"
        meta={<span>导入一串历史推荐，只测「怎么买、买多少、何时卖」</span>}
      />
      <Callout tone="info">
        信号集是一串「某天推荐了某只股票」的记录（比如你过去的选股）。用它建一个「信号模式」的策略，就能只测买卖与仓位规则：信号日收盘后决策，次日开盘买入。
      </Callout>
      <Card title="导入" icon={IconImport}>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
            <Field label="名称">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：我 2025 年的推荐"
              />
            </Field>
            <Field label="市场">
              <Select value={market} onChange={(e) => setMarket(e.target.value)} className="w-full">
                <option value="A">A 股</option>
                <option value="HK">港股</option>
              </Select>
            </Field>
          </div>
          <Field
            label="内容（每行：日期,代码）"
            hint="日期 YYYY-MM-DD；代码可写 600519 / 600519.SH / 700 / 00700.HK"
          >
            <Textarea
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={8}
              spellCheck={false}
              placeholder={"2025-06-10,600519\n2025-06-11,000858"}
              className="font-mono text-xs leading-6"
            />
          </Field>
          {errors ? (
            <ErrorNote error={new Error(errors.join("\n"))} />
          ) : (
            <ErrorNote error={create.error} />
          )}
          <div className="flex items-center justify-end gap-3">
            {lines > 0 && (
              <span className="text-xs text-muted">
                <span className="tabular font-medium text-ink-2">{lines}</span> 行
              </span>
            )}
            <Button
              variant="primary"
              icon={IconImport}
              loading={create.isPending}
              disabled={!name || !csv}
              onClick={() => create.mutate()}
            >
              导入
            </Button>
          </div>
        </div>
      </Card>
      <Card title="已导入" icon={IconSignals} flush>
        {q.isLoading ? (
          <div className="px-4 pb-3">
            <ListSkeleton rows={2} />
          </div>
        ) : q.data?.length ? (
          <ul className="px-4">
            {q.data.map((d) => (
              <li
                key={d.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-3 text-sm last:border-0"
              >
                <span className="font-medium text-ink">{d.name}</span>
                <Tag>{MARKET_TEXT[d.market]}</Tag>
                <span className="text-ink-2">
                  <span className="tabular">{d.count}</span> 条
                </span>
                <code className="text-[11px] text-muted">{d.id}</code>
                <span className="ml-auto font-mono text-[11px] text-muted">
                  {dateTime(d.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon={IconSignals} title="还没有信号集" className="mx-4 mb-3">
            导入后，在对话里让 AI 用它建一个「信号模式」的策略。
          </Empty>
        )}
      </Card>
    </div>
  );
}

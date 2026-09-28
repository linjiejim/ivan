/**
 * 信号集（spec §11）：导入「日期,代码」列表，只测买卖与仓位规则（信号模式策略的输入）。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Select } from "../components/ui.tsx";
import { api, ApiError } from "../lib/api.ts";
import { dateTime, MARKET_TEXT } from "../lib/format.ts";

interface Dataset {
  id: string;
  name: string;
  market: string;
  count: number;
  createdAt: number;
}

export function SignalsPage() {
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
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">信号集</h1>
      <p className="text-sm text-ink-2">
        信号集是一串「某天推荐了某只股票」的记录（比如你过去的选股）。用它建一个「信号模式」的策略，就能只测「怎么买、买多少、何时卖」——信号日收盘后决策，次日开盘买入。
      </p>
      <Card title="导入">
        <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
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
          <textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            rows={8}
            placeholder={"2025-06-10,600519\n2025-06-11,000858"}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs text-ink outline-none focus:border-accent"
          />
        </Field>
        {errors ? (
          <ErrorNote error={new Error(errors.join("\n"))} />
        ) : (
          <ErrorNote error={create.error} />
        )}
        <div className="mt-3 flex justify-end">
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={!name || !csv}
            onClick={() => create.mutate()}
          >
            导入
          </Button>
        </div>
      </Card>
      <Card title="已导入">
        {q.data?.length ? (
          <ul className="divide-y divide-line">
            {q.data.map((d) => (
              <li key={d.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="font-medium">{d.name}</span>
                <Badge>{MARKET_TEXT[d.market]}</Badge>
                <span className="text-ink-2">{d.count} 条</span>
                <code className="text-xs text-muted">{d.id}</code>
                <span className="ml-auto text-xs text-muted">{dateTime(d.createdAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="还没有信号集" />
        )}
      </Card>
    </div>
  );
}

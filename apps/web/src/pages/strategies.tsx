import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useChatUi } from "../chat/chat-context.tsx";
import { SpecEditor } from "../components/spec-editor.tsx";
import { Badge, Button, Card, Empty, ErrorNote, Info, Modal, Spinner } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { dateTime, MARKET_TEXT } from "../lib/format.ts";
import type { PresetView, StrategyView } from "../lib/types.ts";
import { PresetGallery } from "./dashboard.tsx";

export function StrategiesPage() {
  const q = useQuery({
    queryKey: ["strategies"],
    queryFn: () => api.get<StrategyView[]>("/api/strategies"),
  });
  const presets = useQuery({
    queryKey: ["presets"],
    queryFn: () => api.get<PresetView[]>("/api/presets"),
  });
  const chat = useChatUi();
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    chat.setPage({});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">我的策略</h1>
        <div className="ml-auto flex items-center gap-2">
          <Link
            to="/signals"
            className="inline-flex items-center gap-1 text-xs text-ink-2 hover:text-accent"
          >
            信号集
            <Info>
              已经有一份历史推荐名单（日期 +
              代码）？导入成信号集，就能只测买卖和仓位规则，不用写选股条件。
            </Info>
          </Link>
          <Button onClick={() => chat.ask("我想新建一个选股策略：", {})}>用对话新建</Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            表单新建
          </Button>
        </div>
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : q.data?.length ? (
        <div className="grid gap-3 @3xl:grid-cols-2">
          {q.data.map((s) => (
            <Link
              key={s.id}
              to={`/strategies/${s.id}`}
              className="block rounded-xl border border-line bg-surface p-4 hover:border-accent"
            >
              <div className="flex items-center gap-2">
                <span className="font-semibold">{s.name}</span>
                <Badge>{MARKET_TEXT[s.market]}</Badge>
                {s.current && <Badge tone="accent">v{s.current.n}</Badge>}
                <span className="ml-auto text-xs text-muted">{dateTime(s.updatedAt)}</span>
              </div>
              <ul className="mt-2 space-y-0.5 text-xs text-ink-2">
                {s.current?.describe.slice(0, 2).map((l) => (
                  <li key={l} className="truncate">
                    {l}
                  </li>
                ))}
              </ul>
            </Link>
          ))}
        </div>
      ) : (
        <Empty title="还没有策略">
          可以从下面的模板开始，或者点「用对话新建」告诉 AI 你的想法。
        </Empty>
      )}
      <ErrorNote error={q.error} />
      {presets.data && (
        <Card title="模板" subtitle="一键建好并回测，再按自己的想法改">
          <PresetGallery presets={presets.data} />
        </Card>
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title="新建策略" wide>
        <SpecEditor onDone={() => setCreating(false)} />
      </Modal>
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useChatUi } from "../chat/chat-context.tsx";
import {
  IconAdd,
  IconAI,
  IconArrowRight,
  IconSignals,
  IconTemplate,
} from "../components/icons.tsx";
import { SpecEditor } from "../components/spec-editor.tsx";
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Info,
  Modal,
  PageHeader,
  Skeleton,
  Tag,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { dateTime, MARKET_TEXT } from "../lib/format.ts";
import { usePageTitle } from "../lib/title.ts";
import type { PresetView, StrategyView } from "../lib/types.ts";
import { PresetGallery } from "./dashboard.tsx";

/** 「股票池：A 股，排除 ST」→ 标签淡、内容实 */
function RuleLine({ line }: { line: string }) {
  const i = line.indexOf("：");
  if (i < 0) return <li className="truncate">{line}</li>;
  return (
    <li className="flex min-w-0 gap-2">
      <span className="shrink-0 text-muted">{line.slice(0, i)}</span>
      <span className="truncate text-ink-2">{line.slice(i + 1)}</span>
    </li>
  );
}

function StrategyCard({ s }: { s: StrategyView }) {
  return (
    <Link
      to={`/strategies/${s.id}`}
      className="group/card relative flex min-w-0 flex-col rounded-xl border border-line bg-surface p-4 shadow-[var(--edge)] transition-[border-color,box-shadow,transform] duration-200 hover:border-line-strong hover:shadow-raise active:translate-y-px"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate font-semibold text-ink">{s.name}</span>
        <Tag>{MARKET_TEXT[s.market]}</Tag>
        {s.current && <Tag mono>v{s.current.n}</Tag>}
        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted transition-opacity duration-150 group-hover/card:opacity-0">
          {dateTime(s.updatedAt)}
        </span>
        <IconArrowRight
          size={16}
          className="absolute top-4 right-4 -translate-x-1 text-ink-2 opacity-0 transition-[opacity,transform] duration-200 group-hover/card:translate-x-0 group-hover/card:opacity-100"
        />
      </div>
      <ul className="mt-3 space-y-1 text-xs leading-5">
        {s.current?.describe.slice(0, 2).map((l) => (
          <RuleLine key={l} line={l} />
        ))}
      </ul>
    </Link>
  );
}

export function StrategiesPage() {
  usePageTitle("策略");
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
  const newByChat = () => chat.ask("我想新建一个选股策略：", {});
  return (
    <div className="space-y-6">
      <PageHeader
        title="我的策略"
        meta={
          q.data?.length ? (
            <span>
              共 <span className="tabular font-medium text-ink-2">{q.data.length}</span>{" "}
              个策略，按最近修改排序
            </span>
          ) : undefined
        }
        actions={
          <>
            {/* 手机上一行只放两个新建按钮；信号集在账户菜单里也有 */}
            <Link
              to="/signals"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink max-sm:hidden"
            >
              <IconSignals size={16} className="text-muted" />
              信号集
              <Info>
                已经有一份历史推荐名单（日期 +
                代码）？导入成信号集，就能只测买卖和仓位规则，不用写选股条件。
              </Info>
            </Link>
            <Button variant="ai" icon={IconAI} onClick={newByChat}>
              用对话新建
            </Button>
            <Button variant="primary" icon={IconAdd} onClick={() => setCreating(true)}>
              表单新建
            </Button>
          </>
        }
      />
      {q.isLoading ? (
        <div className="grid gap-3 @3xl:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="space-y-3 rounded-xl border border-line bg-surface p-4">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-3 w-3/5" />
            </div>
          ))}
        </div>
      ) : q.data?.length ? (
        <div className="grid gap-3 @3xl:grid-cols-2">
          {q.data.map((s) => (
            <StrategyCard key={s.id} s={s} />
          ))}
        </div>
      ) : (
        <Card>
          <Empty
            art="start"
            title="还没有策略"
            action={
              <>
                <Button variant="ai" icon={IconAI} onClick={newByChat}>
                  用对话新建
                </Button>
                <Button icon={IconAdd} onClick={() => setCreating(true)}>
                  表单新建
                </Button>
              </>
            }
          >
            把你的选股思路告诉 AI，它会写成规则并回测；也可以从下面的模板开始。
          </Empty>
        </Card>
      )}
      <ErrorNote error={q.error} />
      {presets.data && (
        <Card title="模板" icon={IconTemplate} subtitle="一键建好并回测，再按自己的想法改">
          <PresetGallery presets={presets.data} />
        </Card>
      )}
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="新建策略"
        icon={IconAdd}
        wide
      >
        <SpecEditor onDone={() => setCreating(false)} />
      </Modal>
    </div>
  );
}

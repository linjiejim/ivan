/**
 * 图表右上角的「框选问 AI」条：没选时一句提示（这个交互原来只写在 ⓘ 里，没人发现），
 * 选中后显示区间 + 问 AI + 清除。
 */
import { IconAI, IconBrush, IconClose } from "../icons.tsx";
import { Button, IconButton } from "../ui.tsx";

export function BrushBar({
  range,
  onAsk,
  onClear,
}: {
  range: { from: string; to: string } | null;
  onAsk: () => void;
  onClear: () => void;
}) {
  if (!range)
    return (
      <span className="hidden items-center gap-1.5 text-xs text-muted sm:inline-flex">
        <IconBrush size={14} />
        在图上拖动，框选一段问 AI
      </span>
    );
  return (
    <div className="flex animate-pop items-center gap-1.5">
      <span className="inline-flex h-7 items-center rounded-lg bg-accent-wash px-2 font-mono text-[11px] text-accent tabular">
        {range.from} → {range.to}
      </span>
      <Button size="sm" variant="ai" icon={IconAI} onClick={onAsk}>
        问 AI 这段
      </Button>
      <IconButton size="sm" icon={IconClose} label="清除框选" onClick={onClear} />
    </div>
  );
}

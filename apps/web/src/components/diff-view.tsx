import type { SpecChange } from "../lib/types.ts";

/** 策略差异：按「股票池 / 条件 / 排序 / 调仓 / 仓位 / 基准」逐行，旧 → 新 */
export function DiffView({ changes, describe }: { changes: SpecChange[]; describe?: string[] }) {
  if (describe) {
    return (
      <ul className="space-y-1 text-sm">
        {describe.map((l) => {
          const i = l.indexOf("：");
          return (
            <li key={l}>
              <span className="text-muted">{l.slice(0, i)}：</span>
              {l.slice(i + 1)}
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <ul className="space-y-2 text-sm">
      {changes.map((c) => (
        <li key={c.label}>
          <div className="text-xs font-medium text-muted">{c.label}</div>
          {c.before && (
            <div className="text-ink-2 line-through decoration-muted/60">{c.before}</div>
          )}
          <div className="text-ink">{c.after ?? "（删除）"}</div>
        </li>
      ))}
    </ul>
  );
}

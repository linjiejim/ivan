import type { SpecChange } from "../lib/types.ts";

/**
 * 策略规则 / 差异：按「股票池 / 条件 / 排序 / 调仓 / 仓位 / 基准」逐行。
 * 差异不用红绿（红绿在这里是涨跌）：旧的划掉退后，新的用花青竖线标出来。
 */
export function DiffView({ changes, describe }: { changes: SpecChange[]; describe?: string[] }) {
  if (describe) {
    return (
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        {describe.map((l) => {
          const i = l.indexOf("：");
          return (
            <div key={l} className="contents">
              <dt className="whitespace-nowrap text-muted">{i >= 0 ? l.slice(0, i) : ""}</dt>
              <dd className="leading-6 text-ink">{i >= 0 ? l.slice(i + 1) : l}</dd>
            </div>
          );
        })}
      </dl>
    );
  }
  return (
    <ul className="space-y-3 text-sm">
      {changes.map((c) => (
        <li key={c.label}>
          <div className="mb-1 text-xs font-medium text-muted">{c.label}</div>
          <div className="space-y-1 border-l-2 border-accent-line pl-3">
            {c.before && (
              <div className="leading-6 text-muted line-through decoration-faint">{c.before}</div>
            )}
            <div className="leading-6 text-ink">
              {c.after ?? <span className="text-muted">（删除）</span>}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

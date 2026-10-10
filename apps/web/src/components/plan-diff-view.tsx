/**
 * 计划版次对比（D71）：第 1 版（当晚看到的）与最新版的差异，逐行「新增 / 移除 / 变化」。
 * 除了买卖徽标不用红绿：版次差异不是涨跌，用中性的徽标与文字。
 */
import { NA, pct, reasonDetailShort } from "../lib/format.ts";
import type { PlanDiff, PlanItemLite } from "../lib/types.ts";
import { Badge, DataTable, Td, Th } from "./ui.tsx";

const FIELD_TEXT: Record<PlanDiff["changed"][number]["field"], string> = {
  side: "方向",
  rank: "名次",
  estWeight: "估算仓位",
  reasonDetail: "细分原因",
};

function value(field: keyof typeof FIELD_TEXT, v: string | number | null): string {
  if (v === null || v === undefined) return NA;
  switch (field) {
    case "side":
      return v === "buy" ? "买" : v === "sell" ? "卖" : String(v);
    case "rank":
      return `第 ${v}`;
    case "estWeight":
      return typeof v === "number" ? pct(v, 1, false) : String(v);
    case "reasonDetail":
      return reasonDetailShort(String(v));
  }
}

function Side({ side }: { side: string }) {
  return <Badge tone={side === "buy" ? "up" : "down"}>{side === "buy" ? "买" : "卖"}</Badge>;
}

function Name({ it }: { it: { code: string; name: string | null } }) {
  return (
    <>
      <span className="text-ink">{it.name ?? it.code}</span>
      <span className="ml-1.5 font-mono text-[11px] text-muted">{it.code}</span>
    </>
  );
}

function itemText(it: PlanItemLite): string {
  const parts = [reasonDetailShort(it.reasonDetail)];
  if (it.rank !== null) parts.push(`第 ${it.rank}`);
  if (it.estWeight !== null) parts.push(`估算仓位 ${pct(it.estWeight, 1, false)}`);
  return parts.join("，");
}

export function PlanDiffView({ diff }: { diff: PlanDiff }) {
  const empty = !diff.added.length && !diff.removed.length && !diff.changed.length;
  if (empty) return <p className="text-sm text-muted">两版的计划项一样。</p>;
  return (
    <DataTable>
      <thead>
        <tr>
          <Th className="w-14">差异</Th>
          <Th>股票</Th>
          <Th>第 1 版</Th>
          <Th>最新版</Th>
        </tr>
      </thead>
      <tbody>
        {diff.added.map((it) => (
          <tr key={`a-${it.code}`}>
            <Td>
              <Badge>新增</Badge>
            </Td>
            <Td>
              <Name it={it} />
            </Td>
            <Td className="text-muted">{NA}</Td>
            <Td className="text-ink-2">
              <span className="inline-flex items-center gap-1.5">
                <Side side={it.side} />
                {itemText(it)}
              </span>
            </Td>
          </tr>
        ))}
        {diff.removed.map((it) => (
          <tr key={`r-${it.code}`}>
            <Td>
              <Badge>移除</Badge>
            </Td>
            <Td>
              <Name it={it} />
            </Td>
            <Td className="text-ink-2">
              <span className="inline-flex items-center gap-1.5">
                <Side side={it.side} />
                {itemText(it)}
              </span>
            </Td>
            <Td className="text-muted">{NA}</Td>
          </tr>
        ))}
        {diff.changed.map((c) => (
          <tr key={`c-${c.code}-${c.field}`}>
            <Td>
              <Badge>变化</Badge>
            </Td>
            <Td>
              <Name it={c} />
            </Td>
            <Td className="text-ink-2">
              <span className="text-muted">{FIELD_TEXT[c.field]}</span> {value(c.field, c.before)}
            </Td>
            <Td className="text-ink">
              <span className="text-muted">{FIELD_TEXT[c.field]}</span> {value(c.field, c.after)}
            </Td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

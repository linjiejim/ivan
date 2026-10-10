import { useQuery } from "@tanstack/react-query";
import type { FactorDef, StrategySpec } from "@ivan/core";
import { api } from "../lib/api.ts";
import { fmtFactor, NA } from "../lib/format.ts";
import type { ScreenResult } from "../lib/types.ts";
import { IconScreen } from "./icons.tsx";
import { DataTable, Empty, Td, Th } from "./ui.tsx";

/** 选股结果表：排名、代码、名称、得分 + 策略用到的因子 */
export function ScreenTable({ result, spec }: { result: ScreenResult; spec?: StrategySpec }) {
  const market = spec?.market ?? (result.rows[0]?.code.endsWith(".HK") ? "HK" : "A");
  const factors = useQuery({
    queryKey: ["factors", market],
    queryFn: () => api.get<{ factors: FactorDef[] }>(`/api/factors?market=${market}`),
  });
  const byKey = new Map((factors.data?.factors ?? []).map((f) => [f.key, f]));
  const cols = Object.keys(result.rows[0]?.factors ?? {}).filter((k) => k !== "industry");
  if (!result.rows.length)
    return (
      <Empty icon={IconScreen} title="这一天没有股票同时满足所有条件" className="border-0">
        可以放宽一两个条件，或者换个数据日再看。
      </Empty>
    );
  return (
    <DataTable minWidth={640}>
      <thead>
        <tr>
          <Th className="w-8">#</Th>
          <Th>股票</Th>
          <Th>行业</Th>
          <Th align="right">得分</Th>
          {cols.map((c) => (
            <Th key={c} align="right">
              {byKey.get(c)?.label ?? c}
            </Th>
          ))}
        </tr>
      </thead>
      <tbody>
        {result.rows.map((r) => (
          <tr key={r.code} className="transition-colors hover:bg-surface-2/60">
            <Td className="font-mono text-[11px] text-muted">{r.rank}</Td>
            <Td className="whitespace-nowrap">
              <span className="font-medium text-ink">{r.name ?? r.code}</span>
              <span className="ml-1.5 font-mono text-[11px] text-muted">{r.code}</span>
            </Td>
            <Td className="whitespace-nowrap text-ink-2">{String(r.factors.industry ?? NA)}</Td>
            <Td align="right" className="font-mono text-[12px] text-ink">
              {r.score.toFixed(3)}
            </Td>
            {cols.map((c) => (
              <Td key={c} align="right" className="text-ink-2">
                {fmtFactor(r.factors[c], byKey.get(c)?.unit)}
              </Td>
            ))}
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

/**
 * 今日选股可追溯（D67）：读的数据版本与名单指纹；免责声明另放右边，不和追溯信息挤在同一串「·」里
 * （设计系统 §10，和个股证据卡的页脚一样）
 */
export function ScreenTrace({ result }: { result: ScreenResult }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-line pt-2 text-2xs text-muted">
      {result.listHash ? (
        <span className="font-mono">
          数据版本 #{result.dataVersion?.id ?? NA} · 校验 {result.listHash.slice(0, 8)}
        </span>
      ) : null}
      <span className="ml-auto">仅供研究，不构成投资建议</span>
    </div>
  );
}

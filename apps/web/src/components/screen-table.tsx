import { useQuery } from "@tanstack/react-query";
import type { FactorDef, StrategySpec } from "@ivan/core";
import { api } from "../lib/api.ts";
import { fmtFactor } from "../lib/format.ts";
import type { ScreenResult } from "../lib/types.ts";

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
    return <p className="text-sm text-muted">这一天没有股票同时满足所有条件。</p>;
  return (
    <div className="overflow-x-auto">
      <table className="tabular w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            <th className="py-2 pr-2 font-normal">#</th>
            <th className="py-2 pr-3 font-normal">股票</th>
            <th className="py-2 pr-3 font-normal">行业</th>
            <th className="py-2 pr-3 text-right font-normal">得分</th>
            {cols.map((c) => (
              <th key={c} className="py-2 pr-3 text-right font-normal">
                {byKey.get(c)?.label ?? c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((r) => (
            <tr key={r.code} className="border-b border-line last:border-0">
              <td className="py-1.5 pr-2 text-muted">{r.rank}</td>
              <td className="py-1.5 pr-3">
                <span className="font-medium">{r.name ?? r.code}</span>
                <span className="ml-1.5 text-xs text-muted">{r.code}</span>
              </td>
              <td className="py-1.5 pr-3 text-ink-2">{String(r.factors.industry ?? "—")}</td>
              <td className="py-1.5 pr-3 text-right">{r.score.toFixed(3)}</td>
              {cols.map((c) => (
                <td key={c} className="py-1.5 pr-3 text-right text-ink-2">
                  {fmtFactor(r.factors[c], byKey.get(c)?.unit)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

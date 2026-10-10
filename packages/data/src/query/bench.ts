/**
 * 基准的可用性与「基准不匹配」提示（D75）。
 *
 * - 各基准的首个数据日：/internal/data-status 给 server 提交前校验，buildSimInput 里同样的检查只对回测抛错；
 * - bench_mismatch（info）：一次查询算各决策日入选股票的市值排名中位数，A 股沪深300 配中小盘、红利排序没配中证红利、
 *   港股恒指配中小盘时提示。只是报告：进 reportHash，不进输入指纹。
 */
import {
  BENCHMARKS,
  type BenchmarkKey,
  benchmarkOf,
  type Check,
  type DateStr,
  type Market,
  type StrategySpec,
} from "@ivan/core";
import type { Warehouse } from "../warehouse/db.ts";

/** 某个市场各基准（按 index_bars 的 sym）的首个数据日；一行都没有为 null */
export async function benchFirstDates(
  wh: Warehouse,
  market: Market,
): Promise<Record<string, DateStr | null>> {
  const syms = [
    ...new Set(
      (Object.keys(BENCHMARKS) as BenchmarkKey[])
        .filter((k) => BENCHMARKS[k].market === market)
        .map((k) => BENCHMARKS[k].sym),
    ),
  ];
  const rows = await wh.all<{ sym: string; first: string }>(
    `SELECT sym, min(date)::VARCHAR AS first FROM index_bars
     WHERE sym IN (${syms.map((s) => `'${s}'`).join(", ")}) GROUP BY sym`,
  );
  const got = new Map(rows.map((r) => [r.sym, r.first]));
  return Object.fromEntries(syms.map((s) => [s, got.get(s) ?? null]));
}

/** 单个基准的首个数据日 */
export async function benchFirstDate(wh: Warehouse, sym: string): Promise<DateStr | null> {
  return (
    (await wh.scalar<string>(`SELECT min(date)::VARCHAR FROM index_bars WHERE sym = $s`, { s: sym })) ??
    null
  );
}

/** 市值排名中位数超过这些名次时建议换基准（A 股对沪深300、港股对恒指） */
export const BENCH_MISMATCH = {
  csi1000Rank: 800,
  csi500Rank: 500,
  hkSmallRank: 300,
  /** 排序里股息率的权重占比 ≥ 这个值时建议中证红利 */
  dividendShare: 0.3,
  /** 最多取这么多（决策日, 代码）对，多了按间隔均匀抽 */
  maxPairs: 5000,
} as const;

/** 排序里股息率的权重占比（强势、弱势两套排序合在一起算） */
export function dividendWeightShare(spec: StrategySpec): number {
  const terms = [...(spec.rank?.terms ?? []), ...(spec.rank?.regime?.weak.terms ?? [])];
  const total = terms.reduce((s, t) => s + t.weight, 0);
  if (!(total > 0)) return 0;
  return terms.filter((t) => t.factor === "dividend_yield_ttm").reduce((s, t) => s + t.weight, 0) / total;
}

/** 名次写成「约第 1,150 名」：100 名以上取整到 10 */
function rankText(r: number): string {
  const v = r >= 100 ? Math.round(r / 10) * 10 : Math.round(r);
  return v.toLocaleString("en-US");
}

/** 入选股票（各决策日的前 top 只）的市值排名中位数；没有排名数据时为 null */
export async function selectedMedianMcapRank(
  wh: Warehouse,
  pairs: ReadonlyArray<readonly [DateStr, string]>,
): Promise<number | null> {
  if (!pairs.length) return null;
  const step = pairs.length > BENCH_MISMATCH.maxPairs ? pairs.length / BENCH_MISMATCH.maxPairs : 1;
  const picked: Array<readonly [DateStr, string]> = [];
  for (let x = 0; Math.floor(x) < pairs.length && picked.length < BENCH_MISMATCH.maxPairs; x += step) {
    picked.push(pairs[Math.floor(x)]!);
  }
  const values = picked.map(([d, c]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`非法日期 ${d}`);
    if (!/^\d{5,6}\.(SH|SZ|BJ|HK)$/.test(c)) throw new Error(`非法代码 ${c}`);
    return `(DATE '${d}', '${c}')`;
  });
  const m = await wh.scalar<number | null>(
    `SELECT median(f.mcap_rank) FROM (VALUES ${values.join(", ")}) s(d, c)
     JOIN factors_daily f ON f.code = s.c AND f.date = s.d`,
  );
  return m === null || m === undefined || !Number.isFinite(Number(m)) ? null : Number(m);
}

/**
 * 「基准可能不匹配」（bench_mismatch，info）：selections 是各决策日的名单（按名次），只看前 top 只。
 * 不匹配时返回一条提示，否则 null。
 */
export async function benchMismatchCaveat(
  wh: Warehouse,
  spec: StrategySpec,
  selections: ReadonlyMap<DateStr, readonly string[]>,
): Promise<Check | null> {
  if (spec.mode !== "rules" || !spec.rank) return null;
  const key = benchmarkOf(spec);
  const lines: string[] = [];
  const rankCheck = (spec.market === "A" && key === "csi300") || (spec.market === "HK" && key === "hsi");
  if (rankCheck) {
    const pairs: Array<readonly [DateStr, string]> = [];
    for (const [d, list] of selections) for (const c of list.slice(0, spec.rank.top)) pairs.push([d, c]);
    const median = await selectedMedianMcapRank(wh, pairs);
    if (median !== null && spec.market === "A") {
      const suggestion =
        median > BENCH_MISMATCH.csi1000Rank ? "中证1000" : median > BENCH_MISMATCH.csi500Rank ? "中证500" : null;
      if (suggestion) {
        lines.push(
          `持仓中位市值排名约第 ${rankText(median)} 名，沪深300 可能不是合适的比较基准，可试试${suggestion}`,
        );
      }
    }
    if (median !== null && spec.market === "HK" && median > BENCH_MISMATCH.hkSmallRank) {
      lines.push("持仓多是中小盘，恒指可能不是合适的比较基准");
    }
  }
  if (spec.market === "A" && key !== "csi_div" && dividendWeightShare(spec) >= BENCH_MISMATCH.dividendShare) {
    lines.push("排序主要看股息率，可以和中证红利全收益比一比");
  }
  if (!lines.length) return null;
  return { id: "bench_mismatch", level: "info", title: "基准可能不匹配", detail: `${lines.join("；")}。` };
}

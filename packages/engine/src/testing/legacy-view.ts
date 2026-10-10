/**
 * 1.1.0 结果视图（D56，冻结）：只取引擎 1.1.0 已有的字段，金标准对它求指纹。
 * 之后的切片可以给结果加字段，这里永远不投影新字段；旧口径必须让这个视图逐字节不变。
 */
import type { PeriodMetrics, SimResult } from "@ivan/core";

function pick<T extends object, K extends string>(o: T, keys: readonly K[]): Record<K, unknown> {
  const src = o as Record<string, unknown>;
  const out = {} as Record<K, unknown>;
  for (const k of keys) out[k] = src[k];
  return out;
}

const PERIOD_KEYS = [
  "start",
  "end",
  "days",
  "totalReturn",
  "benchReturn",
  "cagr",
  "benchCagr",
  "excessCagr",
  "excessTotal",
  "maxDrawdown",
  "volatility",
  "sharpe",
] as const;

const METRIC_KEYS = [
  ...PERIOD_KEYS,
  "drawdownPeak",
  "drawdownTrough",
  "drawdownRecovery",
  "calmar",
  "winRate",
  "avgHoldDays",
  "turnover",
  "fees",
  "costDrag",
  "buys",
  "sells",
  "avgExposure",
  "finalEquity",
] as const;

const period = (p: PeriodMetrics | null) => (p ? pick(p, PERIOD_KEYS) : null);

export function legacyView(r: SimResult) {
  return {
    series: r.series.map((p) => pick(p, ["date", "nav", "bench", "cash", "positions"])),
    trades: r.trades.map((t) =>
      pick(t, [
        "date",
        "code",
        "side",
        "price",
        "shares",
        "amount",
        "fee",
        "reason",
        "pnl",
        "holdDays",
      ]),
    ),
    holdings: r.holdings.map((h) => ({
      date: h.date,
      items: h.items.map((x) => pick(x, ["code", "weight"])),
    })),
    metrics: {
      ...pick(r.metrics, METRIC_KEYS),
      monthly: r.metrics.monthly.map((m) => pick(m, ["month", "ret", "bench"])),
      yearly: r.metrics.yearly.map((y) => pick(y, ["year", "ret", "bench"])),
    },
    segments: {
      inSample: period(r.segments.inSample),
      outOfSample: period(r.segments.outOfSample),
    },
    attribution: {
      byStock: r.attribution.byStock.map((s) =>
        pick(s, ["code", "name", "industry", "pnl", "trades"]),
      ),
      byIndustry: r.attribution.byIndustry.map((s) => pick(s, ["industry", "pnl", "avgWeight"])),
    },
    checks: r.checks.map((c) => pick(c, ["id", "level", "title", "detail"])),
    final: {
      date: r.final.date,
      cash: r.final.cash,
      equity: r.final.equity,
      positions: r.final.positions.map((p) =>
        pick(p, [
          "code",
          "name",
          "shares",
          "value",
          "weight",
          "entryDate",
          "entryPrice",
          "ret",
          "cost",
        ]),
      ),
      pending: r.final.pending.map((p) => pick(p, ["code", "name", "side", "reason"])),
      exposure: r.final.exposure ? pick(r.final.exposure, ["current", "next"]) : undefined,
    },
  };
}

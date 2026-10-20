/**
 * 对话分析工具的内部接口（spec 20261020，D99–D104）：走势、对比、大盘、行业、因子历史、财报。
 * 全部只读、只读已提交的数据（D60）；参数不对或找不到时 AnalyticsError → 4xx 中文原因（onError 里转）。
 * 今天这个市场的更新失败了（stale）时在 notes 最前面写明「数据没更新」，免得模型把旧数据说成今天的。
 */
import type { Market, PeriodInput } from "@ivan/core";
import {
  AnalyticsError,
  compareSecurities,
  factorHistory,
  financialHistory,
  industryPerformance,
  marketOverview,
  priceHistory,
} from "@ivan/data";
import type { Hono } from "hono";
import { env } from "./env.ts";
import { marketDayStatus } from "./market-day.ts";

type Body = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const market = (v: unknown): Market => {
  if (v === "A" || v === "HK") return v;
  throw new AnalyticsError(400, "market 只能是 A 或 HK");
};

async function body(c: { req: { json: () => Promise<unknown> } }): Promise<Body> {
  const b: unknown = await c.req.json().catch(() => ({}));
  if (!b || typeof b !== "object" || Array.isArray(b))
    throw new AnalyticsError(400, "请求体要是一个对象");
  return b as Body;
}

/** 今天这个市场的数据没更新成功：写在 notes 最前面 */
async function staleNotes(markets: Market[]): Promise<string[]> {
  const out: string[] = [];
  for (const m of [...new Set(markets)]) {
    if ((await marketDayStatus(m)) === "stale")
      out.push(
        `今天${m === "HK" ? "港股" : " A 股"}的数据没更新成功，下面用的是之前已提交的数据。`,
      );
  }
  return out;
}

export function registerAnalytics(app: Hono): void {
  app.post("/internal/analytics/price-history", async (c) => {
    const b = await body(c);
    const query = str(b.query);
    if (!query) throw new AnalyticsError(400, "要查哪只股票或哪个指数？");
    const r = await priceHistory(env().wh, {
      query,
      period: str(b.period) as PeriodInput | null,
      from: str(b.from),
      to: str(b.to),
      benchmark: str(b.benchmark),
    });
    r.notes.unshift(...(await staleNotes([r.market])));
    return c.json(r);
  });

  app.post("/internal/analytics/compare", async (c) => {
    const b = await body(c);
    const queries = Array.isArray(b.queries)
      ? b.queries.filter((x): x is string => typeof x === "string")
      : [];
    const r = await compareSecurities(env().wh, {
      queries,
      period: str(b.period) as PeriodInput | null,
      from: str(b.from),
      to: str(b.to),
    });
    r.notes.unshift(...(await staleNotes(r.items.map((i) => i.market))));
    return c.json(r);
  });

  app.post("/internal/analytics/market", async (c) => {
    const b = await body(c);
    const r = await marketOverview(env().wh, { market: market(b.market), date: str(b.date) });
    r.notes.unshift(...(await staleNotes([r.market])));
    return c.json(r);
  });

  app.post("/internal/analytics/industries", async (c) => {
    const b = await body(c);
    const level = b.level === "l2" ? "l2" : "l1";
    const r = await industryPerformance(env().wh, {
      market: market(b.market),
      period: str(b.period) as PeriodInput | null,
      from: str(b.from),
      to: str(b.to),
      level,
      industry: str(b.industry),
      sort: str(b.sort),
      limit: num(b.limit),
    });
    r.notes.unshift(...(await staleNotes([r.market])));
    return c.json(r);
  });

  app.post("/internal/analytics/factor-history", async (c) => {
    const b = await body(c);
    const query = str(b.query);
    if (!query) throw new AnalyticsError(400, "要查哪只股票？");
    const factors = Array.isArray(b.factors)
      ? b.factors.filter((x): x is string => typeof x === "string")
      : null;
    const r = await factorHistory(env().wh, {
      query,
      factors,
      period: str(b.period) as PeriodInput | null,
      from: str(b.from),
      to: str(b.to),
    });
    r.notes.unshift(...(await staleNotes([r.instrument.market])));
    return c.json(r);
  });

  app.post("/internal/analytics/financials", async (c) => {
    const b = await body(c);
    const query = str(b.query);
    if (!query) throw new AnalyticsError(400, "要查哪只股票？");
    const r = await financialHistory(env().wh, {
      query,
      periods: num(b.periods),
      annualOnly: b.annualOnly === true,
    });
    return c.json(r);
  });
}

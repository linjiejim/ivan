/**
 * worker 内部接口（只监听 127.0.0.1，带共享密钥）：server 所有行情查询都经这里（D3）。
 */
import { type Market, toCode, validateSpec } from "@ivan/core";
import {
  captureStatus,
  committedAsOf,
  dataVersionState,
  FACTOR_COLUMNS,
  latestDataVersion,
  screenOn,
  sqlCodeList,
  weakRegimeDates,
} from "@ivan/data";
import { computeBlocked, jobs } from "@ivan/db";
import { and, desc, eq, like } from "drizzle-orm";
import { Hono } from "hono";
import { env, todayOf } from "./env.ts";
import { marketDayStatus } from "./market-day.ts";
import { wake } from "./runner.ts";

export function createInternalApp() {
  const app = new Hono();

  app.use("/internal/*", async (c, next) => {
    if (c.req.header("x-internal-secret") !== env().cfg.internalSecret) {
      return c.json({ error: "forbidden" }, 403);
    }
    return next();
  });
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  // 维护状态（行情仓还没升级到第 3 版，D76）：读行情仓的接口一律 503；健康检查、数据状态、唤醒照常
  const maintenanceSafe = new Set([
    "/internal/health",
    "/internal/jobs/kick",
    "/internal/data-status",
  ]);
  app.use("/internal/*", async (c, next) => {
    const m = env().wh.maintenance;
    if (m && !maintenanceSafe.has(c.req.path)) return c.json({ error: m }, 503);
    return next();
  });

  // 部署健康检查只看 200：维护状态也是「活着」，带上说明
  app.get("/internal/health", (c) => c.json({ ok: true, maintenance: env().wh.maintenance }));

  app.post("/internal/jobs/kick", (c) => {
    wake();
    return c.json({ ok: true });
  });

  app.get("/internal/data-status", async (c) => {
    const { wh, app: db } = env();
    const blocked = computeBlocked(db.sqlite);
    const computePaused = blocked ? { reason: blocked.kind, since: blocked.since } : null;
    if (wh.maintenance) return c.json({ markets: [], maintenance: wh.maintenance, computePaused });
    const markets = [];
    for (const m of ["A", "HK"] as Market[]) {
      const v = await latestDataVersion(wh, m);
      const last = db.db
        .select({ status: jobs.status, finishedAt: jobs.finishedAt, error: jobs.error })
        .from(jobs)
        .where(and(eq(jobs.kind, "etl"), like(jobs.payload, `%"market":"${m}"%`)))
        .orderBy(desc(jobs.createdAt))
        .get();
      markets.push({
        market: m,
        asOf: v.asOf,
        dataVersion: v.id,
        lastEtl: last ?? null,
        // 今天的状态（D78）：已更新 / 休市 / 没更新 / 进行中
        day: await marketDayStatus(m),
        // 正在写的版本、上一个版本的结果（D60）
        ...(await dataVersionState(wh, m)),
        // 点时数据的采集情况（D61）
        capture: await captureStatus(wh, m, todayOf()),
      });
    }
    return c.json({ markets, maintenance: null, computePaused });
  });

  app.post("/internal/screen", async (c) => {
    const b = (await c.req.json()) as { spec: unknown; date?: string; limit?: number };
    const v = validateSpec(b.spec);
    if (!v.spec) return c.json({ error: v.errors.join("；") }, 400);
    const { wh } = env();
    // 默认选最新的已提交交易日（D60），不读还没提交的数据
    const date = b.date ?? (await committedAsOf(wh, v.spec.market));
    if (!date) return c.json({ error: "行情仓还没有数据" }, 400);
    const rows = await screenOn(wh, v.spec, date, Math.min(Math.max(b.limit ?? 30, 1), 100));
    // 按大盘状态切换排序的策略（D53）：告诉前端这天用的是哪套排序
    const regime = v.spec.rank?.regime
      ? (await weakRegimeDates(wh, v.spec.market, [date], v.spec.rank.regime.ma)).has(date)
        ? "weak"
        : "strong"
      : null;
    return c.json({ date, rows, regime });
  });

  app.get("/internal/securities/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    const market = c.req.query("market");
    if (!q) return c.json([]);
    const { wh } = env();
    const rows = await wh.all(
      `SELECT code, name, market, board, industry, list_date::VARCHAR AS list_date, delist_date::VARCHAR AS delist_date
       FROM securities
       WHERE (code ILIKE $q OR name ILIKE $q) ${market === "A" || market === "HK" ? "AND market = $m" : ""}
       ORDER BY delist_date IS NOT NULL, code LIMIT 20`,
      market === "A" || market === "HK" ? { q: `%${q}%`, m: market } : { q: `%${q}%` },
    );
    return c.json(rows);
  });

  /** 个股卡：最新因子 + 最近几期财报 + 最近的分红送转 */
  app.get("/internal/securities/:code", async (c) => {
    let code: string;
    try {
      code = toCode(c.req.param("code"));
    } catch {
      return c.json({ error: "代码不对" }, 400);
    }
    const { wh } = env();
    const sec = await wh.one(
      `SELECT code, name, market, board, industry_l1, industry, lot_size,
              list_date::VARCHAR AS list_date, delist_date::VARCHAR AS delist_date
       FROM securities WHERE code = $c`,
      { c: code },
    );
    if (!sec) return c.json({ error: `找不到 ${code}` }, 404);
    const factors = await wh.one(
      `SELECT date::VARCHAR AS date, close, ${FACTOR_COLUMNS.join(", ")}
       FROM factors_daily WHERE code IN (${sqlCodeList([code])}) ORDER BY date DESC LIMIT 1`,
    );
    const financials = await wh.all(
      `SELECT report_date::VARCHAR AS report_date, period, eff_date::VARCHAR AS eff_date, currency,
              revenue, np, deducted_np, revenue_yoy, np_yoy, deducted_np_yoy, roe, gross_margin, debt_ratio
       FROM financials WHERE code = $c ORDER BY report_date DESC LIMIT 8`,
      { c: code },
    );
    const actions = await wh.all(
      `SELECT date::VARCHAR AS date, prev_close, ref_price, cash, split
       FROM corp_actions WHERE code = $c ORDER BY date DESC LIMIT 6`,
      { c: code },
    );
    return c.json({ security: sec, factors: factors ?? null, financials, actions });
  });

  return app;
}

/**
 * 个股证据（D67）：「为什么那天选了它」只用决策日当时可得的数据回答。
 * 决策日 = 成交日在交易日历上的前一个交易日（成交记录上的日期是次日开盘的成交日，用它的收盘价就是偷看一天）。
 * 带回测、策略版本或跟踪时，再用和回测同一条 SQL 解释它在策略里排第几、没满足哪条。计入 analyses 额度（D59）。
 * 带跟踪与日期、而那晚有计划快照时（D68），先给第 1 版计划里这只股票的记录（当晚用户看到的、存的是当时的因子值），
 * 证据卡只作补充，不再按现在的数据重新解释名次。
 */
import { isDateStr, type StrategySpec, specFactorKeys, toCode } from "@ivan/core";
import { AppError } from "../lib/errors.ts";
import { consume } from "../lib/quota.ts";
import { worker } from "../lib/worker-client.ts";
import { type PlanRecord, planRecordFor } from "./plans.ts";
import { runSpecContext } from "./runs.ts";
import { getVersion } from "./strategies.ts";
import { trackingVersionId } from "./trackings.ts";

/** worker 返回的证据条目（与 @ivan/data 的 EvidenceItem 同形） */
export interface EvidenceItem {
  group: "price" | "valuation" | "financial" | "status" | "quality";
  key: string;
  label: string;
  value: number | string | boolean | null;
  unit?: string;
  asOf: string;
  availDate: string;
  ref: {
    table: string;
    key: Record<string, string | number>;
    src: string | null;
    ver: number | null;
  };
  note?: string;
}

export interface EvidenceCaveat {
  id: string;
  level: "info" | "warn";
  title: string;
}

export interface SecurityDossier {
  evidenceVersion: number;
  code: string;
  name: string | null;
  market: "A" | "HK";
  asOf: string;
  dataDate: string;
  dataVersion: { id: number | null; asOf: string | null };
  items: EvidenceItem[];
  caveats: EvidenceCaveat[];
  hash: string;
}

interface CodeExplain {
  code: string;
  hasData: boolean;
  passed: boolean;
  failed: string[];
  rank: number | null;
  cappedOut: boolean;
  score: number | null;
  termPct: Record<string, number> | null;
}

interface SelectionExplain {
  date: string;
  regime: "strong" | "weak" | null;
  limit: number;
  codes: CodeExplain[];
}

/** 名次落在哪一段：前 top 名（会买入）/ 缓冲区内（已持有就继续拿）/ 缓冲区外 */
export type EvidenceBand = "top" | "buffer" | "out";

export interface EvidenceStrategy {
  source: "run" | "version" | "tracking";
  versionId: string;
  name: string;
  date: string;
  regime: "strong" | "weak" | null;
  passed: boolean;
  failed: string[];
  rank: number | null;
  score: number | null;
  termPct: Record<string, number> | null;
  band: EvidenceBand | null;
  top: number;
  /** 持仓掉出前 hold 名才卖（top × buffer） */
  hold: number;
}

export interface SecurityEvidence {
  /** 那晚第 1 版计划里这只股票的记录（带跟踪与日期且有快照时）；有它时 strategy 为空 */
  planRecord: PlanRecord | null;
  dossier: SecurityDossier;
  decision: { decisionDate: string; tradeDate: string | null };
  strategy: EvidenceStrategy | null;
  caveats: EvidenceCaveat[];
}

export interface EvidenceQuery {
  decisionDate?: string;
  tradeDate?: string;
  runId?: string;
  versionId?: string;
  trackingId?: string;
}

interface StrategyContext {
  source: EvidenceStrategy["source"];
  versionId: string;
  name: string;
  spec: StrategySpec;
  caveat: (currentDataVersion: number | null) => EvidenceCaveat | null;
}

/** 策略内容：回测（扫描子回测用它自己的 specOverride）> 策略版本 > 跟踪的策略版本；都校验归属 */
function strategyContext(userId: string, q: EvidenceQuery): StrategyContext | null {
  if (q.runId) {
    const r = runSpecContext(userId, q.runId);
    return {
      source: "run",
      versionId: r.versionId,
      name: r.name,
      spec: r.spec,
      caveat: (cur) =>
        !r.hasCard
          ? {
              id: "run_data_revised",
              level: "warn",
              title: "这次回测早于数据版本记录，名次可能和当时不同",
            }
          : r.cardDataVersionId !== cur
            ? {
                id: "run_data_revised",
                level: "warn",
                title: "这次回测之后数据修订过，名次可能和当时不同",
              }
            : null,
    };
  }
  const versionId = q.versionId ?? (q.trackingId ? trackingVersionId(userId, q.trackingId) : null);
  if (!versionId) return null;
  const { strategy, version } = getVersion(userId, versionId);
  return {
    source: q.versionId ? "version" : "tracking",
    versionId,
    name: strategy.name,
    spec: version.spec,
    caveat: () => null,
  };
}

function bandOf(rank: number | null, top: number, hold: number): EvidenceBand | null {
  if (rank === null) return null;
  return rank <= top ? "top" : rank <= hold ? "buffer" : "out";
}

export async function securityEvidence(
  userId: string,
  codeIn: string,
  q: EvidenceQuery,
): Promise<SecurityEvidence> {
  let code: string;
  try {
    code = toCode(codeIn);
  } catch {
    throw new AppError(400, "代码不对");
  }
  for (const d of [q.decisionDate, q.tradeDate]) {
    if (d && !isDateStr(d)) throw new AppError(400, "日期格式要是 YYYY-MM-DD");
  }
  const market = code.endsWith(".HK") ? "HK" : "A";
  const ctx = strategyContext(userId, q);
  if (ctx && ctx.spec.market !== market) {
    throw new AppError(400, "这只股票和策略不在同一个市场");
  }
  consume(userId, "analyses");

  // 决策日：给了决策日就用；只给成交日时取交易日历上它的前一个交易日；都没给 = 最新的已提交数据日
  let decisionDate = q.decisionDate;
  if (!decisionDate && q.tradeDate) {
    const r = await worker.get<{ prev: string | null }>(
      `/internal/calendar/prev?market=${market}&date=${q.tradeDate}`,
    );
    if (!r.prev) throw new AppError(400, `${q.tradeDate} 之前没有交易日数据`);
    decisionDate = r.prev;
  }
  const factorKeys = ctx ? specFactorKeys(ctx.spec) : [];
  const params = new URLSearchParams();
  if (decisionDate) params.set("asOf", decisionDate);
  if (factorKeys.length) params.set("factors", factorKeys.join(","));
  const dossier = await worker.get<SecurityDossier>(
    `/internal/securities/${encodeURIComponent(code)}/dossier?${params}`,
  );

  const caveats = [...dossier.caveats];
  // 跟踪那晚的计划快照（D68）：按决策日找第 1 版，只给成交日时也按计划日找
  const planRecord =
    q.trackingId && (decisionDate || q.tradeDate)
      ? planRecordFor(userId, q.trackingId, code, {
          decisionDate: decisionDate ?? null,
          planDate: q.tradeDate ?? null,
        })
      : null;
  let strategy: EvidenceStrategy | null = null;
  if (ctx && !planRecord) {
    const extra = ctx.caveat(dossier.dataVersion.id);
    if (extra) caveats.push(extra);
    const rank = ctx.spec.rank;
    if (ctx.spec.mode !== "rules" || !rank) {
      caveats.push({ id: "signals_mode", level: "info", title: "信号模式的策略没有选股排名" });
    } else {
      // 同一条 SQL 解释（D67）：日期用证据的决策日（已截到已提交的截至日）
      const ex = await worker.post<SelectionExplain>("/internal/explain", {
        spec: ctx.spec,
        date: dossier.asOf,
        codes: [code],
      });
      const c = ex.codes[0];
      const hold = Math.ceil(rank.top * ctx.spec.rebalance.buffer);
      strategy = {
        source: ctx.source,
        versionId: ctx.versionId,
        name: ctx.name,
        date: ex.date,
        regime: ex.regime,
        passed: c?.passed ?? false,
        failed: c?.failed ?? [],
        rank: c?.rank ?? null,
        score: c?.score ?? null,
        termPct: c?.termPct ?? null,
        band: bandOf(c?.rank ?? null, rank.top, hold),
        top: rank.top,
        hold,
      };
    }
  }
  return {
    planRecord,
    dossier,
    decision: { decisionDate: dossier.asOf, tradeDate: q.tradeDate ?? null },
    strategy,
    caveats,
  };
}

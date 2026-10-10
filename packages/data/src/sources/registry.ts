/**
 * 数据源注册表与回退链（D72）。默认链按封禁风险排序：东财（串行 0.6 秒）在前，容易触发 WAF 的腾讯在后。
 *
 * 配置只能重排、不能增删：`IVAN_CHAIN_<能力>_<市场>=tencent,eastmoney` 必须恰好是默认集合的一个排列，
 * 否则日志「数据源顺序配置无效，沿用默认顺序」并用默认链。`KLINE_SOURCE=tencent|eastmoney` 是显式单一来源，
 * 对日线与指数生效、不回退（开发机 IP 被某家封禁时用）。全收益基准仍走中证官网与 ETF 两条专用路径。
 */
import type { Market } from "@ivan/core";
import { csindexAdapter } from "./adapters/csindex.ts";
import { eastmoneyAdapter } from "./adapters/eastmoney.ts";
import { tencentAdapter } from "./adapters/tencent.ts";
import type { Capability, SourceAdapter, SourceId } from "./types.ts";

export const ADAPTERS: Record<SourceId, SourceAdapter> = {
  eastmoney: eastmoneyAdapter,
  tencent: tencentAdapter,
  csindex: csindexAdapter,
};

export const DEFAULT_CHAINS: Record<Capability, Record<Market, readonly SourceId[]>> = {
  bars: { A: ["eastmoney", "tencent"], HK: ["eastmoney", "tencent"] },
  quotes: { A: ["tencent"], HK: ["tencent"] },
  index: { A: ["eastmoney", "tencent"], HK: ["eastmoney", "tencent"] },
};

export const INVALID_CHAIN_TEXT = "数据源顺序配置无效，沿用默认顺序";

export interface ResolvedChain {
  cap: Capability;
  market: Market;
  adapters: SourceAdapter[];
  /** 显式单一来源（KLINE_SOURCE）：不回退 */
  explicit: boolean;
}

/** 按给定顺序组链（专用路径用，比如全收益基准只有中证官网一家） */
export function chainOf(
  cap: Capability,
  market: Market,
  ids: readonly SourceId[],
  explicit = false,
): ResolvedChain {
  return { cap, market, adapters: ids.map((id) => ADAPTERS[id]), explicit };
}

function samePermutation(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

/**
 * 某能力、某市场的回退链。env 默认 process.env；配置无效时调用 log（不传就不记）。
 */
export function resolveChain(
  cap: Capability,
  market: Market,
  env: Record<string, string | undefined> = process.env,
  log?: (msg: string) => void,
): ResolvedChain {
  const def = DEFAULT_CHAINS[cap][market];
  const single = env.KLINE_SOURCE?.trim().toLowerCase();
  if ((cap === "bars" || cap === "index") && single && single !== "auto") {
    if (single === "eastmoney" || single === "tencent") return chainOf(cap, market, [single], true);
    log?.(`${INVALID_CHAIN_TEXT}（KLINE_SOURCE=${env.KLINE_SOURCE}）`);
  }
  const key = `IVAN_CHAIN_${cap.toUpperCase()}_${market}`;
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return chainOf(cap, market, def);
  const ids = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!samePermutation(ids, def)) {
    log?.(`${INVALID_CHAIN_TEXT}（${key}=${raw}）`);
    return chainOf(cap, market, def);
  }
  return chainOf(cap, market, ids as SourceId[]);
}

const warned = new Set<string>();

/**
 * ETL 用的 resolveChain：同一份无效配置在一个进程里只记一次日志（日线是逐股取链的，不能每只都记）。
 */
export function chainFor(cap: Capability, market: Market, log: (msg: string) => void): ResolvedChain {
  return resolveChain(cap, market, process.env, (msg) => {
    if (warned.has(msg)) return;
    warned.add(msg);
    log(msg);
  });
}

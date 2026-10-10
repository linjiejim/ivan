/**
 * 数据源注册表与回退链（D72）。默认链按封禁风险排序：东财（串行 0.6 秒）在前，容易触发 WAF 的腾讯在后。
 *
 * 配置只能重排、不能增删：`IVAN_CHAIN_<能力>_<市场>=tencent,eastmoney` 必须恰好是默认集合的一个排列，
 * 否则日志「数据源顺序配置无效，沿用默认顺序」并用默认链。`KLINE_SOURCE=tencent|eastmoney` 是显式单一来源，
 * 对日线与指数生效、不回退（开发机 IP 被某家封禁时用）。全收益基准仍走中证官网与 ETF 两条专用路径。
 */
import type { Market, PitDatasetId } from "@ivan/core";
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
  // 点时事件数据只有 A 股；各数据集的链见 DEFAULT_EVENT_CHAINS
  events: { A: ["eastmoney"], HK: [] },
};

/**
 * 点时事件数据集的默认链（D81）：本轮每个数据集只有东财。三期接 Tushare 的解禁时实现同名 fetcher、追加到这里即可。
 */
export const DEFAULT_EVENT_CHAINS: Record<PitDatasetId, readonly SourceId[]> = {
  margin: ["eastmoney"],
  holders: ["eastmoney"],
  lockups: ["eastmoney"],
  blocks: ["eastmoney"],
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

/** 显式单一来源（KLINE_SOURCE，去空格、不分大小写）：eastmoney | tencent，其余（含 auto、没设）为 null */
export function klineSingleSource(
  env: Record<string, string | undefined> = process.env,
): "eastmoney" | "tencent" | null {
  const v = env.KLINE_SOURCE?.trim().toLowerCase();
  return v === "eastmoney" || v === "tencent" ? v : null;
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

/**
 * 某个事件数据集的链：`IVAN_CHAIN_EVENTS_MARGIN=...` 这类变量照同样的规矩只能重排，无效时沿用默认并记日志。
 * 链上没实现这个数据集的来源会被去掉。
 */
export function resolveEventChain(
  id: PitDatasetId,
  env: Record<string, string | undefined> = process.env,
  log?: (msg: string) => void,
): ResolvedChain {
  const def = DEFAULT_EVENT_CHAINS[id];
  const key = `IVAN_CHAIN_EVENTS_${id.toUpperCase()}`;
  const raw = env[key];
  let ids: readonly SourceId[] = def;
  if (raw !== undefined && raw.trim() !== "") {
    const asked = raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (samePermutation(asked, def)) ids = asked as SourceId[];
    else log?.(`${INVALID_CHAIN_TEXT}（${key}=${raw}）`);
  }
  return chainOf(
    "events",
    "A",
    ids.filter((s) => ADAPTERS[s].events?.[id]),
  );
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

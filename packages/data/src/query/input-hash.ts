/**
 * 输入指纹（D57）：对组装好的回测输入（选股、价格面板、基准）做流式 sha256，截到 cut 为止。
 *
 * - 必须在 runSimulation 之前算：转交给回测线程会让 TypedArray 的底层内存失效。
 * - 检查项说明（dataCaveats）与试错次数不进指纹：它们是报告，运行卡另记 caveatsHash。
 * - 组成或 resolveExec 的输出形状一变，HASH_VERSION 就加 1（S04 升到 2：上市日、规则表 / 指标版本）；口径版本不同的两个指纹不比，
 *   归因记「早于记录」，不误报数据修订。
 *
 * 纳入规则 rule：
 * - all（默认，回测与复核用）：决策日 ≤ cut；
 * - executed（跟踪前缀用）：决策日的执行日（日历上的下一个交易日）≤ cut。这样「今晚 cut = 昨天」与
 *   「昨晚 cut = 昨天」纳入的决策完全相同，不受「昨天是不是周末前最后一个交易日」这类边界影响。
 */
import {
  canonicalJson,
  type DateStr,
  resolveExec,
  type SecurityInfo,
  type SimInput,
} from "@ivan/core";
import { sha256Canonical, Sha256Stream } from "@ivan/core/node";

/**
 * 指纹口径版本。1 = R1（S02）；2 = R2（S04）：证券信息加上市日、resolveExec 多了 rules / metrics
 * （S05 的 adv / sigma 在同一批上线，一起算在 2 里）。
 */
export const HASH_VERSION = 2;

export type HashRule = "all" | "executed";

export interface InputHashes {
  hashVersion: number;
  inputHash: string;
  selectionHash: string;
  priceHash: string;
  benchHash: string;
  cut: DateStr;
  rule: HashRule;
}

/** 日历上第一个 > d 的下标（d 的下一个交易日；没有就是 calendar.length） */
function nextIdx(calendar: readonly DateStr[], d: DateStr): number {
  let lo = 0;
  let hi = calendar.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (calendar[mid]! <= d) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function securityView(s: SecurityInfo | undefined): unknown {
  if (!s) return null;
  const v: Record<string, unknown> = {
    name: s.name,
    board: s.board,
    lotSize: s.lotSize,
    industry: s.industry,
    delistDate: s.delistDate ?? null,
  };
  if (s.listDate !== undefined) v.listDate = s.listDate;
  return v;
}

export function hashSimInput(
  input: SimInput,
  opts: { cut?: DateStr; rule?: HashRule } = {},
): InputHashes {
  const cut = opts.cut ?? input.params.end;
  const rule = opts.rule ?? "all";
  const { calendar } = input;
  // 最后一个 ≤ cut 的交易日下标（没有就是 -1）
  const cutIdx = nextIdx(calendar, cut) - 1;
  const included = (d: DateStr) => (rule === "all" ? d <= cut : nextIdx(calendar, d) <= cutIdx);

  // 选股：纳入的决策日按日期排序，名单保持原顺序（顺序就是排名）
  const sel = new Sha256Stream();
  const codes = new Set<string>();
  for (const d of [...input.selections.keys()].filter(included).sort()) {
    const list = input.selections.get(d)!;
    sel.update(`${d}\n${list.join(",")}\n`);
    for (const c of list) codes.add(c);
  }
  const signals = (input.signals ?? [])
    .filter((s) => included(s.date))
    .sort((a, b) => (a.date === b.date ? (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) : a.date < b.date ? -1 : 1));
  sel.update("#signals\n");
  for (const s of signals) {
    sel.update(`${s.date},${s.code}\n`);
    codes.add(s.code);
  }

  // 价格：上面这些代码排序后，逐只写起点、长度、证券信息与截到 cut 的原始字节
  const px = new Sha256Stream();
  for (const code of [...codes].sort()) {
    const p = input.prices.get(code);
    if (!p) continue;
    const len = Math.max(0, Math.min(cutIdx - p.from + 1, p.close.length));
    px.update(`${code}:${p.from}:${len}\n`);
    px.update(`${canonicalJson(securityView(input.securities.get(code)))}\n`);
    for (const arr of [p.open, p.high, p.low, p.close, p.adj, p.st]) px.update(arr.subarray(0, len));
    // 按流动性成交（D64）才有的日均成交额、波动率：存在才算
    if (p.adv) px.update("adv").update(p.adv.subarray(0, len));
    if (p.sigma) px.update("sigma").update(p.sigma.subarray(0, len));
  }

  // 基准：截到 cut 的日历、名称与收盘字节
  const bn = new Sha256Stream();
  const n = Math.max(0, cutIdx + 1);
  bn.update(`${calendar.slice(0, n).join(",")}\n${input.benchLabel}\n`);
  bn.update(input.bench.subarray(0, Math.min(n, input.bench.length)));

  const selectionHash = sel.digest();
  const priceHash = px.digest();
  const benchHash = bn.digest();
  const inputHash = sha256Canonical({
    hashVersion: HASH_VERSION,
    spec: input.spec,
    start: input.params.start,
    capital: input.params.capital,
    exec: resolveExec(input.params.exec),
    cut,
    rule,
    selectionHash,
    priceHash,
    benchHash,
  });
  return { hashVersion: HASH_VERSION, inputHash, selectionHash, priceHash, benchHash, cut, rule };
}

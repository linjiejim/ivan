/**
 * 东财的点时事件数据集实现（D80–D82）：报表名、列清单、禁用列、过滤串、翻页与单位自检**只在这里**，
 * 运行器（etl/pit-runner.ts）只认 PitFetcher 与规范化的行。
 *
 * - 只请求列清单里的列，从不用 ALL；用最新价算的市值、最新价、事后涨跌这些列在请求里就禁用（模块加载时断言）；
 * - 每块翻完所有页（单页 500），核对行数与重复行，对不上换个单页行数重取一次（emQueryPagedChecked）；
 *   两次取到一模一样的重复行算真有重复（大宗可能有几笔完全相同的成交）；
 * - 请求过的键在返回行里缺了 → SchemaDriftError（和 9501「字段不存在」一样算结构变了）；
 * - 金丝雀：每个报表一次请求、取前 CANARY_SAMPLE_ROWS 行、同一份列常量，用第一行字段齐全的做单位自检
 *   （样本行缺值不算单位变了，不关掉数据集）；两融取 600519.SH 最近一条已公布的（T 日的两融下一个交易日早上才公布）；
 * - 解禁的占流通比例按股数自己算（本次 ÷ 解禁前的流通股），不用 FREE_RATIO（它的分母过了解禁日会变）。
 */
import { addDays, type DateStr, type PitDatasetId } from "@ivan/core";
import { BlockedError } from "../../http.ts";
import {
  emCountCols,
  emQuery,
  emQueryPagedChecked,
  type EmRow,
  num,
  SchemaDriftError,
  str,
} from "../eastmoney.ts";
import type {
  BlockRow,
  CanaryResult,
  HolderRow,
  LockupRow,
  MarginRow,
  PitChunk,
  PitFetcher,
  PitFetchResult,
  SourceCtx,
} from "../types.ts";

/** 全局禁用：事后涨跌、事后复权涨跌、按最新价算的解禁市值、最新价 */
export const GLOBAL_FORBIDDEN_RE = /^(CHANGE_RATE_\d+DAYS|[AB]\d+_ADJCHRATE|A?LIFT_MARKET_CAP|NEW)$/;

export interface EmEventDef<R> {
  id: PitDatasetId;
  label: string;
  report: string;
  /** 只请求这些列（金丝雀、正式抓取、计数请求共用） */
  columns: readonly string[];
  /** 这个报表里明确禁用的列 */
  forbidden: readonly string[];
  /** 完整、唯一的排序（翻页才不会重一行、丢一行） */
  sort: readonly string[];
  /** 窗口过滤（chunk 的 from / to 已校验过格式） */
  filter(from: DateStr, to: DateStr): string;
  /** 规范化一行；null = 跳过（比如没有公告日的户数） */
  mapRow(r: EmRow): R | null;
  /** 金丝雀的样本：过滤、排序、是否允许为空 */
  canary(today: DateStr, prevTd: DateStr): { filter: string; sort: readonly string[]; asc: boolean };
  emptyOk: boolean;
  /**
   * 单位自检：对得上返回 null；对不上返回 { drift }；这一行缺了要核对的字段（最新的解禁常缺 FREE_RATIO）返回 { missing }，
   * 缺值不是单位变了，金丝雀换下一行样本核对
   */
  unitCheck(r: EmRow): { drift: string } | { missing: string } | null;
}

/** 列清单的断言：不能为空、不能是 ALL、不能含禁用列（模块加载时对四个报表各跑一次） */
export function assertColumns(def: Pick<EmEventDef<unknown>, "report" | "columns" | "forbidden">): void {
  if (!def.columns.length) throw new Error(`东财 ${def.report} 的列清单是空的`);
  for (const c of def.columns) {
    if (c.toUpperCase() === "ALL") throw new Error(`东财 ${def.report} 的列清单不能用 ALL`);
    if (def.forbidden.includes(c) || GLOBAL_FORBIDDEN_RE.test(c)) {
      throw new Error(`东财 ${def.report} 的列清单含禁用列 ${c}`);
    }
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkDate(d: DateStr): DateStr {
  if (!DATE_RE.test(d)) throw new Error(`非法日期 ${d}`);
  return d;
}

const day = (v: unknown): DateStr | null => {
  const s = str(v);
  return s && DATE_RE.test(s.slice(0, 10)) ? s.slice(0, 10) : null;
};

/** 请求过的键都要在（值可以是 null）：缺了就是结构变了 */
function requireKeys(def: Pick<EmEventDef<unknown>, "label" | "columns">, r: EmRow): void {
  for (const k of def.columns) {
    if (!(k in r)) throw new SchemaDriftError(`${def.label}缺少字段 ${k}`, 9501);
  }
}

const range = (col: string) => (from: DateStr, to: DateStr) =>
  `(${col}>='${checkDate(from)}')(${col}<='${checkDate(to)}')`;

/**
 * 两融金丝雀从上一个交易日往前找多少个自然日：交易所 T 日的两融下一个交易日早上才公布，周末、长假里与开盘前
 * 上一个交易日还是空的（2026-10-10 周六实测 10-09 回 9201），所以取窗口里最近一条已公布的；15 天长假前后也够
 */
const MARGIN_CANARY_LOOKBACK_DAYS = 15;

export const MARGIN_DEF: EmEventDef<MarginRow> = {
  id: "margin",
  label: "两融明细",
  report: "RPTA_WEB_RZRQ_GGMX",
  columns: ["DATE", "SECUCODE", "RZYE", "RZMRE", "RZCHE", "RQYE", "RQYL", "SZ", "RZYEZB"],
  forbidden: [],
  sort: ["SECUCODE"],
  // 一个交易日一块
  filter: (from, to) =>
    from === to ? `(DATE='${checkDate(from)}')` : `(DATE>='${checkDate(from)}')(DATE<='${checkDate(to)}')`,
  mapRow(r) {
    const code = str(r.SECUCODE);
    const date = day(r.DATE);
    if (!code || !date) return null;
    return {
      code,
      date,
      rzye: num(r.RZYE),
      rzmre: num(r.RZMRE),
      rzche: num(r.RZCHE),
      rqye: num(r.RQYE),
      rqyl: num(r.RQYL),
      floatMcap: num(r.SZ),
      rzyezb: num(r.RZYEZB),
    };
  },
  // 600519.SH 最近一条已公布的（上一个交易日还没公布不算出错）
  canary: (today, prevTd) => ({
    filter: `${range("DATE")(addDays(checkDate(prevTd), -MARGIN_CANARY_LOOKBACK_DAYS), today)}(SECUCODE="600519.SH")`,
    sort: ["DATE"],
    asc: false,
  }),
  emptyOk: false,
  unitCheck(r) {
    const rzye = num(r.RZYE);
    const sz = num(r.SZ);
    const zb = num(r.RZYEZB);
    if (rzye === null || !sz || zb === null) return { missing: "样本行缺少融资余额或流通市值" };
    return Math.abs((rzye / sz) * 100 - zb) > 0.01 * Math.abs(zb)
      ? { drift: "融资余额占流通市值对不上（单位可能变了）" }
      : null;
  },
};

export const HOLDERS_DEF: EmEventDef<HolderRow> = {
  id: "holders",
  label: "股东户数",
  report: "RPT_HOLDERNUM_DET",
  columns: [
    "SECUCODE",
    "END_DATE",
    "HOLD_NOTICE_DATE",
    "HOLDER_NUM",
    "PRE_HOLDER_NUM",
    "PRE_END_DATE",
    "HOLDER_NUM_RATIO",
  ],
  forbidden: ["CLOSE_PRICE", "TOTAL_MARKET_CAP", "AVG_MARKET_CAP", "INTERVAL_CHRATE"],
  sort: ["HOLD_NOTICE_DATE", "SECUCODE", "END_DATE"],
  filter: range("HOLD_NOTICE_DATE"),
  mapRow(r) {
    const code = str(r.SECUCODE);
    const endDate = day(r.END_DATE);
    const noticeDate = day(r.HOLD_NOTICE_DATE);
    const holderNum = num(r.HOLDER_NUM);
    // 没有公告日的行没法点时使用；户数不是正数的是脏行
    if (!code || !endDate || !noticeDate || holderNum === null || holderNum <= 0) return null;
    return {
      code,
      endDate,
      noticeDate,
      holderNum,
      preHolderNum: num(r.PRE_HOLDER_NUM),
      preEndDate: day(r.PRE_END_DATE),
    };
  },
  canary: () => ({ filter: `(SECUCODE="600519.SH")`, sort: ["END_DATE"], asc: false }),
  emptyOk: false,
  unitCheck(r) {
    const cur = num(r.HOLDER_NUM);
    const pre = num(r.PRE_HOLDER_NUM);
    const ratio = num(r.HOLDER_NUM_RATIO);
    if (cur === null || !pre || ratio === null) return { missing: "样本行缺少户数或环比" };
    return Math.abs((cur / pre - 1) * 100 - ratio) > 0.01 ? { drift: "户数环比对不上（单位可能变了）" } : null;
  },
};

export const LOCKUPS_DEF: EmEventDef<LockupRow> = {
  id: "lockups",
  label: "限售解禁",
  report: "RPT_LIFT_STAGE",
  columns: [
    "SECUCODE",
    "FREE_DATE",
    "FREE_SHARES_TYPE",
    "CURRENT_FREE_SHARES",
    "ABLE_FREE_SHARES",
    "FREE_SHARES",
    "FREE_RATIO",
    "TOTAL_RATIO",
  ],
  forbidden: ["LIFT_MARKET_CAP", "ALIFT_MARKET_CAP", "NEW", "B20_ADJCHRATE", "A20_ADJCHRATE"],
  sort: ["FREE_DATE", "SECUCODE", "FREE_SHARES_TYPE"],
  filter: range("FREE_DATE"),
  mapRow(r) {
    const code = str(r.SECUCODE);
    const freeDate = day(r.FREE_DATE);
    if (!code || !freeDate) return null;
    // 股数列是万股
    const shares = (v: unknown) => {
      const n = num(v);
      return n === null ? null : n * 1e4;
    };
    const cur = num(r.CURRENT_FREE_SHARES);
    const after = num(r.FREE_SHARES);
    return {
      code,
      freeDate,
      type: str(r.FREE_SHARES_TYPE) ?? "未知",
      unlockShares: shares(r.CURRENT_FREE_SHARES),
      ableShares: shares(r.ABLE_FREE_SHARES),
      floatAfter: shares(r.FREE_SHARES),
      // 占流通比例按股数自己算、只用一个口径：本次解禁 ÷ 解禁前的流通股（FREE_SHARES 是解禁后的流通股）。
      // 不用 FREE_RATIO：解禁日过了东财改用解禁后的流通股当分母（同一行会被改写），照搬的话
      // 回填的历史与每晚记下的新解禁口径不一样（2026-10-10 实测，spec §16 实现备注）。股数缺了就为空
      ratioFloat: cur === null || after === null || after <= cur ? null : cur / (after - cur),
      ratioTotal: num(r.TOTAL_RATIO),
    };
  },
  canary: (today) => ({
    filter: range("FREE_DATE")(addDays(today, -400), today),
    sort: ["FREE_DATE"],
    asc: false,
  }),
  emptyOk: true,
  unitCheck(r) {
    const cur = num(r.CURRENT_FREE_SHARES);
    const after = num(r.FREE_SHARES);
    const ratio = num(r.FREE_RATIO);
    if (cur === null || after === null || ratio === null || after === cur) {
      return { missing: "样本行缺少解禁股数或比例" };
    }
    // FREE_RATIO 有两种分母：解禁日还没到是解禁前的流通股，= 本次 ÷（FREE_SHARES − 本次）；
    // 过了是解禁后的，= 本次 ÷ FREE_SHARES。和哪一种相差 ≤ 1% 都算对得上，两种都对不上才是单位变了
    const near = (den: number) => den > 0 && Math.abs(cur / den - ratio) <= 0.01 * Math.abs(ratio);
    return near(after) || near(after - cur) ? null : { drift: "解禁占流通比例对不上（单位可能变了）" };
  },
};

export const BLOCKS_DEF: EmEventDef<BlockRow> = {
  id: "blocks",
  label: "大宗交易",
  report: "RPT_DATA_BLOCKTRADE",
  columns: [
    "SECUCODE",
    "TRADE_DATE",
    "DEAL_PRICE",
    "CLOSE_PRICE",
    "PREMIUM_RATIO",
    "DEAL_VOLUME",
    "DEAL_AMT",
    "BUYER_NAME",
    "SELLER_NAME",
  ],
  forbidden: ["CHANGE_RATE_1DAYS", "CHANGE_RATE_5DAYS", "CHANGE_RATE_10DAYS", "CHANGE_RATE_20DAYS"],
  sort: ["TRADE_DATE", "SECUCODE", "DEAL_AMT", "DEAL_PRICE", "DEAL_VOLUME", "BUYER_NAME", "SELLER_NAME"],
  filter: range("TRADE_DATE"),
  mapRow(r) {
    const code = str(r.SECUCODE);
    const tradeDate = day(r.TRADE_DATE);
    if (!code || !tradeDate) return null;
    const dealPrice = num(r.DEAL_PRICE);
    const closePrice = num(r.CLOSE_PRICE);
    const premium =
      num(r.PREMIUM_RATIO) ?? (dealPrice !== null && closePrice ? dealPrice / closePrice - 1 : null);
    return {
      code,
      tradeDate,
      dealPrice,
      closePrice,
      premium,
      dealVolume: num(r.DEAL_VOLUME),
      dealAmount: num(r.DEAL_AMT),
      buyerInst: str(r.BUYER_NAME) === "机构专用",
      sellerInst: str(r.SELLER_NAME) === "机构专用",
    };
  },
  canary: (today) => ({
    filter: range("TRADE_DATE")(addDays(today, -30), today),
    sort: ["TRADE_DATE"],
    asc: false,
  }),
  emptyOk: true,
  unitCheck(r) {
    const price = num(r.DEAL_PRICE);
    const close = num(r.CLOSE_PRICE);
    const premium = num(r.PREMIUM_RATIO);
    if (price === null || !close || premium === null) return { missing: "样本行缺少成交价、收盘价或折溢价" };
    return Math.abs(price / close - 1 - premium) > 0.001 ? { drift: "大宗折溢价对不上（单位可能变了）" } : null;
  },
};

export const EM_EVENT_DEFS: Record<PitDatasetId, EmEventDef<unknown>> = {
  margin: MARGIN_DEF,
  holders: HOLDERS_DEF,
  lockups: LOCKUPS_DEF,
  blocks: BLOCKS_DEF,
};

// 模块加载时断言：列清单不空、不是 ALL、不含禁用列
for (const def of Object.values(EM_EVENT_DEFS)) assertColumns(def);

/** 错误说明里去掉 URL 与查询串（金丝雀详情要进管理页） */
function scrub(msg: string): string {
  return msg.replace(/https?:\/\/\S+/g, "（接口地址）").slice(0, 200);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function query<R>(def: EmEventDef<R>, from: DateStr, to: DateStr) {
  return { report: def.report, columns: def.columns.join(","), filter: def.filter(from, to), sort: def.sort, asc: true };
}

/** 整块取：翻页对不上重取一次，还不对就抛 PageDriftError（两次一模一样的重复行算真有重复，见 emQueryPagedChecked） */
async function fetchChunk<R>(
  def: EmEventDef<R>,
  sctx: SourceCtx,
  chunk: PitChunk,
): Promise<PitFetchResult<R>> {
  const paged = await emQueryPagedChecked(sctx.http, query(def, chunk.from, chunk.to), (e) =>
    sctx.log(`${def.label} ${chunk.id} 翻页结果对不上，重取一次：${e.message}`),
  );
  if (paged.duplicateRows) {
    sctx.log(`${def.label} ${chunk.id} 有 ${paged.duplicateRows} 行与别的行完全相同，两次取到的一样，按真有重复记录处理`);
  }
  const requests = paged.requests;
  const rows: R[] = [];
  let sh = 0;
  let sz = 0;
  for (const r of paged.rows) {
    requireKeys(def, r);
    const code = str(r.SECUCODE) ?? "";
    if (code.endsWith(".SH")) sh++;
    else if (code.endsWith(".SZ")) sz++;
    const m = def.mapRow(r);
    if (m) rows.push(m);
  }
  return {
    rows,
    rawCount: paged.rows.length,
    requests,
    ...(def.id === "margin" ? { byExchange: { sh, sz } } : {}),
  };
}

/** 金丝雀样本取几行：第一行缺字段时换下一行核对单位 */
export const CANARY_SAMPLE_ROWS = 5;

/**
 * 金丝雀（D82）：一次请求、同一份列常量，再做单位自检。取前 CANARY_SAMPLE_ROWS 行，用第一行字段齐全的核对单位；
 * 都缺字段时只说没能核对（缺值不是单位变了，不关掉这个数据集）
 */
async function canary<R>(
  def: EmEventDef<R>,
  sctx: SourceCtx,
  today: DateStr,
  prevTd: DateStr,
): Promise<CanaryResult> {
  const at = new Date().toISOString();
  const res = (status: CanaryResult["status"], detail: string): CanaryResult => ({
    status,
    source: "eastmoney",
    at,
    detail: scrub(detail),
  });
  try {
    const c = def.canary(today, prevTd);
    const rows = await emQuery(sctx.http, {
      report: def.report,
      columns: def.columns.join(","),
      filter: c.filter,
      sort: c.sort,
      asc: c.asc,
      pageSize: CANARY_SAMPLE_ROWS,
      maxRows: CANARY_SAMPLE_ROWS,
    });
    if (!rows.length) return def.emptyOk ? res("empty", "样本窗口里没有数据") : res("error", "样本没有返回数据");
    let missing = "";
    for (const r of rows) {
      requireKeys(def, r);
      const unit = def.unitCheck(r);
      if (unit === null) return res("ok", "字段与单位正常");
      if ("drift" in unit) return res("unit_drift", unit.drift);
      missing = unit.missing;
    }
    return res("ok", `字段正常；${missing}，没能核对单位`);
  } catch (e) {
    if (e instanceof SchemaDriftError) return res("schema_drift", errText(e));
    if (e instanceof BlockedError) return res("blocked", errText(e));
    return res("error", errText(e));
  }
}

function fetcherOf<R>(def: EmEventDef<R>): PitFetcher<R> {
  return {
    fetchChunk: (sctx, chunk) => fetchChunk(def, sctx, chunk),
    canary: (sctx, today, prevTd) => canary(def, sctx, today, prevTd),
    estimateRows: (sctx, from, to) => emCountCols(sctx.http, def.report, def.filter(from, to), def.columns),
  };
}

export const EASTMONEY_EVENTS: Record<PitDatasetId, PitFetcher<unknown>> = {
  margin: fetcherOf(MARGIN_DEF) as PitFetcher<unknown>,
  holders: fetcherOf(HOLDERS_DEF) as PitFetcher<unknown>,
  lockups: fetcherOf(LOCKUPS_DEF) as PitFetcher<unknown>,
  blocks: fetcherOf(BLOCKS_DEF) as PitFetcher<unknown>,
};

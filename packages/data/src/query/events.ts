/**
 * 个股的两融与筹码明细（S15b，D85）：`get_security_events` 工具与「两融与筹码」卡、证据弹窗的明细分页共用。
 * 只读 asOf 当时可得且没撤下的行（`avail_date ≤ asOf 且 (gone_from 为空 或 gone_from > asOf)`）；
 * asOf 默认并截到已提交的数据截至日，再落到交易日（和个股证据同一个决策日）。只有 A 股。
 */
import {
  type DateStr,
  EVENTS_A_ONLY_TEXT,
  isDateStr,
  type LockupAvailRule,
  PIT_DATASET_IDS,
  PIT_DATASETS,
  type PitDatasetId,
  SOFT_FAILING_ALERT,
} from "@ivan/core";
import { sha256Canonical } from "@ivan/core/node";
import type { Warehouse } from "../warehouse/db.ts";
import { type DataVersionInfo, lastTradingDay, latestDataVersion } from "./backtest.ts";
import { softStepStatus } from "./data-health.ts";
import { EvidenceError } from "./evidence.ts";

export { EVENTS_A_ONLY_TEXT };

export interface MarginRowView {
  date: DateStr;
  availDate: DateStr;
  /** 融资余额（元） */
  financingAmount: number | null;
  /** 融券余额（元） */
  shortAmount: number | null;
  /** 融资余额占流通市值（%） */
  marginRatio: number | null;
}

export interface HolderRowView {
  endDate: DateStr;
  noticeDate: DateStr;
  holderNum: number | null;
  /** 季末对上一季末的环比（%）；不是季末、或上一季末当时还没公告时为空 */
  qoqPct: number | null;
}

export interface LockupRowView {
  freeDate: DateStr;
  type: string;
  /** 解禁股数（股） */
  unlockShares: number | null;
  /** 解禁股数占解禁前流通股（%） */
  ratioFloatPct: number | null;
  availDate: DateStr;
  availRule: LockupAvailRule | string;
}

export interface BlockRowView {
  tradeDate: DateStr;
  availDate: DateStr;
  dealPrice: number | null;
  closePrice: number | null;
  /** 成交价 ÷ 当日收盘 − 1（%），负数是折价 */
  premiumPct: number | null;
  /** 成交额（元） */
  dealAmount: number | null;
  buyerInst: boolean | null;
  sellerInst: boolean | null;
}

export interface EventCoverage {
  label: string;
  coveredFrom: DateStr | null;
  windowThrough: DateStr | null;
  syncedAt: DateStr | null;
  failingNights: number;
}

export interface SecurityEvents {
  code: string;
  name: string | null;
  asOf: DateStr;
  dataVersion: DataVersionInfo;
  margin: MarginRowView[];
  holders: HolderRowView[];
  lockups: LockupRowView[];
  blocks: BlockRowView[];
  coverage: Partial<Record<PitDatasetId, EventCoverage>>;
  caveats: Array<{ id: string; level: "info" | "warn"; title: string }>;
  /** 覆盖代码、决策日与四组明细（不含提示与同步状态） */
  hash: string;
}

const VISIBLE = `avail_date <= $a::DATE AND (gone_from IS NULL OR gone_from > $a::DATE)`;
const isQuarterEnd = (d: DateStr) => ["03-31", "06-30", "09-30", "12-31"].includes(d.slice(5));
/** 上一季末（季末才有） */
function prevQuarterEnd(d: DateStr): DateStr {
  const y = Number(d.slice(0, 4));
  const md = d.slice(5);
  return md === "03-31" ? `${y - 1}-12-31` : md === "06-30" ? `${y}-03-31` : md === "09-30" ? `${y}-06-30` : `${y}-09-30`;
}

export async function securityEvents(
  wh: Warehouse,
  code: string,
  asOfIn?: DateStr | null,
  datasets: readonly PitDatasetId[] = PIT_DATASET_IDS,
): Promise<SecurityEvents> {
  if (asOfIn && !isDateStr(asOfIn)) throw new EvidenceError(400, "日期格式要是 YYYY-MM-DD");
  for (const d of datasets) {
    if (!PIT_DATASET_IDS.includes(d)) throw new EvidenceError(400, `数据集只能是 ${PIT_DATASET_IDS.join("、")}`);
  }
  const sec = await wh.one<{ name: string | null; market: string }>(
    `SELECT name, market FROM securities WHERE code = $c`,
    { c: code },
  );
  if (!sec) throw new EvidenceError(404, `找不到 ${code}`);
  if (sec.market !== "A") throw new EvidenceError(404, EVENTS_A_ONLY_TEXT);
  const dataVersion = await latestDataVersion(wh, "A");
  const committed = dataVersion.asOf;
  if (!committed) throw new EvidenceError(404, "行情仓还没有提交过的数据");
  const asOf = await lastTradingDay(wh, "A", asOfIn && asOfIn < committed ? asOfIn : committed);
  const want = new Set(datasets);
  const p = { c: code, a: asOf };

  const margin: MarginRowView[] = want.has("margin")
    ? (
        await wh.all<{ d: string; av: string; rzye: number | null; rqye: number | null; fm: number | null }>(
          `SELECT date::VARCHAR AS d, avail_date::VARCHAR AS av, rzye, rqye, float_mcap AS fm FROM margin_daily
           WHERE code = $c AND avail_date <= $a::DATE ORDER BY date DESC LIMIT 60`,
          p,
        )
      )
        .reverse()
        .map((r) => ({
          date: r.d,
          availDate: r.av,
          financingAmount: r.rzye,
          shortAmount: r.rqye,
          marginRatio: r.rzye !== null && r.fm ? (r.rzye / r.fm) * 100 : null,
        }))
    : [];

  let holders: HolderRowView[] = [];
  if (want.has("holders")) {
    // 同一截至日有几次公告时取当时最新的那次
    const rows = await wh.all<{ e: string; n: string; num: number | null }>(
      `SELECT end_date::VARCHAR AS e, notice_date::VARCHAR AS n, holder_num AS num FROM holder_counts
       WHERE code = $c AND ${VISIBLE}
       QUALIFY row_number() OVER (PARTITION BY end_date ORDER BY notice_date DESC) = 1
       ORDER BY end_date DESC`,
      p,
    );
    const byEnd = new Map(rows.map((r) => [r.e, r]));
    holders = rows.slice(0, 8).map((r) => {
      const prev = isQuarterEnd(r.e) ? byEnd.get(prevQuarterEnd(r.e)) : undefined;
      return {
        endDate: r.e,
        noticeDate: r.n,
        holderNum: r.num,
        qoqPct: r.num !== null && prev?.num ? (r.num / prev.num - 1) * 100 : null,
      };
    });
  }

  const lockups: LockupRowView[] = want.has("lockups")
    ? (
        await wh.all<{
          f: string;
          t: string;
          s: number | null;
          r: number | null;
          av: string;
          rule: string;
        }>(
          `SELECT free_date::VARCHAR AS f, type AS t, unlock_shares AS s, ratio_float AS r,
                  avail_date::VARCHAR AS av, avail_rule AS rule FROM lockups
           WHERE code = $c AND ${VISIBLE} AND free_date > $a::DATE AND free_date <= $a::DATE + 180
           ORDER BY free_date, type`,
          p,
        )
      ).map((r) => ({
        freeDate: r.f,
        type: r.t,
        unlockShares: r.s,
        ratioFloatPct: r.r === null ? null : r.r * 100,
        availDate: r.av,
        availRule: r.rule,
      }))
    : [];

  let blocks: BlockRowView[] = [];
  if (want.has("blocks")) {
    const days = await wh.all<{ d: string }>(
      `SELECT DISTINCT date::VARCHAR AS d FROM trade_calendar WHERE market = 'A' AND date <= $a::DATE
       ORDER BY d DESC LIMIT 20`,
      { a: asOf },
    );
    const from = days.at(-1)?.d ?? asOf;
    blocks = (
      await wh.all<{
        td: string;
        av: string;
        dp: number | null;
        cp: number | null;
        pr: number | null;
        amt: number | null;
        bi: boolean | null;
        si: boolean | null;
      }>(
        `SELECT trade_date::VARCHAR AS td, avail_date::VARCHAR AS av, deal_price AS dp, close_price AS cp,
                premium AS pr, deal_amount AS amt, buyer_inst AS bi, seller_inst AS si FROM block_trades
         WHERE code = $c AND avail_date >= $f::DATE AND avail_date <= $a::DATE
         ORDER BY trade_date DESC, seq`,
        { ...p, f: from },
      )
    ).map((r) => ({
      tradeDate: r.td,
      availDate: r.av,
      dealPrice: r.dp,
      closePrice: r.cp,
      premiumPct: r.pr === null ? null : r.pr * 100,
      dealAmount: r.amt,
      buyerInst: r.bi,
      sellerInst: r.si,
    }));
  }

  // 覆盖与过期：只是说明，不进校验值
  const sync = await wh.all<{
    dataset: string;
    cf: string | null;
    wt: string | null;
    sa: string | null;
  }>(
    `SELECT dataset, covered_from::VARCHAR AS cf, window_through::VARCHAR AS wt, synced_at::VARCHAR AS sa
     FROM pit_sync`,
  );
  const soft = await softStepStatus(wh, "A");
  const coverage: SecurityEvents["coverage"] = {};
  const caveats: SecurityEvents["caveats"] = [];
  for (const id of datasets) {
    const s = sync.find((x) => x.dataset === id);
    const failingNights = soft.find((x) => x.step === id)?.failingNights ?? 0;
    coverage[id] = {
      label: PIT_DATASETS[id].label,
      coveredFrom: s?.cf ?? null,
      windowThrough: s?.wt ?? null,
      syncedAt: s?.sa ?? null,
      failingNights,
    };
    if (!s?.cf) {
      caveats.push({
        id: "event_backfilling",
        level: "info",
        title: `「${PIT_DATASETS[id].label}」的历史还在补，早些日子的记录可能不全`,
      });
    } else if (asOf < s.cf) {
      caveats.push({
        id: "event_before_coverage",
        level: "warn",
        title: `「${PIT_DATASETS[id].label}」从 ${s.cf} 起才有数据`,
      });
    }
    if (failingNights >= SOFT_FAILING_ALERT) {
      caveats.push({
        id: "event_stale",
        level: "warn",
        title: `「${PIT_DATASETS[id].label}」已经 ${failingNights} 晚没更新成功，数据可能是旧的`,
      });
    }
  }
  // 明细本身不受影响，但策略用的因子值是由它算的：夜间算因子失败也说一声
  const calc = soft.find((x) => x.step === "event_factors")?.failingNights ?? 0;
  if (calc >= SOFT_FAILING_ALERT) {
    caveats.push({
      id: "event_stale",
      level: "warn",
      title: `两融与筹码类因子已经 ${calc} 晚没算成功，这几天的因子值为空（下面的明细不受影响）`,
    });
  }
  return {
    code,
    name: sec.name ?? null,
    asOf,
    dataVersion,
    margin,
    holders,
    lockups,
    blocks,
    coverage,
    caveats,
    hash: sha256Canonical({ code, asOf, datasets: [...datasets], margin, holders, lockups, blocks }),
  };
}

/**
 * 事件因子的覆盖检查与提示（S15b，D83、D84），buildSimInput 用：
 * - 回测：用到事件因子而补算没完成（或签名、版本对不上）→ 抛错；起点早于某个因子的数据起点 → 抛错
 *   （server 提交前已经按 /internal/data-status 拦过一次、不扣额度，这里是第二道）；
 * - 跟踪：同样的情况只加提示 `event_coverage`（warn），那段时间按空值处理；
 * - 提示（只进 reportHash）：`stale_events` 数据集连续 3 晚没更新成功；`event_avail_approx` 用到解禁因子且起点早于夜间同步开始。
 * - 运行卡 data.events：事件因子版本、补算签名与批次、用到的数据集的覆盖起点与同步到哪天。
 *
 * 复现契约（D83）：
 * - 已有的（核心）因子列在这里和补算里都不会被改写；事件列只加在表尾；
 * - 不用事件因子的策略，compileSelection 的文本逐字节不变（query/selection.test.ts 钉着），所以选股、输入指纹、提示、运行卡都和 S15b 之前一样；
 * - 注册表版本（factorRegistry）只记进运行卡与数据版本，不是漂移原因；
 * - HASH_VERSION 不变（事件因子的值经选股结果进入输入指纹，覆盖信息只进 reportHash 与运行卡）。
 */
import {
  type Check,
  type DateStr,
  EVENT_FACTOR_VERSION,
  eventCoverageFrom,
  eventNotReadyText,
  eventStartTooEarlyText,
  FACTOR_MAP,
  factorsUsedBySpec,
  LOCKUP_NOTICE_LEAD_TD,
  PIT_DATASETS,
  type PitDatasetId,
  type RunCardEvents,
  SOFT_FAILING_ALERT,
  type StrategySpec,
} from "@ivan/core";
import { eventColumnsStatus } from "../etl/event-columns.ts";
import { readPitSync } from "../etl/pit-runner.ts";
import type { Warehouse } from "../warehouse/db.ts";
import { softStepStatus } from "./data-health.ts";

type Caveat = Check;

export interface EventCoverageResult {
  caveats: Caveat[];
  /** 运行卡 data.events；策略不用事件因子时为 undefined */
  events?: RunCardEvents;
}

/** 策略用到的事件因子（按出现顺序） */
export function eventFactorsUsed(spec: StrategySpec): string[] {
  return factorsUsedBySpec(spec).filter((k) => !!FACTOR_MAP.get(k)?.dataset);
}

export async function eventCoverage(
  wh: Warehouse,
  spec: StrategySpec,
  start: DateStr,
  o: { tracking: boolean },
): Promise<EventCoverageResult> {
  const used = eventFactorsUsed(spec);
  if (!used.length) return { caveats: [] };
  const st = await eventColumnsStatus(wh);
  const sync = await readPitSync(wh);
  const datasets = [...new Set(used.map((k) => FACTOR_MAP.get(k)!.dataset!))] as PitDatasetId[];
  const caveats: Caveat[] = [];

  if (!st.complete) {
    const text = eventNotReadyText(st.doneYears, st.totalYears);
    if (!o.tracking) throw new Error(text);
  }
  const early: string[] = [];
  for (const k of used) {
    const def = FACTOR_MAP.get(k)!;
    const from = eventCoverageFrom(def, sync.get(def.dataset!)?.covered_from ?? null);
    if (!st.complete || !from) {
      // 只有跟踪会走到这里（回测上面已经拒绝）
      early.push(`因子「${def.label}」的历史还在补算，补完之前的日子按空值处理`);
    } else if (start < from) {
      if (!o.tracking) throw new Error(eventStartTooEarlyText(def.label, from));
      early.push(`因子「${def.label}」在 ${from} 之前没有数据，这段时间按空值处理`);
    }
  }
  if (early.length) {
    caveats.push({
      id: "event_coverage",
      level: "warn",
      title: "两融与筹码类因子的数据起点",
      detail: `${early.join("；")}。`,
    });
  }

  const soft = await softStepStatus(wh, "A");
  for (const id of datasets) {
    const n = soft.find((s) => s.step === id)?.failingNights ?? 0;
    if (n >= SOFT_FAILING_ALERT) {
      caveats.push({
        id: "stale_events",
        level: "warn",
        title: `「${PIT_DATASETS[id].label}」数据过期`,
        detail: `「${PIT_DATASETS[id].label}」已经 ${n} 晚没更新成功，相关因子按过期规则为空，选股可能变少。`,
      });
    }
  }
  // 事件因子的夜间计算本身失败（数据集都同步了也一样）：新日子的事件列为空
  const calc = soft.find((s) => s.step === "event_factors")?.failingNights ?? 0;
  if (calc >= SOFT_FAILING_ALERT) {
    caveats.push({
      id: "stale_events",
      level: "warn",
      title: "两融与筹码类因子没算成功",
      detail: `两融与筹码类因子已经 ${calc} 晚没算成功，这几天的值为空，选股可能变少。`,
    });
  }
  if (used.some((k) => k.startsWith("unlock_"))) {
    const since = sync.get("lockups")?.nightly_since ?? null;
    if (!since || start < since) {
      caveats.push({
        id: "event_avail_approx",
        level: "info",
        title: "解禁的可得日为推算",
        detail: `解禁数据${since ? `在 ${since} 之前` : "在每晚同步开始之前"}按规则推算可得日：首发限售按上市日、其他类型按解禁前 ${LOCKUP_NOTICE_LEAD_TD} 个交易日，可能少算提前已知的解禁。`,
      });
    }
  }

  const events: RunCardEvents = {
    version: EVENT_FACTOR_VERSION,
    sig: st.sig,
    batch: st.meta && st.complete ? st.meta.batch : null,
    datasets: Object.fromEntries(
      datasets.map((id) => {
        const s = sync.get(id);
        return [
          id,
          {
            coveredFrom: s?.covered_from ?? null,
            windowThrough: s?.window_through ?? null,
            syncedAt: s?.synced_at ?? null,
          },
        ];
      }),
    ),
  };
  return { caveats, events };
}

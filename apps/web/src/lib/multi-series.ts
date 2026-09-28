/**
 * 看板「多策略对照图」的数据准备（纯函数，有单测）：
 * - 每个策略的「回测段 + 跟踪段」合成一条线，按窗口起点归一（净值视图画累计收益）；
 * - 超额 = 相对「自己的」基准，所以不同市场的策略也能放在一张图上比；
 * - 基准按名字分组，同一个基准只画一条灰线，和该组第一个策略同一天起算。
 */

export interface ChartPoint {
  date: string;
  nav: number;
  bench: number;
}

export interface StrategyLine {
  id: string;
  name: string;
  /** 颜色槽位（跟着策略走，不跟排名走） */
  slot: number;
  benchLabel: string;
  /** 上线日：这天起是向前跟踪 */
  startDate: string;
  backtest: ChartPoint[];
  tracking: ChartPoint[];
}

export type MultiView = "nav" | "excess" | "drawdown";
/** all = 含上线前的回测；tracking = 只看上线以后 */
export type MultiRange = "all" | "tracking";

export interface PreparedSeries {
  id: string;
  name: string;
  slot: number;
  /** 与 dates 对齐，没有数据的日子为 null；回测段与跟踪段在上线处共用一个点，画出来是连着的 */
  backtest: Array<number | null>;
  tracking: Array<number | null>;
  /** 上线点（还没上线或窗口里没有跟踪段时为 null） */
  goLive: { index: number; value: number } | null;
}

export interface PreparedBench {
  label: string;
  values: Array<number | null>;
}

export interface Prepared {
  dates: string[];
  series: PreparedSeries[];
  benches: PreparedBench[];
}

function windowPoints(line: StrategyLine, range: MultiRange): ChartPoint[] {
  if (range === "all") return [...line.backtest, ...line.tracking];
  // 只看跟踪：以上线前最后一个回测点为起点（归一到 0%），没有回测就从第一天跟踪算
  const anchor = line.backtest.at(-1);
  return anchor ? [anchor, ...line.tracking] : [...line.tracking];
}

function transform(pts: ChartPoint[], view: MultiView, of: "nav" | "bench"): number[] {
  const base = pts[0]!;
  if (view === "nav") return pts.map((p) => p[of] / base[of] - 1);
  if (view === "excess") return pts.map((p) => p.nav / base.nav / (p.bench / base.bench) - 1);
  let peak = -Infinity;
  return pts.map((p) => {
    peak = Math.max(peak, p[of]);
    return p[of] / peak - 1;
  });
}

export function prepareMulti(lines: StrategyLine[], view: MultiView, range: MultiRange): Prepared {
  const raw = lines
    .map((l) => ({ line: l, pts: windowPoints(l, range) }))
    .filter((x) => x.pts.length > 0);
  if (!raw.length) return { dates: [], series: [], benches: [] };

  // 含回测：从所有策略都有数据的那天起比；只看跟踪：各自从自己的上线点起算
  const common = raw.map((x) => x.pts[0]!.date).sort();
  const start = range === "all" ? common.at(-1)! : common[0]!;
  const used = raw
    .map((x) => ({ ...x, pts: x.pts.filter((p) => p.date >= start) }))
    .filter((x) => x.pts.length > 0);

  const dates = [...new Set(used.flatMap((x) => x.pts.map((p) => p.date)))].sort();
  const at = new Map(dates.map((d, i) => [d, i]));
  const empty = () => new Array<number | null>(dates.length).fill(null);

  const series: PreparedSeries[] = used.map(({ line, pts }) => {
    const vals = transform(pts, view, "nav");
    const backtest = empty();
    const tracking = empty();
    // 跟踪段从上线前最后一个点接上，保证两段连着
    const firstTrack = pts.findIndex((p) => p.date >= line.startDate);
    pts.forEach((p, k) => {
      const i = at.get(p.date)!;
      if (firstTrack < 0 || k < firstTrack) backtest[i] = vals[k]!;
      if (firstTrack >= 0 && k >= Math.max(0, firstTrack - 1)) tracking[i] = vals[k]!;
    });
    // 上线点在窗口里才标（窗口起点晚于上线日时不标，免得把窗口起点误标成上线）
    const goLive =
      firstTrack > 0
        ? {
            index: at.get(pts[Math.max(0, firstTrack - 1)]!.date)!,
            value: vals[Math.max(0, firstTrack - 1)]!,
          }
        : null;
    return { id: line.id, name: line.name, slot: line.slot, backtest, tracking, goLive };
  });

  // 超额视图的基准就是 0 线，不画灰线
  const benches: PreparedBench[] = [];
  if (view !== "excess") {
    const seen = new Set<string>();
    for (const { line, pts } of used) {
      if (seen.has(line.benchLabel)) continue;
      seen.add(line.benchLabel);
      const vals = transform(pts, view, "bench");
      const values = empty();
      pts.forEach((p, k) => (values[at.get(p.date)!] = vals[k]!));
      benches.push({ label: line.benchLabel, values });
    }
  }
  return { dates, series, benches };
}

/** 提示框用：这一天没有点（另一个市场的交易日）时，取之前最近的一个 */
export function valueAt(values: Array<number | null>, i: number): number | null {
  for (let k = i; k >= 0 && k > i - 10; k--) {
    const v = values[k];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

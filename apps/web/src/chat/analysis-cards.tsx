/**
 * 对话分析工具的卡片（spec 20261020）：走势、对比、大盘、行业、因子历史、财报、计算器。
 * 和其他卡片一样直接渲染工具结果，数字以卡片为准；模型的文字只做解读。红涨绿跌（tone）。
 */
import type {
  CompareResult,
  FactorHistory,
  FinancialHistory,
  IndustryPerformance,
  Instrument,
  MarketOverview,
  PeriodKey,
  PriceHistory,
} from "@ivan/core";
import { LinesChart, type Line } from "../components/charts/lines-chart.tsx";
import { Sparkline } from "../components/charts/small.tsx";
import {
  IconCalc,
  IconChart,
  IconCompare,
  IconFinancials,
  IconIndustry,
  IconMarket,
  IconValuation,
} from "../components/icons.tsx";
import { cx, DataTable, Tag, Td, Th } from "../components/ui.tsx";
import { fmtFactor, money, NA, num, pct, tone } from "../lib/format.ts";
import { Frame, MiniStats } from "./cards.tsx";

const nameOf = (i: Instrument) => (i.kind === "stock" ? i.name : i.label);
const idOf = (i: Instrument) => (i.kind === "stock" ? i.code : null);
const unitOf = (p: { currency: "CNY" | "HKD" | null }) =>
  p.currency === "HKD" ? "港元" : p.currency === "CNY" ? "元" : "点";

const WINDOW_TEXT: Array<[PeriodKey, string]> = [
  ["1w", "1 周"],
  ["1m", "1 月"],
  ["3m", "3 月"],
  ["6m", "6 月"],
  ["ytd", "今年"],
  ["1y", "1 年"],
  ["3y", "3 年"],
  ["5y", "5 年"],
];

/** 一行小字说明（口径、数据截至、数据没更新） */
function Notes({ notes }: { notes: string[] }) {
  if (!notes.length) return null;
  return (
    <ul className="mt-3 space-y-0.5 border-t border-line pt-2.5 text-2xs leading-relaxed text-muted">
      {notes.map((n) => (
        <li key={n} className={cx(/没更新/.test(n) && "text-warn")}>
          {n}
        </li>
      ))}
    </ul>
  );
}

/** 标签 + 值的两列清单 */
function Rows({ rows }: { rows: Array<[string, React.ReactNode] | null | false> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
      {rows
        .filter((r): r is [string, React.ReactNode] => Boolean(r))
        .map(([l, v]) => (
          <div key={l} className="contents">
            <dt className="text-muted">{l}</dt>
            <dd className="tabular text-ink">{v}</dd>
          </div>
        ))}
    </dl>
  );
}

function Pct({ x, digits = 1 }: { x: number | null | undefined; digits?: number }) {
  return <span className={tone(x)}>{pct(x, digits)}</span>;
}

/** 多窗口涨跌：一行小格 */
function Windows({ w }: { w: Partial<Record<PeriodKey, number | null>> }) {
  const cells = WINDOW_TEXT.filter(([k]) => k in w);
  return (
    <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-8">
      {cells.map(([k, label]) => (
        <div key={k} className="rounded-md bg-surface-2/60 px-1.5 py-1 text-center">
          <div className="text-2xs text-muted">{label}</div>
          <div className={cx("tabular text-xs font-medium", tone(w[k]))}>{pct(w[k], 1)}</div>
        </div>
      ))}
    </div>
  );
}

// ── 走势 ──

export function PriceHistoryCard({ output: p }: { output: PriceHistory }) {
  const s = p.stats;
  const name = nameOf(p.instrument);
  const lines: Line[] = [{ name, points: p.series.map((x) => ({ d: x.d, v: x.v })) }];
  if (p.benchmark) {
    lines.push({
      name: p.benchmark.label,
      bench: true,
      points: p.series.filter((x) => x.b !== null).map((x) => ({ d: x.d, v: x.b! })),
    });
  }
  const u = unitOf(p);
  const dd = s.drawdown;
  return (
    <Frame
      title={
        <>
          {name}
          {idOf(p.instrument) && (
            <span className="ml-1.5 font-mono text-[11px] font-normal text-muted">
              {idOf(p.instrument)}
            </span>
          )}
          <span className="ml-1.5 font-normal text-muted">· {p.period.label}</span>
        </>
      }
      icon={IconChart}
      right={
        <span className="font-mono text-[11px] font-normal text-muted">
          {s.start} ~ {s.end}
        </span>
      }
      info="收益、回撤、波动按复权价（分红再投入）算；价格是不复权收盘。年化不足 1 年不算。"
    >
      <MiniStats
        items={[
          ["区间涨跌", pct(s.ret), tone(s.ret)],
          ["年化", s.cagr === null ? NA : pct(s.cagr), tone(s.cagr)],
          ["最大回撤", pct(dd.maxDrawdown, 1, false)],
          ["年化波动", pct(s.volatility, 1, false)],
        ]}
      />
      <div className="mt-3">
        <LinesChart lines={lines} />
      </div>
      <div className="mt-3">
        <Windows w={p.windows} />
      </div>
      <div className="mt-3">
        <Rows
          rows={[
            ["收盘", `${num(p.levels.startClose)} → ${num(p.levels.endClose)} ${u}`],
            [
              "区间最高 / 最低",
              `${num(p.levels.highClose)}（${p.levels.highDate}）/ ${num(p.levels.lowClose)}（${p.levels.lowDate}）`,
            ],
            [
              "最大回撤",
              dd.peakDate
                ? `${dd.peakDate} → ${dd.troughDate}，${dd.recoveryDate ? `${dd.recoveryDate} 回到前高` : "还没回到前高"}`
                : "区间内没有回撤",
            ],
            ["距区间高点", pct(dd.currentDrawdown, 1)],
            [
              "均线位置",
              `20 日 ${pct(p.trend.vsMa20)} · 60 日 ${pct(p.trend.vsMa60)} · 250 日 ${pct(p.trend.vsMa250)}`,
            ],
            p.benchmark && [
              p.benchmark.label,
              <>
                <Pct x={p.benchmark.ret} />
                ，超额 <Pct x={p.benchmark.excess} />
                {p.benchmark.beta !== null &&
                  `，β ${num(p.benchmark.beta)}，相关 ${num(p.benchmark.correlation)}`}
              </>,
            ],
            p.totalReturn && [p.totalReturn.label, <Pct key="tr" x={p.totalReturn.ret} />],
            p.listing && [
              p.listing.firstIsListingDay ? "上市首日" : "数据起点",
              `${p.listing.firstDate}，开 ${num(p.listing.firstOpen)} 收 ${num(p.listing.firstClose)}；从首日收盘 ${pct(p.listing.retFromFirstClose)}`,
            ],
            p.suspendedDays ? ["停牌", `${p.suspendedDays} 个交易日`] : false,
            p.avgDailyAmount20d !== null && [
              "近 20 日日均成交",
              `${money(p.avgDailyAmount20d)}${u}`,
            ],
          ]}
        />
      </div>
      <Notes notes={p.notes} />
    </Frame>
  );
}

// ── 对比 ──

export function CompareSecuritiesCard({ output: c }: { output: CompareResult }) {
  const lines: Line[] = c.items.map((i) => ({ name: nameOf(i.instrument), points: i.series }));
  const f = (i: CompareResult["items"][number], k: string, unit?: string) =>
    fmtFactor(i.factors?.[k] ?? null, unit);
  return (
    <Frame
      title={`对比 · ${c.period.label}`}
      icon={IconCompare}
      right={<span className="font-mono text-[11px] font-normal text-muted">至 {c.end}</span>}
      info="收益按复权价；相关系数用两只都有行情的交易日的日收益算。PE、PB 是倍数。"
    >
      <LinesChart lines={lines} height={210} />
      <DataTable minWidth={560} className="mt-2">
        <thead>
          <tr>
            <Th>名称</Th>
            <Th align="right">涨跌</Th>
            <Th align="right">波动</Th>
            <Th align="right">回撤</Th>
            <Th align="right">PE</Th>
            <Th align="right">PB</Th>
            <Th align="right">ROE</Th>
            <Th align="right">股息率</Th>
          </tr>
        </thead>
        <tbody>
          {c.items.map((i) => (
            <tr key={idOf(i.instrument) ?? nameOf(i.instrument)} className="text-xs">
              <Td>
                {nameOf(i.instrument)}
                {idOf(i.instrument) && (
                  <span className="ml-1 font-mono text-[10.5px] text-muted">
                    {idOf(i.instrument)}
                  </span>
                )}
              </Td>
              <Td align="right">
                <Pct x={i.stats?.ret} />
              </Td>
              <Td align="right">{pct(i.stats?.volatility, 1, false)}</Td>
              <Td align="right">{pct(i.stats?.drawdown.maxDrawdown, 1, false)}</Td>
              <Td align="right">{f(i, "pe_ttm")}</Td>
              <Td align="right">{f(i, "pb")}</Td>
              <Td align="right">{f(i, "roe_ttm", "%")}</Td>
              <Td align="right">{f(i, "dividend_yield_ttm", "%")}</Td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      {c.correlation.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5 text-2xs text-muted">
          {c.correlation.map((x) => (
            <Tag key={`${x.a}-${x.b}`}>
              {shortName(c, x.a)} × {shortName(c, x.b)} 相关 {num(x.value)}
            </Tag>
          ))}
        </div>
      )}
      <Notes notes={c.notes} />
    </Frame>
  );
}

function shortName(c: CompareResult, id: string): string {
  const i = c.items.find(
    (x) => (x.instrument.kind === "stock" ? x.instrument.code : x.instrument.sym) === id,
  );
  return i ? nameOf(i.instrument) : id;
}

// ── 大盘 ──

export function MarketCard({ output: m }: { output: MarketOverview }) {
  const b = m.breadth;
  const total = b.buckets.reduce((a, x) => a + x.count, 0) || 1;
  // 分布条：跌（绿）→ 平 → 涨（红），越极端颜色越深
  const shade = [
    "bg-down",
    "bg-down/70",
    "bg-down/35",
    "bg-surface-2",
    "bg-up/35",
    "bg-up/70",
    "bg-up",
  ];
  return (
    <Frame
      title={`${m.market === "HK" ? "港股" : "A 股"}大盘 · ${m.date}`}
      icon={IconMarket}
      info="涨跌按复权价（除权日不算成下跌）；估值是全市场中位数，分位按近 5 年每周一天算。"
    >
      <DataTable minWidth={420}>
        <thead>
          <tr>
            <Th>指数</Th>
            <Th align="right">收盘</Th>
            <Th align="right">当日</Th>
            <Th align="right">1 月</Th>
            <Th align="right">今年</Th>
            <Th align="right">1 年</Th>
          </tr>
        </thead>
        <tbody>
          {m.indices.map((i) => (
            <tr key={i.sym} className="text-xs">
              <Td>{i.label}</Td>
              <Td align="right">{num(i.close)}</Td>
              <Td align="right">
                <Pct x={i.chg1d} digits={2} />
              </Td>
              <Td align="right">
                <Pct x={i.windows["1m"]} />
              </Td>
              <Td align="right">
                <Pct x={i.windows.ytd} />
              </Td>
              <Td align="right">
                <Pct x={i.windows["1y"]} />
              </Td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      <div className="mt-3">
        <MiniStats
          items={[
            ["上涨 / 下跌", `${b.up} / ${b.down}`],
            ["涨跌幅中位数", pct(b.medianChg, 2), tone(b.medianChg)],
            ["涨停 / 跌停", b.limitUp === null ? NA : `${b.limitUp} / ${b.limitDown}`],
            ["新高 / 新低", `${b.newHigh250} / ${b.newLow250}`],
          ]}
        />
      </div>
      <div className="mt-3 flex h-2 overflow-hidden rounded-full" aria-hidden="true">
        {b.buckets.map((x, i) => (
          <div
            key={x.label}
            className={shade[i]}
            style={{ width: `${(x.count / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-2xs text-muted">
        <span>跌 7% 以上 {b.buckets[0]?.count ?? 0}</span>
        <span>平 {b.flat}</span>
        <span>涨 7% 以上 {b.buckets.at(-1)?.count ?? 0}</span>
      </div>
      <div className="mt-3">
        <Rows
          rows={[
            [
              "成交额",
              `${money(m.turnover.amount)}${m.market === "HK" ? "港元" : "元"}${m.turnover.ratioTo20d !== null ? `，是 20 日均值的 ${num(m.turnover.ratioTo20d)} 倍` : ""}`,
            ],
            ["站上 60 日线", pct(b.aboveMa60Ratio, 0, false)],
            [
              "估值中位数",
              `PE ${fmtFactor(m.valuation.pe_ttm)}（5 年分位 ${fmtFactor(m.valuation.pePercentile5y, "名")}%）· PB ${fmtFactor(m.valuation.pb)} · 股息率 ${fmtFactor(m.valuation.dividend_yield_ttm, "%")}`,
            ],
            m.industries.top.length > 0 && [
              "最强行业",
              m.industries.top.map((x) => `${x.industry} ${pct(x.medianChg)}`).join("、"),
            ],
            m.industries.bottom.length > 0 && [
              "最弱行业",
              m.industries.bottom.map((x) => `${x.industry} ${pct(x.medianChg)}`).join("、"),
            ],
          ]}
        />
      </div>
      <Notes notes={m.notes} />
    </Frame>
  );
}

// ── 行业 ──

export function IndustryCard({ output: r }: { output: IndustryPerformance }) {
  return (
    <Frame
      title={
        r.focus
          ? `${r.focus.industry} · ${r.period.label}`
          : `${r.market === "HK" ? "港股" : "A 股"}${r.level === "l1" ? "一级" : "二级"}行业 · ${r.period.label}`
      }
      icon={IconIndustry}
      right={
        <span className="font-mono text-[11px] font-normal text-muted">
          {r.start} ~ {r.end}
        </span>
      }
      info="行业收益按起点市值加权（分红再投入）；估值是行业里股票的中位数。行业是行情仓里的股票自己算的，不是官方行业指数。"
    >
      {r.benchmark && (
        <p className="mb-2 text-xs text-muted">
          同期{r.benchmark.label} <Pct x={r.benchmark.ret} />
        </p>
      )}
      {r.focus ? (
        <DataTable minWidth={520}>
          <thead>
            <tr>
              <Th>名称</Th>
              <Th align="right">涨跌</Th>
              <Th align="right">市值</Th>
              <Th align="right">PE</Th>
              <Th align="right">PB</Th>
              <Th align="right">ROE</Th>
              <Th align="right">股息率</Th>
            </tr>
          </thead>
          <tbody>
            {r.focus.members.map((x) => (
              <tr key={x.code} className="text-xs">
                <Td>
                  {x.name}
                  <span className="ml-1 font-mono text-[10.5px] text-muted">{x.code}</span>
                </Td>
                <Td align="right">
                  <Pct x={x.ret} />
                </Td>
                <Td align="right">{fmtFactor(x.mcap, "亿")}</Td>
                <Td align="right">{fmtFactor(x.pe_ttm)}</Td>
                <Td align="right">{fmtFactor(x.pb)}</Td>
                <Td align="right">{fmtFactor(x.roe_ttm, "%")}</Td>
                <Td align="right">{fmtFactor(x.dividend_yield_ttm, "%")}</Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : (
        <div className="max-h-80 overflow-y-auto">
          <DataTable minWidth={500}>
            <thead>
              <tr>
                <Th>行业</Th>
                <Th align="right">加权涨跌</Th>
                <Th align="right">中位数</Th>
                <Th align="right">上涨比例</Th>
                <Th align="right">PE 中位</Th>
                <Th align="right">股息率</Th>
              </tr>
            </thead>
            <tbody>
              {r.industries.map((x) => (
                <tr key={x.industry} className="text-xs">
                  <Td>
                    {x.industry}
                    <span className="ml-1 text-2xs text-muted">{x.members}</span>
                  </Td>
                  <Td align="right">
                    <Pct x={x.capWeightedRet} />
                  </Td>
                  <Td align="right">
                    <Pct x={x.medianRet} />
                  </Td>
                  <Td align="right">{pct(x.upRatio, 0, false)}</Td>
                  <Td align="right">{fmtFactor(x.median.pe_ttm)}</Td>
                  <Td align="right">{fmtFactor(x.median.dividend_yield_ttm, "%")}</Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </div>
      )}
      {r.focus && r.focus.total > r.focus.members.length && (
        <p className="mt-2 text-2xs text-muted">
          共 {r.focus.total} 只，只列了前 {r.focus.members.length} 只。
        </p>
      )}
      <Notes notes={r.notes} />
    </Frame>
  );
}

// ── 因子历史 ──

export function FactorHistoryCard({ output: f }: { output: FactorHistory }) {
  return (
    <Frame
      title={
        <>
          {f.instrument.name}
          <span className="ml-1.5 font-mono text-[11px] font-normal text-muted">
            {f.instrument.code}
          </span>
          <span className="ml-1.5 font-normal text-muted">· 估值与因子 · {f.period.label}</span>
        </>
      }
      icon={IconValuation}
      info="分位：当前值在区间历史里的位置（0 = 最低，100 = 最高）；PE、PB 只算为正的日子。横截面分位是同一天在全市场、同一级行业里的位置。"
    >
      <div className="space-y-3">
        {f.factors.map((x) => {
          const u = x.unit ?? undefined;
          return (
            <div key={x.key} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1">
              <div className="min-w-0">
                <div className="flex items-baseline gap-2 text-xs">
                  <span className="text-muted">{x.label}</span>
                  <span className="tabular text-sm font-semibold text-ink">
                    {fmtFactor(x.current, u)}
                  </span>
                  {x.percentile !== null && (
                    <span className="text-2xs text-muted">历史分位 {x.percentile.toFixed(0)}%</span>
                  )}
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-2">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${Math.max(x.percentile ?? 0, 2)}%` }}
                  />
                </div>
                <div className="tabular mt-1 text-2xs text-muted">
                  最低 {fmtFactor(x.min, u)} · 中位 {fmtFactor(x.median, u)} · 最高{" "}
                  {fmtFactor(x.max, u)}
                  {x.crossSection && (
                    <>
                      {" "}
                      · 全市场 {x.crossSection.marketPercentile?.toFixed(0) ?? NA}%
                      {x.crossSection.industryPercentile !== null &&
                        ` · ${x.crossSection.industry} ${x.crossSection.industryPercentile.toFixed(0)}%（中位 ${fmtFactor(x.crossSection.industryMedian, u)}）`}
                    </>
                  )}
                </div>
              </div>
              <Sparkline values={x.series.map((p) => p.v)} width={110} height={34} />
            </div>
          );
        })}
      </div>
      <Notes notes={f.notes} />
    </Frame>
  );
}

// ── 财报 ──

export function FinancialsCard({ output: f }: { output: FinancialHistory }) {
  const yoy = (x: number | null) => (x === null ? NA : `${x > 0 ? "+" : ""}${x.toFixed(1)}%`);
  const yoyTone = (x: number | null) => tone(x === null ? null : x);
  return (
    <Frame
      title={
        <>
          {f.instrument.name}
          <span className="ml-1.5 font-mono text-[11px] font-normal text-muted">
            {f.instrument.code}
          </span>
          <span className="ml-1.5 font-normal text-muted">· 财报与分红</span>
        </>
      }
      icon={IconFinancials}
      info="报告期累计口径；单季 = 本期累计 − 同年上一期累计（港股是半年）；TTM = 近四季合计。"
    >
      <DataTable minWidth={620}>
        <thead>
          <tr>
            <Th>报告期</Th>
            <Th align="right">营收</Th>
            <Th align="right">同比</Th>
            <Th align="right">归母净利</Th>
            <Th align="right">同比</Th>
            <Th align="right">单季净利</Th>
            <Th align="right">单季同比</Th>
            <Th align="right">ROE</Th>
            <Th align="right">毛利率</Th>
          </tr>
        </thead>
        <tbody>
          {f.rows.map((r) => (
            <tr key={r.reportDate} className="text-xs">
              <Td>
                <span className="font-mono">{r.reportDate}</span>
                <span className="ml-1 text-2xs text-muted">{r.period}</span>
              </Td>
              <Td align="right">{money(r.revenue)}</Td>
              <Td align="right" className={yoyTone(r.revenue_yoy)}>
                {yoy(r.revenue_yoy)}
              </Td>
              <Td align="right">{money(r.np)}</Td>
              <Td align="right" className={yoyTone(r.np_yoy)}>
                {yoy(r.np_yoy)}
              </Td>
              <Td align="right">
                {r.single ? (
                  <>
                    <span className="mr-1 text-2xs text-muted">{r.single.label}</span>
                    {money(r.single.np)}
                  </>
                ) : (
                  NA
                )}
              </Td>
              <Td align="right" className={yoyTone(r.single?.npYoyPct ?? null)}>
                {yoy(r.single?.npYoyPct ?? null)}
              </Td>
              <Td align="right">{fmtFactor(r.roe, "%")}</Td>
              <Td align="right">{fmtFactor(r.gross_margin, "%")}</Td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      {f.dividendsByYear.length > 0 && (
        <div className="mt-3">
          <Rows
            rows={[
              [
                "每股分红（按年）",
                f.dividendsByYear.map((d) => `${d.year} ${num(d.cash, 3)}`).join(" · "),
              ],
              ["股息率 TTM", fmtFactor(f.dividend_yield_ttm, "%")],
            ]}
          />
        </div>
      )}
      <Notes notes={f.notes} />
    </Frame>
  );
}

// ── 计算器 ──

const CALC_UNIT_TEXT: Record<string, string> = { x: "倍", "": "" };

export function CalcCard({
  output,
}: {
  output: {
    items: Array<{
      label: string;
      expr: string;
      unit: string;
      value: number | null;
      error?: string;
    }>;
  };
}) {
  return (
    <Frame title="计算" icon={IconCalc}>
      <dl className="space-y-1.5 text-xs">
        {output.items.map((i, n) => (
          <div key={`${n}-${i.label}`} className="grid grid-cols-[1fr_auto] gap-x-3">
            <dt className="min-w-0">
              <div className="text-ink-2">{i.label}</div>
              <div className="truncate font-mono text-[10.5px] text-muted">{i.expr}</div>
            </dt>
            <dd
              className={cx("tabular self-center font-medium", i.error ? "text-warn" : "text-ink")}
            >
              {i.error
                ? i.error
                : `${num(i.value, 4)}${i.unit === "%" ? "%" : ` ${CALC_UNIT_TEXT[i.unit] ?? i.unit}`}`}
            </dd>
          </div>
        ))}
      </dl>
    </Frame>
  );
}

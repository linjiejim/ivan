/**
 * 「两融与筹码」明细（S15b，D85）：融资余额走势与最新一行、股东户数、已知的解禁、近 20 个交易日大宗交易。
 * 只含 asOf 当时已公布、没撤下的数据。对话里的 EventsCard 与个股证据弹窗的「两融与筹码明细」分页渲染同一个 EventsBody。
 */
import { Sparkline } from "./charts/small.tsx";
import {
  holdersText,
  LOCKUP_RULE_TAG,
  lockupRuleText,
  money,
  NA,
  pctPoints,
  premiumText,
  sharesText,
} from "../lib/format.ts";
import type { SecurityEvents } from "../lib/types.ts";
import { Callout, DataTable, Info, Tag, Td, Th } from "./ui.tsx";

function Section({
  title,
  children,
  empty,
}: {
  title: string;
  children: React.ReactNode;
  empty: boolean;
}) {
  return (
    <section>
      <h4 className="mb-1 text-2xs font-medium text-muted">{title}</h4>
      {empty ? <p className="text-2xs text-muted">当时没有记录</p> : children}
    </section>
  );
}

/** 融资余额一句话：「融资余额 172.33 亿（09-29 的数据，09-30 可得）· 占流通市值 1.1% · 20 日 +3.2%」 */
export function marginLine(m: SecurityEvents["margin"]): string | null {
  const last = m.at(-1);
  if (!last) return null;
  const base = m.length >= 21 ? m[m.length - 21] : undefined;
  const amount =
    last.financingAmount === null ? NA : `${(last.financingAmount / 1e8).toFixed(2)} 亿`;
  const rest = [
    last.marginRatio === null ? null : `占流通市值 ${last.marginRatio.toFixed(1)}%`,
    base?.financingAmount && last.financingAmount !== null
      ? `20 日 ${pctPoints((last.financingAmount / base.financingAmount - 1) * 100)}`
      : null,
  ].filter(Boolean);
  return `融资余额 ${amount}（${last.date} 的数据，${last.availDate} 可得）${rest.length ? `· ${rest.join(" · ")}` : ""}`;
}

export function EventsBody({ e }: { e: SecurityEvents }) {
  const line = marginLine(e.margin);
  const spark = e.margin.map((r) => r.financingAmount ?? Number.NaN);
  return (
    <div className="space-y-3 text-xs">
      <p className="text-ink">
        <span className="font-medium">{e.name ?? e.code}</span>
        <span className="ml-1.5 font-mono text-[11px] text-muted">{e.code}</span>
        <span className="text-muted"> · 截至 </span>
        <span className="font-mono">{e.asOf}</span>
        <span className="text-muted">（只含当时已公布的数据）</span>
      </p>
      {e.caveats.length > 0 && (
        <Callout
          tone={e.caveats.some((c) => c.level === "warn") ? "warn" : "info"}
          className="text-xs leading-5"
        >
          <ul className="space-y-0.5">
            {e.caveats.map((c, i) => (
              <li key={`${c.id}:${i}`}>{c.title}</li>
            ))}
          </ul>
        </Callout>
      )}

      <Section title="融资融券" empty={!line}>
        <div className="flex items-center gap-3">
          <Sparkline values={spark} width={88} height={26} />
          <p className="min-w-0 flex-1 text-ink-2">{line}</p>
        </div>
      </Section>

      <Section title="股东户数（按公告日）" empty={!e.holders.length}>
        <DataTable>
          <thead>
            <tr>
              <Th>截至日</Th>
              <Th>公告日</Th>
              <Th align="right">户数</Th>
              <Th align="right">环比</Th>
            </tr>
          </thead>
          <tbody>
            {e.holders.map((h) => (
              <tr key={`${h.endDate}:${h.noticeDate}`} className="text-xs">
                <Td className="font-mono">{h.endDate}</Td>
                <Td className="font-mono text-muted">{h.noticeDate}</Td>
                <Td align="right">{holdersText(h.holderNum)}</Td>
                <Td align="right">{pctPoints(h.qoqPct)}</Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </Section>

      <Section title="180 天内已知的解禁" empty={!e.lockups.length}>
        <DataTable>
          <thead>
            <tr>
              <Th>解禁日</Th>
              <Th>类型</Th>
              <Th align="right">股数</Th>
              <Th align="right">占解禁前流通股</Th>
              <Th>可得日依据</Th>
            </tr>
          </thead>
          <tbody>
            {e.lockups.map((l) => (
              <tr key={`${l.freeDate}:${l.type}`} className="text-xs">
                <Td className="font-mono">{l.freeDate}</Td>
                <Td className="max-w-40 truncate">{l.type}</Td>
                <Td align="right">{sharesText(l.unlockShares)}</Td>
                <Td align="right">
                  {l.ratioFloatPct === null ? NA : `${l.ratioFloatPct.toFixed(2)}%`}
                </Td>
                <Td>
                  <span className="inline-flex items-center gap-1">
                    <Tag>{LOCKUP_RULE_TAG[l.availRule] ?? l.availRule}</Tag>
                    <Info>
                      {lockupRuleText(l.availRule)}；{l.availDate} 起可得
                    </Info>
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </Section>

      <Section title="近 20 个交易日大宗交易（T+1 可得）" empty={!e.blocks.length}>
        <DataTable>
          <thead>
            <tr>
              <Th>成交日</Th>
              <Th align="right">成交价</Th>
              <Th align="right">折溢价</Th>
              <Th align="right">成交额</Th>
              <Th>买方</Th>
            </tr>
          </thead>
          <tbody>
            {e.blocks.map((b, i) => (
              <tr key={`${b.tradeDate}:${i}`} className="text-xs">
                <Td className="font-mono">{b.tradeDate}</Td>
                <Td align="right">{b.dealPrice === null ? NA : b.dealPrice.toFixed(2)}</Td>
                <Td align="right">{premiumText(b.premiumPct)}</Td>
                <Td align="right">{money(b.dealAmount)}</Td>
                <Td>{b.buyerInst ? <Tag>机构</Tag> : <span className="text-muted">{NA}</span>}</Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </Section>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-line pt-2 text-2xs text-muted">
        <span className="font-mono">
          数据版本 #{e.dataVersion.id ?? NA} · 校验 {e.hash.slice(0, 8)}
        </span>
        <span className="ml-auto">仅供研究，不构成投资建议</span>
      </div>
    </div>
  );
}

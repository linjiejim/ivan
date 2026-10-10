/**
 * Phase 0 数据探针：逐项确认免费数据源能给什么、给到哪年、缺什么，输出覆盖报告。
 * 探针只读外部接口，不写任何本地数据。结论写进 spec 的决策记录。
 */
import { addDays, type DateStr, todayCN } from "@ivan/core";
import { Http, mapLimit } from "./http.ts";
import { centralParity } from "./sources/chinamoney.ts";
import { csindexHistory } from "./sources/csindex.ts";
import { emCount, emQuery, EastmoneyError, str } from "./sources/eastmoney.ts";
import {
  sseDelisted,
  szseDelisted,
  szseNameChanges,
  szseRecordCount,
} from "./sources/exchanges.ts";
import { indexKline, klineOnce, klineRange } from "./sources/tencent.ts";

export type ProbeStatus = "ok" | "warn" | "fail";

export interface ProbeCheck {
  id: string;
  area: "A 股" | "港股" | "指数与汇率" | "吞吐";
  title: string;
  status: ProbeStatus;
  facts: string[];
  /** 这一项对设计的结论 */
  conclusion?: string;
  ms: number;
}

export interface ProbeReport {
  date: DateStr;
  env: string;
  checks: ProbeCheck[];
  estimate: string[];
}

type CheckFn = (http: Http, ctx: ProbeContext) => Promise<Omit<ProbeCheck, "id" | "area" | "title" | "ms">>;

interface ProbeContext {
  today: DateStr;
  aListedNow?: number;
  aDelistedSince2013?: number;
  hkEquities?: number;
  klineReqPerSec?: number;
  emReqPerSec?: number;
}

const d10 = (v: unknown) => String(v ?? "").slice(0, 10);

const CHECKS: Array<{ id: string; area: ProbeCheck["area"]; title: string; run: CheckFn }> = [
  {
    id: "a.bars",
    area: "A 股",
    title: "A 股日线（腾讯，不复权 + 后复权）",
    async run(http, ctx) {
      const raw = await klineRange(http, "600519.SH", "raw", "2001-01-01", "2003-12-31");
      const hfq = await klineOnce(http, "600519.SH", "hfq", "2016-01-04", "2016-01-08");
      const rawSame = await klineOnce(http, "600519.SH", "raw", "2016-01-04", "2016-01-08");
      const cap = await klineOnce(http, "600519.SH", "raw", "2016-01-01", ctx.today);
      const factor = hfq[0] && rawSame[0] ? hfq[0].close / rawSame[0].close : NaN;
      return {
        status: raw.length && hfq.length ? "ok" : "fail",
        facts: [
          `600519 不复权最早 ${raw[0]?.date ?? "无"}（上市 2001-08-27）`,
          `后复权可取：2016-01-04 hfq 收盘 ${hfq[0]?.close}，不复权 ${rawSame[0]?.close}，复权因子 ${factor.toFixed(4)}`,
          `单次请求上限：2016 至今一次只返回 ${cap.length} 条（${cap[0]?.date} 起），需要按窗口分段`,
        ],
        conclusion: "日线存不复权 OHLC + 复权因子（hfq/raw），按 800 自然日窗口分段回填。",
      };
    },
  },
  {
    id: "a.delisted_bars",
    area: "A 股",
    title: "A 股退市股日线",
    async run(http) {
      const samples: Array<[string, string, DateStr, DateStr]> = [
        ["000418.SZ", "小天鹅A（2019 吸收合并）", "2016-01-01", "2016-12-31"],
        ["600087.SH", "长航油运（2014 退市）", "2013-01-01", "2014-12-31"],
        ["300104.SZ", "乐视（2020 退市）", "2019-01-01", "2020-12-31"],
        ["002450.SZ", "康得新（2021 退市）", "2020-01-01", "2021-12-31"],
      ];
      const facts: string[] = [];
      let ok = 0;
      for (const [code, label, from, to] of samples) {
        const bars = await klineOnce(http, code, "raw", from, to);
        if (bars.length) ok++;
        facts.push(`${code} ${label}：${bars.length} 条，最后 ${bars.at(-1)?.date ?? "无"}`);
      }
      return {
        status: ok === samples.length ? "ok" : ok ? "warn" : "fail",
        facts,
        conclusion: "退市股日线可取，A 股回测可以做到无幸存者偏差（前提是拿全退市名单）。",
      };
    },
  },
  {
    id: "a.delisted_list",
    area: "A 股",
    title: "A 股退市名单（交易所官方）",
    async run(http, ctx) {
      const [sz, shMain, shStar] = await Promise.all([
        szseDelisted(http),
        sseDelisted(http, "1"),
        sseDelisted(http, "8"),
      ]);
      const all = [...sz, ...shMain, ...shStar];
      const since2013 = all.filter((r) => (r.delistDate ?? "") >= "2013-01-01");
      ctx.aDelistedSince2013 = since2013.length;
      return {
        status: sz.length && shMain.length ? "ok" : "fail",
        facts: [
          `深交所终止上市 ${sz.length} 家，上交所主板 ${shMain.length} 家，科创板 ${shStar.length} 家`,
          `其中 2013 年以后退市 ${since2013.length} 家（回测起点之后，必须纳入股票池）`,
          `样例：${all
            .slice(-3)
            .map((r) => `${r.code} ${r.name} ${r.delistDate}`)
            .join("；")}`,
        ],
        conclusion: "退市名单与退市日取交易所官方数据；北交所退市极少，v1 默认也不纳入北交所。",
      };
    },
  },
  {
    id: "a.universe",
    area: "A 股",
    title: "A 股证券表（东财公司资料）",
    async run(http, ctx) {
      const all = await emCount(http, {
        report: "RPT_F10_BASIC_ORGINFO",
        host: "sec",
        filter: '(SECURITY_TYPE_CODE="058001001")',
      });
      const latest = await emQuery(http, {
        report: "RPT_VALUEANALYSIS_DET",
        columns: "TRADE_DATE",
        sort: "TRADE_DATE",
        pageSize: 1,
        maxRows: 1,
      });
      const latestDate = d10(latest[0]?.TRADE_DATE);
      const listed = await emCount(http, {
        report: "RPT_VALUEANALYSIS_DET",
        filter: `(TRADE_DATE='${latestDate}')`,
      });
      ctx.aListedNow = listed;
      const sample = await emQuery(http, {
        report: "RPT_F10_BASIC_ORGINFO",
        host: "sec",
        filter: '(SECUCODE="000418.SZ")',
        columns: "SECUCODE,SECURITY_NAME_ABBR,LISTING_DATE,EM2016,FORMERNAME",
        maxRows: 1,
      });
      return {
        status: all > listed ? "ok" : "warn",
        facts: [
          `公司资料里 A 股类记录 ${all} 条（含已退市），${latestDate} 在交易的 ${listed} 只`,
          `退市股也有资料：000418 上市 ${d10(sample[0]?.LISTING_DATE)}，行业 ${str(sample[0]?.EM2016)}`,
          `曾用名只有序列没有日期：${str(sample[0]?.FORMERNAME)}`,
        ],
        conclusion: "证券表 = 公司资料（上市日、东财三级行业）+ 交易所退市名单（退市日）。",
      };
    },
  },
  {
    id: "a.financials",
    area: "A 股",
    title: "A 股财报（东财主要指标，逐股）",
    async run(http, ctx) {
      const rows = await emQuery(http, {
        report: "RPT_F10_FINANCE_MAINFINADATA",
        host: "sec",
        filter: '(SECUCODE="600519.SH")',
        columns: "REPORT_DATE,NOTICE_DATE,PARENTNETPROFIT,KCFJCXSYJLR,TOTAL_SHARE",
        sort: "REPORT_DATE",
        pageSize: 200,
      });
      const since2010 = rows.filter((r) => d10(r.REPORT_DATE) >= "2010-01-01");
      const withNotice = since2010.filter((r) => r.NOTICE_DATE).length;
      const delisted = await emCount(http, {
        report: "RPT_F10_FINANCE_MAINFINADATA",
        host: "sec",
        filter: '(SECUCODE="000418.SZ")',
      });
      const incr = await emCount(http, {
        report: "RPT_F10_FINANCE_MAINFINADATA",
        host: "sec",
        filter: `(NOTICE_DATE>='${addDays(ctx.today, -7)}')`,
      });
      return {
        status: withNotice === since2010.length && delisted > 0 ? "ok" : "warn",
        facts: [
          `600519 共 ${rows.length} 期，最早 ${d10(rows.at(-1)?.REPORT_DATE)}；2010 年后 ${since2010.length} 期全部带公告日（${withNotice}/${since2010.length}）`,
          `字段含归母净利、扣非净利、ROE、毛利率、负债率、每股经营现金流、报告期总股本`,
          `退市股 000418 有 ${delisted} 期（业绩报表 RPT_LICO_FN_CPD 不含退市股，所以必须逐股取主要指标）`,
          `按公告日全市场增量可查：近 7 天新公告 ${incr} 期`,
        ],
        conclusion: "财报按公告日生效（点时正确）；回填逐股一次取完，每日按公告日增量。",
      };
    },
  },
  {
    id: "a.shares",
    area: "A 股",
    title: "A 股股本变动历史（算点时市值）",
    async run(http, ctx) {
      const rows = await emQuery(http, {
        report: "RPT_F10_EH_EQUITY",
        host: "sec",
        filter: '(SECUCODE="600519.SH")',
        columns: "END_DATE,NOTICE_DATE,CHANGE_REASON,TOTAL_SHARES",
        sort: "END_DATE",
      });
      const delisted = await emCount(http, {
        report: "RPT_F10_EH_EQUITY",
        host: "sec",
        filter: '(SECUCODE="000418.SZ")',
      });
      const incr = await emCount(http, {
        report: "RPT_F10_EH_EQUITY",
        host: "sec",
        filter: `(NOTICE_DATE>='${addDays(ctx.today, -7)}')`,
      });
      return {
        status: rows.length && delisted ? "ok" : "fail",
        facts: [
          `600519 共 ${rows.length} 次变动，最早 ${d10(rows.at(-1)?.END_DATE)}（${str(rows.at(-1)?.CHANGE_REASON)}）`,
          `送转股有生效日：${rows
            .filter((r) => /送|转增/.test(String(r.CHANGE_REASON)))
            .slice(0, 2)
            .map((r) => `${d10(r.END_DATE)} ${r.CHANGE_REASON} → ${r.TOTAL_SHARES}`)
            .join("；")}`,
          `退市股 000418 有 ${delisted} 条；近 7 天全市场新公告 ${incr} 条`,
        ],
        conclusion: "市值 = 不复权收盘 × 当日有效总股本；PE/PB 由市值与财报自算，覆盖退市股，不依赖东财估值表。",
      };
    },
  },
  {
    id: "a.valuation_em",
    area: "A 股",
    title: "东财每日估值表（只作校验）",
    async run(http) {
      const first = await emQuery(http, {
        report: "RPT_VALUEANALYSIS_DET",
        filter: '(SECURITY_CODE="600519")',
        columns: "TRADE_DATE,PE_TTM,TOTAL_MARKET_CAP",
        sort: "TRADE_DATE",
        asc: true,
        maxRows: 1,
        pageSize: 1,
      });
      const delisted = await emCount(http, {
        report: "RPT_VALUEANALYSIS_DET",
        filter: '(SECURITY_CODE="000418")',
      });
      return {
        status: "warn",
        facts: [
          `最早 ${d10(first[0]?.TRADE_DATE)}，更早没有`,
          `不含退市股（000418 返回 ${delisted} 条）`,
        ],
        conclusion: "东财估值表有幸存者偏差且只到 2018，不作为因子来源，只用于体检时抽样核对自算的 PE/市值。",
      };
    },
  },
  {
    id: "a.names",
    area: "A 股",
    title: "A 股简称历史（ST 点时判定）",
    async run(http) {
      const count = await szseRecordCount(http, "SSGSGMXX", "tab2");
      const firstPages = await szseNameChanges(http, 3);
      const st = firstPages.filter((r) => /ST/.test(r.before + r.after)).length;
      return {
        status: "warn",
        facts: [
          `深交所官方简称变更 ${count} 条（含日期、变更前后简称），前 3 页 ${firstPages.length} 条里 ${st} 条与 ST 有关`,
          "上交所没有找到公开的简称变更接口；东财估值表有每日简称但只到 2018 且不含退市股",
        ],
        conclusion:
          "深市 ST 按官方简称变更精确判定；沪市 2018 年起用东财每日简称，更早与沪市退市股用「最近两期年报归母净利均为负」近似，并在结果里标注。",
      };
    },
  },
  {
    id: "hk.bars",
    area: "港股",
    title: "港股日线（腾讯）",
    async run(http) {
      const raw = await klineOnce(http, "00700.HK", "raw", "2016-01-01", "2016-12-31");
      const hfq = await klineRange(http, "00700.HK", "hfq", "2016-01-01", "2016-12-31");
      const f = hfq.length && raw.length ? hfq.at(-1)!.close / raw.at(-1)!.close : NaN;
      return {
        status: raw.length && hfq.length ? "ok" : "fail",
        facts: [
          `00700 2016 年不复权 ${raw.length} 条；后复权（hkfqkline）${hfq.length} 条，2016-12-30 复权因子 ${f.toFixed(4)}`,
          "港股复权接口忽略起始日、返回截止日往前 640 条，按截止日往回翻页",
          "fqkline 的 hfq 参数对港股无效（返回的是不复权价），必须用 hkfqkline",
        ],
        conclusion: "港股与 A 股同一张日线表：不复权 OHLC + 复权因子。",
      };
    },
  },
  {
    id: "hk.universe",
    area: "港股",
    title: "港股证券表（东财港股资料）",
    async run(http, ctx) {
      const info = await emQuery(http, {
        report: "RPT_HKF10_INFO_SECURITYINFO",
        host: "sec",
        columns: "SECUCODE,SECURITY_TYPE,BOARD,TRADE_UNIT,LISTING_DATE,GANGGUTONGBIAODISHEN",
        pageSize: 5000,
      });
      const types = new Map<string, number>();
      for (const r of info) types.set(String(r.SECURITY_TYPE), (types.get(String(r.SECURITY_TYPE)) ?? 0) + 1);
      const withLot = info.filter((r) => Number(r.TRADE_UNIT) > 0).length;
      const connect = info.filter((r) => r.GANGGUTONGBIAODISHEN === "是").length;
      ctx.hkEquities = info.length;
      const profile = await emCount(http, { report: "RPT_HKF10_INFO_ORGPROFILE", host: "sec" });
      return {
        status: info.length > 2000 ? "ok" : "warn",
        facts: [
          `证券资料 ${info.length} 条：${[...types.entries()].map(([k, v]) => `${k} ${v}`).join("、")}`,
          `每手股数 ${withLot}/${info.length} 有值；港股通（深）标的 ${connect} 只`,
          `公司资料（含行业 BELONG_INDUSTRY）${profile} 条，比在市证券多，含历史公司但没有退市日`,
        ],
        conclusion: "港股证券表 = 证券资料（每手、板块、H 股标记、港股通）+ 公司资料（行业）。",
      };
    },
  },
  {
    // 只在命令行（pnpm ivan probe）里跑：找沪港通的标记列（GANGGUTONGBIAODISHEN 只是深港通，D61）；找到后 S14 加采 hk_connect_sh
    id: "hk.connect.columns",
    area: "港股",
    title: "港股通标记列（证券资料里所有含 GANGGUTONG 的列）",
    async run(http) {
      const rows = await emQuery(http, {
        report: "RPT_HKF10_INFO_SECURITYINFO",
        host: "sec",
        columns: "ALL",
        pageSize: 1,
        maxRows: 1,
      });
      const keys = Object.keys(rows[0] ?? {}).filter((k) => /GANGGUTONG/i.test(k));
      return {
        status: keys.length ? "ok" : "warn",
        facts: [
          keys.length
            ? `含 GANGGUTONG 的列：${keys.map((k) => `${k}=${String(rows[0]![k] ?? "空")}`).join("、")}`
            : "证券资料里没有含 GANGGUTONG 的列",
        ],
        conclusion:
          "GANGGUTONGBIAODISHEN 是深港通标的，记为 hk_connect_sz；另有沪港通的列时核实含义后再采集 hk_connect_sh。",
      };
    },
  },
  {
    id: "hk.financials",
    area: "港股",
    title: "港股财报（东财港股主要指标）",
    async run(http) {
      const rows = await emQuery(http, {
        report: "RPT_HKF10_FN_MAININDICATOR",
        host: "sec",
        filter: '(SECUCODE="00700.HK")',
        columns: "REPORT_DATE,DATE_TYPE_CODE,HOLDER_PROFIT,ISSUED_COMMON_SHARES",
        sort: "REPORT_DATE",
        pageSize: 200,
      });
      let noticeField = "有";
      try {
        await emQuery(http, {
          report: "RPT_HKF10_FN_MAININDICATOR",
          host: "sec",
          filter: '(SECUCODE="00700.HK")',
          columns: "NOTICE_DATE",
          maxRows: 1,
        });
      } catch (e) {
        if (e instanceof EastmoneyError) noticeField = "没有（接口报字段不存在）";
        else throw e;
      }
      const period = "2025-12-31";
      const cur = await emQuery(http, {
        report: "RPT_HKF10_FN_INCOME",
        host: "sec",
        filter: `(REPORT_DATE='${period}')(STD_ITEM_CODE="004001001")`,
        columns: "SECUCODE,CURRENCY_CODE",
        pageSize: 5000,
      });
      const byCur = new Map<string, number>();
      for (const r of cur) byCur.set(String(r.CURRENCY_CODE), (byCur.get(String(r.CURRENCY_CODE)) ?? 0) + 1);
      const marketWide = await emCount(http, {
        report: "RPT_HKF10_FN_MAININDICATOR",
        host: "sec",
        filter: `(REPORT_DATE='${period}')`,
      });
      return {
        status: "warn",
        facts: [
          `00700 共 ${rows.length} 期，最早 ${d10(rows.at(-1)?.REPORT_DATE)}；可按报告期全市场取（${period} 期 ${marketWide} 家）`,
          `公告日字段：${noticeField}`,
          `记账币种（${period} 期营业额科目）：${[...byCur.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k} ${v}`)
            .join("、")}——金额是记账币种，不是港币`,
        ],
        conclusion:
          "港股财报按法定披露期限保守推算生效日（年报 +90 天，中报/季报 +60 天）；金额按外汇中心中间价换成港币再算 PE。",
      };
    },
  },
  {
    id: "hk.shares",
    area: "港股",
    title: "港股股本变动",
    async run(http) {
      const n = await emCount(http, {
        report: "RPT_HKF10_INFO_EQUITY",
        host: "sec",
        filter: '(SECUCODE="00700.HK")',
      });
      return {
        status: n ? "ok" : "fail",
        facts: [`00700 股本变动 ${n} 条（含期权行权、回购，每条有生效日与总股本）`],
        conclusion: "港股点时市值同 A 股：不复权收盘 × 当日有效总股本。",
      };
    },
  },
  {
    id: "hk.delisted",
    area: "港股",
    title: "港股退市股",
    async run() {
      return {
        status: "warn",
        facts: [
          "没有找到港股退市名单的免费接口；港股代码退市后会被重新分配，不能靠「代码没行情了」推断",
        ],
        conclusion: "港股回测有幸存者偏差，结果常驻 survivorship 提示。",
      };
    },
  },
  {
    id: "idx.price",
    area: "指数与汇率",
    title: "价格指数（腾讯）",
    async run(http) {
      const syms = ["sh000300", "sh000001", "sz399006", "hkHSI", "hkHSCEI"];
      const facts: string[] = [];
      let ok = 0;
      for (const s of syms) {
        const bars = await indexKline(http, s, "2013-01-01", "2013-01-31");
        if (bars.length) ok++;
        facts.push(`${s}：2013-01 ${bars.length} 条`);
      }
      return { status: ok === syms.length ? "ok" : "warn", facts };
    },
  },
  {
    id: "idx.tri",
    area: "指数与汇率",
    title: "全收益基准",
    async run(http, ctx) {
      const tri = await csindexHistory(http, "H00300", "2013-01-01", ctx.today);
      const hsi = await klineRange(http, "02800.HK", "hfq", addDays(ctx.today, -40), ctx.today);
      const hscei = await klineRange(http, "02828.HK", "hfq", addDays(ctx.today, -40), ctx.today);
      return {
        status: tri.length ? "ok" : "warn",
        facts: [
          `中证官网 H00300 沪深300全收益：${tri.length} 条，${tri[0]?.date} ~ ${tri.at(-1)?.date}（最新值通常晚 1 个交易日以上）`,
          `恒指没有免费的全收益指数接口；盈富基金 02800 后复权近 40 天 ${hsi.length} 条，恒生中国企业 ETF 02828 ${hscei.length} 条`,
        ],
        conclusion:
          "A 股基准默认用 H00300 全收益；港股基准用盈富基金 02800（国企指数用 02828）后复权价作为含分红基准（含约 0.1%/年管理费），界面标注来源。",
      };
    },
  },
  {
    id: "fx",
    area: "指数与汇率",
    title: "人民币汇率中间价",
    async run(http) {
      const rows = await centralParity(http, ["USD/CNY", "HKD/CNY"], "2013-01-04", "2013-01-31");
      return {
        status: rows.length ? "ok" : "fail",
        facts: [`2013-01 取到 ${rows.length} 天，例：${rows[0]?.date} ${JSON.stringify(rows[0]?.rates)}`],
        conclusion: "港股财报金额换算港币：人民币 ÷ HKD/CNY；美元先 × USD/CNY 再 ÷ HKD/CNY。",
      };
    },
  },
  {
    id: "throughput",
    area: "吞吐",
    title: "抓取吞吐（并发 4）",
    async run(_http, ctx) {
      const http = new Http({ concurrencyPerHost: 4, minIntervalMs: 50 });
      const codes = [
        "600519.SH", "000001.SZ", "000858.SZ", "601318.SH", "600036.SH", "300750.SZ",
        "002415.SZ", "600276.SH", "000333.SZ", "601888.SH", "688981.SH", "002594.SZ",
        "600900.SH", "601166.SH", "000651.SZ", "600030.SH", "300059.SZ", "002475.SZ",
        "601012.SH", "000725.SZ",
      ];
      let t0 = Date.now();
      await mapLimit(codes, 8, async (c) => {
        await klineOnce(http, c, "raw", "2016-01-01", "2018-03-10");
        await klineOnce(http, c, "hfq", "2016-01-01", "2018-03-10");
      });
      const kRate = (codes.length * 2) / ((Date.now() - t0) / 1000);
      t0 = Date.now();
      await mapLimit(codes, 8, (c) =>
        emQuery(http, {
          report: "RPT_F10_FINANCE_MAINFINADATA",
          host: "sec",
          filter: `(SECUCODE="${c}")`,
          columns: "REPORT_DATE,NOTICE_DATE,PARENTNETPROFIT",
          pageSize: 200,
        }),
      );
      const eRate = codes.length / ((Date.now() - t0) / 1000);
      ctx.klineReqPerSec = kRate;
      ctx.emReqPerSec = eRate;
      const stats = http.stats().map((s) => `${s.host} 平均 ${s.avgMs}ms，失败 ${s.failures}`);
      return {
        status: "ok",
        facts: [
          `腾讯日 K ${kRate.toFixed(1)} 次/秒，东财 ${eRate.toFixed(1)} 次/秒`,
          ...stats,
        ],
      };
    },
  },
];

export async function runProbe(onProgress?: (c: ProbeCheck) => void): Promise<ProbeReport> {
  const http = new Http({ concurrencyPerHost: 4, minIntervalMs: 50 });
  const ctx: ProbeContext = { today: todayCN() };
  const checks: ProbeCheck[] = [];
  for (const c of CHECKS) {
    const t0 = Date.now();
    let res: Omit<ProbeCheck, "id" | "area" | "title" | "ms">;
    try {
      res = await c.run(http, ctx);
    } catch (e) {
      res = { status: "fail", facts: [`异常：${e instanceof Error ? e.message : String(e)}`] };
    }
    const check = { id: c.id, area: c.area, title: c.title, ms: Date.now() - t0, ...res };
    checks.push(check);
    onProgress?.(check);
  }
  return {
    date: ctx.today,
    env: `Node ${process.version} · ${process.platform}-${process.arch}`,
    checks,
    estimate: estimateBackfill(ctx),
  };
}

/** 回填耗时估算：2013 年起（留出 5 年给估值分位），不复权 + 后复权两套日线。 */
function estimateBackfill(ctx: ProbeContext): string[] {
  const years = Number(ctx.today.slice(0, 4)) - 2013 + 1;
  const windows = Math.ceil((years * 365) / 800);
  const aStocks = (ctx.aListedNow ?? 5500) + (ctx.aDelistedSince2013 ?? 300);
  const hkStocks = ctx.hkEquities ?? 2600;
  const kRate = ctx.klineReqPerSec ?? 10;
  const eRate = ctx.emReqPerSec ?? 5;
  const aK = aStocks * windows * 2;
  const hkK = hkStocks * (windows + Math.ceil((years * 250) / 640));
  const aE = aStocks * 3; // 主要指标 + 股本 + 公司资料
  const hkE = hkStocks * 2;
  const kMin = (aK + hkK) / kRate / 60;
  const eMin = (aE + hkE) / eRate / 60;
  return [
    `A 股约 ${aStocks} 只（在市 + 2013 年后退市），港股约 ${hkStocks} 只；日线窗口 ${windows} 段/只/复权口径`,
    `日线请求约 ${(aK + hkK).toLocaleString()} 次，按实测 ${kRate.toFixed(1)} 次/秒约 ${kMin.toFixed(0)} 分钟`,
    `东财逐股请求约 ${(aE + hkE).toLocaleString()} 次，按实测 ${eRate.toFixed(1)} 次/秒约 ${eMin.toFixed(0)} 分钟`,
    `两类请求走不同域名可并行，全量回填预计 ${Math.max(kMin, eMin).toFixed(0)}–${(kMin + eMin).toFixed(0)} 分钟；可断点续跑`,
  ];
}

const ICON: Record<ProbeStatus, string> = { ok: "✅", warn: "⚠️", fail: "❌" };

export function renderProbeMarkdown(r: ProbeReport): string {
  const lines = [
    `# 数据探针报告 ${r.date}`,
    "",
    `运行环境：${r.env}。由 \`pnpm ivan probe --out\` 生成；只读外部接口，不写本地数据。`,
    "",
  ];
  let area = "";
  for (const c of r.checks) {
    if (c.area !== area) {
      area = c.area;
      lines.push(`## ${area}`, "");
    }
    lines.push(`### ${ICON[c.status]} ${c.title} \`${c.id}\``, "");
    for (const f of c.facts) lines.push(`- ${f}`);
    if (c.conclusion) lines.push("", `**结论**：${c.conclusion}`);
    lines.push("");
  }
  lines.push("## 回填耗时估算", "");
  for (const e of r.estimate) lines.push(`- ${e}`);
  lines.push("");
  return lines.join("\n");
}

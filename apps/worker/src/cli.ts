/**
 * 运维命令行：`pnpm ivan <命令>`。
 *   probe [--out <文件>]                      数据探针：确认免费数据源的覆盖范围
 *   backfill --market A|HK [--since 2013-01-01] [--steps a,b] [--limit N] [--top N] [--codes c1,c2] [--force]
 *            （环境变量 KLINE_SOURCE=tencent|eastmoney 让日线与指数只走一家、不回退；auto 或不设 = 按回退链，
 *              顺序见 IVAN_CHAIN_*，D72）
 *                                              回填行情仓（可断点续跑）
 *   daily --market A|HK [--critical c1,c2]   夜间增量（休市自动跳过）。完整性闸门（D73）：缺日线的股票超过阈值时
 *                                              版本记 incomplete 并报错；ETL_ACCEPT_MISSING=c1,c2 放行指定代码；
 *                                              命令行不读应用库的跟踪，持仓股要用 --critical 指定（缺了不让整晚失败）
 *   factors --market A|HK [--from 日期]       重算因子
 *   backtest <spec.json> [--start 2018-01-01] [--end 日期] [--capital 1000000] [--out 结果.json]
 *                                              回测一份策略（CLI 版，不写应用库）
 *   screen <spec.json> [--date 日期] [--limit 30] 按策略在某天选股
 *   doctor                                    体检：数据源连通性 + 行情仓各表的规模与最新日期 + 失败的回填项
 *   migrate                                   升级行情仓表结构（要改大表时 worker 不自己做，见 scripts/migrate.sh）
 *   sql "<SQL>"                               对行情仓执行只读查询（调试用）
 *
 * 注意：worker 服务运行时独占行情仓文件，命令行要在 worker 停掉时跑（或通过管理页触发任务）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "@ivan/core/config";
import {
  DEFAULT_PARAMS,
  defaultExec,
  describeExec,
  type Market,
  todayCN,
  validateSpec,
} from "@ivan/core";
import {
  acceptMissingFromEnv,
  backfill,
  BACKFILL_STEPS,
  type BackfillStep,
  buildSimInput,
  committedAsOf,
  hashSimInput,
  computeFactors,
  screenOn,
  daily,
  type EtlContext,
  Http,
  renderProbeMarkdown,
  runProbe,
  SCHEMA_VERSION,
  Warehouse,
} from "@ivan/data";
import { runSimTasks, validationSeed } from "./sim-tasks.ts";

const [cmd, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}
const has = (name: string) => rest.includes(`--${name}`);

function market(): Market {
  const m = (flag("market") ?? "A").toUpperCase();
  if (m !== "A" && m !== "HK") throw new Error(`--market 只能是 A 或 HK`);
  return m;
}

/** ETL 上下文 + 具体的 Http（上下文里只是 HttpLike，统计要从具体实例拿）。 */
async function openCtx(): Promise<{ ctx: EtlContext; http: Http }> {
  const cfg = loadConfig();
  const wh = await Warehouse.open(cfg.warehousePath, cfg.duckdb);
  const klineMs = process.env.KLINE_INTERVAL_MS ? Number(process.env.KLINE_INTERVAL_MS) : undefined;
  const http = new Http({
    concurrencyPerHost: cfg.fetch.concurrency,
    minIntervalMs: cfg.fetch.minIntervalMs,
    ...(klineMs
      ? { hostIntervals: { "web.ifzq.gtimg.cn": klineMs, "push2his.eastmoney.com": klineMs } }
      : {}),
  });
  const t0 = Date.now();
  const ctx: EtlContext = {
    wh,
    http,
    today: flag("today") ?? todayCN(),
    log: (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s] ${m}`),
  };
  return { ctx, http };
}

async function main() {
  switch (cmd) {
    case "probe": {
      const icon = { ok: "✅", warn: "⚠️ ", fail: "❌" } as const;
      const report = await runProbe((c) =>
        console.log(`${icon[c.status]} ${c.title}（${(c.ms / 1000).toFixed(1)}s）`),
      );
      const md = renderProbeMarkdown(report);
      const out = flag("out");
      if (out) {
        writeFileSync(out, md);
        console.log(`\n报告已写入 ${out}`);
      } else console.log(`\n${md}`);
      if (report.checks.some((c) => c.status === "fail")) process.exitCode = 1;
      return;
    }
    case "backfill": {
      const { ctx, http } = await openCtx();
      const steps = flag("steps")?.split(",") as BackfillStep[] | undefined;
      for (const s of steps ?? []) {
        if (!BACKFILL_STEPS.includes(s))
          throw new Error(`未知步骤 ${s}，可选 ${BACKFILL_STEPS.join(",")}`);
      }
      await backfill(ctx, market(), {
        since: flag("since"),
        steps,
        limit: flag("limit") ? Number(flag("limit")) : undefined,
        codes: flag("codes")?.split(","),
        top: flag("top") ? Number(flag("top")) : undefined,
        force: has("force"),
      });
      printHttp(http);
      ctx.wh.close();
      return;
    }
    case "daily": {
      const { ctx, http } = await openCtx();
      const r = await daily(ctx, market(), {
        critical: flag("critical")?.split(","),
        acceptMissing: acceptMissingFromEnv(),
      });
      console.log(r);
      printHttp(http);
      ctx.wh.close();
      return;
    }
    case "factors": {
      const { ctx } = await openCtx();
      await computeFactors(ctx, market(), flag("from") ?? "2013-01-01", {
        codes: flag("codes")?.split(","),
      });
      ctx.wh.close();
      return;
    }
    case "backtest":
    case "screen": {
      const file = rest.find((r) => r.endsWith(".json"));
      if (!file) throw new Error("需要一个策略 JSON 文件");
      const v = validateSpec(JSON.parse(readFileSync(file, "utf8")));
      if (!v.ok || !v.spec) {
        console.error(`策略不合法：\n${v.errors.join("\n")}`);
        process.exitCode = 1;
        return;
      }
      const cfg = loadConfig();
      const wh = await Warehouse.open(cfg.warehousePath, { ...cfg.duckdb, readOnly: true });
      if (cmd === "screen") {
        const date = flag("date") ?? (await committedAsOf(wh, v.spec.market));
        if (!date) throw new Error("行情仓还没有提交过的数据，先运行回填");
        const rows = await screenOn(wh, v.spec, date, Number(flag("limit") ?? 30));
        console.log(`${date} 选股 ${rows.length} 只`);
        console.table(
          rows.map((r) => ({
            rank: r.rank,
            code: r.code,
            name: r.name,
            score: r.score.toFixed(3),
            ...r.factors,
          })),
        );
        wh.close();
        return;
      }
      const t0 = Date.now();
      const built = await buildSimInput(wh, v.spec, {
        ...DEFAULT_PARAMS,
        start: flag("start") ?? DEFAULT_PARAMS.start,
        end: flag("end") ?? todayCN(),
        capital: Number(flag("capital") ?? DEFAULT_PARAMS.capital),
        oosMonths: Number(flag("oos") ?? DEFAULT_PARAMS.oosMonths),
        // 和网页回测一样显式传成交假设（D55），不让引擎悄悄按缺省跑
        exec: defaultExec(v.spec.market),
      });
      const t1 = Date.now();
      const hashes = hashSimInput(built.input);
      // 和网页回测一样：指标第 2 版再算可信度（D65），种子来自输入指纹
      const { result: r, validation } = runSimTasks(built.input, {
        tasks: ["validation"],
        seed: validationSeed(hashes.inputHash),
      });
      const t2 = Date.now();
      const m = r.metrics;
      const p = (x: number) => `${(x * 100).toFixed(2)}%`;
      console.log(
        `区间 ${m.start} ~ ${m.end}（数据版本 ${built.dataVersion.id}，截至 ${built.dataVersion.asOf}）`,
      );
      console.log(
        `引擎 ${r.engineVersion}，成交假设：${describeExec(r.exec)}，输入指纹 ${hashes.inputHash.slice(0, 8)}`,
      );
      console.log(
        `组装 ${t1 - t0}ms（决策日 ${built.stats.decisionDates}，股票 ${built.stats.codes}，日线 ${built.stats.priceRows} 行），模拟 ${t2 - t1}ms，内存 ${(process.memoryUsage().rss / 1e6).toFixed(0)}MB`,
      );
      console.table({
        总收益: p(m.totalReturn),
        年化: p(m.cagr),
        基准年化: p(m.benchCagr),
        年化超额: p(m.excessCagr),
        最大回撤: p(m.maxDrawdown),
        夏普: m.sharpe.toFixed(2),
        胜率: m.winRate === null ? "-" : p(m.winRate),
        年化换手: m.turnover.toFixed(2),
        买入笔数: m.buys,
      });
      if (r.segments.outOfSample) {
        console.log(
          `样本内年化超额 ${p(r.segments.inSample.excessCagr)}，样本外（${r.segments.outOfSample.start} 起）${p(r.segments.outOfSample.excessCagr)}`,
        );
      }
      if (validation) {
        const c = validation.confidence;
        const ci = (x: { est: number; lo: number; hi: number }) =>
          `${p(x.est)}（95% 区间 ${p(x.lo)} ~ ${p(x.hi)}）`;
        console.log(
          `可信度（按历史日收益成段重抽样 ${c.B} 次，平均段长 ${c.blockMean} 天，种子 ${c.seed}；是区间，不是预测）：` +
            `年化超额 ${ci(c.excessCagr)}，最大回撤 ${ci(c.maxDrawdown)}，` +
            `跑赢基准的把握 ${c.psrActive === null ? "-" : p(c.psrActive)}`,
        );
      }
      for (const c of r.checks)
        console.log(`${c.level === "warn" ? "⚠️ " : "ℹ️ "} ${c.title}：${c.detail}`);
      const out = flag("out");
      if (out) writeFileSync(out, JSON.stringify(validation ? { ...r, validation } : r, null, 2));
      wh.close();
      return;
    }
    case "doctor": {
      const cfg = loadConfig();
      const http = new Http({ retries: 1, timeoutMs: 10_000 });
      const checks: Array<[string, () => Promise<unknown>]> = [
        [
          "东财数据中心",
          () =>
            http.json(
              "https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_EH_EQUITY&columns=END_DATE&filter=(SECUCODE=%22600519.SH%22)&pageNumber=1&pageSize=1&source=WEB&client=WEB",
            ),
        ],
        [
          "东财日 K（push2his）",
          () =>
            http.json(
              "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600519&fields1=f1&fields2=f51,f52&klt=101&fqt=0&beg=20250101&end=20250110&lmt=5",
            ),
        ],
        [
          "腾讯日 K",
          () =>
            http.json(
              "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,2025-01-01,2025-01-10,5,",
            ),
        ],
        ["腾讯报价", () => http.text("https://qt.gtimg.cn/q=sh600519", { encoding: "gbk" })],
        [
          "深交所",
          () =>
            http.json(
              "https://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=1793_ssgs&TABKEY=tab2&PAGENO=1",
            ),
        ],
        [
          "中证指数",
          () =>
            http.json(
              "https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=H00300&startDate=20250102&endDate=20250110",
            ),
        ],
      ];
      for (const [name, fn] of checks) {
        const t0 = Date.now();
        try {
          await fn();
          console.log(`✅ ${name}（${Date.now() - t0}ms）`);
        } catch (e) {
          console.log(`❌ ${name}：${e instanceof Error ? e.message : e}`);
        }
      }
      let wh: Warehouse;
      try {
        wh = await Warehouse.open(cfg.warehousePath, { ...cfg.duckdb, readOnly: true });
      } catch (e) {
        console.log(
          `\n行情仓打不开（worker 正在运行时会被独占）：${e instanceof Error ? e.message : e}`,
        );
        return;
      }
      const q = (sql: string) => wh.all(sql);
      console.log("\n行情仓：");
      console.table(
        await q(
          `SELECT market, count(*) AS 证券, count(delist_date) AS 已退市 FROM securities GROUP BY market ORDER BY market`,
        ),
      );
      console.table(
        await q(`SELECT s.market, count(*) AS 日线行数, count(DISTINCT b.code) AS 股票数, max(b.date)::VARCHAR AS 最新
                 FROM bars_daily b JOIN securities s ON s.code = b.code GROUP BY s.market ORDER BY s.market`),
      );
      console.table(
        await q(
          `SELECT market, count(*) AS 因子行数, max(date)::VARCHAR AS 最新 FROM factors_daily GROUP BY market ORDER BY market`,
        ),
      );
      if (await wh.pendingHeavyMigration()) {
        console.log("\n⚠️  行情仓还是第 2 版，需要升级：bash scripts/migrate.sh");
      } else {
        console.table(
          await q(
            `SELECT id, market, as_of::VARCHAR AS as_of, kind, coalesce(status, 'ok') AS 状态,
                    finished_at::VARCHAR AS 完成 FROM data_versions ORDER BY id DESC LIMIT 4`,
          ),
        );
      }
      const failed = await q(
        `SELECT task, count(*) AS n FROM etl_progress WHERE status = 'failed' GROUP BY task`,
      );
      if (failed.length) {
        console.log("回填失败项（重跑 backfill 会自动重试）：");
        console.table(failed);
      }
      wh.close();
      return;
    }
    case "migrate": {
      // 改大表的升级（第 3 版在约 2500 万行日线上补列）：worker 要先停掉，scripts/migrate.sh 负责停与拉起
      const cfg = loadConfig();
      const t0 = Date.now();
      const wh = await Warehouse.open(cfg.warehousePath, { ...cfg.duckdb, migrate: "auto" });
      await wh.checkpoint();
      wh.close();
      console.log(
        `行情仓已升级到第 ${SCHEMA_VERSION} 版，用时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`,
      );
      return;
    }
    case "sql": {
      const cfg = loadConfig();
      const wh = await Warehouse.open(cfg.warehousePath, { ...cfg.duckdb, readOnly: true });
      const rows = await wh.all(rest.filter((r) => !r.startsWith("--")).join(" "));
      console.table(rows.slice(0, Number(flag("limit") ?? 50)));
      wh.close();
      return;
    }
    default:
      console.log(
        "用法：pnpm ivan <probe|backfill|daily|factors|backtest|screen|doctor|migrate|sql> [参数]，详见 apps/worker/src/cli.ts",
      );
      process.exitCode = cmd ? 1 : 0;
  }
}

function printHttp(http: Http) {
  for (const s of http.stats()) {
    console.log(`  ${s.host}: ${s.requests} 次请求，失败 ${s.failures}，平均 ${s.avgMs}ms`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * 行情仓表结构。改表结构时 SCHEMA_VERSION 加 1；这里只做「IF NOT EXISTS」式的增量建表，
 * 需要改列的变更写成显式的 ALTER 语句追加在末尾。
 */
import { EVENT_FACTOR_KEYS, FACTORS } from "@ivan/core";
import { FIX_A_VOLUME_SQL } from "../compute/volume-unit.ts";

/**
 * 5 = S15b：factors_daily 表尾加 7 个事件因子列（注册表第 3 版）。在约 1600 万行的因子表上加列是重迁移（D76、D83），
 * worker 启动时不做，进维护状态（MAINTENANCE_V5），由 scripts/migrate.sh 执行；回滚到 R4 之前先 `migrate --down 4`。
 */
export const SCHEMA_VERSION = 5;

/** factors_daily 的列：键列 + 注册表里的全部因子（分类因子 VARCHAR，布尔 BOOLEAN，其余 DOUBLE）。 */
export const FACTOR_COLUMNS = FACTORS.map((f) => f.key);

function factorType(kind: string): string {
  return kind === "category" ? "VARCHAR" : kind === "bool" ? "BOOLEAN" : "DOUBLE";
}

function factorColumnDdl(): string {
  return FACTORS.map((f) => `${f.key} ${factorType(f.kind)}`).join(",\n  ");
}

/** 表尾带 src、ver 两列的表（第 3 版起）。 */
export const PROVENANCE_TABLES = [
  "bars_daily",
  "corp_actions",
  "index_bars",
  "financials",
  "share_changes",
] as const;

/** 数据来源的中文名（界面与日志用；空 = 来源未记录）。 */
export const SOURCE_LABEL: Record<string, string> = {
  em: "东财",
  tx: "腾讯日 K",
  txq: "腾讯实时报价",
  csi: "中证官网",
  prov: "临时补齐的全收益",
};

export const SCHEMA_SQL: string[] = [
  `CREATE TABLE IF NOT EXISTS securities (
  code VARCHAR PRIMARY KEY,
  market VARCHAR NOT NULL,
  name VARCHAR,
  board VARCHAR,
  list_date DATE,
  delist_date DATE,
  lot_size INTEGER,
  industry_l1 VARCHAR,
  industry VARCHAR,
  sec_type VARCHAR,
  updated_at TIMESTAMP DEFAULT current_timestamp
)`,
  // 简称历史：source = szse（深交所官方变更记录，before/after）| em_daily（东财每日简称，只记变化）
  `CREATE TABLE IF NOT EXISTS name_changes (
  code VARCHAR NOT NULL,
  date DATE NOT NULL,
  before VARCHAR,
  after VARCHAR,
  source VARCHAR NOT NULL
)`,
  // 日线：不复权 OHLC；volume 统一为股；amount 成交额（本币元；腾讯日 K 来源时为空，夜间报价有）；
  // adj = 等比复权因子（分红再投入，只在公司行动日变化；由后复权价反推，见 compute/adjust.ts）
  `CREATE TABLE IF NOT EXISTS bars_daily (
  code VARCHAR NOT NULL,
  date DATE NOT NULL,
  open DOUBLE,
  high DOUBLE,
  low DOUBLE,
  close DOUBLE,
  volume DOUBLE,
  amount DOUBLE,
  adj DOUBLE
)`,
  // 除权除息事实：前收与参考价（二者之比 = 等比因子跳变）；cash/split 已知时直接存，
  // 未知（A 股单请求路径）时为空，算因子时结合股本变动拆分
  `CREATE TABLE IF NOT EXISTS corp_actions (
  code VARCHAR NOT NULL,
  date DATE NOT NULL,
  prev_close DOUBLE,
  ref_price DOUBLE,
  cash DOUBLE,
  split DOUBLE
)`,
  // 股本变动：eff_date 起生效
  `CREATE TABLE IF NOT EXISTS share_changes (
  code VARCHAR NOT NULL,
  eff_date DATE NOT NULL,
  notice_date DATE,
  total_shares DOUBLE,
  reason VARCHAR
)`,
  // 财报（报告期累计口径）：eff_date = A 股公告日；港股按法定期限推算（D22）
  `CREATE TABLE IF NOT EXISTS financials (
  code VARCHAR NOT NULL,
  report_date DATE NOT NULL,
  period VARCHAR,
  fy_start DATE,
  notice_date DATE,
  eff_date DATE NOT NULL,
  currency VARCHAR,
  revenue DOUBLE,
  np DOUBLE,
  deducted_np DOUBLE,
  revenue_yoy DOUBLE,
  np_yoy DOUBLE,
  deducted_np_yoy DOUBLE,
  roe DOUBLE,
  gross_margin DOUBLE,
  debt_ratio DOUBLE,
  ocf DOUBLE,
  equity DOUBLE,
  shares DOUBLE
)`,
  // 指数：sym = csi300 / csi300_tr / sse / hsi / hsi_tr / hscei / hscei_tr / chinext …
  `CREATE TABLE IF NOT EXISTS index_bars (
  sym VARCHAR NOT NULL,
  date DATE NOT NULL,
  close DOUBLE,
  provisional BOOLEAN DEFAULT false
)`,
  `CREATE TABLE IF NOT EXISTS trade_calendar (
  market VARCHAR NOT NULL,
  date DATE NOT NULL
)`,
  // 汇率：1 单位 ccy = rate 港币（由人民币中间价换算）
  `CREATE TABLE IF NOT EXISTS fx_hkd (
  ccy VARCHAR NOT NULL,
  date DATE NOT NULL,
  rate DOUBLE
)`,
  `CREATE TABLE IF NOT EXISTS factors_daily (
  code VARCHAR NOT NULL,
  date DATE NOT NULL,
  market VARCHAR NOT NULL,
  close DOUBLE,
  ${factorColumnDdl()}
)`,
  `CREATE TABLE IF NOT EXISTS data_versions (
  id INTEGER PRIMARY KEY,
  market VARCHAR NOT NULL,
  as_of DATE,
  kind VARCHAR,
  finished_at TIMESTAMP DEFAULT current_timestamp,
  revised_rows INTEGER DEFAULT 0,
  note VARCHAR
)`,
  `CREATE SEQUENCE IF NOT EXISTS data_version_seq START 1`,
  `CREATE TABLE IF NOT EXISTS etl_progress (
  task VARCHAR NOT NULL,
  key VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  detail VARCHAR,
  updated_at TIMESTAMP DEFAULT current_timestamp,
  PRIMARY KEY (task, key)
)`,
  // 第 2 版（注册表第 2 版新增因子）与第 5 版（注册表第 3 版的 7 个事件因子，S15b）：已有的行情仓在表尾补列，
  // 顺序与注册表一致；新建的库这些语句是空操作
  ...FACTORS.map((f) => `ALTER TABLE factors_daily ADD COLUMN IF NOT EXISTS ${f.key} ${factorType(f.kind)}`),
  // 第 3 版（D60、D61）：行级来源与版本号加在表尾（Warehouse.append 按列序写，写入方在行元组末尾补这两个值）。
  // src：em 东财 / tx 腾讯日 K / txq 腾讯实时报价 / csi 中证官网 / prov 临时补齐的全收益；已有的行为空 = 来源未记录。
  // 在约 2500 万行的 bars_daily 上补列是重迁移，worker 启动时不做（见 Warehouse.open 的 migrate: "light" 与 scripts/migrate.sh）
  ...PROVENANCE_TABLES.flatMap((t) => [
    `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS src VARCHAR`,
    `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ver INTEGER`,
  ]),
  // 交易日历也盖版本号（夜间增量先开版本再更新指数与日历）
  `ALTER TABLE trade_calendar ADD COLUMN IF NOT EXISTS ver INTEGER`,
  // 停牌 / 没成交 / 缺失（S13 起写）
  `CREATE TABLE IF NOT EXISTS bar_status (
  code VARCHAR NOT NULL,
  date DATE NOT NULL,
  status VARCHAR NOT NULL,
  reason VARCHAR,
  src VARCHAR,
  ver INTEGER
)`,
  `CREATE SEQUENCE IF NOT EXISTS data_issue_seq START 1`,
  // 数据问题：severity = reject（拒收不入库）| flag（入库但标记）；resolved_by = refetch | check | admin（S13 起写）
  `CREATE TABLE IF NOT EXISTS data_issues (
  id BIGINT DEFAULT nextval('data_issue_seq'),
  ver INTEGER,
  dataset VARCHAR,
  code VARCHAR,
  date DATE,
  rule VARCHAR,
  severity VARCHAR,
  detail VARCHAR,
  src VARCHAR,
  created_at TIMESTAMP DEFAULT current_timestamp,
  resolved_ver INTEGER,
  resolved_by VARCHAR
)`,
  // 点时属性快照（D61）：[valid_from, valid_to) 区间，valid_to 为空 = 当前值；首次快照从当天起算，绝不回填
  `CREATE TABLE IF NOT EXISTS attr_history (
  code VARCHAR NOT NULL,
  attr VARCHAR NOT NULL,
  value VARCHAR,
  valid_from DATE NOT NULL,
  valid_to DATE,
  src VARCHAR,
  ver INTEGER
)`,
  // 财报首见留底（D61）：（代码, 报告期, 数值指纹）第一次见到的日子与按列名的原始行
  `CREATE TABLE IF NOT EXISTS financials_seen (
  code VARCHAR NOT NULL,
  report_date DATE NOT NULL,
  row_hash VARCHAR NOT NULL,
  first_seen DATE NOT NULL,
  ver INTEGER,
  row_json VARCHAR
)`,
  // 数据版本先开后提交（D60）：status = open | ok | incomplete | failed | skipped，旧行为空 = ok
  `ALTER TABLE data_versions ADD COLUMN IF NOT EXISTS status VARCHAR`,
  `ALTER TABLE data_versions ADD COLUMN IF NOT EXISTS started_at TIMESTAMP`,
  `ALTER TABLE data_versions ADD COLUMN IF NOT EXISTS completeness VARCHAR`,
  `ALTER TABLE data_versions ADD COLUMN IF NOT EXISTS sources VARCHAR`,
  `ALTER TABLE data_versions ADD COLUMN IF NOT EXISTS registry_version INTEGER`,
  // ── 第 4 版（S15，D80、D81）：点时事件数据集，只加表、轻量升级 ──
  // 列顺序是约定（Warehouse.append 按列序写），迁移测试钉着。每行：src 来源（本轮只有 em）、
  // ver 写它的夜间数据版本（后台回填为空）、batch 写它的 pit_batches.id（永远有值）。
  // 两融明细：日期之后的下一个交易日才可得；rzyezb 是东财原样的 %（留作核对），其余金额元、融券余量股
  `CREATE TABLE IF NOT EXISTS margin_daily (
  code VARCHAR NOT NULL,
  date DATE NOT NULL,
  avail_date DATE NOT NULL,
  rzye DOUBLE,
  rzmre DOUBLE,
  rzche DOUBLE,
  rqye DOUBLE,
  rqyl DOUBLE,
  float_mcap DOUBLE,
  rzyezb DOUBLE,
  src VARCHAR,
  ver INTEGER,
  batch INTEGER
)`,
  // 股东户数：键（代码, 截至日, 公告日），可得日 = 公告日；消失的行设 gone_from，不删
  `CREATE TABLE IF NOT EXISTS holder_counts (
  code VARCHAR NOT NULL,
  end_date DATE NOT NULL,
  notice_date DATE NOT NULL,
  avail_date DATE NOT NULL,
  holder_num DOUBLE,
  pre_holder_num DOUBLE,
  pre_end_date DATE,
  first_seen DATE NOT NULL,
  last_seen DATE NOT NULL,
  gone_from DATE,
  src VARCHAR,
  ver INTEGER,
  batch INTEGER
)`,
  // 限售解禁：键（代码, 解禁日, 类型），股数为股、比例为小数；avail_rule 见 @ivan/core 的 LockupAvailRule
  `CREATE TABLE IF NOT EXISTS lockups (
  code VARCHAR NOT NULL,
  free_date DATE NOT NULL,
  type VARCHAR NOT NULL,
  unlock_shares DOUBLE,
  able_shares DOUBLE,
  float_after DOUBLE,
  ratio_float DOUBLE,
  ratio_total DOUBLE,
  avail_date DATE NOT NULL,
  avail_rule VARCHAR NOT NULL,
  first_seen DATE NOT NULL,
  last_seen DATE NOT NULL,
  gone_from DATE,
  src VARCHAR,
  ver INTEGER,
  batch INTEGER
)`,
  // 大宗交易：键（代码, 成交日, 序号），premium 是相对当日收盘的小数，金额元、数量股
  `CREATE TABLE IF NOT EXISTS block_trades (
  code VARCHAR NOT NULL,
  trade_date DATE NOT NULL,
  seq INTEGER NOT NULL,
  avail_date DATE NOT NULL,
  deal_price DOUBLE,
  close_price DOUBLE,
  premium DOUBLE,
  deal_volume DOUBLE,
  deal_amount DOUBLE,
  buyer_inst BOOLEAN,
  seller_inst BOOLEAN,
  src VARCHAR,
  ver INTEGER,
  batch INTEGER
)`,
  // 各数据集的同步状态：last_status = ok | partial | canary_failed | failed | blocked；canary 是 CanaryResult 的 JSON
  `CREATE TABLE IF NOT EXISTS pit_sync (
  dataset VARCHAR PRIMARY KEY,
  backfill_from DATE,
  covered_from DATE,
  window_through DATE,
  synced_at DATE,
  nightly_since DATE,
  last_ok_at TIMESTAMP,
  last_status VARCHAR,
  last_detail VARCHAR,
  canary VARCHAR
)`,
  `CREATE SEQUENCE IF NOT EXISTS pit_batch_seq START 1`,
  // 每次写事件表的批次（D81）：kind = nightly | backfill | check | event_cols；status = running | ok | partial | failed。
  // 后台回填与补算只写这里、不开数据版本
  `CREATE TABLE IF NOT EXISTS pit_batches (
  id INTEGER PRIMARY KEY,
  kind VARCHAR NOT NULL,
  datasets VARCHAR,
  data_version INTEGER,
  started_at TIMESTAMP,
  finished_at TIMESTAMP,
  status VARCHAR,
  chunks INTEGER,
  rows INTEGER,
  requests INTEGER,
  note VARCHAR
)`,
];

/**
 * 降到第 4 版（`pnpm ivan migrate --down 4`，回滚到 R4 之前跑，D83）：R4 的代码写因子时用
 * `INSERT INTO factors_daily SELECT <旧列>`，多出来的事件列会让它报错。删掉 7 个事件列、清掉补算进度与完成标记；
 * 事件表（S15）留着无害。版本号由调用方写回 4。
 */
export const DOWN_TO_V4_SQL: string[] = [
  ...[...EVENT_FACTOR_KEYS].reverse().map((k) => `ALTER TABLE factors_daily DROP COLUMN IF EXISTS ${k}`),
  `DELETE FROM meta WHERE key = 'event_factors:A'`,
  `DELETE FROM etl_progress WHERE task LIKE 'event_cols:%'`,
];

/**
 * 一次性数据修正：每条按 meta 键 `fix:<id>` 只跑一次（新建的库跑在空表上，等于只打个标记）。
 * 和 SCHEMA_SQL 分开，是因为 SCHEMA_SQL 在以后每次升表结构时都会整体重跑，而数据修正不能跑两遍。
 */
export const DATA_FIXES: Array<{ id: string; sql: string[] }> = [
  // D51：科创板等被多乘了 100 的成交量
  { id: "a_volume_units_2026_09", sql: FIX_A_VOLUME_SQL },
];

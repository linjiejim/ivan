/**
 * 行情仓表结构。改表结构时 SCHEMA_VERSION 加 1；这里只做「IF NOT EXISTS」式的增量建表，
 * 需要改列的变更写成显式的 ALTER 语句追加在末尾。
 */
import { FACTORS } from "@ivan/core";

export const SCHEMA_VERSION = 1;

/** factors_daily 的列：键列 + 注册表里的全部因子（分类因子 VARCHAR，布尔 BOOLEAN，其余 DOUBLE）。 */
export const FACTOR_COLUMNS = FACTORS.map((f) => f.key);

function factorColumnDdl(): string {
  return FACTORS.map((f) => {
    const t = f.kind === "category" ? "VARCHAR" : f.kind === "bool" ? "BOOLEAN" : "DOUBLE";
    return `${f.key} ${t}`;
  }).join(",\n  ");
}

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
];

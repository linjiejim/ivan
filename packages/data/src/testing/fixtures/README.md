# 测试夹具

`loadFixture(name)` 读这个目录下的文件，配合 `FakeHttp` 的路由当作数据源的返回。

规矩：

- **测试绝不联网**。所有 HTTP 都走 `FakeHttp`；没有配置的请求会直接抛错（`FakeHttp：没有配置这个请求 …`），不会悄悄放行。
- 夹具优先用已有测试里的真实片段，裁到够用为止；拿不到真实样本时按接口文档的字段布局手工构造，并在下面写明。
- 夹具里**不能有 token、Cookie、账号**这类东西，也不要放整份大响应（几 KB 以内）。
- 文件名：`<来源>-<接口或报表>-<场景>.<json|txt>`。

| 文件 | 来源 | 内容 |
| --- | --- | --- |
| `em-datacenter-page1.json` | 东财数据中心 `api/data/v1/get` | 手工构造（按真实字段布局）：两页中的第 1 页，2 行 |
| `em-datacenter-page2.json` | 同上 | 第 2 页，1 行 |
| `em-datacenter-empty.json` | 同上 | 返回数据为空（code 9201，`result: null`），是正常结果 |
| `em-hk-securityinfo.json` | 东财数据中心 `RPT_HKF10_INFO_SECURITYINFO` | 手工构造（按真实字段布局）：港股证券资料 6 行，含深港通标记 `GANGGUTONGBIAODISHEN`（是 / 否 / 空）、人民币柜台与基金各一行 |
| `em-hk-orgprofile.json` | 东财数据中心 `RPT_HKF10_INFO_ORGPROFILE` | 手工构造：上面 4 只普通股的所属行业 |
| `em-kline-a-raw.json` | 东财 push2his `api/qt/stock/kline/get`（fqt=0） | 茅台 2025-06-19 ~ 06-30 不复权 8 行（价格取自 compute.test.ts 的真实行；成交量、成交额、振幅、涨跌幅手工补齐）；2025-06-26 除息：收盘 − 涨跌额 = 1408.24 ≠ 前收 1435.86 |
| `em-kline-empty.json` | 同上 | 没有数据（`rc: 0`、`data: null`），是正常结果 |
| `tx-kline-raw.json` | 腾讯 `fqkline/get`（不复权，键 `day`） | 同一段茅台不复权行（compute.test.ts 的真实行），成交量单位手 |
| `tx-kline-hfq.json` | 同上（后复权，键 `hfqday`） | 同一段茅台后复权行（真实行，3 位小数） |
| `tx-quote-batch.txt` | 腾讯 `qt.gtimg.cn/q=`（GBK 解码后的文本） | 手工构造，只填 `quotes()` 读的段（1 简称、3 现价、4 前收、5 开、6 量、30 时间、33 高、34 低、35 价/量/额、37 额）：sh600000、sh600001 两行，**故意漏掉** sh600002 |
| `csindex-h00905.json` | 中证官网 `csindex-home/perf/index-perf`（`indexCode=H00905`） | 手工构造（按 H00300 的真实字段布局）：中证500全收益 2026-09-21 ~ 10-02 共 10 个工作日；`csindexHistory` 只读 `tradeDate` 与 `close`。代码要等探针 `idx.tri.more` 联网核对 |
| `em-rzrq-2026-09-29.json` | 东财数据中心 `RPTA_WEB_RZRQ_GGMX`（两融明细） | 按 2026-10-05 实测的字段布局裁剪（只留请求的 9 列）：2026-09-29 的 000001.SZ、000002.SZ、600519.SH（`RZYEZB` 1.09532005 = 实测值）、688981.SH 与 ETF 510050.SH（`SZ` 为空）；除 600519 的融资余额与流通市值外数值手工构造，`count` 改成 5 |
| `em-rzrq-2026-09-30-sh-only.json` | 同上 | 2026-09-30 只有沪市 3 行（实测那天深市还没出），用来测「只到一个交易所」 |
| `em-holdernum.json` | 东财数据中心 `RPT_HOLDERNUM_DET`（股东户数） | 000603.SZ 截至 2026-06-30、公告 2026-08-01，66961 / 74197 户，上期截至 2026-05-29（实测行）；002064.SZ 一行手工构造；`HOLDER_NUM_RATIO` 是 % |
| `em-lift-stage.json` | 东财数据中心 `RPT_LIFT_STAGE`（限售解禁） | 300005.SZ 2013-01-04 首发原股东限售股份、002150.SZ 股权激励、301358.SZ 定向增发 8253.7493 / 84581.5647 万股、`FREE_RATIO` 0.108135536917（实测行）；股数列是万股，比例是小数 |
| `em-blocktrade.json` | 东财数据中心 `RPT_DATA_BLOCKTRADE`（大宗交易） | 001309.SZ 平价成交（`PREMIUM_RATIO` 0）；001366.SZ 11.84 / 13.13 买方机构专用两笔（代码、日期、金额相同，卖方不同）；`DEAL_AMT` 元、`DEAL_VOLUME` 股 |
| `em-blocktrade-identical.json` | 同上 | 手工构造：001309.SZ 一笔，加 001366.SZ 两笔**完全相同**的成交（同价同量、买卖席位都一样），用来测「真有一模一样的大宗」不算翻页漂移 |
| `em-9501-schema-drift.json` | 东财数据中心 | 请求了不存在的列：`code 9501`、`NO_SUCH_COLUMN_X返回字段不存在`（实测原文） |
| `em-9201-empty.json` | 东财数据中心 | 空结果 `code 9201`（正常结果） |

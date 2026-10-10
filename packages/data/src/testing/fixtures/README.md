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

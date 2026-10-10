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

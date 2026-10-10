/**
 * `@ivan/data/testing`：测试底座（HTTP 假件、夹具读取、合成市场）。只给测试用，主入口不导出。
 */
export { type FakeRequest, type FakeRoute, FakeHttp, loadFixture } from "./fake-http.ts";
export { type SeedOptions, type SeedStock, seedSyntheticMarket, syntheticCalendar } from "./seed.ts";
export { downgradeWarehouseToV2 } from "./warehouse.ts";
export { A_INDEX_SECIDS, emDailyRoute, emSecidOf } from "./nightly.ts";
export { emEventsServer, emPage, emReportRoute, eventColumnViolations } from "./events.ts";

/**
 * 东财数据中心的翻页与错误（D81、D82）：单页上限 500、翻完核对行数与重复行、9201 空、9501 结构变了、多列排序、
 * 计数请求带明确的列清单。
 */
import { describe, expect, it } from "vitest";
import { emPage } from "../testing/events.ts";
import { FakeHttp, loadFixture } from "../testing/fake-http.ts";
import {
  EastmoneyError,
  emCountCols,
  emQuery,
  emQueryPaged,
  emQueryPagedChecked,
  EM_PAGE_CAP,
  EM_REFETCH_PAGE_SIZE,
  PageDriftError,
  SchemaDriftError,
} from "./eastmoney.ts";

const row = (i: number) => ({ SECUCODE: `${600000 + i}.SH`, V: i });

/** 按 pageNumber 回一页（共 total 行、每页 per 行） */
function pagedRoute(total: number, per: number, mutate?: (rows: object[], page: number) => object[]) {
  return {
    match: /datacenter-web/,
    reply: ({ url }: { url: string }) => {
      const page = Number(new URL(url).searchParams.get("pageNumber"));
      const all = Array.from({ length: total }, (_, i) => row(i));
      let rows: object[] = all.slice((page - 1) * per, page * per);
      if (mutate) rows = mutate(rows, page);
      return emPage(rows, { pages: Math.ceil(total / per), count: total });
    },
  };
}

describe("emQueryPaged", () => {
  it("翻完 3 页；pageSize 最多 500；带请求数", async () => {
    const http = new FakeHttp([pagedRoute(1100, 500)]);
    const r = await emQueryPaged(http, { report: "RPT_X", columns: "SECUCODE,V", pageSize: 5000 });
    expect(r.rows).toHaveLength(1100);
    expect(r).toMatchObject({ count: 1100, requests: 3 });
    expect(http.calls.map((c) => new URL(c.url).searchParams.get("pageSize"))).toEqual(["500", "500", "500"]);
    expect(EM_PAGE_CAP).toBe(500);
  });

  it("行数和 count 对不上 → PageDriftError", async () => {
    const http = new FakeHttp([pagedRoute(1100, 500, (rows, page) => (page === 2 ? rows.slice(1) : rows))]);
    const err = await emQueryPaged(http, { report: "RPT_X", columns: "SECUCODE,V" }).catch((e) => e);
    expect(err).toBeInstanceOf(PageDriftError);
    expect(err.message).toContain("拿到 1099 行，报表说 1100 行");
  });

  it("排序不唯一：重一行、丢一行，总数照样对得上 → 仍然 PageDriftError（重复行）", async () => {
    const http = new FakeHttp([
      pagedRoute(1100, 500, (rows, page) => (page === 2 ? [row(499), ...rows.slice(1)] : rows)),
    ]);
    const err = await emQueryPaged(http, { report: "RPT_X", columns: "SECUCODE,V" }).catch((e) => e);
    expect(err).toBeInstanceOf(PageDriftError);
    expect(err.message).toContain("翻页结果有重复行");
  });

  it("9201 是空结果", async () => {
    const http = new FakeHttp([{ match: /datacenter-web/, reply: loadFixture("em-9201-empty.json") }]);
    expect(await emQueryPaged(http, { report: "RPT_X", columns: "A" })).toEqual({ rows: [], count: 0, requests: 1 });
  });

  it("9501 → SchemaDriftError（emQuery 也一样），带上错误码", async () => {
    const http = new FakeHttp([{ match: /datacenter-web/, reply: loadFixture("em-9501-schema-drift.json") }]);
    const err = await emQueryPaged(http, { report: "RPT_X", columns: "X" }).catch((e) => e);
    expect(err).toBeInstanceOf(SchemaDriftError);
    expect(err).toBeInstanceOf(EastmoneyError);
    expect(err.code).toBe(9501);
    expect(await emQuery(http, { report: "RPT_X", columns: "X" }).catch((e) => e)).toBeInstanceOf(SchemaDriftError);
  });

  it("别的错误码是普通的 EastmoneyError", async () => {
    const http = new FakeHttp([{ match: /datacenter-web/, reply: { result: null, code: 9999, message: "系统繁忙" } }]);
    const err = await emQuery(http, { report: "RPT_X", columns: "X" }).catch((e) => e);
    expect(err).toBeInstanceOf(EastmoneyError);
    expect(err).not.toBeInstanceOf(SchemaDriftError);
  });

  it("多列排序：sortColumns 与 sortTypes 一样多", async () => {
    const http = new FakeHttp([{ match: /datacenter-web/, reply: emPage([]) }]);
    await emQueryPaged(http, { report: "RPT_X", columns: "A", sort: ["A", "B", "C"], asc: true });
    await emQuery(http, { report: "RPT_X", columns: "A", sort: "A" });
    const q = (i: number) => new URL(http.calls[i]!.url).searchParams;
    expect([q(0).get("sortColumns"), q(0).get("sortTypes")]).toEqual(["A,B,C", "1,1,1"]);
    expect([q(1).get("sortColumns"), q(1).get("sortTypes")]).toEqual(["A", "-1"]);
  });
});

/** 按请求里的 pageNumber / pageSize 翻 all（和东财一样按单页行数切） */
function sizedRoute(all: () => object[]) {
  return {
    match: /datacenter-web/,
    reply: ({ url }: { url: string }) => {
      const q = new URL(url).searchParams;
      const page = Number(q.get("pageNumber"));
      const size = Number(q.get("pageSize"));
      const rows = all();
      return emPage(rows.slice((page - 1) * size, page * size), {
        pages: Math.ceil(rows.length / size),
        count: rows.length,
      });
    },
  };
}

describe("emQueryPagedChecked", () => {
  const q = { report: "RPT_X", columns: "SECUCODE,V" };

  it("对得上：一次取完，不重取", async () => {
    const http = new FakeHttp([pagedRoute(1100, 500)]);
    const onRetry: string[] = [];
    const r = await emQueryPagedChecked(http, q, (e) => onRetry.push(e.message));
    expect(r).toMatchObject({ count: 1100, requests: 3, duplicateRows: 0 });
    expect(onRetry).toEqual([]);
  });

  it("第一次漂移、重取对上：换一个单页行数重取，请求数两次相加", async () => {
    let calls = 0;
    const http = new FakeHttp([
      pagedRoute(1100, 500, (rows, page) => (calls++ === 1 && page === 2 ? [row(499), ...rows.slice(1)] : rows)),
    ]);
    // 第二次（单页 400）走一个按单页行数切的路由
    const retry = new FakeHttp([sizedRoute(() => Array.from({ length: 1100 }, (_, i) => row(i)))]);
    let first = true;
    const both = {
      json: <T>(url: string) => {
        const size = new URL(url).searchParams.get("pageSize");
        if (size === String(EM_REFETCH_PAGE_SIZE)) first = false;
        return (first ? http : retry).json<T>(url);
      },
    } as unknown as FakeHttp;
    const onRetry: string[] = [];
    const r = await emQueryPagedChecked(both, q, (e) => onRetry.push(e.message));
    expect(onRetry).toEqual(["东财 RPT_X 翻页结果有重复行"]);
    expect(r.rows).toHaveLength(1100);
    expect(r).toMatchObject({ requests: 3 + 3, duplicateRows: 0 });
    expect(retry.calls.map((c) => new URL(c.url).searchParams.get("pageSize"))).toEqual(["400", "400", "400"]);
  });

  it("排序不唯一造成的重行丢行：每次都在页边界漂移（换单页行数后漂移的行也跟着变）→ 仍然 PageDriftError", async () => {
    const http = new FakeHttp([
      {
        match: /datacenter-web/,
        reply: ({ url }: { url: string }) => {
          const sp = new URL(url).searchParams;
          const page = Number(sp.get("pageNumber"));
          const size = Number(sp.get("pageSize"));
          const all = Array.from({ length: 1100 }, (_, i) => row(i));
          const rows = all.slice((page - 1) * size, page * size);
          // 每页第一行换成上一页最后一行
          if (page > 1) rows[0] = all[(page - 1) * size - 1]!;
          return emPage(rows, { pages: Math.ceil(all.length / size), count: all.length });
        },
      },
    ]);
    const err = await emQueryPagedChecked(http, q).catch((e) => e);
    expect(err).toBeInstanceOf(PageDriftError);
    expect(err.message).toContain("重复行");
    expect(http.calls).toHaveLength(3 + 3);
  });

  it("两次漂移得不一样（重的是不同的行）→ PageDriftError", async () => {
    let n = 0;
    const http = new FakeHttp([
      sizedRoute(() => {
        const all = Array.from({ length: 10 }, (_, i) => row(i));
        n++;
        // 第一次重 row(1)、丢 row(2)；第二次重 row(3)、丢 row(4)
        return n === 1 ? all.map((r, i) => (i === 2 ? row(1) : r)) : all.map((r, i) => (i === 4 ? row(3) : r));
      }),
    ]);
    const err = await emQueryPagedChecked(http, q).catch((e) => e);
    expect(err).toBeInstanceOf(PageDriftError);
    expect(err.message).toContain("重复行");
  });

  it("行数对不上两次 → PageDriftError（不当成真重复）", async () => {
    const http = new FakeHttp([pagedRoute(1100, 500, (rows, page) => (page === 2 ? rows.slice(1) : rows))]);
    const err = await emQueryPagedChecked(http, q).catch((e) => e);
    expect(err).toBeInstanceOf(PageDriftError);
    expect(err.message).toContain("行数对不上");
  });

  it("真有完全相同的行：换页边界重取，两次一模一样 → 照常返回，记下重复行数", async () => {
    const all = [row(1), row(2), row(2), row(3)];
    const http = new FakeHttp([sizedRoute(() => all)]);
    const onRetry: string[] = [];
    const r = await emQueryPagedChecked(http, { ...q, pageSize: 3 }, (e) => onRetry.push(e.message));
    expect(r.rows).toEqual(all);
    expect(r).toMatchObject({ count: 4, requests: 2 + 1, duplicateRows: 1 });
    expect(onRetry).toHaveLength(1);
    expect(http.calls.map((c) => new URL(c.url).searchParams.get("pageSize"))).toEqual(["3", "3", "400"]);
  });
});

describe("emCountCols", () => {
  it("一次请求、pageSize 1，带明确的列清单（不是 ALL）", async () => {
    const http = new FakeHttp([{ match: /datacenter-web/, reply: emPage([row(1)], { count: 441010 }) }]);
    expect(await emCountCols(http, "RPT_HOLDERNUM_DET", "(A>='2013-01-01')", ["SECUCODE", "END_DATE"])).toBe(441010);
    const q = new URL(http.calls[0]!.url).searchParams;
    expect(q.get("columns")).toBe("SECUCODE,END_DATE");
    expect(q.get("pageSize")).toBe("1");
    expect(q.get("filter")).toBe("(A>='2013-01-01')");
    await expect(emCountCols(http, "RPT_X", "", [])).rejects.toThrow("明确的列清单");
  });
});

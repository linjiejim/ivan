/**
 * HTTP 假件（测试专用）：按正则路由给固定返回 / 风控封禁 / HTTP 错误，记录每次请求。
 * 测试一律用它代替真实的 Http，绝不联网；没有配置的请求直接报错，不会悄悄放行。
 */
import { readFileSync } from "node:fs";
import { BlockedError, HttpError, type HttpLike, type RequestOptions } from "../http.ts";

export interface FakeRequest {
  url: string;
  body?: string;
}

type BlockReason = "waf" | "unreachable";

export interface FakeRoute {
  /** 对完整 URL（含查询串）匹配 */
  match: RegExp;
  method?: "GET" | "POST";
  /** 字符串原样返回；对象 JSON.stringify；函数按请求现算 */
  reply?: string | object | ((req: FakeRequest) => string | object);
  /** 模拟风控：把这个域名封到 untilMs，并抛 BlockedError */
  block?: { untilMs: number; reason?: BlockReason };
  /** 模拟 HTTP 错误码：抛 HttpError */
  status?: number;
  /** 最多命中几次，用完后交给后面的路由（默认不限） */
  times?: number;
}

export class FakeHttp implements HttpLike {
  readonly calls: Array<{ url: string; method: string; body?: string }> = [];
  private readonly used = new Map<FakeRoute, number>();
  private readonly blocked = new Map<string, { until: number; reason: BlockReason }>();
  private readonly now: () => number;

  constructor(
    private readonly routes: FakeRoute[],
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  async text(url: string, opts: RequestOptions = {}): Promise<string> {
    const method = opts.method ?? "GET";
    this.calls.push({ url, method, ...(opts.body !== undefined ? { body: opts.body } : {}) });
    const host = new URL(url).host;
    const b = this.blocked.get(host);
    if (b && b.until > this.now()) throw new BlockedError(host, b.until, b.reason);
    const route = this.routes.find(
      (r) =>
        r.match.test(url) &&
        (!r.method || r.method === method) &&
        (r.times === undefined || (this.used.get(r) ?? 0) < r.times),
    );
    if (!route) {
      throw new HttpError(`FakeHttp：没有配置这个请求 ${url.split("?")[0]}`, url, 599);
    }
    this.used.set(route, (this.used.get(route) ?? 0) + 1);
    if (route.block) {
      const reason = route.block.reason ?? "waf";
      this.blocked.set(host, { until: route.block.untilMs, reason });
      throw new BlockedError(host, route.block.untilMs, reason);
    }
    if (route.status !== undefined) {
      throw new HttpError(`HTTP ${route.status}`, url.split("?")[0]!, route.status);
    }
    const r =
      typeof route.reply === "function" ? route.reply({ url, body: opts.body }) : route.reply;
    if (r === undefined) return "";
    return typeof r === "string" ? r : JSON.stringify(r);
  }

  async json<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
    const text = await this.text(url, opts);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HttpError(`不是合法 JSON：${text.slice(0, 120)}`, url);
    }
  }

  isBlocked(host: string): boolean {
    return (this.blocked.get(host)?.until ?? 0) > this.now();
  }

  /** 与 Http 相同：给定域名全都被封时返回最早解封的时刻；有一个没被封就返回 0。 */
  earliestUnblock(hosts: string[]): number {
    const now = this.now();
    const until = hosts.map((h) => this.blocked.get(h)?.until ?? 0);
    return until.some((u) => u <= now) ? 0 : Math.min(...until);
  }

  /** 直接把域名封到 untilMs；之后对它的请求抛带 reason 的 BlockedError（默认 waf）。 */
  setBlocked(host: string, untilMs: number, reason: BlockReason = "waf"): void {
    this.blocked.set(host, { until: untilMs, reason });
  }
}

/** 读 testing/fixtures/ 下的夹具文件（UTF-8 文本）。 */
export function loadFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

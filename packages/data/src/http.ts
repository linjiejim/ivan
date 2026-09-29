/**
 * 抓取用 HTTP 客户端：按域名限并发 + 两次请求的最小间隔（礼貌抓取），失败退避重试，统计耗时。
 *
 * 用 Node 自带 fetch：Node 22 不读 HTTP(S)_PROXY 环境变量，国内数据源直连（本机开着代理也不绕路）。
 */
export interface HttpConfig {
  /** 每个域名同时在途的请求数 */
  concurrencyPerHost: number;
  /** 同一域名两次请求开始之间的最小间隔（毫秒） */
  minIntervalMs: number;
  timeoutMs: number;
  retries: number;
  userAgent: string;
  /** 按域名覆盖最小间隔（毫秒）：有风控的源放慢 */
  hostIntervals: Record<string, number>;
  /** 按域名覆盖并发数 */
  hostConcurrency: Record<string, number>;
}

/**
 * 默认节奏（D26、D31）：多家数据源都有反爬——腾讯 fqkline 突发几百次就 WAF 封 IP（约半小时），
 * 东财 push2his 并发 4、每秒 10 次时一两百次后连接被重置（数小时），深交所连续拉几百页后也被拒。
 * 日 K 一律串行、0.6 秒起；交易所与官方站点 0.3 秒；东财数据中心 0.1 秒。都带 0–50% 随机抖动。
 */
export const DEFAULT_HOST_INTERVALS: Record<string, number> = {
  "web.ifzq.gtimg.cn": 600,
  "push2his.eastmoney.com": 600,
  "www.szse.cn": 300,
  "query.sse.com.cn": 300,
  "www.csindex.com.cn": 300,
  "www.chinamoney.com.cn": 300,
  "datacenter.eastmoney.com": 100,
  "datacenter-web.eastmoney.com": 100,
};
export const DEFAULT_HOST_CONCURRENCY: Record<string, number> = {
  "web.ifzq.gtimg.cn": 1,
  "push2his.eastmoney.com": 1,
  "www.szse.cn": 1,
  "query.sse.com.cn": 1,
  "www.chinamoney.com.cn": 2,
};

export interface RequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** 响应编码，腾讯 qt 接口是 GBK */
  encoding?: "utf-8" | "gbk";
  timeoutMs?: number;
  retries?: number;
}

/**
 * 这个域名暂停一段时间，调用方应换数据源。两种来由：对方返回了风控页（如腾讯云 WAF 的 501 页面），
 * 或连续多次连不上（东财被封时表现为空响应/断连，本机断网也是这样，分不清，所以两种可能都说）。
 */
export class BlockedError extends Error {
  constructor(
    readonly host: string,
    readonly until: number,
    readonly reason: "waf" | "unreachable" = "waf",
  ) {
    const at = new Date(until).toLocaleTimeString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false,
    });
    super(
      reason === "waf"
        ? `${host} 触发风控，暂停到 ${at}`
        : `${host} 连续连不上（可能被限流，也可能是网络不通），暂停到 ${at}`,
    );
  }
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

interface HostState {
  blockedUntil: number;
  blockCount: number;
  /** 连续网络失败次数（东财被封时表现为连接被重置，不是拦截页） */
  netFailStreak: number;
  blockReason: BlockedError["reason"];
  active: number;
  lastStart: number;
  queue: Array<() => void>;
  requests: number;
  failures: number;
  totalMs: number;
}

export interface HostStats {
  host: string;
  requests: number;
  failures: number;
  avgMs: number;
}

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export class Http {
  readonly cfg: HttpConfig;
  private hosts = new Map<string, HostState>();

  constructor(cfg: Partial<HttpConfig> = {}) {
    this.cfg = {
      concurrencyPerHost: 4,
      minIntervalMs: 50,
      timeoutMs: 20_000,
      retries: 3,
      userAgent: DEFAULT_UA,
      ...cfg,
      hostIntervals: { ...DEFAULT_HOST_INTERVALS, ...cfg.hostIntervals },
      hostConcurrency: { ...DEFAULT_HOST_CONCURRENCY, ...cfg.hostConcurrency },
    };
  }

  private state(host: string): HostState {
    let s = this.hosts.get(host);
    if (!s) {
      s = {
        blockedUntil: 0,
        blockCount: 0,
        netFailStreak: 0,
        blockReason: "waf",
        active: 0,
        lastStart: 0,
        queue: [],
        requests: 0,
        failures: 0,
        totalMs: 0,
      };
      this.hosts.set(host, s);
    }
    return s;
  }

  private async acquire(host: string): Promise<void> {
    const s = this.state(host);
    const limit = this.cfg.hostConcurrency[host] ?? this.cfg.concurrencyPerHost;
    if (s.active >= limit) {
      await new Promise<void>((resolve) => s.queue.push(resolve));
    }
    s.active++;
    const base = this.cfg.hostIntervals[host] ?? this.cfg.minIntervalMs;
    // 有专门节奏的域名加 0–50% 随机抖动，避免机械的固定间隔
    const interval = this.cfg.hostIntervals[host] ? base * (1 + Math.random() * 0.5) : base;
    const wait = s.lastStart + interval - Date.now();
    s.lastStart = Math.max(Date.now(), s.lastStart + interval);
    if (wait > 0) await sleep(wait);
  }

  private release(host: string): void {
    const s = this.state(host);
    s.active--;
    s.queue.shift()?.();
  }

  /** 标记域名被风控：5 分钟起，连续被封翻倍，最长 1 小时。 */
  private block(host: string, reason: BlockedError["reason"] = "waf"): BlockedError {
    const s = this.state(host);
    s.blockCount++;
    s.blockedUntil = Date.now() + Math.min(60, 5 * 2 ** (s.blockCount - 1)) * 60_000;
    s.blockReason = reason;
    return new BlockedError(host, s.blockedUntil, reason);
  }

  isBlocked(host: string): boolean {
    return this.state(host).blockedUntil > Date.now();
  }

  /** 所有给定域名都被封时，最早解封的时刻；有一个没被封就返回 0。 */
  earliestUnblock(hosts: string[]): number {
    const until = hosts.map((h) => this.state(h).blockedUntil);
    return until.some((u) => u <= Date.now()) ? 0 : Math.min(...until);
  }

  async text(url: string, opts: RequestOptions = {}): Promise<string> {
    const host = new URL(url).host;
    const retries = opts.retries ?? this.cfg.retries;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (this.state(host).blockedUntil > Date.now()) {
        const st = this.state(host);
        throw new BlockedError(host, st.blockedUntil, st.blockReason);
      }
      if (attempt > 0) await sleep(400 * 2 ** (attempt - 1) + Math.random() * 300);
      await this.acquire(host);
      const s = this.state(host);
      const t0 = Date.now();
      try {
        const res = await fetch(url, {
          method: opts.method ?? "GET",
          headers: { "User-Agent": this.cfg.userAgent, ...opts.headers },
          body: opts.body,
          signal: AbortSignal.timeout(opts.timeoutMs ?? this.cfg.timeoutMs),
        });
        s.requests++;
        s.totalMs += Date.now() - t0;
        if (res.status === 501 || res.status === 403 || res.status === 429) {
          const body = await res.text().catch(() => "");
          if (res.status !== 429 || /waf|<html|<!DOCTYPE/i.test(body)) {
            s.failures++;
            throw Object.assign(this.block(host), { fatal: true });
          }
        }
        if (res.status === 429 || res.status >= 500) {
          throw new HttpError(`HTTP ${res.status}`, url, res.status);
        }
        if (!res.ok) {
          // 4xx 不重试
          s.failures++;
          throw Object.assign(new HttpError(`HTTP ${res.status}`, url, res.status), { fatal: true });
        }
        const buf = await res.arrayBuffer();
        const text = new TextDecoder(opts.encoding ?? "utf-8").decode(buf);
        // JSON 接口返回了 HTML：多半是风控页
        if (/^\s*<(!DOCTYPE|html)/i.test(text) && /waf|verify|captcha|501page/i.test(text)) {
          s.failures++;
          throw Object.assign(this.block(host), { fatal: true });
        }
        s.blockCount = 0;
        s.netFailStreak = 0;
        return text;
      } catch (e) {
        lastErr = e;
        if ((e as { fatal?: boolean }).fatal) throw e;
        s.failures++;
        // 连续 6 次连接级失败：当成被封
        if (!(e instanceof HttpError) && ++s.netFailStreak >= 6) {
          s.netFailStreak = 0;
          throw this.block(host, "unreachable");
        }
      } finally {
        this.release(host);
      }
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new HttpError(`请求失败（重试 ${retries} 次）：${msg}`, url);
  }

  async json<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
    const text = await this.text(url, opts);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HttpError(`不是合法 JSON：${text.slice(0, 120)}`, url);
    }
  }

  stats(): HostStats[] {
    return [...this.hosts.entries()].map(([host, s]) => ({
      host,
      requests: s.requests,
      failures: s.failures,
      avgMs: s.requests ? Math.round(s.totalMs / s.requests) : 0,
    }));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 有限并发地对一组输入执行异步函数，保持结果顺序。 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

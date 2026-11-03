# Ivan

English · [中文](README.md)

> **The interface, prompts, and docs are in Chinese.** Ivan targets the A-share and Hong Kong markets, and the UI, the chat agent,
> and the design records under `docs/` are written in Chinese. This page is an English overview.

AI-native stock-screening strategy backtesting and forward tracking for China A-shares and Hong Kong stocks, built to be self-hosted.
Demo site: <https://ivan.linjiejim.com> (sign-up requires an invite code).

Describe a screening idea in plain language → the AI translates it into a structured strategy (it only takes effect after you confirm it on a card)
→ the engine backtests it on point-in-time-correct history → when you're happy, put it live: after every trading day's close the rules are replayed
as a paper portfolio, and the dashboard plots the backtest and real-world performance on the same curve.

> For research only. Not investment advice. Market data comes from unofficial third-party endpoints and may be wrong or delayed —
> see [Data sources and disclaimer](#data-sources-and-disclaimer).

## Principles

- **The LLM translates and explains; the engine does the math.** Every number on screen comes from the engine and the database;
  cards render tool results directly, and numbers in chat replies are checked against tool output.
- **Only rules can be backtested.** Asking a model to "pick stocks" at a historical date is peeking at the answer — its training data contains the future.
- **Point-in-time correctness.** Financials take effect on their announcement date; the A-share universe includes delisted stocks;
  valuation (market cap, P/E, P/B) is computed from that day's share count and already-published financials.
- **Honesty.** Out-of-sample decay, concentrated returns, too few trades, fragile parameters, and confidence intervals are computed
  by the engine against fixed thresholds and surfaced unprompted.

## Architecture

```
apps/server   Hono: auth (better-auth + invite codes), REST, chat agent (AI SDK), serves the frontend
apps/worker   scheduler (Beijing time) + ETL + backtest / screen / tracking / daily-brief jobs; sole owner of the DuckDB warehouse
apps/web      Vite + React: dashboard, strategies, backtest reports, chat drawer, admin
packages/core     strategy DSL (zod), factor registry, market rules and fees, types
packages/engine   backtest / tracking simulator, metrics, attribution, honesty checks (pure functions)
packages/data     data sources (Eastmoney, Tencent, exchanges, CSI, CFETS), warehouse, ETL, screening SQL
packages/db       app database schema (SQLite + Drizzle)
packages/ai       LLM provider config (shared by chat and the nightly brief)
```

Design decisions are recorded (in Chinese) under [docs/specs](docs/specs/README.md); data-source coverage is in
[docs/probe-report.md](docs/probe-report.md); the UI design system is in [docs/design-system.md](docs/design-system.md).

## Self-hosting

You need Node 22+, pnpm 10+, and an API key for an OpenAI-compatible provider (DeepSeek by default) or Anthropic.
Nothing else: the app database is `data/app.sqlite` and the market warehouse is `data/market.duckdb`.

```bash
pnpm install
cp .env.example .env        # at least set BETTER_AUTH_SECRET, INTERNAL_SECRET, PUBLIC_URL, LLM_API_KEY
pnpm build                  # build the frontend

pnpm ivan probe                         # check the data sources are reachable (read-only, a minute or two)
pnpm ivan backfill --market A           # A-shares since 2013 (resumable; run while the worker is stopped)
pnpm ivan backfill --market HK          # Hong Kong
pnpm ivan doctor                        # table sizes and latest dates

pm2 start ecosystem.config.cjs && pm2 save   # or `pnpm start`
```

A full A-share + HK backfill takes roughly 2–4 hours because requests are deliberately slow. To try it out first, backfill only the largest names:
`pnpm ivan backfill --market A --top 300 --since 2016-01-01`.

Open `PUBLIC_URL`; **the first account to register becomes the admin**, after which sign-up needs an invite code (generated in the admin page or with `pnpm admin invite`).

To let strangers ask for a code, set `TRIAL_REQUESTS_ENABLED=true`: the login page gains a "request a trial" form, requests land in the admin page,
and the admin sends an invite or dismisses each one. Add a [Resend](https://resend.com) `RESEND_API_KEY` and `TRIAL_NOTIFY_TO` to get an email for every new request;
to email invites straight to applicants, verify your own domain in Resend and set `MAIL_FROM` (see `.env.example`).

Running it on a VPS behind a reverse proxy, the worker memory budget, older Linux distributions, push-to-deploy with GitHub Actions,
warehouse upgrades, and rollback are covered in [DEPLOY.md](DEPLOY.md) (Chinese).

## Development

```bash
pnpm dev          # server + worker + frontend (Vite on 5173, proxying the API)
pnpm test         # unit tests, fully offline
pnpm typecheck && pnpm lint
```

## Known limitations

- No delisting list for Hong Kong, so HK backtests have survivorship bias (flagged on every result).
- HK financials have no announcement date; effective dates are estimated conservatively from statutory deadlines.
- Industry classification is Eastmoney's current one, not a historical one.
- Margin-trading and shareholder factors are A-share only.
- The data comes from unofficial endpoints; when they change, use `pnpm ivan doctor` to diagnose.

## Data sources and disclaimer

- **The endpoints are not official APIs.** Ivan reads public endpoints behind the Eastmoney and Tencent Finance websites and apps, and public pages
  and files on the Shanghai, Shenzhen, and Hong Kong exchanges, China Securities Index, and CFETS websites. None of them promise anything to
  third parties; they may change, rate-limit, or disappear at any time.
- **The data belongs to its providers.** Rights to quotes, financials, and index data belong to Eastmoney, Tencent, the exchanges, CSI, and the other
  providers; follow their terms of service. This project is not affiliated with, authorized, or endorsed by any of them.
- **This repository distributes no market data.** It contains code and a few trimmed sample responses used as test fixtures
  (`packages/data/src/testing/fixtures/`). The warehouse, the app database, and the request cache live under `data/`, which has never been committed.
  Every self-hosted instance fetches its own data, and whether that is permitted where you are is for you to judge.
- **Keep request rates low.** The default pacing (per-domain concurrency limits; daily K-lines serial with at least 0.6 s between requests;
  pausing when rate-limited) is intentionally slow. Please don't raise concurrency or shorten intervals, and don't turn Ivan into a service that re-serves the data.
- **Not investment advice.** Backtests and tracking only describe how rules behaved on historical data, which may contain errors, delays, and gaps.
  Any investment decision you make is your own risk.

## License

The code is released under the [MIT](LICENSE) license. The license covers the code and docs in this repository only, not any third-party data obtained through it.

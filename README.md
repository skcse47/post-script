# Binance Square Evidence Based Signal Bot

Fetches live Binance market data, grades each chart against real structure, and posts
to Binance Square. The grade decides what kind of post gets written, including
whether to post a trade at all.

**Read [PLAYBOOK.md](PLAYBOOK.md)** for why the posts are shaped this way and what
drives reach on Square. That document is the actual point of this repo.

---

## How a cycle works

```
1. Fetch live 24h tickers, filter to liquid USDT altcoins
2. Settle any open calls against real candles (wins and losses both)
3. ~12% of the time: publish the honest track record recap instead
4. Pick a coin, skipping anything inside its cooldown window
5. Pull 1h + 15m klines, compute ATR, RSI, volume ratio, swing structure
6. Grade the setup   -> TRADE | WATCH | NO_TRADE
7. The verdict picks the format, the LLM writes it from measured numbers only
8. Validate every price in the output, retry once if any were invented
9. Strip promise language, guarantee disclosure, publish
10. If levels were published, log the call so it gets graded later
```

## Post formats

| Format | When | What it does |
|---|---|---|
| `EVIDENCE_SIGNAL` | TRADE / WATCH | Setup with structure based levels, real R:R, stated invalidation and risks |
| `NO_TRADE_CALL` | NO_TRADE | Publicly passes on the coin and says which number stopped it |
| `LEVEL_ALERT` | any | One level, what a break means, what a failure means. Short |
| `TEACH` | any | One lesson worked through on the live chart |
| `TRENDING_TOPIC` | any | A real position on a trending hashtag, including what would prove it wrong |
| `QUICK_TAKE` | any | Under 220 chars, built on one verifiable number |
| `TRACK_RECORD` | ~daily | Settled results from the database, losses included. Assembled in code, not by the LLM |

## Quick start

```bash
cp .env.example .env
```

Fill in `BINANCE_SQUARE_API_KEY` and one LLM key, then:

```bash
npm start
```

### Dry run, publishes nothing

```bash
node test.js
```

Prints the chart grades for the current top movers and one sample post. Force a
format to inspect it:

```bash
node test.js NO_TRADE_CALL
```

Or run the real scheduler with publishing disabled:

```bash
DRY_RUN=1 npm start
```

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `POST_INTERVAL_MINUTES` | 45 | Minutes between posts |
| `COIN_COOLDOWN_HOURS` | 6 | Before the same ticker can repeat |
| `LLM_PROVIDER` | openrouter | `openrouter` or `gemini` |
| `LLM_MODEL` | qwen3-next-80b | Any model your provider supports |
| `DRY_RUN` | unset | `DRY_RUN=1` generates and logs posts but publishes nothing and writes nothing to the database |

## Files

| File | Role |
|---|---|
| `src/marketContext.js` | Klines, indicators, setup grading, structure based levels |
| `src/trackRecord.js` | Logs calls, settles them against candles, builds the recap |
| `src/topGainersBot.js` | Market scan, prompts, number validation, publishing |
| `src/standaloneGainers.js` | Scheduler, SQLite state, cycle orchestration |
| `test.js` | Dry run |

## Database

SQLite at `gainers_history.db`:

- `post_history` — every post published
- `coin_performance` — per coin posting stats and trending overlap
- `trade_calls` — published levels and their settled outcome
- `bot_state` — rotation index

Inspect the record:

```bash
sqlite3 gainers_history.db "SELECT base_asset, status, ROUND(result_r,2) FROM trade_calls WHERE status != 'OPEN' ORDER BY resolved_at DESC LIMIT 20;"
```

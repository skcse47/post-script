# Binance Square Evidence Based Signal Bot

Fetches live Binance market data, grades each chart against real structure, and posts
to Binance Square. The grade decides what kind of post gets written, including
whether to post a trade at all.

**Read [PLAYBOOK.md](PLAYBOOK.md)** for why the posts are shaped this way and what
drives reach on Square. That document is the actual point of this repo.

---

## How a cycle works

```
1. Fetch live 24h tickers; gainers with $5M+ volume lead the queue
2. Fetch Square's hot hashtags and the coins they name
3. Settle any open calls against real candles (wins and losses both)
4. Grade a shortlist (2 trending coins + 10 from the queue, minus cooldowns and
   coins with an open call) both ways, LONG and SHORT, and keep the best
   TRADE / WATCH setup with at least MIN_SIGNAL_RISK_PCT to the stop
5. If a call just hit a target or its stop: publish its CALL_UPDATE instead,
   with the best setup attached as the next trade
6. Decide the slot: SIGNAL if signals are under SIGNAL_SHARE of the last 10
   posts (or inside the peak window) and a setup exists, else CONTENT
7. CONTENT slots only: ~12% of the time, the track record recap instead
8. SIGNAL: the best setup, as EVIDENCE_SIGNAL. CONTENT: the rotation or a coin
   trending on Square, as a level alert, lesson, trend take, quick take or pass,
   with no levels
9. The LLM writes the words from measured numbers only; never the levels
10. Review the draft: invented prices, cut off text, copied instruction labels.
    Retry once; a signal falls back to plain reasons from code instead
11. Strip promise language, publish, store the post link
12. Log the signal's levels as a call, graded and followed up later
```

### The signal post

Half the posts, by default. Built for a reader to act on in a few seconds:

```
$MUBARAK looks ready to drop from here 📉

Why it can dump:
• It pumped 55.0% today so buyers are tapped out
• RSI is at 76 which means it is very overbought

🎯 Short $MUBARAK at: $0.05823 to $0.06087
🛑 Stop loss: $0.06341
✅ Target 1: $0.05179
✅ Target 2: $0.04715
✅ Target 3: $0.04018

Price is in the zone now. Tap $MUBARAK to open a short.

Shorting this one? 👇
```

- **Reason first, in plain words.** The model rewrites the measured reasons
  (`plainReasons`) for a new trader: no "liquidity", "structure", R multiples.
- **Levels and call to action in code** (`buildSignalPost`, `buildTradeBlock`), so
  they are exact. The cashtag sits on the buy / short line and in "Tap $COIN to
  buy". The "in the zone now" line is true at the moment of posting.
- **Long and short.** Most of the board already pumped; those rarely make good
  longs but often make good fades (`gradeShortSetup`). Settlement grades shorts the
  right way round. Note that a short needs futures, not spot.
- **Content posts carry no levels**, so the signals stand out in the feed.
- **No "not financial advice" line.** Square does not require it and it cost a line
  of every post. The stop loss on every signal does the real job.

- **The first line.** Square shows about two lines before "see more". Every hook
  carries the cashtag, one real number, and a reason to keep reading.
- **Cashtag slots.** Prices never use up Square's 2 cashtag slots, and the coin
  the post is about always keeps its link.
- **Hashtags.** Three at most: a hot Square hashtag only when it names this coin,
  then `#COIN`, then a format tag (`#TradingSignals` on signals).
- **Comments.** Every post ends on a question that takes one word to answer.

## Post formats

| Format | When | What it does |
|---|---|---|
| `EVIDENCE_SIGNAL` | signal slot | Long or short. Plain reasons first, then buy / short zone, stop loss, 3 targets, "Tap $COIN to buy" |
| `NO_TRADE_CALL` | NO_TRADE | Publicly passes on the coin and says which number stopped it |
| `LEVEL_ALERT` | any | One level, what a break means, what a failure means. Short |
| `TEACH` | any | One lesson worked through on the live chart |
| `TRENDING_TOPIC` | any | A real position on a trending hashtag, including what would prove it wrong. Cashtags the coin the hashtag names; topics with no coin are used about a third of the time |
| `QUICK_TAKE` | any | Under 260 chars, built on one verifiable number |
| `CALL_UPDATE` | a call resolves | TP hit or stop out, with the original levels and a link to the original post. Assembled in code, at most one every 3 hours |
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
| `PEAK_WINDOW_IST` | 05:00-09:00 | Best reach window. Inside it: shorter spacing, the strongest chart from a graded shortlist, written as a signal. `off` disables |
| `PEAK_POST_INTERVAL_MINUTES` | 30 | Spacing inside the peak window. The workflow cron adds :30 runs to match |
| `SIGNAL_SHARE` | 0.5 | Share of posts that are trade signals. Every peak window slot is a signal slot on top |
| `MIN_SIGNAL_RISK_PCT` | 1.5 | Smallest % to the stop for a signal. Filters out setups whose targets are too small to matter |
| `LLM_PROVIDER` | gemini | `gemini` or `openrouter` |
| `LLM_MODEL` | gemini-flash-lite-latest | See the quota note below before changing this |
| `DRY_RUN` | unset | `DRY_RUN=1` generates and logs posts but publishes nothing and writes nothing to the database |

## Gemini free tier quotas

Gemini's free tier caps requests **per day, per model**. The flagship flash models
(`gemini-3.6-flash`, `gemini-3.8-flash`) get **20 a day**, which an hourly bot
exhausts before lunch and then fails every cycle with a 429.

Use the **lite** tier. Measured on a live key:

| | Flagship flash | Flash lite |
|---|---|---|
| Free requests/day | 20 | Far higher |
| Thinking tokens per call | ~2000 | 0 |
| Post quality for this job | Good | Just as good |

The flagship models are reasoning models: they spend roughly 2000 output tokens on
internal thinking before writing a word, which is what caused truncated posts at the
old token ceiling. The lite models report `thoughts=0` and answer directly.

Because the cap is per model, the candidate list in `topGainersBot.js` is a real
budget multiplier, not just a retry chain: each entry has its own daily allowance.
When they all fail, `discoverGeminiModel()` asks the API what else the key can use
and prefers lite.

If you would rather not think about quotas, put $5 of credit on OpenRouter and set
`LLM_PROVIDER=openrouter`.

## Deploying free

**GitHub Pages will not work.** It serves static files only: no Node runtime, no
scheduler, no secrets, no writable database. This bot needs all four.

**GitHub Actions will**, and is free for public repositories.
[`.github/workflows/post.yml`](.github/workflows/post.yml) runs one cycle on a
schedule via `src/runOnce.js`.

Setup:

1. Repo **Settings -> Secrets and variables -> Actions -> Secrets**, add:
   `BINANCE_SQUARE_API_KEY`, and `OPENROUTER_API_KEY` and/or `GEMINI_API_KEY`.
2. Optionally add **Variables** to override defaults: `LLM_PROVIDER`, `LLM_MODEL`,
   `POST_INTERVAL_MINUTES`, `COIN_COOLDOWN_HOURS`.
3. Push, then run it once from the **Actions** tab with **Run workflow** and
   `dry_run` ticked, to confirm it works before it posts for real.

Things to know:

- The schedule is hourly by default. Edit the `cron:` line to change it.
- Actions cron is best effort. Runs are often 5 to 30 minutes late on the free tier
  and are occasionally skipped entirely. Fine for a posting bot, not for anything
  time critical.
- Database state is committed to a separate `bot-state` branch after each run, so
  the track record survives between runs without cluttering `main`.
- GitHub disables scheduled workflows after ~60 days of repository inactivity and
  emails you to re-enable them.
- Free minutes are unlimited on public repos. On a private repo you get 2000
  minutes a month, and this job uses roughly 1 to 2 minutes per run, so hourly
  fits but every 15 minutes would not.

### Alternatives

| Host | Free? | Notes |
|---|---|---|
| GitHub Actions | Yes, public repos | Set up here. Best fit for a scheduled job |
| Oracle Cloud Always Free | Yes | A real always-on VM. Most work to set up, most control, exact timing |
| Fly.io | Small free allowance | Needs a card. Real long running process |
| Render / Railway free tiers | Limited | Web services sleep, and cron is usually a paid feature |

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

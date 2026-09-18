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
4. Grade a shortlist (trending coins + top of the queue, minus cooldowns and
   coins with an open call) and keep the best TRADE / WATCH setup, if any
5. If a call just hit a target or its stop: publish its CALL_UPDATE instead,
   with the best setup attached as the next trade
6. ~12% of the time, outside the peak window: the track record recap instead
7. Pick the coin: the best setup (always at peak, half the time otherwise),
   else the rotation or a coin trending on Square
8. Grade it   -> TRADE | WATCH | NO_TRADE; the verdict picks the format
9. The LLM writes the words from measured numbers only; never the levels
10. Review the draft: invented prices, cut off text, copied instruction labels.
    Retry once; never publish a post that still fails
11. finalizePost: cashtag in the first line, the trade block (see below), data
    timestamp, 7 day record (when there are 5+ settled calls), chosen hashtags
12. Strip promise language, publish, store the post link
13. Log whatever levels were published as a call, graded and followed up later
```

### What the post text is built for

Square pays commission on trades placed through a cashtag, so every post is built
to end on something a reader can act on.

- **The trade block.** Built in code by `buildTradeBlock`, never by the model:
  `🎯 $COIN entry`, stop with its % risk, TP1 to TP3, then where price is right now
  and "Tap $COIN to trade it" (or "set a limit at ..." when price is above the zone).
  In a signal it sits right after the two reason lines, so readers hit it fast.
- **Every format carries one when a chart earned it.** Its own levels when the coin
  graded TRADE or WATCH. Otherwise the best graded alternative: a pass post becomes
  "not $ONE, the better setup is $COTI" with $COTI's levels. With nothing tradable
  on the board, no setup is invented.
- **No "not financial advice" line.** Square does not require it and it spent a
  line of every post telling readers not to act. The stop and its % risk are on
  every setup instead.

- **The first line.** Square shows about two lines before "see more". Every hook
  carries the cashtag, one real number, and a reason to keep reading.
- **Cashtag slots.** Prices never use up Square's 2 cashtag slots. The coin the
  post is about keeps its link, and the trade block coin takes the other.
- **Hashtags.** Three at most: a hot Square hashtag only when it names this coin,
  then `#COIN` (and the trade block coin's tag), then a format tag.
- **Comments.** Every post ends on a question that takes one word to answer.

## Post formats

| Format | When | What it does |
|---|---|---|
| `EVIDENCE_SIGNAL` | TRADE / WATCH | Setup with structure based levels, real R:R, stated invalidation and risks |
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

# Getting read on Binance Square

Two separate problems were killing this account. Worth keeping them apart, because
the fixes are different and only one of them is a code problem.

1. **Nobody trusted the posts.** Fixed in code. See "What changed" below.
2. **Nobody saw the posts.** Mostly not a code problem. See "Distribution".

---

## Why the old posts did not convert

Read the old output as a stranger scrolling a feed, not as the person who wrote it.

| What the post said | What a reader actually concluded |
|---|---|
| "I'm going LONG on $X, momentum breakout confirmed" | Every post says this. It is a bot. |
| Entry, SL, TP1/TP2/TP3 on every coin | The stop is always 4.5%, targets always 4.8/9.5/15.5%. These numbers are not from a chart. |
| "I see buyers stepping in on every dip" | Unfalsifiable. He would write this either way. |
| "WE NAILED IT! My $X call just hit TP1 and TP2!" | I can scroll your profile. That call is not there. |
| Posted again 15 minutes later | Muted. |

The last one was the worst. The old `TARGET_HIT_CONGRATS` format took the **current**
price, multiplied it by 1.048 and 1.095, and announced that a call had hit those
targets. There had been no such call. Anyone who checked the profile found nothing,
and a reader who catches one fabricated win discounts everything else on the account
permanently. It was deleted, not improved.

The second worst is subtler: **every single post was a buy call.** A feed that is
bullish 100% of the time, every 15 minutes, on whatever coin is already up the most,
is indistinguishable from a pump account no matter how well each post is written.
Nobody is right that often and readers know it.

---

## What changed in the code

### 1. Levels now come from the chart

`src/marketContext.js` pulls 1h and 15m klines and computes ATR, RSI, volume versus
the 7 day average, position in the 24h range, and recent swing highs and lows.

The stop is placed below the actual swing low, padded by half an ATR so noise does
not clip it. Targets are then multiples of that risk, which is why the R:R printed in
a post is a real ratio. Risk came out at 2.7% on one coin and would be 9% on a more
volatile one, instead of 4.5% on everything forever.

### 2. The chart decides whether to post a trade at all

`gradeSetup()` scores the evidence and returns `TRADE`, `WATCH`, or `NO_TRADE`. On a
live sample of the top 3 gainers, one graded tradable and two did not. That ratio is
the point.

`NO_TRADE` produces a post that publicly passes on the coin and says why. This is the
highest value post type on the account and the one that was completely missing.
Saying "up 22% today and I am not touching it, here is the number that stopped me"
does more for credibility than ten correct calls, because it is the thing a pump
account structurally cannot say.

### 3. Results are real or they are not posted

`src/trackRecord.js` writes every published signal to a `trade_calls` table with its
entry, stop and targets. Later cycles pull the candles that printed since and settle
each call against what actually happened. When a candle contains both the stop and a
target, the stop wins, because intra-candle order is unknowable and resolving ties in
your own favour is how fake track records get built.

The recap post is assembled in code, not by the model, and includes the losses. It
refuses to publish below 8 settled calls, because a recap of four trades is not
evidence.

### 4. The model cannot invent a price

`validatePostNumbers()` extracts every dollar figure from the generated post and
checks it against the numbers actually supplied plus the coin's real 7 day range.
Anything else triggers one retry with the offending figures named, and a warning if
it still fails.

This is not theoretical. During testing the model invented `$0.11879` to fill an
empty prompt slot, stated with full confidence. A reader who charts an invented level
and finds nothing there is gone for good.

### 5. Promise language is stripped at publish time

`publishToSquare` catches "guaranteed", "easy money", "will pump", "100x", "can't
lose", "all in" and similar, and guarantees the risk disclosure is present. The
prompts already forbid these; this is the net under the net.

### 6. Broken images fixed

Post images pointed at `assets.coincap.io/assets/icons/{sym}@2x.png`, which 404s for
most newly listed small caps, which is exactly what this bot posts about. Every post
about a fresh gainer was shipping a broken thumbnail. Image URLs are now verified
before attaching.

### 7. Cadence and repetition

Default interval moved from 15 to 45 minutes (`POST_INTERVAL_MINUTES`), and a coin
cooldown (`COIN_COOLDOWN_HOURS`, default 6) stops the same ticker appearing three
times before lunch. 96 posts a day from one account was suppressing its own reach.

---

## Distribution: how posts actually get seen

Most of this is not something a script can do for you. Being honest about that is
more useful than pretending otherwise.

### The levers that matter most

**Cashtags put you on the coin's page.** A `$TICKER` cashtag makes the post eligible
for that coin's feed on Binance, which is where people who are actually about to
trade it are looking. This is the single highest intent audience available to you.
The publisher already caps at 2 distinct cashtags because Binance limits them; make
sure the ones you use are the coin you are actually writing about, not a trending
coin bolted on.

**Campaign hashtags are the real reach multiplier.** Binance regularly runs Square
campaigns with specific hashtags and promotes those topic pages directly. Posting
into an active campaign puts you on a page Binance itself is driving traffic to,
which no amount of prompt tuning replicates. Check the Square Task Center and
creator announcements for what is live, and post into it while it is running. This
is manual work and it is worth more than anything in this repo.

**Comments outrank likes.** Reply to every comment on your posts, quickly, with
something substantive. Your reply is itself a signal, it pulls the commenter back,
and it is the cheapest way to make a post look alive. A bot that never replies reads
as a bot even when its posts are good. Set aside 15 minutes twice a day for this.

**Comment on bigger accounts.** Being early and substantive on a large creator's
post routinely gets more eyes than your own post does. This is how small accounts
actually bootstrap on Square.

**Timing.** Aim at high activity windows, roughly 12:00 to 16:00 UTC (US morning
overlapping Europe afternoon) and 01:00 to 04:00 UTC for Asia. `POST_INTERVAL_MINUTES`
spreads posts evenly, which wastes good slots on dead hours. If you want to be
deliberate about it, replace the flat cron with a fixed schedule hitting those
windows.

**Follower conversion.** The account needs a reason to follow beyond a single signal.
The `TRACK_RECORD` and `TEACH` posts exist for this. Teaching posts get saved, and
saves are worth more than likes.

### Things that feel like they help and do not

- Posting more often. Past a point it actively suppresses reach and burns readers.
- More emojis and caps. Reads as a pump account, which is the thing you are trying
  not to be.
- Stuffing trending hashtags unrelated to the post. The hashtag page audience
  bounces immediately, and a high bounce rate is worse than not appearing.
- Buying engagement. Fake engagement does not become real followers and it puts the
  account at risk.

### The highest leverage manual upgrade

Post a real annotated chart screenshot. A marked up chart with the level drawn on it
stops the scroll in a way a coin logo never will, and it makes the analysis instantly
checkable, which is the entire trust argument. The script cannot generate one, but
you can attach one to the calls you care about.

---

## Running it

```bash
npm start
```

Dry run without publishing, which prints the grades and a sample post:

```bash
node test.js
```

Force a specific format to inspect it:

```bash
node test.js NO_TRADE_CALL
```

Formats: `EVIDENCE_SIGNAL`, `NO_TRADE_CALL`, `LEVEL_ALERT`, `TEACH`,
`TRENDING_TOPIC`, `QUICK_TAKE`.

---

## Two things to keep an eye on

**The persona is now "a systematic trader publishing screener levels", not "I just
bought this".** That change is deliberate. Claims about trades you supposedly already
entered cannot be verified by a reader, so they are discounted anyway, and they are
the specific thing that made the old feed read as fake. Publishing a level before it
plays out is a claim that gets tested in public, which is why it is worth something.

**The recap post is only as honest as the settlement logic.** If you ever change
`resolveOpenCalls`, keep the rule that a stop wins a tie. The moment that logic starts
resolving ambiguity favourably, the recap becomes the same fabrication as the old
`TARGET_HIT_CONGRATS`, just with more steps.

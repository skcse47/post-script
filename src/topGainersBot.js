/**
 * Binance Top Movers (Gainers & Losers) Technical Analysis & Signal Generator
 * 
 * Fetches real-time 24h ticker data from Binance public API, filters USDT pairs,
 * creates a balanced rotation queue of Top 5 Gainers and Top 5 Losers,
 * and uses OpenRouter or Gemini to generate authentic trader setups (Long/Short/Scalp/Dip-Buy)
 * with dynamic catchy opening hooks, explicit dollar price levels, and clickable coin cashtags ($BTC, $SOL, etc.).
 */

import { buildMarketContext, gradeSetup, fmtCompact } from "./marketContext.js";

const BINANCE_TICKER_URLS = [
  "https://data-api.binance.vision/api/v3/ticker/24hr",
  "https://api.binance.com/api/v3/ticker/24hr",
  "https://fapi.binance.com/fapi/v1/ticker/24hr",
  "https://api.mexc.com/api/v3/ticker/24hr",
];
const BINANCE_SQUARE_PUBLISH_URL =
  "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

// Candidate models tried in order before falling back to live discovery.
//
// This list WILL go stale. As of the last check gemini-2.0-flash, gemini-2.5-flash
// and gemini-1.5-flash had all been retired and every one of them 404'd, which made
// the provider look broken when it was only out of date. `discoverGeminiModel()`
// asks the API what actually exists when these all fail, so a stale entry here
// costs one wasted request rather than a dead bot.
const GEMINI_CANDIDATE_MODELS = [
  "gemini-3.6-flash",
  "gemini-flash-latest",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
];

// Diverse watchlist of 80+ top traded & trending coins across AI, Layer 1s, Memes, DeFi, and RWA (NO BNB, ETH, XRP, BTC, SOL)
const WATCHLIST_UNIVERSE = [
  "SUI", "PEPE", "DOGE", "ADA", "AVAX", "NEAR", "LINK", "SHIB", "FET",
  "APT", "RENDER", "INJ", "WIF", "TIA", "ARB", "OP", "DOT", "LTC", "GALA",
  "SEI", "FLOKI", "BONK", "TON", "FTM", "JASMY", "ENA", "PENDLE", "JTO", "PYTH",
  "WLD", "ICP", "STX", "KAS", "T", "THETA", "AAVE", "CRV", "UNI", "DYDX",
  "ONDO", "OM", "BEAM", "RUNE", "CHZ", "BLUR", "STRK", "ZK", "NOT", "BANANA",
  "TAO", "TURBO", "MEW", "BRETT", "POPCAT", "NEIRO", "1000SATS", "ORDI", "TRUMP",
  "CFX", "FIL", "SAND", "MANA", "AXS", "EOS", "KSM", "FLOW", "QNT", "ALGO",
  "ZRO", "IO", "LISTA", "BB", "REZ", "NOT", "IO", "TNSR", "W", "SAGA", "HEMI", "EGLD", "MUBARAK"
];

// Helper: Shuffle array for maximum coin variety
function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Strictly BANNED from primary signal targets (Never post about BNB, ETH, XRP, BTC, SOL)
const BANNED_BASE_ASSETS = new Set([
  "BNB", "ETH", "XRP", "BTC", "SOL", "USDT", "USDC", "FDUSD", "TUSD", "BUSD", "EUR", "DAI", "WBTC", "SUSD", "UST"
]);

const EXCLUDED_SYMBOLS = new Set([
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "SOLUSDT",
  "USDCUSDT", "FDUSDUSDT", "TUSDUSDT", "BUSDUSDT", "EURUSDT",
  "USDPUSDT", "AEURUSDT", "WBTCUSDT", "BTCSTUSDT", "DAIUSDT",
  "SUSDUSDT", "PAXUSDT", "USTUSDT"
]);

/**
 * Format numbers cleanly depending on price scale
 * @param {number} num 
 * @returns {string}
 */
export function formatPrice(num) {
  if (num >= 1000) return num.toFixed(2);
  if (num >= 1) return num.toFixed(4);
  if (num >= 0.01) return num.toFixed(5);
  if (num >= 0.0001) return num.toFixed(6);
  return num.toFixed(8);
}

/**
 * Null-safe price formatter for prompt building. A missing level must never render
 * as "NaN" or crash mid-prompt; it renders as "n/a" and the format that needed it
 * is not selected in the first place.
 */
function px(num) {
  if (num === null || num === undefined || Number.isNaN(num) || !Number.isFinite(num)) return "n/a";
  return formatPrice(num);
}

/**
 * Fetch top real-time altcoin gainers from Binance (Strictly NO BNB, ETH, XRP, BTC).
 * - >45% 24h pump: Classified as SHORT (overextended pump rejection)
 * - <45% 24h pump: Classified as LONG (momentum continuation)
 * @param {number} count Number of coins to return
 * @param {number} minVolumeUSDT Minimum 24h volume ($1M default)
 * @returns {Promise<{gainers: Array<object>, losers: Array<object>, top3: Array<object>, queue: Array<object>}>}
 */
export async function getMarketMovers(count = 10, minVolumeUSDT = 1_000_000) {
  console.log("[market] Scanning real-time Binance Top Altcoin Gainers...");
  
  let tickers = null;
  const errors = [];

  for (const url of BINANCE_TICKER_URLS) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json",
        },
      });

      if (res.ok) {
        tickers = await res.json();
        break;
      } else {
        errors.push(`${url} => HTTP ${res.status}: ${res.statusText}`);
      }
    } catch (err) {
      errors.push(`${url} => ${err.message}`);
    }
  }

  if (!tickers || !Array.isArray(tickers)) {
    throw new Error(`Failed to fetch tickers: ${errors.join(" | ")}`);
  }

  const validPairs = tickers
    .filter((t) => {
      const sym = t.symbol;
      if (!sym.endsWith("USDT")) return false;
      if (EXCLUDED_SYMBOLS.has(sym)) return false;
      if (sym.includes("UPUSDT") || sym.includes("DOWNUSDT") || sym.includes("BEARUSDT") || sym.includes("BULLUSDT")) {
        return false;
      }
      const quoteVol = parseFloat(t.quoteVolume || "0");
      if (quoteVol < minVolumeUSDT) return false;

      const baseAsset = t.symbol.replace("USDT", "");
      if (BANNED_BASE_ASSETS.has(baseAsset)) return false; // Strictly ban BNB, ETH, XRP, BTC
      return true;
    })
    .map((t) => {
      const lastPrice = parseFloat(t.lastPrice);
      const priceChangePercent = parseFloat(t.priceChangePercent); // Exact percentage from API
      const highPrice = parseFloat(t.highPrice);
      const lowPrice = parseFloat(t.lowPrice);
      const quoteVolume = parseFloat(t.quoteVolume);
      const baseAsset = t.symbol.replace("USDT", "");
      
      // USER RULE:
      // If pumped > 45% -> SHORT signal (Overextended pump blow-off top)
      // If gained < 45% -> LONG signal (Momentum continuation)
      let direction = "LONG";
      let isOverpumped = false;
      if (priceChangePercent >= 45.0) {
        direction = "SHORT";
        isOverpumped = true;
      } else if (priceChangePercent > 0) {
        direction = "LONG";
      } else {
        direction = "DIP_BUY";
      }

      const isUniverseCoin = WATCHLIST_UNIVERSE.includes(baseAsset);

      return {
        symbol: t.symbol,
        baseAsset,
        lastPrice,
        priceChangePercent,
        highPrice,
        lowPrice,
        quoteVolume,
        isOverpumped,
        defaultDirection: direction,
        isUniverseCoin,
        category: direction === "SHORT" ? "loser" : "gainer",
      };
    });

  // Sort real altcoins by 24h percentage gain descending
  const topAltcoinGainers = [...validPairs]
    .filter((p) => p.priceChangePercent > 3.0)
    .sort((a, b) => b.priceChangePercent - a.priceChangePercent);

  // Guarantee Top 3 gainers lead the rotation queue
  const top3Gainers = topAltcoinGainers.slice(0, 3);
  const otherGainers = topAltcoinGainers.slice(3, 8);
  const universeCoins = shuffleArray(
    validPairs.filter((p) => p.isUniverseCoin && !top3Gainers.some((t) => t.symbol === p.symbol))
  );

  // Priority Queue: Top 3 Gainers lead the rotation, followed by remaining top gainers
  const queue = [...top3Gainers, ...otherGainers, ...universeCoins.slice(0, 2)].slice(0, count);

  const gainers = queue.filter(q => q.defaultDirection === "LONG");
  const losers = queue.filter(q => q.defaultDirection === "SHORT");

  return { 
    gainers: gainers.length > 0 ? gainers : queue, 
    losers, 
    top3: top3Gainers,
    queue: queue.length > 0 ? queue : validPairs.slice(0, count)
  };
}

/**
 * Fetch Top 3 Trending Hashtags / Hot Topics from Binance Square PGC API
 * @param {number} limit Number of trending topics to return (default 3)
 * @returns {Promise<Array<object>>}
 */
export async function getHotTrendingHashtags(limit = 3) {
  const HOT_LIST_URL = "https://www.binance.com/bapi/composite/v2/public/pgc/hashtag/hot-list";
  try {
    const res = await fetch(HOT_LIST_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "lang": "en"
      }
    });

    if (!res.ok) {
      console.warn(`[hot-list] API returned ${res.status}: ${res.statusText}`);
      return [];
    }

    const json = await res.json();
    const dataList = json?.data?.data || [];
    const topContent = json?.data?.topContent;

    // Extract trending coins from hot list (e.g. ZEC, DASH, BTC)
    const rawCoinPairs = (topContent?.coinPairList || []).map(c => c.replace(/[\$\s]/g, "").toUpperCase());
    const tradingPairsCodes = (topContent?.tradingPairs || []).map(p => p.code?.toUpperCase()).filter(Boolean);
    const extractedCoins = [...new Set([...rawCoinPairs, ...tradingPairsCodes])].filter(c => !BANNED_BASE_ASSETS.has(c));

    return dataList.slice(0, limit).map((item, idx) => ({
      rank: idx + 1,
      hashtag: item.hashtag, // e.g. "#ZECHitsANewAllTimeHigh"
      viewCount: item.viewCount,
      contentCount: item.contentCount,
      description: item.description,
      trendingCoins: extractedCoins,
      topSnippet: (idx === 0 && topContent?.content) ? topContent.content.substring(0, 300) : null,
      topImage: (idx === 0 && topContent?.images?.[0]) ? topContent.images[0] : null
    }));
  } catch (err) {
    console.error(`[hot-list] Error fetching trending hashtags: ${err.message}`);
    return [];
  }
}

/**
 * Build the post prompt.
 *
 * Design notes, because the previous version is why engagement was flat:
 *
 * - Every post was a buy call. A feed that is bullish 100% of the time, every 15
 *   minutes, on whatever is already up the most, is indistinguishable from a pump
 *   account. NO_TRADE_CALL and LEVEL_ALERT exist so the account is seen refusing
 *   trades, which is the single cheapest credibility signal available.
 * - Levels were current price x a fixed multiplier, identical on every coin. Now
 *   they come from `marketContext.gradeSetup` and differ per chart.
 * - Claims were unfalsifiable ("I see buyers stepping in"). Now the model is handed
 *   real measurements and forbidden from inventing any others.
 * - TARGET_HIT_CONGRATS fabricated wins for trades that were never called. Deleted.
 *   Real results come from `trackRecord`, assembled in code, not by a model.
 *
 * Formats:
 *   EVIDENCE_SIGNAL  a setup with real levels, real risk, stated invalidation
 *   NO_TRADE_CALL    a public pass, with the reason
 *   LEVEL_ALERT      one specific level and what it means, short
 *   TEACH            one lesson taught through the live chart
 *   TRENDING_TOPIC   an opinion on a trending hashtag with an actual position in it
 *   QUICK_TAKE       short, but built around one verifiable number
 */
function buildMultiFormatPrompt(coin, formatType = "EVIDENCE_SIGNAL", allMovers = [], trendingTopic = null, grade = null) {
  const symbol = coin?.baseAsset || "MARKET";
  const ctx = grade?.ctx || null;
  const levels = grade?.levels || null;

  // Only measurements that came off real candles are ever put in front of the model.
  const evidence = (grade?.reasons || []).map((r) => `- ${r}`).join("\n");
  const risks = (grade?.warnings || []).map((r) => `- ${r}`).join("\n");

  const factBlock = ctx
    ? `VERIFIED MARKET DATA for $${symbol} (every number below is measured from Binance candles, do not alter any of them):
- Price: $${px(ctx.price)}
- 24h change: ${ctx.changePct >= 0 ? "+" : ""}${ctx.changePct.toFixed(1)}%
- 24h range: $${px(ctx.rangeLow)} to $${px(ctx.rangeHigh)}, price is sitting at ${ctx.rangePos.toFixed(0)}% of that range
- 7 day high: $${px(ctx.high7d)} (price is ${ctx.pctFrom7dHigh.toFixed(1)}% from it)
- 1h RSI: ${ctx.rsi1h !== null ? ctx.rsi1h.toFixed(0) : "n/a"}
- 24h volume: $${fmtCompact(ctx.last24Vol)}, which is ${ctx.volRatio.toFixed(1)}x the 7 day average
- 1h ATR: ${ctx.atrPct !== null ? ctx.atrPct.toFixed(1) : "n/a"}% of price (this is the normal hourly swing)
- Last 1h swing low: $${px(ctx.swingLow1h)}   Last 1h swing high: $${px(ctx.swingHigh1h)}`
    : `MARKET DATA for $${symbol}: price $${px(coin?.lastPrice || 0)}, 24h change ${(coin?.priceChangePercent || 0).toFixed(1)}%.`;

  const VOICE = `VOICE AND HONESTY RULES (these override everything else):
1. You are a systematic trader who publishes levels from a screener. Write in first person.
2. NEVER claim you already bought, already sold, or already made money. You have no proof of that and readers assume it is a lie. Say what the setup is and what you would do, not what you supposedly did.
3. NEVER invent a number. Use ONLY the measured values above. If you want to make a point you have no number for, do not make the point.
4. NEVER promise an outcome. No "guaranteed", no "easy money", no "this WILL pump", no "100x".
5. No hype punctuation walls. Maximum 4 emojis in the whole post.
6. Lead with the specific number, not with excitement. "Volume is 3.2x average" beats "MASSIVE VOLUME".
7. Do not use dashes (-- or em-dashes).
8. Simple everyday English. Short lines. Mobile readers.
9. Output ONLY the raw post text, no preamble, no explanation of what you wrote.`;

  // ---------------------------------------------------------------- NO_TRADE
  if (formatType === "NO_TRADE_CALL") {
    return `Write a Binance Square post where you publicly PASS on $${symbol} and explain why.

This post exists to show readers you say no. It is the most valuable post type on the account, so do not soften it into a buy call.

${factBlock}

WHY THIS IS A PASS:
${risks || `- The evidence for continuation is not strong enough to justify the risk here.`}

WHAT WOULD CHANGE YOUR MIND (use these exact levels, do not invent your own):
- An hourly close and hold above $${px(ctx?.swingHigh1h ?? coin?.highPrice)}
- Or a pullback that holds $${px(ctx?.swingLow1h ?? coin?.lowPrice)} and bounces from it

STRUCTURE TO FOLLOW:
Line 1: a hook that states the pass plainly. Example shape: "$${symbol} is up ${Math.abs(coin?.priceChangePercent || 0).toFixed(0)}% today and I am not touching it. Here is the number that stopped me."
Then: the specific measured reason, in 2 or 3 short lines.
Then: exactly what you need to see before this becomes a trade, with the price level.
Then: one honest line admitting this could keep running without you, and that missing a move costs nothing while a bad entry costs real money.
Then: ask readers who ARE in the trade what their invalidation level is. Genuine question, not bait.
End with: "Not financial advice. My levels, my risk." and the tags #${symbol} #RiskManagement

${VOICE}`;
  }

  // ------------------------------------------------------------- LEVEL_ALERT
  if (formatType === "LEVEL_ALERT") {
    const key = ctx?.swingHigh1h || coin?.highPrice;
    return `Write a SHORT Binance Square post (under 400 characters) about one single price level on $${symbol}.

${factBlock}

THE LEVEL: $${px(key)}

STRUCTURE:
Line 1: name the level and why it matters, in one sentence.
Line 2: what it means if price closes above it.
Line 3: what it means if it fails.
Last line: ask readers which side they are leaning. Tags: #${symbol}

No entry, no targets, no stop in this post. It is a heads up, not a signal. Keep it under 400 characters total.

${VOICE}`;
  }

  // -------------------------------------------------------------------- TEACH
  if (formatType === "TEACH") {
    const lessons = [
      {
        topic: "position sizing",
        angle: `Use $${symbol} as the live example. Its 1h ATR is ${ctx?.atrPct?.toFixed(1) || "high"}% of price, so show the reader how to work out a size where a stop that far away only costs 1% of the account. Do the arithmetic on a $1000 account so it is concrete.`,
      },
      {
        topic: "why chasing the top gainer usually loses",
        angle: `$${symbol} is up ${(coin?.priceChangePercent || 0).toFixed(0)}% and sitting at ${ctx?.rangePos?.toFixed(0) || "the top"}% of its 24h range. Explain who is selling to a buyer at this price and what that means for the odds.`,
      },
      {
        topic: "reading volume properly",
        angle: `$${symbol} volume is ${ctx?.volRatio?.toFixed(1) || "elevated"}x its 7 day average. Explain the difference between a move with volume behind it and a move without, and how to check that ratio yourself in 20 seconds.`,
      },
      {
        topic: "where a stop actually belongs",
        angle: `Explain that a stop belongs below the level that proves you wrong, not at a round percentage. Use $${symbol}: its last 1h swing low is $${px(ctx?.swingLow1h || 0)}, and its normal hourly swing is ${ctx?.atrPct?.toFixed(1) || "n/a"}%, so a tighter stop than that gets hit by noise alone.`,
      },
    ];
    const lesson = lessons[Math.floor(Math.random() * lessons.length)];

    return `Write a Binance Square post that TEACHES one thing: ${lesson.topic}.

${factBlock}

THE ANGLE: ${lesson.angle}

STRUCTURE:
Line 1: a hook that names the mistake most people make. No coin hype.
Then: teach it in 4 to 6 short lines, using the real $${symbol} numbers as the worked example. Show the actual arithmetic.
Then: one line on what to do differently on the next trade.
Then: ask readers what their own rule is for this. Tags: #TradingTips #${symbol}

This post is not a signal. Do not give an entry or a target.

${VOICE}`;
  }

  // ---------------------------------------------------------- TRENDING_TOPIC
  if (formatType === "TRENDING_TOPIC" && trendingTopic) {
    const hashtag = trendingTopic.hashtag || "#Crypto";
    const cleanTopic = hashtag.replace(/^#/, "").replace(/([a-z])([A-Z0-9])/g, "$1 $2");
    return `Write a Binance Square post giving your genuine take on the trending topic ${hashtag}.

TOPIC: ${cleanTopic}
${trendingTopic.viewCount ? `This topic has ${trendingTopic.viewCount.toLocaleString()} views on Binance Square right now.` : ""}
${trendingTopic.topSnippet ? `Context being discussed: ${trendingTopic.topSnippet}` : ""}

STRUCTURE:
Line 1: a hook that takes an actual position on the topic. Not "here is what is happening". Something a reader could disagree with.
Then: 3 or 4 short lines on why you hold that view, and what it changes for a trader specifically.
Then: state plainly what you are doing about it, including if the answer is nothing.
Then: name the thing that would prove your view wrong. This is the part that makes people trust you, do not skip it.
Then: ask readers for the opposite view. Tags: ${hashtag}

IMPORTANT: if you do not have real information about this topic beyond the hashtag itself, write about what the topic trending TELLS you about market attention and positioning, rather than inventing news, numbers, partnerships, or events. Never state a fact you were not given.

${VOICE}`;
  }

  // -------------------------------------------------------------- QUICK_TAKE
  if (formatType === "QUICK_TAKE") {
    return `Write a very short Binance Square post about $${symbol}, under 220 characters.

${factBlock}

It must be built around ONE specific measured number from the data above, and it must say something useful. Not "this is pumping". Something like the volume ratio, the RSI reading, the distance from the 7 day high, or where price sits in its range, and what that one number implies.

End with a short question. Tag: #${symbol}

Under 220 characters total.

${VOICE}`;
  }

  // --------------------------------------------------------- EVIDENCE_SIGNAL
  const isWatch = grade?.verdict === "WATCH" || grade?.verdict === "WATCH";
  const rr = levels?.targetR?.[0] || 1.5;

  return `Write a Binance Square post presenting a ${isWatch ? "tentative" : "clean"} long setup on $${symbol}.

${factBlock}

THE EVIDENCE THAT SUPPORTS IT:
${evidence || "- Momentum and volume are constructive."}

THE RISKS, WHICH YOU MUST INCLUDE IN THE POST:
${risks || "- Any breakdown of the swing low invalidates the idea immediately."}

THE LEVELS, USE THESE EXACTLY AND DO NOT RECALCULATE THEM:
Entry zone: $${px(levels?.entryLow)} to $${px(levels?.entryHigh)}
Stop loss: $${px(levels?.stop)}, which is ${levels?.riskPct?.toFixed(1)}% away and sits under the last swing low at $${px(levels?.invalidation)}
TP1: $${px(levels?.targets?.[0])} (${levels?.targetR?.[0]}R)
TP2: $${px(levels?.targets?.[1])} (${levels?.targetR?.[1]}R)
TP3: $${px(levels?.targets?.[2])} (${levels?.targetR?.[2]}R)
${levels?.notes?.length ? `Note to include: ${levels.notes.join(" ")}` : ""}

STRUCTURE TO FOLLOW:
Line 1: a hook built on the strongest measured fact, not on excitement. It should make a reader want to check the chart.
Then: 2 or 3 short lines explaining the setup using the evidence above. Every claim must map to a number you were given.
Then: the levels, laid out clean and scannable, entry then stop then the three targets. Mention that risking to the stop is ${levels?.riskPct?.toFixed(1)}% and the first target pays ${rr}R.
Then: a line naming exactly what kills the idea. Use the stop level. Say plainly that if it closes below there you are out and not arguing with it.
Then: include at least one of the risks above, honestly. ${isWatch ? "Say clearly this is a watch and not a full size entry, and why." : ""}
Then: ask a real question that invites disagreement. Something like whether readers see the same level, or what would make them fade this.
End with: "Not financial advice. My levels, my risk. Size so a stop out does not hurt." and tags #${symbol} #TradingSetup

${VOICE}`;
}

/**
 * Check that every dollar figure in the post is a number we actually supplied.
 *
 * LLMs fill gaps. Given a prompt slot it has no data for, a model will happily
 * produce a confident, specific, invented price level, and a reader who charts it
 * and finds nothing there never trusts the account again. This is the last gate
 * before publishing: any price that is not one we handed the model, and not inside
 * the coin's real 7 day range, fails the post.
 *
 * @returns {{ok: boolean, offenders: string[]}}
 */
export function validatePostNumbers(text, ctx, levels) {
  if (!ctx) return { ok: true, offenders: [] };

  const allowed = [
    ctx.price, ctx.rangeLow, ctx.rangeHigh, ctx.high7d, ctx.low7d,
    ctx.swingLow1h, ctx.swingHigh1h, ctx.swingLow3d, ctx.swingHigh3d,
    ctx.swingLow15m, ctx.swingHigh15m,
    levels?.entryLow, levels?.entryHigh, levels?.stop, levels?.invalidation,
    ...(levels?.targets || []),

    // Derived quantities the TEACH format is explicitly asked to work out: the ATR
    // expressed in dollars, and the distance from entry to stop. These are correct
    // arithmetic on numbers we supplied, not invented levels.
    ctx.atr,
    levels?.stop ? ctx.price - levels.stop : null,

    // The position sizing lesson asks for the size that risks 1% of a $1000 account
    // across a stop one ATR wide. That produces a dollar figure like $136.98, which
    // is a position size, not a price. It is deterministic from the ATR, so allow it
    // rather than flagging correct arithmetic as a fabricated level.
    ctx.atrPct ? 10 / (ctx.atrPct / 100) : null,
    levels?.riskPct ? 10 / (levels.riskPct / 100) : null,
  ].filter((n) => typeof n === "number" && Number.isFinite(n));

  // Price levels only.
  //
  // The lookaheads stop the engine backtracking to a shorter number: without them
  // "$15.4M" also matches as "$15", which then looks like an invented price. They
  // are split so that a price ending a sentence ("...at $0.99000.") still matches,
  // which a single `(?![\d.,])` would silently skip. The trailing suffix group
  // catches volume figures ($15.4M) and percentages so they are not read as prices.
  const matches = [...text.matchAll(/\$\s?(\d+(?:,\d{3})*(?:\.\d+)?)(?!\d)(?!,\d{3})(?!\.\d)\s*([KMBTkmbt%])?/g)];

  const offenders = [];
  for (const m of matches) {
    if (m[2]) continue; // $15.4M volume, 5% etc, not a price level

    // formatPrice always emits a decimal point, so every level we hand the model
    // has one. A bare integer is an account size or a round rhetorical figure
    // ("on a $1000 account, 1% is $10"), not a price level being claimed.
    if (!m[1].includes(".")) continue;

    const value = parseFloat(m[1].replace(/,/g, ""));
    if (!Number.isFinite(value) || value === 0) continue;

    // Tolerate rounding: 0.5% of the quoted value.
    const nearAllowed = allowed.some((a) => Math.abs(value - a) <= Math.abs(a) * 0.005);
    if (nearAllowed) continue;

    // A price inside the real 7 day range is a defensible reference even if we did
    // not hand it over verbatim. Anything outside it was invented.
    const inRange = value >= ctx.low7d * 0.97 && value <= ctx.high7d * 1.03;
    if (inRange) continue;

    offenders.push(m[0]);
  }

  return { ok: offenders.length === 0, offenders };
}

/**
 * Generate post using OpenRouter API
 */
async function generateWithOpenRouter(prompt, apiKey, modelName = "qwen/qwen-2.5-7b-instruct") {
  console.log(`[openrouter] Calling OpenRouter model: ${modelName}...`);

  const payload = {
    model: modelName,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
    temperature: 0.85,
    max_tokens: 800,
  };

  const res = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": "https://binance.com",
      "X-Title": "Binance Square Reposter",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter API Error ${res.status}: ${errText}`);
  }

  const json = await res.json();
  const choice = json?.choices?.[0];
  const text = choice?.message?.content?.trim();

  if (!text) {
    throw new Error(`OpenRouter returned empty response: ${JSON.stringify(json)}`);
  }

  // Same guard as Gemini: never publish a post that stopped mid sentence because it
  // ran out of tokens. Reasoning models configured here will hit this too.
  if (choice?.finish_reason === "length") {
    throw new Error(`OpenRouter model ${modelName} hit the token ceiling and returned a truncated post`);
  }

  console.log(`[openrouter] ✅ Successfully generated post via OpenRouter (${modelName})`);
  return text;
}

/**
 * Generate post using Google Gemini API
 */
async function generateWithGemini(prompt, apiKey, preferredModel) {
  console.log("[gemini] Calling Google Gemini API...");

  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.9,
      topP: 0.95,
      // Gemini 3.x models are reasoning models and spend output tokens on internal
      // thinking BEFORE emitting any text. Measured: ~2000 thought tokens for a
      // short post. At the old 900 ceiling, thinking ate 865 of them and the post
      // came back cut off mid sentence. There is no way to disable it on this API
      // version (thinkingBudget and thinkingLevel are both rejected), so the budget
      // has to cover thinking plus the answer.
      maxOutputTokens: 4096,
    },
  };

  const modelsToTry = preferredModel
    ? [preferredModel, ...GEMINI_CANDIDATE_MODELS.filter((m) => m !== preferredModel)]
    : GEMINI_CANDIDATE_MODELS;

  let lastError;

  for (const model of modelsToTry) {
    const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errText = await res.text();
        // 404 means the model is retired. 429/500/503 mean this particular model is
        // busy or rate limited right now, which is common on the free tier for the
        // newest model. Both are reasons to try the next model, not to abandon the
        // whole provider: bailing to OpenRouter on a transient 503 was turning a few
        // seconds of Gemini load into a completely failed cycle.
        if ([404, 429, 500, 503].includes(res.status)) {
          console.warn(`[gemini] Model '${model}' returned ${res.status}, trying next fallback...`);
          lastError = new Error(`Gemini API Error ${res.status} (${model}): ${errText.slice(0, 200)}`);
          continue;
        }
        throw new Error(`Gemini API Error ${res.status} (${model}): ${errText}`);
      }

      const json = await res.json();
      const candidate = json?.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text?.trim();

      // A truncated post is worse than no post: it publishes a sentence that stops
      // halfway and makes the account look broken. Treat it as a failed attempt.
      if (candidate?.finishReason === "MAX_TOKENS") {
        const thoughts = json?.usageMetadata?.thoughtsTokenCount ?? 0;
        console.warn(`[gemini] '${model}' hit the token ceiling (${thoughts} spent on thinking). Discarding truncated output.`);
        lastError = new Error(`Gemini returned a truncated post from ${model}`);
        continue;
      }

      if (text) {
        console.log(`[gemini] ✅ Successfully generated post using model: ${model}`);
        return text;
      }
    } catch (err) {
      if (/\b(404|429|500|503)\b/.test(err.message)) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  // Every hardcoded candidate 404'd, which means Google retired them all. Rather
  // than keep shipping a list that goes stale every few months, ask the API which
  // models this key can actually use and retry with the newest flash one.
  const discovered = await discoverGeminiModel(apiKey);
  if (discovered && !modelsToTry.includes(discovered)) {
    console.log(`[gemini] Retrying with auto discovered model: ${discovered}`);
    const res = await fetch(`${GEMINI_API_BASE}/${discovered}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (text) {
        console.log(`[gemini] ✅ Successfully generated post using model: ${discovered}`);
        console.log(`[gemini] 💡 Set LLM_MODEL=${discovered} in .env to skip the fallback scan next time.`);
        return text;
      }
    } else {
      lastError = new Error(`Gemini API Error ${res.status} (${discovered}): ${await res.text()}`);
    }
  }

  throw lastError || new Error("All Gemini candidate models failed.");
}

// Discovered once per process; the ListModels call is not worth repeating per post.
let cachedGeminiModel = null;

/**
 * Ask the Gemini API which models this key can use, and pick the newest flash tier
 * one that supports generateContent.
 *
 * The hardcoded candidate list went completely stale: gemini-2.0-flash,
 * gemini-2.5-flash and gemini-1.5-flash were all retired, so every fallback 404'd
 * and the provider looked broken when it was only out of date.
 */
export async function discoverGeminiModel(apiKey) {
  if (cachedGeminiModel !== null) return cachedGeminiModel;
  try {
    const res = await fetch(`${GEMINI_API_BASE}?key=${apiKey}&pageSize=200`);
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[gemini] Could not list models (HTTP ${res.status}): ${body.slice(0, 160)}`);
      cachedGeminiModel = false;
      return false;
    }
    const json = await res.json();
    const usable = (json.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      // Skip previews, experimental builds and non text variants; they are the ones
      // most likely to disappear or behave oddly mid run.
      .filter((n) => !/(preview|exp|thinking|image|audio|tts|embedding|vision)/i.test(n));

    // Prefer flash for cost, then anything else. Higher version numbers first.
    const score = (n) => {
      const v = parseFloat((n.match(/(\d+\.?\d*)/) || [])[1] || "0");
      return (/flash/i.test(n) ? 1000 : 0) + v;
    };
    usable.sort((a, b) => score(b) - score(a));

    cachedGeminiModel = usable[0] || false;
    if (cachedGeminiModel) {
      console.log(`[gemini] Discovered ${usable.length} usable models, picked: ${cachedGeminiModel}`);
    } else {
      console.warn(`[gemini] The API listed no usable text models for this key.`);
    }
    return cachedGeminiModel;
  } catch (err) {
    console.warn(`[gemini] Model discovery failed: ${err.message}`);
    cachedGeminiModel = false;
    return false;
  }
}

/**
 * Universal Post Generator supporting Gemini or OpenRouter with 30% Signal / 70% News & Engagement mix
 */
/**
 * Resolve high-quality relevant image URL for news, coin ecosystem, and target hit posts.
 */
export function resolvePostImageUrl(coin, formatType = "", trendingTopic = null) {
  if (formatType === "TRENDING_TOPIC") {
    if (trendingTopic?.topImage) return trendingTopic.topImage;
    const trendingImages = [
      "https://images.unsplash.com/photo-1642543492481-44e81e3914a7?w=800&auto=format&fit=crop&q=80", // Crypto Trend / Liquidity
      "https://images.unsplash.com/photo-1621416894569-0f39ed31d247?w=800&auto=format&fit=crop&q=80", // Bitcoin Market Momentum
      "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=800&auto=format&fit=crop&q=80"  // Trading Analytics
    ];
    return trendingImages[Math.floor(Math.random() * trendingImages.length)];
  }

  const sym = (coin?.baseAsset || "").toLowerCase();
  if (sym) {
    return `https://assets.coincap.io/assets/icons/${sym}@2x.png`;
  }

  return null;
}

// Coincap has no icon for most newly listed small caps, which are precisely the
// coins this bot posts about. Attaching a 404 means the post renders with a broken
// thumbnail in the feed, and a post with no working image gets a fraction of the
// impressions. Verified once per symbol, then cached for the process lifetime.
const imageUrlCache = new Map();

const FALLBACK_IMAGES = [
  "https://images.unsplash.com/photo-1642543492481-44e81e3914a7?w=800&auto=format&fit=crop&q=80",
  "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=800&auto=format&fit=crop&q=80",
];

async function urlResolves(url) {
  if (!url) return false;
  if (imageUrlCache.has(url)) return imageUrlCache.get(url);
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(6000) });
    const ok = res.ok;
    imageUrlCache.set(url, ok);
    if (!ok) console.warn(`[image] ${url} returned ${res.status}, not attaching it.`);
    return ok;
  } catch (err) {
    imageUrlCache.set(url, false);
    console.warn(`[image] Could not verify ${url}: ${err.message}`);
    return false;
  }
}

/** Resolve an image that is known to load, or null. */
export async function resolveVerifiedImageUrl(coin, formatType = "", trendingTopic = null) {
  const primary = resolvePostImageUrl(coin, formatType, trendingTopic);
  if (await urlResolves(primary)) return primary;

  for (const fallback of FALLBACK_IMAGES) {
    if (await urlResolves(fallback)) return fallback;
  }
  return null;
}

/**
 * Universal Post Generator supporting Gemini or OpenRouter:
 * 30% Top Gainer Signals (>45% Short, <45% Long), 30% FOMO Tease, 40% Trending Topics (Hot List)
 */
export async function generateTraderPost(coin, allMovers, options = {}) {
  // The chart decides the format, not a dice roll. This is the important change:
  // previously every outcome was some flavour of "buy this", so the feed was 100%
  // bullish forever. Now a weak chart produces a public pass, and only a genuinely
  // strong one produces a signal with levels.
  const ctx = options.marketContext !== undefined ? options.marketContext : await buildMarketContext(coin);
  const grade = options.grade || gradeSetup(ctx);
  grade.ctx = ctx;

  let weightedFormats;
  if (grade.verdict === "TRADE") {
    weightedFormats = [
      "EVIDENCE_SIGNAL", "EVIDENCE_SIGNAL", "EVIDENCE_SIGNAL", "EVIDENCE_SIGNAL",
      "LEVEL_ALERT",
      "TEACH",
      "TRENDING_TOPIC",
      "QUICK_TAKE",
    ];
  } else if (grade.verdict === "WATCH") {
    weightedFormats = [
      "LEVEL_ALERT", "LEVEL_ALERT",
      "EVIDENCE_SIGNAL",
      "TEACH", "TEACH",
      "TRENDING_TOPIC",
      "QUICK_TAKE",
      "NO_TRADE_CALL",
    ];
  } else {
    // Nothing tradable here. Say so, or teach instead. Never manufacture a setup
    // just because the scheduler fired.
    weightedFormats = [
      "NO_TRADE_CALL", "NO_TRADE_CALL", "NO_TRADE_CALL",
      "TEACH", "TEACH",
      "TRENDING_TOPIC", "TRENDING_TOPIC",
      "LEVEL_ALERT",
    ];
  }

  let formatType = options.format || weightedFormats[Math.floor(Math.random() * weightedFormats.length)];

  // A signal without usable levels is not a signal. This fires when a NO_TRADE chart
  // is asked for EVIDENCE_SIGNAL, including via the test harness, so say so out loud
  // rather than silently writing a different kind of post.
  if (formatType === "EVIDENCE_SIGNAL" && !grade.levels?.stop) {
    console.log(`[ai] ${grade.verdict} chart has no tradeable levels, writing TEACH instead of EVIDENCE_SIGNAL.`);
    formatType = "TEACH";
  }

  let trendingTopic = options.trendingTopic || null;

  if (formatType === "TRENDING_TOPIC" && !trendingTopic) {
    try {
      const hotList = await getHotTrendingHashtags(3);
      if (hotList && hotList.length > 0) {
        trendingTopic = hotList[Math.floor(Math.random() * hotList.length)];
        console.log(`[hot-list] 🔥 Trending Context Loaded: ${trendingTopic.hashtag} (Coins: ${trendingTopic.trendingCoins?.join(", ") || "None"})`);
      }
    } catch (err) {
      console.warn(`[hot-list] Failed to fetch trending topic: ${err.message}`);
    }
  }

  // TRENDING_TOPIC was selected but the hot list is unavailable; fall back to
  // something grounded in the chart rather than posting about a topic we know
  // nothing about.
  if (formatType === "TRENDING_TOPIC" && !trendingTopic) {
    formatType = grade.verdict === "NO_TRADE" ? "NO_TRADE_CALL" : "TEACH";
  }

  const targetName = formatType === "TRENDING_TOPIC" && trendingTopic ? trendingTopic.hashtag : `$${coin?.baseAsset || "MARKET"}`;
  console.log(`[ai] Format [${formatType}] for ${targetName} (verdict: ${grade.verdict}, score: ${grade.score})`);

  const prompt = buildMultiFormatPrompt(coin, formatType, allMovers, trendingTopic, grade);
  const imageUrl = await resolveVerifiedImageUrl(coin, formatType, trendingTopic);
  
  const rawProvider = String(options.provider || "").trim().toLowerCase();
  const isGemini = rawProvider === "1" || rawProvider === "gemini";
  const isOpenRouter = rawProvider === "openrouter" || rawProvider === "2" || (!isGemini && options.openrouterKey);

  // Try the configured provider, then fall back to the other one if a key exists.
  // An out of credit or rate limited provider used to abort the whole cycle and skip
  // the slot entirely; with both keys configured there is no reason for that.
  const runModel = async (p) => {
    const primary = isOpenRouter ? "openrouter" : "gemini";
    const order = primary === "openrouter" ? ["openrouter", "gemini"] : ["gemini", "openrouter"];

    let lastErr;
    for (const provider of order) {
      const key = provider === "openrouter" ? options.openrouterKey : options.geminiKey;
      if (!key) continue;
      try {
        // LLM_MODEL names a model on the PRIMARY provider only. Passing it to the
        // fallback sent "gemini-3.8-flash" to OpenRouter, which is not a model it
        // has; the fallback must use its own default instead.
        const model = provider === primary ? options.model : undefined;
        if (provider === "openrouter") {
          return await generateWithOpenRouter(p, key, model || "qwen/qwen-2.5-7b-instruct");
        }
        return await generateWithGemini(p, key, model);
      } catch (err) {
        lastErr = err;
        console.warn(`[ai] ${provider} failed: ${err.message.slice(0, 160)}`);
        if (provider !== order[order.length - 1]) console.warn(`[ai] Falling back to the other provider.`);
      }
    }
    throw lastErr || new Error("No LLM API key configured. Set OPENROUTER_API_KEY or GEMINI_API_KEY in .env");
  };

  let text = await runModel(prompt);

  // Reject invented price levels and retry once with the offenders named. If the
  // second attempt is still fabricating, fall through with a warning rather than
  // silently publishing numbers that are not on the chart.
  const check = validatePostNumbers(text, ctx, grade.levels);
  if (!check.ok) {
    console.warn(`[validate] ⚠️ Post contained price levels that are not in the data: ${check.offenders.join(", ")}. Retrying once.`);
    const retryPrompt = `${prompt}

RETRY. Your previous attempt contained these price levels, which do not exist in the data you were given: ${check.offenders.join(", ")}. You invented them. Rewrite the post using ONLY the price levels listed above, and do not introduce any dollar figure that was not given to you.`;
    const retryText = await runModel(retryPrompt);
    const recheck = validatePostNumbers(retryText, ctx, grade.levels);
    if (recheck.ok) {
      text = retryText;
    } else {
      console.warn(`[validate] ❌ Retry still contained invented levels: ${recheck.offenders.join(", ")}. Using the cleaner of the two.`);
      text = recheck.offenders.length < check.offenders.length ? retryText : text;
    }
  }

  // If caller expects a simple string, return text with metadata attached
  const result = new String(text);
  result.text = text;
  result.formatType = formatType;
  result.imageUrl = imageUrl;
  result.images = imageUrl ? [imageUrl] : [];
  result.grade = grade;
  result.verdict = grade.verdict;
  // Only formats that actually publish levels get logged as a call to be graded later.
  result.levels = formatType === "EVIDENCE_SIGNAL" ? grade.levels : null;
  return result;
}

/**
 * Publish post to Binance Square OpenAPI (supports text and images).
 * @param {string|object} content Post text or object containing { text, imageUrl, images }
 * @param {string} apiKey Binance Square API Key
 * @param {object} [options] Optional publish options e.g. { imageUrl, images }
 * @returns {Promise<object>}
 */
export async function publishToSquare(content, apiKey, options = {}) {
  console.log("[publish] Publishing post to Binance Square...");

  const rawText = typeof content === "object" && content.text ? content.text : String(content);
  const imageUrl = options.imageUrl || (typeof content === "object" ? content.imageUrl : null);
  const images = options.images || (typeof content === "object" && content.images ? content.images : (imageUrl ? [imageUrl] : []));

  // 1. Sanitize cashtags ($SYMBOL): Binance limits to max 2 distinct coin pairs per post
  const seenCoins = new Set();
  let sanitized = rawText.replace(/\$([A-Za-z0-9]+)/g, (match, symbol) => {
    const symUpper = symbol.toUpperCase();
    if (seenCoins.has(symUpper)) return match;
    if (seenCoins.size < 2) {
      seenCoins.add(symUpper);
      return match;
    }
    return symbol; // drop $ to avoid coin pair limit
  });

  // 2. Sanitize hashtags (#TAG): Binance limits to max 3 hashtags per post
  let hashtagCount = 0;
  sanitized = sanitized.replace(/#([A-Za-z0-9_]+)/g, (match, tag) => {
    hashtagCount++;
    if (hashtagCount <= 3) {
      return match;
    }
    return ""; // remove excess hashtags cleanly
  });

  // 3. Strip outcome promises. The prompts forbid these, but a model under a hype
  //    prior will still occasionally emit one, and a single "guaranteed 100x" undoes
  //    weeks of building credibility. Cheaper to catch it here than to trust the LLM.
  const PROMISE_PATTERNS = [
    [/\bguaranteed?\b/gi, "likely"],
    [/\beasy money\b/gi, "a setup"],
    [/\bfree money\b/gi, "a setup"],
    [/\bwill (definitely |certainly |100% )?(pump|moon|explode|fly|skyrocket)\b/gi, "could move"],
    [/\b(100x|50x|10x)\b/gi, "a large move"],
    [/\bcan'?t lose\b/gi, "has a defined risk"],
    [/\bsure thing\b/gi, "a setup"],
    [/\bno risk\b/gi, "defined risk"],
    [/\brisk ?free\b/gi, "defined risk"],
    [/\bnext (bitcoin|ethereum|solana)\b/gi, "a high beta altcoin"],
    [/\ball ?in\b/gi, "sized carefully"],
  ];
  for (const [pattern, replacement] of PROMISE_PATTERNS) {
    if (pattern.test(sanitized)) {
      console.warn(`[publish] ⚠️ Stripped promise language matching ${pattern}`);
      sanitized = sanitized.replace(pattern, replacement);
    }
  }

  // 4. Guarantee the risk disclosure is present even if the model dropped it.
  if (!/not financial advice|nfa\b|dyor/i.test(sanitized)) {
    sanitized += "\n\nNot financial advice. My levels, my risk.";
  }

  // 5. Remove dashes while strictly preserving line breaks and clean paragraph spacing
  sanitized = sanitized
    .replace(/--+/g, " ")
    .replace(/[—–]/g, " ")
    .replace(/[ \t]+/g, " ")               // Collapse multiple spaces on same line
    .replace(/\n\s*\n\s*\n+/g, "\n\n")     // Max 1 empty line between paragraphs
    .replace(/([^\n])\s*(✅|🔥|💡|🎯|🚨|🐂|🐻)/g, "$1\n\n$2") // Ensure clean line break before major emojis/sections
    .trim();

  let richContent = sanitized;
  if (images && Array.isArray(images) && images.length > 0) {
    // Embed markdown image tag into rich content so Binance Square web/app renderer shows the image
    richContent = `${sanitized}\n\n![Market Visual](${images[0]})`;
  }

  const payload = {
    bodyTextOnly: sanitized,
    contentType: 1,
    content: richContent,
  };

  // Attach images to payload
  if (images && Array.isArray(images) && images.length > 0) {
    payload.picList = images;
    payload.pics = images;
    console.log(`[publish] 🖼️ Attached ${images.length} image(s) to post: ${images[0]}`);
  }

  const res = await fetch(BINANCE_SQUARE_PUBLISH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Square-OpenAPI-Key": apiKey,
      "clienttype": "binanceSkill",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Origin": "https://www.binance.com",
      "Referer": "https://www.binance.com/en/square",
    },
    body: JSON.stringify(payload),
  });

  const responseText = await res.text();
  let json;
  try {
    json = JSON.parse(responseText);
  } catch {
    throw new Error(`Binance Square response parse failed (${res.status}): ${responseText}`);
  }

  if (json.code !== "000000" && json.code !== 0 && json.success !== true) {
    throw new Error(`Binance Square API returned error: ${responseText}`);
  }

  console.log("[publish] ✅ Successfully published to Binance Square!");
  return json;
}

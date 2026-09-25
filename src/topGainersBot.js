/**
 * Binance Top Movers (Gainers & Losers) Technical Analysis & Signal Generator
 * 
 * Fetches real-time 24h ticker data from Binance public API, filters USDT pairs,
 * creates a balanced rotation queue of Top 5 Gainers and Top 5 Losers,
 * and uses OpenRouter or Gemini to generate authentic trader setups (Long/Short/Scalp/Dip-Buy)
 * with dynamic catchy opening hooks, explicit dollar price levels, and clickable coin cashtags ($BTC, $SOL, etc.).
 */

import { buildMarketContext, gradeSetup, fmtCompact, plainReasons } from "./marketContext.js";

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
// LITE MODELS FIRST, deliberately. Two reasons, both measured against this API:
//
// 1. Quota. The free tier caps requests PER DAY PER MODEL, and the flagship flash
//    models get 20/day, which one hourly bot exhausts before lunch. The lite tier
//    is far more generous. Because the cap is per model, having several working
//    entries here multiplies the daily budget rather than just adding a retry.
// 2. Thinking tokens. gemini-3.x flash models are reasoning models and spend ~2000
//    output tokens thinking before writing anything. The lite models report
//    thoughts=0, so the whole budget goes to the post and responses are faster.
//
// This list WILL go stale; Google retires models constantly. Every 2.x model here
// was killed within months. `discoverGeminiModel()` asks the API what actually
// exists when these all fail, so a stale entry costs one wasted request rather
// than a dead bot.
const GEMINI_CANDIDATE_MODELS = [
  "gemini-flash-lite-latest",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
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

// 24h turnover a coin needs to lead the queue. Below this there is rarely anyone on
// Square reading about it. See getMarketMovers.
export const AUDIENCE_MIN_VOLUME_USDT = 5_000_000;

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

  // Sort real altcoins by 24h percentage gain descending.
  //
  // Lead with gainers that have real turnover. The raw top of the list is mostly thin
  // tokens (IOST, LITEB, FF) with nobody reading about them on Square, so the posts
  // got no views and their cashtags had nobody to click. On a quiet day with fewer
  // than 3 liquid gainers, fall back to the full list rather than post nothing.
  const allGainers = [...validPairs]
    .filter((p) => p.priceChangePercent > 3.0)
    .sort((a, b) => b.priceChangePercent - a.priceChangePercent);
  const liquidGainers = allGainers.filter((p) => p.quoteVolume >= AUDIENCE_MIN_VOLUME_USDT);
  const topAltcoinGainers = liquidGainers.length >= 3 ? liquidGainers : allGainers;

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
    queue: queue.length > 0 ? queue : validPairs.slice(0, count),
    // Every liquid pair, so callers can match coins that are trending on Square.
    all: validPairs,
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
 * What the prompts are optimised for, in order:
 *
 * 1. The first line. Square shows two or three lines in the feed before "see more",
 *    so the hook is the post as far as reach is concerned. Every format gets a hook
 *    built on the cashtag plus one real number plus a reason to keep reading, and
 *    the example shapes rotate so the feed does not open the same way every hour.
 * 2. Cashtag trades. Commission is paid on trades placed through a cashtag, so
 *    `$SYMBOL` goes in the hook and, above all, on the entry line of a concrete
 *    setup followed by "tap $SYMBOL to trade it". That block is built in code by
 *    `buildTradeBlock`, and non signal formats carry one too whenever a chart has
 *    earned it (their own, or the best graded alternative). The model never writes
 *    the levels or the call to action.
 * 3. Trust. Every number comes from real candles, the post says what would prove it
 *    wrong, and it never claims a trade that cannot be verified. Measured facts
 *    written conversationally read as a person; the old report style read as a bot.
 * 4. Comments. Posts end on a question that takes one word to answer, because a
 *    question that needs a paragraph gets scrolled past.
 *
 * Hashtags and the disclaimer are added in code by `finalizePost`, not by the model,
 * so they are consistent and capped correctly.
 *
 * Formats:
 *   EVIDENCE_SIGNAL  a setup with real levels, real risk, stated invalidation
 *   NO_TRADE_CALL    a public pass, with the reason
 *   LEVEL_ALERT      one specific level and what it means, short
 *   TEACH            one lesson taught through the live chart
 *   TRENDING_TOPIC   an opinion on a trending hashtag with an actual position in it
 *   QUICK_TAKE       short, but built around one verifiable number
 */

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Two distinct example shapes, so the model has range without a template to copy. */
function pickTwo(arr) {
  const shuffled = shuffleArray(arr);
  return shuffled.slice(0, 2);
}

function signedPct(n, digits = 0) {
  if (!Number.isFinite(n)) return "n/a";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function buildMultiFormatPrompt(coin, formatType = "EVIDENCE_SIGNAL", allMovers = [], trendingTopic = null, grade = null, extras = {}) {
  const symbol = coin?.baseAsset || "MARKET";
  const S = `$${symbol}`;
  const ctx = grade?.ctx || null;
  const levels = grade?.levels || null;
  const chg = ctx?.changePct ?? coin?.priceChangePercent ?? 0;
  const upDown = chg >= 0 ? `up ${Math.abs(chg).toFixed(0)}%` : `down ${Math.abs(chg).toFixed(0)}%`;
  const vol = ctx ? `${ctx.volRatio.toFixed(1)}x` : null;

  // Only measurements that came off real candles are ever put in front of the model.
  const evidence = (grade?.reasons || []).map((r) => `- ${r}`).join("\n");
  const risks = (grade?.warnings || []).map((r) => `- ${r}`).join("\n");

  const factBlock = ctx
    ? `VERIFIED MARKET DATA for ${S} (measured from Binance candles, do not alter any of them):
- Price: $${px(ctx.price)}
- 24h change: ${signedPct(ctx.changePct, 1)}
- 24h range: $${px(ctx.rangeLow)} to $${px(ctx.rangeHigh)}, price is at ${ctx.rangePos.toFixed(0)}% of that range
- 7 day high: $${px(ctx.high7d)} (price is ${ctx.pctFrom7dHigh.toFixed(1)}% from it)
- 1h RSI: ${Number.isFinite(ctx.rsi1h) ? ctx.rsi1h.toFixed(0) : "n/a"}
- 24h volume: $${fmtCompact(ctx.last24Vol)}, which is ${ctx.volRatio.toFixed(1)}x the 7 day average
- 1h ATR: ${Number.isFinite(ctx.atrPct) ? ctx.atrPct.toFixed(1) : "n/a"}% of price (the normal hourly swing)
- Last 24h swing low: $${px(ctx.swingLow1h)}   Last 24h swing high: $${px(ctx.swingHigh1h)}`
    : `MARKET DATA for ${S}: price $${px(coin?.lastPrice || 0)}, 24h change ${signedPct(coin?.priceChangePercent || 0, 1)}.`;

  const voiceFor = (tag) => `VOICE AND HONESTY RULES (these override everything else):
1. You are an experienced trader sharing a chart read with a friend. First person, plain, confident, a little blunt. Sound like a person, never like a report or an AI.
2. NEVER claim you already bought, sold, or made money. Say what the setup is and what you would do.
3. NEVER invent a number, news, partnership, whale move, on chain stat or event. Use ONLY the data above, including every percentage: if you say price is some percent from a level, it must match the numbers given. If you have no number for a point, drop the point.
4. NEVER promise an outcome. No "guaranteed", "easy money", "will pump", "moon", "100x".
5. ${tag ? `Every time you name the coin write it as ${tag} with the dollar sign. Never write the bare ticker.` : "Do not name any coin ticker."}
6. At most 2 emojis in the whole post, and never one on a line by itself. A post marked up with an emoji on every line reads as generated.
7. Barely any punctuation. No full stop at the end of a line. At most one comma in a line. No colons, no semicolons, no dashes of any kind, no underscores, no quotes. At most one question mark in the whole post. Numbers keep their decimal point, write 9.9 percent and never 9 point 9 percent.
8. Never use bullet points, numbering or headings. Plain lines only.
9. Type like a trader on his phone. Vary the lines, one can be three words, and never start two lines the same way. Short lines, one idea per line, a blank line between blocks.
10. Do NOT write hashtags and do NOT write a disclaimer. Both are added automatically.
11. Never copy wording from these instructions, and never write labels like "Hook", "Line 1", "Structure" or "The level".
12. Output ONLY the finished post. No preamble, no quotes around it, no notes after it.`;
  const VOICE = voiceFor(S);

  const HOOK_RULE = `THE FIRST LINE IS EVERYTHING. Square shows only the first 2 lines before "see more".
The first line must: contain ${S}, contain one real number from the data, and give a reason to keep reading (a tension, a contradiction, or a clear opinion). Under 90 characters. No emoji at the start. No "Hey guys", no "Let's talk about".`;

  const CTA_RULE = `Do not write any "tap ${S}" line; one is added automatically.`;

  // ---------------------------------------------------------------- NO_TRADE
  if (formatType === "NO_TRADE_CALL") {
    const hooks = pickTwo([
      `${S} is ${upDown} today and I am not touching it. One number is why.`,
      `Everyone is looking at ${S} right now. I am sitting this one out.`,
      `${S} looks strong on the surface. The ${ctx?.rsi1h >= 70 ? `RSI at ${ctx.rsi1h.toFixed(0)}` : "volume"} says wait.`,
      `I almost bought ${S} today. Then I checked the ${vol ? `volume, ${vol} average` : "chart"}.`,
    ]);

    return `Write a Binance Square post where you publicly PASS on ${S} and explain why.

Saying no in public is what makes readers trust the yes. Do not soften this into a buy call.

${factBlock}

WHY THIS IS A PASS:
${risks || `- The evidence for continuation is not strong enough to justify the risk here.`}

WHAT WOULD CHANGE YOUR MIND (use these exact levels):
- An hourly close and hold above $${px(ctx?.swingHigh1h ?? coin?.highPrice)}
- Or a pullback that holds $${px(ctx?.swingLow1h ?? coin?.lowPrice)} and bounces

${HOOK_RULE}
Example hook shapes, do not copy them word for word:
- ${hooks[0]}
- ${hooks[1]}

FLOW:
First line: the hook.
Then 2 or 3 short lines: the single most important measured reason, with its number.
Then: exactly what you need to see before this becomes a trade, with the price.
${CTA_RULE}
Then one honest line: it could keep running without you, and a bad entry costs more than a missed move.
Last line: a question answerable in one word, like "Chasing ${S} here, or waiting for ${px(ctx?.swingLow1h ?? coin?.lowPrice)}?"

${VOICE}`;
  }

  // ------------------------------------------------------------- LEVEL_ALERT
  if (formatType === "LEVEL_ALERT") {
    const key = ctx?.swingHigh1h || coin?.highPrice;
    const support = ctx?.swingLow1h || coin?.lowPrice;
    const hooks = pickTwo([
      `${S} has one level that matters today: $${px(key)}.`,
      `Set an alert on ${S} at $${px(key)}. Here is why.`,
      `${S} keeps stalling at $${px(key)}. Something gives soon.`,
    ]);

    return `Write a SHORT Binance Square post (under 450 characters) about one price level on ${S}.

${factBlock}

The level to write about is $${px(key)}, the highest high of the last 24 hourly candles.
Price is $${px(ctx?.price ?? coin?.lastPrice)}, which is ${Number.isFinite(key) && (ctx?.price ?? coin?.lastPrice) ? Math.abs(((key - (ctx?.price ?? coin.lastPrice)) / (ctx?.price ?? coin.lastPrice)) * 100).toFixed(1) : "n/a"}% ${(ctx?.price ?? coin?.lastPrice) <= key ? "below" : "above"} it. Say that distance; never say price is "testing" or "at" the level unless it is within 1%.
The support underneath is $${px(support)}, the lowest low of the same window.

${HOOK_RULE}
Example hook shapes, do not copy them word for word:
- ${hooks[0]}
- ${hooks[1]}

FLOW:
First line: the hook, naming $${px(key)}.
Then one line: what an hourly close above it would mean.
Then one line: what a rejection would mean, and that $${px(support)} is the next level down.
${CTA_RULE}
Last line: "Break or reject? 👀" or a similar one word question in your own words.

No entry, no stop, no targets. This is a heads up, not a signal.

${VOICE}`;
  }

  // -------------------------------------------------------------------- TEACH
  if (formatType === "TEACH") {
    const lessons = [
      {
        topic: "position sizing",
        hook: `${S} moves ${ctx?.atrPct?.toFixed(1) || "a lot"}% an hour. Most people size it like a stablecoin.`,
        angle: `${S} has a 1h ATR of ${ctx?.atrPct?.toFixed(1) || "n/a"}% of price. Show how to size a position so a stop that far away only costs 1% of the account. Do the arithmetic on a $1000 account so it is concrete.`,
      },
      {
        topic: "why chasing the top gainer usually loses",
        hook: `${S} is ${upDown}. Ask yourself who is selling it to you at this price.`,
        angle: `${S} is ${upDown} and sitting at ${ctx?.rangePos?.toFixed(0) || "the top"}% of its 24h range. Explain who is selling to a buyer at this price and what that means for the odds.`,
      },
      {
        topic: "reading volume properly",
        hook: `${S} volume is ${vol || "unusual"} its weekly average. Here is why that matters more than price.`,
        angle: `${S} 24h volume is ${vol || "n/a"} its 7 day average. Explain the difference between a move with volume behind it and a move without, and how to check that ratio yourself in 20 seconds.`,
      },
      {
        topic: "where a stop actually belongs",
        hook: `Your stop on ${S} is probably in the wrong place. Here is where it belongs.`,
        angle: `A stop belongs below the level that proves you wrong, not at a round percentage. Use ${S}: its 24h swing low is $${px(ctx?.swingLow1h)}, and its normal hourly swing is ${ctx?.atrPct?.toFixed(1) || "n/a"}%, so a tighter stop than that gets hit by noise alone.`,
      },
    ];
    const lesson = pick(lessons);

    return `Write a Binance Square post that TEACHES one thing: ${lesson.topic}.

${factBlock}

THE ANGLE: ${lesson.angle}

${HOOK_RULE}
Example hook shape, do not copy it word for word:
- ${lesson.hook}

FLOW:
First line: the hook, naming the mistake most people make, using ${S} and a real number.
Then 4 to 6 short lines teaching it with the real ${S} numbers. Show the arithmetic.
${CTA_RULE}
Then one line: the rule to use on the next trade.
Last line: ask readers for their own rule in a way that takes a few words to answer.

This is not a signal. No entry, no target.

${VOICE}`;
  }

  // ---------------------------------------------------------- TRENDING_TOPIC
  if (formatType === "TRENDING_TOPIC" && trendingTopic) {
    const hashtag = trendingTopic.hashtag || "#Crypto";
    const cleanTopic = hashtag.replace(/^#/, "").replace(/([a-z])([A-Z0-9])/g, "$1 $2");
    const tc = extras.topicCoin;
    const T = tc ? `$${tc.baseAsset}` : null;
    const coinBlock = tc
      ? `COIN LINKED TO THIS TOPIC: ${T}. Live Binance data: price $${px(tc.lastPrice)}, 24h change ${signedPct(tc.priceChangePercent, 1)}, 24h range $${px(tc.lowPrice)} to $${px(tc.highPrice)}, 24h volume $${fmtCompact(tc.quoteVolume)}.
Write it as ${T} every time you mention it, and mention it in the first line.`
      : `There is no coin data for this topic. Do not name any coin price.`;

    return `Write a Binance Square post giving your genuine take on the trending topic ${hashtag}.

TOPIC: ${cleanTopic}
${trendingTopic.viewCount ? `This topic has ${Number(trendingTopic.viewCount).toLocaleString("en-US")} views on Binance Square right now.` : ""}
${trendingTopic.topSnippet ? `What people are posting about it: ${trendingTopic.topSnippet}` : ""}

${coinBlock}

FIRST LINE: take a position a reader could disagree with${T ? `, name ${T}` : ""}, under 90 characters. Not "here is what is happening".

FLOW:
First line: the position.
Then 3 or 4 short lines: why you hold it, and what it changes for a trader specifically.
Then: what you are doing about it, including if the answer is nothing.
Then: the specific thing that would prove you wrong. Do not skip this, it is what earns trust.
Do not write any "tap" line; one is added automatically.
Last line: ask for the opposite view in a way that takes one or two words to answer.

If you have no real information beyond the hashtag, write about what the topic trending tells you about attention and positioning. Never state a fact you were not given.

${voiceFor(T)}`;
  }

  // -------------------------------------------------------------- QUICK_TAKE
  if (formatType === "QUICK_TAKE") {
    return `Write a very short Binance Square post about ${S}, under 260 characters.

${factBlock}

Build it on ONE measured number from the data (volume ratio, RSI, distance from the 7 day high, or position in the 24h range) and say what that number implies. Not "this is pumping".
Start with ${S}. End with a one word question, like "Fade or follow?".

Under 260 characters total.

${VOICE}`;
  }

  // --------------------------------------------------------- EVIDENCE_SIGNAL
  // The model writes only the headline and the reasons, in plain words. The levels,
  // the call to action and the closing question are assembled in code by
  // buildSignalPost, so they are exact and identical in shape every time.
  const isShort = grade?.direction === "SHORT";
  const facts = (extras.reasons || []).map((r) => `- ${r}`).join("\n");

  return `Write the opening of a crypto trade signal for ${S}.
Direction: ${isShort ? "SHORT. The price can DROP from here." : "LONG. The price can GO UP from here."}

${factBlock}

THE REASONS (true, measured; rewrite them in very simple words):
${facts || evidence || "- Volume and price action support the move."}

WRITE EXACTLY THIS, nothing else:
First line: at most 9 words, contains ${S}, says it looks ready to ${isShort ? "drop" : "go up"}.
Then 2 or 3 plain lines. Each one reason with its real number, at most 12 words.

HOW TO WRITE IT (this matters as much as the content):
- Type like a trader on his phone, not like an article. No bullet points, no numbering, no headings.
- Barely any punctuation. No full stop at the end of a line. At most one comma in a line. No colons, no semicolons, no dashes, no underscores, no quotes, no question marks.
- Numbers keep their decimal point. Write 9.9 percent, never 9 point 9 percent.
- Vary the lines. One can be three words. Do not start two lines the same way.
- Words a 12 year old understands. Say buyers, sellers, volume, today's high. Never liquidity, structure, confluence, distribution, momentum shift.
- Use only numbers from the data above. Never invent one.
- Say can or looks ready. Never will, guaranteed, 100%, moon.
- At most one emoji in the whole thing, and only if it feels natural.
- Write the coin as ${S}. No hashtags, no entry, no stop, no targets. Those are added automatically.
- Output only those lines.`;
}

/**
 * The levels and the call to action, built in code so the numbers are exactly the
 * graded ones and the cashtag sits where the reader is deciding.
 *
 * Deliberately plain: no emoji per line, no full stops, hardly any commas, and the
 * three targets on one line instead of stacked. A post that arrives as a neat
 * emoji list every hour reads as a bot, and Square buries it. The wording rotates
 * so two posts in a row are never laid out the same way.
 */
export function buildTradeBlock(symbol, levels, { price = null, direction = "LONG", intro = null, withAction = true } = {}) {
  if (!symbol || !levels?.stop || !levels?.targets?.length) return null;
  const S = `$${symbol}`;
  const short = direction === "SHORT";
  const lo = px(levels.entryLow);
  const hi = px(levels.entryHigh);
  const stop = px(levels.stop);
  const t = levels.targets.map(px);

  const layouts = [
    () => [
      `${short ? "Short" : "Buy"} ${S} ${lo} to ${hi}`,
      `SL ${stop}`,
      `Targets ${t.join(" / ")}`,
    ],
    () => [
      `Entry zone ${lo} to ${hi}`,
      `Stop ${stop}`,
      `Targets ${t[0]} then ${t[1]} then ${t[2]}`,
    ],
    () => [
      `${short ? "Shorting" : "Buying"} ${S} between ${lo} and ${hi}`,
      `Invalid ${short ? "above" : "below"} ${stop}`,
      `Taking profit at ${t[0]} ${t[1]} ${t[2]}`,
    ],
    () => [
      `🎯 ${short ? "Short" : "Buy"} ${S} ${lo} to ${hi}`,
      `Stop loss ${stop}`,
      `Targets ${t.join(" / ")}`,
    ],
  ];

  const lines = intro ? [intro, ...pick(layouts)()] : pick(layouts)();
  if (!withAction) return lines.join("\n");
  return `${lines.join("\n")}\n\n${buildActionLine(symbol, levels, { price, direction })}`;
}

/**
 * Where price is right now against the zone, and the tap. True at the moment of
 * posting, which is the only kind of urgency worth using.
 */
export function buildActionLine(symbol, levels, { price = null, direction = "LONG" } = {}) {
  const S = `$${symbol}`;
  const short = direction === "SHORT";
  const inZone = Number.isFinite(price) && price >= levels.entryLow && price <= levels.entryHigh;
  const verb = short ? "short" : "buy";
  let action;
  if (inZone || !Number.isFinite(price)) {
    action = pick([
      `Price is in the zone right now\nTap ${S} to ${verb}`,
      `Sitting inside the zone as I type this\nTap ${S} to ${verb}`,
      `Tap ${S} to ${verb} it here`,
    ]);
  } else if (short ? price < levels.entryLow : price > levels.entryHigh) {
    const limit = px(short ? levels.entryLow : levels.entryHigh);
    action = `Price ran ${short ? "under" : "past"} the zone\nTap ${S} and leave a limit at ${limit}`;
  } else {
    action = `Tap ${S} to ${verb} it from the zone`;
  }
  return action;
}

// Asked on maybe half the posts. A question every single time is its own tell.
const SIGNAL_QUESTIONS = {
  LONG: ["Are you buying this one 👇", "In or out", "Who else is in", "Taking it or watching it"],
  SHORT: ["Shorting this or fading me 👇", "In or out", "Who else sees this", "Taking it or watching it"],
};

const SIGNAL_HEADLINES = {
  LONG: [
    (s) => `${s} looks ready to run`,
    (s) => `Buyers are stepping into ${s}`,
    (s) => `Watching ${s} closely here`,
    (s) => `${s} is where I want to be today`,
  ],
  SHORT: [
    (s) => `${s} looks ready to drop`,
    (s) => `${s} is running out of buyers`,
    (s) => `Fading ${s} up here`,
    (s) => `${s} pumped too far too fast`,
  ],
};

/**
 * Parse the model's headline and reasons.
 *
 * Bullets are stripped rather than required: the prompt now asks for plain lines,
 * because a bulleted list in every post is exactly what makes a feed look generated.
 * Returns null when the shape is wrong so the caller can retry.
 */
export function parseSignalIntro(text, symbol) {
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.replace(/^\s*[•\-*·\d.]+\s*/, "").trim())
    .filter(Boolean)
    .filter((l) => !/^#/.test(l) && !/^(why|reasons?|headline)\b.{0,12}:?$/i.test(l));
  if (lines.length < 3) return null;
  const headline = lines[0].replace(/^["'*]+|["'*]+$/g, "").trim();
  const reasons = lines.slice(1, 4).filter((r) => r.length <= 110);
  if (!headline || headline.length > 90 || reasons.length < 2) return null;
  return { headline, reasons };
}

/**
 * Strip the punctuation that makes a post read as written by a machine.
 *
 * Full stops at the end of every short line, three commas in a sentence, colons
 * introducing lists, underscores and double dashes: none of that is how people type
 * on Square. Prices and decimals are left alone.
 */
export function humanizePunctuation(text) {
  const lines = String(text).split("\n");
  const out = lines.map((line) => {
    let l = line
      .replace(/_/g, " ")
      .replace(/;/g, " ")
      .replace(/\.{2,}/g, " ")
      .replace(/([!?]){2,}/g, "$1")
      .replace(/,\s+(so|which|and|but|then)\s/gi, " $1 ")
      .replace(/\s+([,.])/g, "$1");

    // At most one comma per line; later ones become spaces.
    let seen = 0;
    l = l.replace(/,/g, () => (++seen === 1 ? "," : " "));

    // A colon is fine mid sentence but not as a list header.
    l = l.replace(/:\s*$/, "");

    // Drop the full stop that ends a line. Keep it inside the line, where it is
    // separating two real sentences.
    l = l.replace(/\.\s*$/, "");
    return l.replace(/[ \t]{2,}/g, " ").trimEnd();
  });

  // One question mark per post, the last one wins.
  let joined = out.join("\n");
  // A post that opens lower case reads as unfinished rather than casual.
  joined = joined.replace(/^(\p{Extended_Pictographic}️?\s*)?(\p{Ll})/u, (m, lead = "", ch) => `${lead}${ch.toUpperCase()}`);
  // Indicator names stay capitalised however the model typed them, so a capitalised
  // line never reads "Rsi is at 80".
  joined = joined.replace(/\b(rsi|atr|sl|tp)\b/gi, (m) => m.toUpperCase());
  const qs = (joined.match(/\?/g) || []).length;
  if (qs > 1) {
    let left = qs - 1;
    joined = joined.replace(/\?/g, (m) => (left-- > 0 ? "" : m));
  }
  return joined;
}

/**
 * The whole signal post.
 *
 * Three layouts, picked at random, so the feed does not show the same skeleton every
 * time: reasons before the levels, one reason as the opening line, or the levels
 * first with the reasons underneath. The track record and the question each appear
 * about half the time, for the same reason.
 */
export function buildSignalPost({ symbol, direction = "LONG", intro, levels, price, trackRecord = null, hashtags = [] }) {
  const S = `$${symbol}`;
  const dir = direction === "SHORT" ? "SHORT" : "LONG";
  let headline = intro?.headline || pick(SIGNAL_HEADLINES[dir])(S);
  if (!new RegExp(`\\$${symbol}\\b`, "i").test(headline)) {
    const bare = new RegExp(`(^|[^$A-Za-z0-9])(${symbol})\\b`, "i");
    headline = bare.test(headline) ? headline.replace(bare, (_, pre) => `${pre}${S}`) : `${S} ${headline}`;
  }

  const reasons = intro.reasons.slice(0, 3).map((r) => r.charAt(0).toUpperCase() + r.slice(1));
  const trade = buildTradeBlock(symbol, levels, { price, direction: dir });
  const shape = Math.random();
  const parts = [];

  if (shape < 0.34) {
    // Headline, then the reasons as plain lines, then the trade.
    parts.push(headline, reasons.join("\n"), trade);
  } else if (shape < 0.67) {
    // Headline carries the first reason, the rest sit under the levels, and the tap
    // still closes the post.
    parts.push(
      `${headline}\n${reasons[0]}`,
      buildTradeBlock(symbol, levels, { price, direction: dir, withAction: false }),
      reasons.slice(1).join("\n"),
      buildActionLine(symbol, levels, { price, direction: dir })
    );
  } else {
    // Levels first for readers who only want the trade, reasons under them, and the
    // tap last so the post still ends on the thing to do.
    parts.push(
      headline,
      buildTradeBlock(symbol, levels, { price, direction: dir, withAction: false }),
      reasons.join("\n"),
      buildActionLine(symbol, levels, { price, direction: dir })
    );
  }

  if (trackRecord && Math.random() < 0.5) {
    parts.push(`Last ${trackRecord.days} days of my calls, ${trackRecord.wins} hit target and ${trackRecord.stopped} hit stop`);
  }
  if (Math.random() < 0.5) parts.push(pick(SIGNAL_QUESTIONS[dir]));
  if (hashtags.length) parts.push(hashtags.join(" "));

  return humanizePunctuation(parts.filter(Boolean).join("\n\n"));
}

/**
 * Hashtags chosen in code.
 *
 * Square caps a post at 3. One slot goes to a trending hashtag only when it is
 * actually about this coin, because a hot tag bolted onto an unrelated post brings
 * readers who bounce. The coin tag always goes in. The last slot is a format tag.
 */
const FORMAT_TAGS = {
  EVIDENCE_SIGNAL: "#TradingSignals",
  NO_TRADE_CALL: "#RiskManagement",
  LEVEL_ALERT: "#PriceAction",
  TEACH: "#TradingTips",
  QUICK_TAKE: "#MarketUpdate",
  TRENDING_TOPIC: "#CryptoNews",
  CALL_UPDATE: "#TradingJournal",
};

/** Split a CamelCase hashtag into its words, so "#ZECHitsANewHigh" yields "ZEC". */
export function hashtagTokens(hashtag) {
  return (String(hashtag).replace(/^#/, "").match(/[A-Z0-9]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) || []).map((t) => t.toUpperCase());
}

export function findRelatedHashtag(hotList, symbol) {
  if (!symbol || !hotList?.length) return null;
  const sym = symbol.toUpperCase();
  return hotList.find((h) => h?.hashtag && hashtagTokens(h.hashtag).includes(sym)) || null;
}

function buildHashtags(symbol, formatType, trendingTopic, hotList, tradeSymbol = null) {
  const tags = [];
  if (formatType === "TRENDING_TOPIC" && trendingTopic?.hashtag) {
    tags.push(trendingTopic.hashtag);
  } else {
    const related = findRelatedHashtag(hotList, symbol);
    if (related) tags.push(related.hashtag);
  }
  if (symbol && symbol !== "MARKET") tags.push(`#${symbol}`);
  // The coin in the trade block gets its tag page too.
  if (tradeSymbol && tradeSymbol !== symbol) tags.push(`#${tradeSymbol}`);
  if (FORMAT_TAGS[formatType]) tags.push(FORMAT_TAGS[formatType]);
  return [...new Set(tags)].slice(0, 2);
}

// Lines in the post that ask the reader to open the coin page. Used only when the
// model forgot to include one, so the cashtag still gets a second, intentional click.
const CASHTAG_CTA = [
  (s) => `Tap $${s} and check the hourly chart yourself`,
  (s) => `Do not take my word for it, tap $${s} and look at the candles`,
  (s) => `Open $${s} and set an alert at that level`,
];

/**
 * Turn raw model output into the post that gets published.
 *
 * - strips any hashtags the model wrote, then appends the chosen ones
 * - guarantees the cashtag is in the first line, since that is what shows in the feed
 * - inserts the trade block (levels plus "tap $COIN to trade it"): right after the
 *   reasons in a signal, before the closing question everywhere else
 * - without a trade block, still guarantees a second cashtag mention
 * - adds the data timestamp and track record, which only code can state truthfully
 *
 * No "not financial advice" boilerplate. Square does not require it, readers skip
 * it, and it spent a line of every post telling people not to act. The risk is
 * stated where it is useful instead: the stop and its % on every setup.
 */
export function finalizePost(text, { symbol, formatType, trendingTopic = null, hotList = [], trackRecord = null, tradeBlock = null, tradeSymbol = null, now = Date.now() } = {}) {
  let body = String(text)
    .replace(/^\s*["'`]+|["'`]+\s*$/g, "")
    .replace(/(^|[ \t])#[A-Za-z][A-Za-z0-9_]*/g, "$1")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    // An emoji stranded on its own line reads as a rendering glitch; attach it to
    // the line it was meant to mark.
    .replace(/^((?:\p{Extended_Pictographic}️?\s?){1,2})\n+(?=\S)/gmu, (_, e) => `${e.trim()} `)
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Keep at most 2 line marker emojis. An emoji opening every line is the clearest
  // tell that a post was generated, and it is what the feed buries.
  let emojiCount = 0;
  body = body.replace(/^(\p{Extended_Pictographic}️?)\s*(?=(.*))/gmu, (m, _e, rest) => {
    if (/^(\$\w+\s+)?(buy|short|entry|stop|target|tp\s?\d)/i.test(rest)) return m;
    return ++emojiCount <= 2 ? m : "";
  });

  const hasSymbol = symbol && symbol !== "MARKET";
  if (hasSymbol) {
    const tag = `$${symbol}`;
    const tagRe = new RegExp(`\\$${symbol}\\b`, "gi");
    const bareRe = new RegExp(`(^|[^$A-Za-z0-9])(${symbol})\\b`);

    const lines = body.split("\n");
    if (!lines[0].match(tagRe)) {
      // Upgrade a bare ticker in the hook if there is one, otherwise lead with it.
      // Function replacement, because "$1$1000SATS" would read as back reference $10.
      lines[0] = bareRe.test(lines[0]) ? lines[0].replace(bareRe, (_, pre) => `${pre}${tag}`) : `${tag}: ${lines[0]}`;
    }
    body = lines.join("\n");

    const mentions = (body.match(tagRe) || []).length;
    if (!tradeBlock && mentions < 2 && formatType !== "QUICK_TAKE") {
      const cta = pick(CASHTAG_CTA)(symbol);
      const blocks = body.split("\n\n");
      // Before the closing question, which is conventionally the last block.
      blocks.splice(Math.max(1, blocks.length - 1), 0, cta);
      body = blocks.join("\n\n");
    }
  }

  if (tradeBlock) {
    // Model written "tap" lines would compete with the real call to action.
    body = body
      .split("\n")
      .filter((l) => !/^\W*(tap|open|click)\s+\$[A-Za-z0-9]+/i.test(l))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
    // The closing question always stays last, even when the model ran it into the
    // previous block.
    const lines = body.split("\n");
    let question = null;
    if (lines.length > 1 && /\?\s*(\p{Extended_Pictographic}️?)?\s*$/u.test(lines[lines.length - 1])) {
      question = lines.pop();
      body = lines.join("\n").trim();
    }
    const blocks = body.split("\n\n");
    // A signal is hook, reasons, levels, then invalidation, so the reader reaches the
    // levels within the first few lines. Anything else gets its trade at the end.
    const at = formatType === "EVIDENCE_SIGNAL" ? Math.min(2, blocks.length) : blocks.length;
    blocks.splice(at, 0, tradeBlock);
    if (question) blocks.push(question);
    body = blocks.join("\n\n");
  }

  // The track record, on about half the posts that can carry one. Every time is a
  // signature, and a signature is what makes a feed look automated.
  const footer = [];
  if (trackRecord && ["EVIDENCE_SIGNAL", "NO_TRADE_CALL"].includes(formatType) && Math.random() < 0.5) {
    footer.push(`Last ${trackRecord.days} days of my calls, ${trackRecord.wins} hit target and ${trackRecord.stopped} hit stop`);
  }

  // No data timestamp any more. It was on every post, in the same place, in the same
  // words, which is exactly the pattern to avoid.
  const tags = buildHashtags(symbol, formatType, trendingTopic, hotList, tradeBlock ? tradeSymbol : null);
  return humanizePunctuation([body, footer.join("\n"), tags.join(" ")].filter(Boolean).join("\n\n"));
}

// Shortest believable post per format. Anything shorter was cut off or refused.
const MIN_CHARS = {
  // The model writes only the hook, reasons, risk and question; levels are code.
  EVIDENCE_SIGNAL: 150,
  NO_TRADE_CALL: 220,
  TEACH: 220,
  TRENDING_TOPIC: 180,
  LEVEL_ALERT: 110,
  QUICK_TAKE: 60,
};

/**
 * Reject output that would embarrass the account: a post cut off mid sentence, a
 * copied instruction label ("THE LEVEL: $0.002448" went out like that), or an
 * assistant preamble. Returns a list of problems, empty when the post is fine.
 */
export function lintPost(text, formatType) {
  const problems = [];
  const raw = String(text || "");
  const body = raw.replace(/(^|\s)#[A-Za-z][A-Za-z0-9_]*/g, "$1").trim();

  if (/^\s*(line\s*\d+|first line|hook|structure|flow|then|the level|the angle|verified market data|market data|output|post)\s*:/im.test(raw)) {
    problems.push("it copied an instruction label into the post");
  }
  if (/\b(here is (the|your) post|here's (the|your) post|as an ai|i cannot help)\b/i.test(raw)) {
    problems.push("it contains an assistant preamble");
  }
  const min = MIN_CHARS[formatType] ?? 150;
  if (body.length < min) {
    problems.push(`it is only ${body.length} characters, which reads as cut off`);
  }
  // Posts are written without a full stop at the end of a line now, so the old
  // "must end in punctuation" check flagged every good draft. A genuinely cut off
  // post ends on a comma or on a word that cannot end a sentence.
  if (/,$/.test(body) || /\b(and|or|but|the|a|an|at|to|of|with|from|for|into|than|because|while|so that|which)$/i.test(body)) {
    problems.push("it ends mid sentence");
  }
  return problems;
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
 * Check every percentage claim against the ones the data actually supports.
 *
 * Prices were already checked; percentages were not, and a model will happily write
 * "sitting 15 percent below that level" when the real distance is 2. A reader who
 * checks one wrong number stops believing the rest, so an unsupported percentage
 * fails the draft the same way an invented price does.
 */
export function validatePostPercents(text, ctx, levels) {
  if (!ctx) return { ok: true, offenders: [] };

  const pctFromPrice = (v) => (Number.isFinite(v) && ctx.price ? Math.abs(((v - ctx.price) / ctx.price) * 100) : null);
  const allowed = [
    Math.abs(ctx.changePct),
    Math.abs(ctx.pctFrom7dHigh),
    Math.abs(ctx.pctFrom7dLow),
    ctx.rangePos,
    100 - ctx.rangePos,
    ctx.atrPct,
    ctx.rsi1h,
    ctx.volRatio,
    // "2.8x average" is also legitimately written as 280 percent of average, or as
    // 180 percent more than average. Allowing both saves a pointless retry.
    ctx.volRatio * 100,
    (ctx.volRatio - 1) * 100,
    levels?.riskPct,
    // How far price sits from every level a post is allowed to mention.
    ...[
      ctx.swingHigh1h, ctx.swingLow1h, ctx.swingHigh15m, ctx.swingLow15m,
      ctx.rangeHigh, ctx.rangeLow, ctx.high7d, ctx.low7d,
      levels?.stop, levels?.entryLow, levels?.entryHigh, ...(levels?.targets || []),
    ].map(pctFromPrice),
    // Round rhetorical figures a lesson legitimately uses ("risk 1% of the account").
    1, 2, 3, 5, 10, 50, 100,
  ].filter((n) => typeof n === "number" && Number.isFinite(n));

  const offenders = [];
  for (const m of String(text).matchAll(/(\d+(?:\.\d+)?)\s*(?:%|percent)/gi)) {
    const value = parseFloat(m[1]);
    if (!Number.isFinite(value)) continue;
    // Tolerate rounding: 0.6 points, or 5% of the figure for the big ones.
    if (allowed.some((a) => Math.abs(value - a) <= Math.max(0.6, Math.abs(a) * 0.05))) continue;
    offenders.push(m[0].trim());
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
 * The whole answer from a Gemini candidate. The model can split its reply across
 * several parts; reading only the first one is how "Look at $LITEB trading at
 * $967.5" went out as if it were a complete post.
 */
function geminiText(candidate) {
  return (candidate?.content?.parts || [])
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("")
    .trim();
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
          // Say which kind of 429 this is. A per day quota means that model is done
          // until Google's reset and no amount of retrying helps; a per minute one
          // clears on its own. Both are handled the same way here (move to the next
          // model, whose quota is counted separately) but the log should not make a
          // daily cap look like a transient blip.
          let detail = "";
          if (res.status === 429) {
            const limit = errText.match(/limit:\s*(\d+)/)?.[1];
            const perDay = /PerDay|RequestsPerDay/i.test(errText);
            detail = perDay
              ? ` (daily free tier quota${limit ? ` of ${limit}` : ""} exhausted for this model until Google's reset)`
              : ` (rate limited, this one clears on its own)`;
          }
          console.warn(`[gemini] Model '${model}' returned ${res.status}${detail}, trying next fallback...`);
          lastError = new Error(`Gemini API Error ${res.status} (${model}): ${errText.slice(0, 200)}`);
          continue;
        }
        throw new Error(`Gemini API Error ${res.status} (${model}): ${errText}`);
      }

      const json = await res.json();
      const candidate = json?.candidates?.[0];
      const text = geminiText(candidate);

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
      const text = geminiText(json?.candidates?.[0]);
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
      // Skip previews, experimental builds and everything that is not a text model.
      // The list is full of image, speech, music and research variants that either
      // reject a plain text prompt or behave oddly mid run.
      .filter(
        (n) =>
          !/(preview|exp|thinking|image|audio|tts|embedding|vision|transcribe|robotics|computer-use|lyria|banana|deep-research|antigravity|omni)/i.test(n)
      );

    // Prefer lite over flagship. Counterintuitive for quality, but the flagship
    // flash models are capped at 20 requests a day on the free tier and burn ~2000
    // tokens per call on internal thinking, while lite has real headroom and
    // thoughts=0. A post that ships beats a better post that hits a quota wall.
    const score = (n) => {
      const v = parseFloat((n.match(/(\d+\.?\d*)/) || [])[1] || "0");
      let s = v;
      if (/flash/i.test(n)) s += 1000;
      if (/lite/i.test(n)) s += 2000;
      if (/^gemma/i.test(n)) s -= 500; // works, but verbose and off style for this
      return s;
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
 * Generate one post: grade decides the format, the model writes it from measured
 * numbers, code checks it and adds the parts only code can state truthfully.
 */
export async function generateTraderPost(coin, allMovers, options = {}) {
  // The chart decides the format, not a dice roll. A weak chart produces a public
  // pass, and only a genuinely strong one produces a signal with levels.
  const ctx = options.marketContext !== undefined ? options.marketContext : await buildMarketContext(coin);
  const grade = options.grade || gradeSetup(ctx);
  grade.ctx = ctx;

  // The scheduler decides which slots are signals (see SIGNAL_SHARE) and passes
  // format: "EVIDENCE_SIGNAL" for those, noSignal for the rest. Without a scheduler
  // (the worker, the test harness), a tradable chart is a signal half the time.
  let weightedFormats;
  if (grade.verdict === "TRADE" || grade.verdict === "WATCH") {
    weightedFormats = ["LEVEL_ALERT", "LEVEL_ALERT", "TEACH", "TRENDING_TOPIC", "QUICK_TAKE"];
    if (!options.noSignal) weightedFormats.push(...Array(weightedFormats.length).fill("EVIDENCE_SIGNAL"));
  } else {
    // Nothing tradable here. Teach, talk trends, or name the level to watch; the odd
    // public pass keeps the signals believable. Never manufacture a setup.
    weightedFormats = ["NO_TRADE_CALL", "TEACH", "TEACH", "TRENDING_TOPIC", "TRENDING_TOPIC", "LEVEL_ALERT"];
  }

  let formatType = options.format || weightedFormats[Math.floor(Math.random() * weightedFormats.length)];

  if (formatType === "EVIDENCE_SIGNAL" && grade.levels?.stop) {
    return generateSignalPost(coin, ctx, grade, options);
  }

  // A signal without usable levels is not a signal. This fires when a NO_TRADE chart
  // is asked for EVIDENCE_SIGNAL, including via the test harness, so say so out loud
  // rather than silently writing a different kind of post.
  if (formatType === "EVIDENCE_SIGNAL" && !grade.levels?.stop) {
    console.log(`[ai] ${grade.verdict} chart has no tradeable levels, writing TEACH instead of EVIDENCE_SIGNAL.`);
    formatType = "TEACH";
  }

  let hotList = options.hotList || null;
  let trendingTopic = options.trendingTopic || null;

  if (formatType === "TRENDING_TOPIC" && !trendingTopic) {
    try {
      hotList = hotList || (await getHotTrendingHashtags(3));
      if (hotList && hotList.length > 0) {
        trendingTopic = hotList[Math.floor(Math.random() * hotList.length)];
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

  // A trending topic post only earns a cashtag when the topic names a real, listed
  // coin. That coin, not the one the scheduler picked, is who the post is about.
  let topicCoin = null;
  if (formatType === "TRENDING_TOPIC") {
    const pairs = options.allPairs || allMovers || [];
    const tokens = hashtagTokens(trendingTopic.hashtag);
    topicCoin = pairs.find((p) => tokens.includes(p.baseAsset)) || null;
    console.log(`[hot-list] 🔥 Topic ${trendingTopic.hashtag}${topicCoin ? `, linked coin $${topicCoin.baseAsset}` : ", no listed coin in it"}`);

    // A topic with no coin in it can still pull hashtag page views, but it carries no
    // cashtag at all, so nothing in it can be clicked through to a coin. Keep those to
    // roughly a third of topic posts and write about the chart the rest of the time.
    // With a tradable alternative the post still ends on a trade, so keep it.
    if (!topicCoin && !options.altSetup && !options.format && Math.random() < 0.67) {
      formatType = grade.verdict === "NO_TRADE" ? "NO_TRADE_CALL" : "LEVEL_ALERT";
      trendingTopic = options.trendingTopic || null;
      console.log(`[hot-list] Topic has no coin to tag, writing ${formatType} on $${coin?.baseAsset} instead.`);
    }
  }

  const postSymbol = formatType === "TRENDING_TOPIC" ? topicCoin?.baseAsset || null : coin?.baseAsset;
  const targetName = formatType === "TRENDING_TOPIC" ? trendingTopic.hashtag : `$${coin?.baseAsset || "MARKET"}`;
  console.log(`[ai] Format [${formatType}] for ${targetName} (verdict: ${grade.verdict}, score: ${grade.score})`);

  const prompt = buildMultiFormatPrompt(coin, formatType, allMovers, trendingTopic, grade, {
    topicCoin,
  });

  // Numbers are checked against whichever coin the post is actually about.
  const checkCtx =
    formatType === "TRENDING_TOPIC"
      ? topicCoin
        ? {
            price: topicCoin.lastPrice,
            rangeLow: topicCoin.lowPrice,
            rangeHigh: topicCoin.highPrice,
            low7d: topicCoin.lowPrice,
            high7d: topicCoin.highPrice,
          }
        : null
      : ctx;
  const checkLevels = formatType === "TRENDING_TOPIC" ? null : grade.levels;

  const runModel = makeModelRunner(options);

  const review = (t) => ({
    problems: lintPost(t, formatType),
    numbers: validatePostNumbers(t, checkCtx, checkLevels),
    percents: validatePostPercents(t, checkCtx, checkLevels),
  });

  let text = await runModel(prompt);
  let result = review(text);

  // One retry, naming exactly what was wrong. Invented prices, a cut off post and a
  // copied instruction label are each the kind of thing a reader notices once and
  // then discounts the account for.
  if (result.problems.length || !result.numbers.ok || !result.percents.ok) {
    const issues = [
      ...result.problems,
      ...(result.numbers.ok ? [] : [`it used price levels that are not in the data: ${result.numbers.offenders.join(", ")}`]),
      ...(result.percents.ok ? [] : [`it used percentages the data does not support: ${result.percents.offenders.join(", ")}`]),
    ];
    console.warn(`[review] ⚠️ Rejected first draft: ${issues.join("; ")}. Retrying once.`);
    const retryPrompt = `${prompt}

RETRY. Your previous attempt was rejected because ${issues.join("; ")}. Write the complete post again from scratch, following every rule, using only the numbers given above.`;
    const retryText = await runModel(retryPrompt);
    const retry = review(retryText);

    const score = (r) => r.problems.length * 10 + r.numbers.offenders.length + r.percents.offenders.length;
    if (score(retry) <= score(result)) {
      text = retryText;
      result = retry;
    }
  }

  // Structural problems are not publishable at all. Invented numbers that survived a
  // retry are logged loudly; the in range check already filtered anything absurd.
  if (result.problems.length) {
    throw new Error(`Post failed review twice (${result.problems.join("; ")}). Not publishing it.`);
  }
  if (!result.numbers.ok) {
    console.warn(`[review] ❌ Post still references levels not in the data: ${result.numbers.offenders.join(", ")}`);
  }
  // A wrong percentage is the easiest thing in a post for a reader to check, and
  // "sitting 15 percent below that level" when it is 2 costs more than a skipped slot.
  if (!result.percents.ok) {
    throw new Error(`Post claims percentages the data does not support twice (${result.percents.offenders.join(", ")}). Not publishing it.`);
  }

  const finalText = finalizePost(text, {
    symbol: postSymbol,
    formatType,
    trendingTopic,
    hotList: hotList || [],
  });

  const out = new String(finalText);
  out.text = finalText;
  out.formatType = formatType;
  out.primarySymbol = postSymbol;
  out.hashtag = trendingTopic?.hashtag || null;
  out.grade = grade;
  out.verdict = grade.verdict;
  // Only signals publish levels, so only signals are logged as calls.
  out.levels = null;
  return out;
}

/**
 * A trade signal. The model writes the headline and the reasons in plain words;
 * everything else is assembled in code. If the model is unavailable or its answer
 * is the wrong shape twice, the post goes out with the plain reasons from code, so
 * a signal slot is never lost to an LLM hiccup.
 */
async function generateSignalPost(coin, ctx, grade, options) {
  const symbol = coin.baseAsset;
  const direction = grade.direction === "SHORT" ? "SHORT" : "LONG";
  console.log(`[ai] Format [EVIDENCE_SIGNAL] ${direction} for $${symbol} (verdict: ${grade.verdict}, score: ${grade.score})`);

  const reasons = plainReasons(ctx, direction);
  const prompt = buildMultiFormatPrompt(coin, "EVIDENCE_SIGNAL", [], null, grade, { reasons });
  const runModel = makeModelRunner(options);

  let intro = null;
  for (let attempt = 0; attempt < 2 && !intro; attempt++) {
    try {
      const text = await runModel(
        attempt === 0
          ? prompt
          : `${prompt}\n\nRETRY. Your last answer had the wrong shape or used a number that is not in the data. One headline line, then 2 or 3 plain lines, no bullets.`
      );
      const parsed = parseSignalIntro(text, symbol);
      const numbers = validatePostNumbers(text, ctx, grade.levels);
      const percents = validatePostPercents(text, ctx, grade.levels);
      if (parsed && numbers.ok && percents.ok) intro = parsed;
      else {
        const why = !parsed
          ? "wrong shape"
          : !numbers.ok
            ? `invented levels ${numbers.offenders.join(", ")}`
            : `unsupported percentages ${percents.offenders.join(", ")}`;
        console.warn(`[review] ⚠️ Signal intro rejected (${why}).`);
      }
    } catch (err) {
      console.warn(`[ai] Signal intro failed: ${err.message.slice(0, 160)}`);
      break;
    }
  }
  if (!intro) {
    console.log(`[ai] Using the plain reasons from code for this signal.`);
    intro = { headline: null, reasons: reasons.length >= 2 ? reasons : [...reasons, ...(grade.reasons || [])].slice(0, 2) };
  }

  const text = buildSignalPost({
    symbol,
    direction,
    intro,
    levels: grade.levels,
    price: ctx?.price ?? coin.lastPrice,
    trackRecord: options.trackRecord || null,
    hashtags: buildHashtags(symbol, "EVIDENCE_SIGNAL", null, options.hotList || []),
  });

  const out = new String(text);
  out.text = text;
  out.formatType = "EVIDENCE_SIGNAL";
  out.primarySymbol = symbol;
  out.hashtag = null;
  out.grade = grade;
  out.verdict = grade.verdict;
  out.direction = direction;
  out.levels = grade.levels;
  out.callCoin = coin;
  out.callGrade = grade;
  return out;
}

/** Call the configured LLM, falling back to the other provider if it has a key. */
function makeModelRunner(options) {
  const rawProvider = String(options.provider || "").trim().toLowerCase();
  const isGemini = rawProvider === "1" || rawProvider === "gemini";
  const isOpenRouter = rawProvider === "openrouter" || rawProvider === "2" || (!isGemini && options.openrouterKey);
  const primary = isOpenRouter ? "openrouter" : "gemini";
  const order = primary === "openrouter" ? ["openrouter", "gemini"] : ["gemini", "openrouter"];

  return async (p) => {
    let lastErr;
    for (const provider of order) {
      const key = provider === "openrouter" ? options.openrouterKey : options.geminiKey;
      if (!key) continue;
      try {
        // LLM_MODEL names a model on the PRIMARY provider only.
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
}

/**
 * Clean text for Square without changing what it says.
 *
 * Exported separately so it can be checked without publishing anything.
 */
export function sanitizeForSquare(rawText, { primarySymbol = null } = {}) {
  // 1. Cashtags. Square links at most 2 distinct coins per post, so keep the coin
  //    the post is about plus the first other one, and drop the `$` from the rest.
  //
  //    A cashtag must contain a letter. Without that rule every price counted as a
  //    coin: in "$FF ... entry $0.41 ... TP $0.45" the prices used up both slots and
  //    later mentions of $FF lost their link, and the prices lost their dollar sign.
  const keep = new Set(primarySymbol ? [primarySymbol.toUpperCase()] : []);
  let sanitized = String(rawText).replace(/\$([A-Za-z0-9]{1,15})\b/g, (match, symbol) => {
    if (!/[A-Za-z]/.test(symbol)) return match; // a price
    if (/^\d+(\.\d+)?[KMBT]$/i.test(symbol)) return match; // $15M volume
    const up = symbol.toUpperCase();
    if (keep.has(up)) return `$${up}`;
    if (keep.size < 2) {
      keep.add(up);
      return `$${up}`;
    }
    return up;
  });

  // 2. Hashtags: max 3 per post.
  let hashtagCount = 0;
  sanitized = sanitized.replace(/#([A-Za-z][A-Za-z0-9_]*)/g, (match) => {
    hashtagCount++;
    return hashtagCount <= 3 ? match : "";
  });

  // 3. Strip outcome promises. The prompts forbid these, but a single "guaranteed
  //    100x" undoes weeks of credibility, so there is a net under the net.
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

  // 4. Dashes out, line structure kept. Level blocks stay one per line.
  return sanitized
    .replace(/--+/g, " ")
    .replace(/\s[—–]\s/g, ". ")
    .replace(/[—–]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ +\n/g, "\n")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/**
 * Publish a text post to Binance Square.
 *
 * @param {string|object} content Post text, or the object from generateTraderPost
 * @param {string} apiKey Binance Square OpenAPI key
 * @param {object} [options] { primarySymbol }
 * @returns {Promise<{postId: string|null, shareLink: string|null, raw: object}>}
 */
export async function publishToSquare(content, apiKey, options = {}) {
  console.log("[publish] Publishing post to Binance Square...");

  const rawText = typeof content === "object" && content.text ? content.text : String(content);
  const primarySymbol = options.primarySymbol || (typeof content === "object" ? content.primarySymbol : null);
  const text = sanitizeForSquare(rawText, { primarySymbol });

  const res = await fetch(BINANCE_SQUARE_PUBLISH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Square-OpenAPI-Key": apiKey,
      clienttype: "binanceSkill",
    },
    body: JSON.stringify({ contentType: 1, bodyTextOnly: text }),
  });

  // Binance's own client treats a 504 from this endpoint as published without an id.
  // Throwing here would fail the cycle, skip recording the post, and let the next run
  // publish a near duplicate.
  if (res.status === 504) {
    console.warn("[publish] ⚠️ Gateway timeout. Binance treats this as published, recording it without a post id.");
    return { postId: null, shareLink: null, raw: null };
  }

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

  const postId = json?.data?.id ? String(json.data.id) : null;
  const shareLink = json?.data?.shareLink || (postId ? `https://www.binance.com/square/post/${postId}` : null);
  console.log(`[publish] ✅ Published to Binance Square${shareLink ? `: ${shareLink}` : "."}`);
  return { postId, shareLink, raw: json };
}

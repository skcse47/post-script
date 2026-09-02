/**
 * Binance Top Movers (Gainers & Losers) Technical Analysis & Signal Generator
 * 
 * Fetches real-time 24h ticker data from Binance public API, filters USDT pairs,
 * creates a balanced rotation queue of Top 5 Gainers and Top 5 Losers,
 * and uses OpenRouter or Gemini to generate authentic trader setups (Long/Short/Scalp/Dip-Buy)
 * with dynamic catchy opening hooks, explicit dollar price levels, and clickable coin cashtags ($BTC, $SOL, etc.).
 */

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

// Candidate models for Gemini fallback
const GEMINI_CANDIDATE_MODELS = [
  "gemini-2.0-flash",
  "gemini-2.5-flash",
  "gemini-1.5-flash-latest",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
  "gemini-pro"
];

// High-liquidity & most searched coins on Binance Square
const POPULAR_WATCHLIST = [
  "BTC", "ETH", "SOL", "BNB", "DOGE", "XRP", "PEPE", "SUI",
  "NEAR", "AVAX", "LINK", "SHIB", "FET", "APT", "RENDER",
  "INJ", "WIF", "ADA", "TIA", "ARB", "OP", "DOT", "LTC",
  "GALA", "SEI", "FLOKI", "BONK", "TON", "FTM", "JASMY", "ENA", "PENDLE"
];

// Blacklist stablecoin pairs & leveraged tokens
const EXCLUDED_SYMBOLS = new Set([
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
  if (num >= 1) return num.toFixed(3);
  if (num >= 0.01) return num.toFixed(4);
  if (num >= 0.0001) return num.toFixed(6);
  return num.toFixed(8);
}

/**
 * Fetch top technical setups from popular liquid coins + trending market movers.
 * @param {number} count Number of coins to return in the queue
 * @param {number} minVolumeUSDT Minimum 24h volume
 * @returns {Promise<{gainers: Array<object>, losers: Array<object>, queue: Array<object>}>}
 */
export async function getMarketMovers(count = 10, minVolumeUSDT = 1_000_000) {
  console.log("[market] Scanning top liquid coins & technical setups...");
  
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

  const tickerMap = new Map();
  for (const t of tickers) {
    if (t.symbol && t.symbol.endsWith("USDT")) {
      tickerMap.set(t.symbol, t);
    }
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
      return quoteVol >= minVolumeUSDT;
    })
    .map((t) => {
      const lastPrice = parseFloat(t.lastPrice);
      let priceChangePercent = parseFloat(t.priceChangePercent);
      if (Math.abs(priceChangePercent) > 0 && Math.abs(priceChangePercent) <= 1.5) {
        priceChangePercent = priceChangePercent * 100;
      }
      const highPrice = parseFloat(t.highPrice);
      const lowPrice = parseFloat(t.lowPrice);
      const quoteVolume = parseFloat(t.quoteVolume);
      const baseAsset = t.symbol.replace("USDT", "");
      
      // Calculate technical range position (0% = at 24h low, 100% = at 24h high)
      const range = highPrice - lowPrice;
      const rangePosition = range > 0 ? ((lastPrice - lowPrice) / range) * 100 : 50;

      // Classify technical trade archetype
      let setupType = "TREND_PULLBACK_LONG";
      let direction = "LONG";
      if (rangePosition >= 80 && priceChangePercent > 3) {
        setupType = "24H_BREAKOUT_MOMENTUM";
        direction = "LONG";
      } else if (rangePosition <= 25 && priceChangePercent < -3) {
        setupType = "OVERSOLD_SUPPORT_BOUNCE";
        direction = "DIP_BUY";
      } else if (priceChangePercent < -10) {
        setupType = "BEARISH_BREAKDOWN_CONTINUATION";
        direction = "SHORT";
      } else if (rangePosition >= 50) {
        setupType = "BULL_FLAG_CONTINUATION";
        direction = "LONG";
      } else {
        setupType = "KEY_SUPPORT_RECLAIM";
        direction = "LONG";
      }

      const isPopular = POPULAR_WATCHLIST.includes(baseAsset);

      return {
        symbol: t.symbol,
        baseAsset,
        lastPrice,
        priceChangePercent,
        highPrice,
        lowPrice,
        quoteVolume,
        rangePosition,
        setupType,
        defaultDirection: direction,
        isPopular,
        category: direction === "SHORT" ? "loser" : "gainer",
      };
    });

  // Prioritize top popular high-liquidity coins first, followed by biggest volume momentum
  const popularSetups = validPairs
    .filter((p) => p.isPopular)
    .sort((a, b) => b.quoteVolume - a.quoteVolume);

  const breakoutSetups = validPairs
    .filter((p) => !p.isPopular && (p.setupType === "24H_BREAKOUT_MOMENTUM" || p.setupType === "OVERSOLD_SUPPORT_BOUNCE"))
    .sort((a, b) => b.quoteVolume - a.quoteVolume);

  // Combine to create an elite 10-coin technical rotation queue
  const combined = [...popularSetups.slice(0, 7), ...breakoutSetups.slice(0, 3)];
  const queue = combined.length >= count ? combined.slice(0, count) : validPairs.slice(0, count);

  const gainers = queue.filter(q => q.defaultDirection !== "SHORT");
  const losers = queue.filter(q => q.defaultDirection === "SHORT");

  return { gainers, losers, queue };
}

/**
 * Backward compatible getTopGainers helper
 */
export async function getTopGainers(limit = 10, minVolumeUSDT = 500000) {
  const movers = await getMarketMovers(limit, minVolumeUSDT);
  return movers.queue;
}

/**
 * Build multi-format prompts based on content archetype:
 * 1. TRADE_SIGNAL: Detailed TA with visual ASCII level map
 * 2. INTERACTIVE_POLL: Voting & opinion debate to maximize comments
 * 3. MARKET_NEWS_NARRATIVE: Macro & sector rotation breakdown
 * 4. TRADER_MEME_PSYCHOLOGY: Viral humor & trader psychology
 * 5. EDUCATIONAL_ALPHA: Actionable trading guides & pro tips
 */
function buildMultiFormatPrompt(coin, formatType = "TRADE_SIGNAL") {
  const currentPrice = coin.lastPrice;
  const changePct = coin.priceChangePercent;
  const symbol = coin.baseAsset;
  const high24h = coin.highPrice;
  const low24h = coin.lowPrice;
  const isShort = coin.defaultDirection === "SHORT";
  const isDipBuy = coin.defaultDirection === "DIP_BUY";

  const entryPoint = formatPrice(currentPrice);
  const entryLow = formatPrice(currentPrice * 0.994);
  const entryHigh = formatPrice(currentPrice * 1.006);
  const slPrice = isShort ? formatPrice(currentPrice * 1.035) : formatPrice(currentPrice * 0.965);
  const tp1Price = isShort ? formatPrice(currentPrice * 0.955) : formatPrice(currentPrice * 1.055);
  const tp2Price = isShort ? formatPrice(currentPrice * 0.908) : formatPrice(currentPrice * 1.112);
  const riskPct = "3.2%";
  const rrRatio = "1:3.2";

  if (formatType === "INTERACTIVE_POLL") {
    return `You are a popular crypto creator on Binance Square creating an interactive community POLL/DEBATE to drive hundreds of comments.

COIN INFO:
- Coin: $${symbol}
- Current Price: $${entryPoint}
- 24h Trend: ${changePct > 0 ? "+" : ""}${changePct.toFixed(2)}%

STRUCTURE:
🔥 COMMUNITY POLL: Where is $${symbol} heading next? 🗳️

[2 concise sentences on current price action and the big debate between bulls and bears around $${entryPoint}]

Cast your vote below:
🅰️ Option A: [Bullish target / breakout level e.g. Rally to $${tp2Price}] 🚀
🅱️ Option B: [Bearish pullback / support retest e.g. Drop to $${slPrice}] 🩸
🅲 Option C: [Sideways consolidation / chop around $${entryPoint}] 🦀

👇 Drop your vote (A, B, or C) and your reasoning in the comments! Top comments get pinned! 📌

#${symbol} #BinanceSquare #CryptoPoll #TradingCommunity

CRITICAL RULES:
1. Strict focus on driving users to reply with A, B, or C in the comments.
2. Must contain clickable cashtag $${symbol} and relevant hashtags.
3. Output ONLY the raw post text ready to publish.`;
  }

  if (formatType === "MARKET_NEWS_NARRATIVE") {
    return `You are a top Web3 & Crypto market analyst posting an insightful market breakdown & narrative update on Binance Square.

CONTEXT:
- Featured Coin: $${symbol} at $${entryPoint} (${changePct > 0 ? "+" : ""}${changePct.toFixed(2)}% 24h)
- 24h High: $${formatPrice(high24h)} | 24h Low: $${formatPrice(low24h)}

STRUCTURE:
⚡ MARKET NARRATIVE UPDATE: $${symbol} Key Developments & Momentum 📊

[3-4 punchy bullet points analyzing current sector rotation, on-chain/volume momentum, and key macro drivers behind $${symbol}'s recent price action around $${entryPoint}]

🔑 Key Levels to Watch:
• Major Resistance: $${tp1Price} - $${tp2Price}
• Critical Support: $${slPrice}

💡 Analyst Perspective: [1 strong forward-looking sentence on risk and strategy]

👇 Are you accumulating or taking profits on $${symbol}? Share your strategy below!

#${symbol} #CryptoNews #MarketUpdate #BinanceSquare

CRITICAL RULES:
1. Make it informative, analytical, and high-value.
2. Must include clickable cashtag $${symbol} and hashtags.
3. Output ONLY the raw post text ready to publish.`;
  }

  if (formatType === "TRADER_MEME_PSYCHOLOGY") {
    return `You are a funny, relatable crypto trader posting a viral trading meme / psychology post on Binance Square.

CONTEXT:
- Coin: $${symbol}
- Price: $${entryPoint}

STRUCTURE:
😂 The 4 Stages of Trading $${symbol} (Every Trader Knows This Pain):

1️⃣ "I'll wait for the dip to buy." (Price skyrockets 🚀)
2️⃣ "Okay, I FOMO'd in at $${entryPoint}." (Price immediately dumps 📉)
3️⃣ "Just holding for the tech now..." (Staring at the 1-minute chart at 3 AM 💀)
4️⃣ "It pumped 2% back to breakeven!" (Celebrates like won the lottery 🥳)

Drop a '💯' if you have been personally attacked by this cycle! What's your craziest trade on $${symbol}?

#${symbol} #CryptoMeme #TraderLife #BinanceSquare

CRITICAL RULES:
1. Extremely relatable, humorous, and engaging.
2. Prompts easy engagement (e.g. drop 💯 or share a story).
3. Output ONLY the raw post text ready to publish.`;
  }

  if (formatType === "EDUCATIONAL_ALPHA") {
    return `You are a pro crypto trading mentor posting an actionable educational trading tip / alpha on Binance Square.

CONTEXT:
- Coin example: $${symbol} around $${entryPoint}

STRUCTURE:
🎓 PRO TRADING TIP: How to Spot Liquidity Sweeps vs Fakeouts on $${symbol} 🧠

[3 punchy steps explaining a vital technical concept: e.g., how institutions hunt stop losses below $${slPrice} before reversing towards $${tp1Price}, volume confirmation, and candle close rules]

📌 Golden Rule: Never chase the initial breakout candle. Wait for the retest and volume confirmation to protect your capital.

👇 Did you know this rule? What's the #1 trading lesson you learned the hard way? Let's hear it below!

#${symbol} #CryptoEducation #TradingTips #BinanceSquare

CRITICAL RULES:
1. Provide real actionable value that traders will bookmark and like.
2. Keep it crisp and easy to digest with bullet points.
3. Output ONLY the raw post text ready to publish.`;
  }

  // DEFAULT: TRADE_SIGNAL with ASCII Visual Level Map
  return `You are a seasoned crypto technical analyst posting a high-probability live trade setup on Binance Square.

DATA & TECHNICAL CONTEXT:
- Coin: $${symbol}
- Current Price: $${entryPoint}
- 24h High: $${formatPrice(high24h)} | 24h Low: $${formatPrice(low24h)}
- 24h Change: ${changePct > 0 ? "+" : ""}${changePct.toFixed(2)}%
- Direction: ${isShort ? "SHORT" : "LONG"}
- Entry Zone: $${entryLow} - $${entryHigh}
- Stop Loss (SL): $${slPrice} (${riskPct} risk)
- Take Profit 1 (TP1): $${tp1Price}
- Take Profit 2 (TP2): $${tp2Price}
- Risk-to-Reward: ${rrRatio}

POST FORMATTING TEMPLATE (INCLUDE THE VISUAL LEVEL MAP):

🚨 $${symbol} / USDT: High RR ${isShort ? "Short" : "Long"} Setup Developing! 📈

[2-3 sentences of authentic technical chart rationale: market structure, volume expansion, liquidity sweep, or key support/resistance reaction]

📊 Visual Level Map:
[Target 2] ──────── $${tp2Price} 🎯 TP2 (${isShort ? "Extension Low" : "Range High"})
[Target 1] ──────── $${tp1Price} 🎯 TP1 (Local Resistance)
[Entry Area] ────── $${entryPoint} 📍 Current Market Price
[Invalidation] ──── $${slPrice} 🛡️ SL (${riskPct} Risk)

🎯 Trade Parameters:
• Entry Zone: $${entryLow} - $${entryHigh}
• Invalidation (SL): $${slPrice} (${riskPct} risk)
• Target 1: $${tp1Price}
• Target 2: $${tp2Price}
📊 Risk-to-Reward: ${rrRatio}

💡 Trade Plan: Lock partials at TP1 and trail stop to entry to keep trade risk-free. Never overleverage.

👇 What's your target for $${symbol} this week? Drop your prediction in the comments!

#${symbol} #CryptoTrading #BinanceSquare #TechnicalAnalysis

CRITICAL INSTRUCTIONS:
1. Always include the exact dollar prices and the formatted Visual Level Map.
2. Make sure to include the clickable cashtag $${symbol} and ending hashtag #${symbol}.
3. Output ONLY the raw post text ready to publish.`;
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
    temperature: 0.9,
    max_tokens: 1500,
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
  const text = json?.choices?.[0]?.message?.content?.trim();

  if (!text) {
    throw new Error(`OpenRouter returned empty response: ${JSON.stringify(json)}`);
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
      maxOutputTokens: 2048,
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
        if (res.status === 404) {
          console.warn(`[gemini] Model '${model}' returned 404, trying next fallback...`);
          lastError = new Error(`Gemini API Error 404 (${model}): ${errText}`);
          continue;
        }
        throw new Error(`Gemini API Error ${res.status} (${model}): ${errText}`);
      }

      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

      if (text) {
        console.log(`[gemini] ✅ Successfully generated post using model: ${model}`);
        return text;
      }
    } catch (err) {
      if (err.message.includes("404")) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error("All Gemini candidate models failed.");
}

/**
 * Universal Post Generator supporting Gemini or OpenRouter with dynamic format selection
 */
export async function generateTraderPost(coin, allMovers, options = {}) {
  // Content format rotation (Signals, Polls, News, Memes, Educational)
  const availableFormats = [
    "TRADE_SIGNAL",
    "TRADE_SIGNAL",
    "INTERACTIVE_POLL",
    "MARKET_NEWS_NARRATIVE",
    "TRADER_MEME_PSYCHOLOGY",
    "EDUCATIONAL_ALPHA"
  ];

  // Pick format based on option override or random weighted selection
  const formatType = options.format || availableFormats[Math.floor(Math.random() * availableFormats.length)];
  console.log(`[ai] Generating post content with format: [${formatType}] for $${coin.baseAsset}`);

  const prompt = buildMultiFormatPrompt(coin, formatType);
  
  const rawProvider = String(options.provider || "").trim().toLowerCase();
  const isGemini = rawProvider === "1" || rawProvider === "gemini";
  const isOpenRouter = rawProvider === "openrouter" || rawProvider === "2" || (!isGemini && options.openrouterKey);

  if (isOpenRouter) {
    const key = options.openrouterKey || options.geminiKey;
    if (!key) {
      throw new Error("OPENROUTER_API_KEY is missing in .env");
    }
    const model = options.model || "qwen/qwen-2.5-7b-instruct";
    return await generateWithOpenRouter(prompt, key, model);
  }

  const key = options.geminiKey || options.openrouterKey;
  if (!key) {
    throw new Error("GEMINI_API_KEY is missing in .env");
  }
  return await generateWithGemini(prompt, key, options.model);
}

/**
 * Publish post to Binance Square OpenAPI.
 * @param {string} content Post text
 * @param {string} apiKey Binance Square API Key
 * @returns {Promise<object>}
 */
export async function publishToSquare(content, apiKey) {
  console.log("[publish] Publishing post to Binance Square...");

  const payload = {
    bodyTextOnly: content,
    contentType: 1,
    content: content,
  };

  const res = await fetch(BINANCE_SQUARE_PUBLISH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Square-OpenAPI-Key": apiKey,
      "clienttype": "binanceSkill",
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

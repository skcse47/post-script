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
 * Backward compatible getTopGainers helper
 */
export async function getTopGainers(limit = 10, minVolumeUSDT = 500000) {
  const movers = await getMarketMovers(limit, minVolumeUSDT);
  return movers.queue;
}

/**
 * Build human-written, urgent, concise, high-converting posts without dashes.
 * Formats:
 * 1. TRADE_SIGNAL (30%): Fast momentum breakout signal for active gainers
 * 2. FOMO_PUMP_CALL (30%): Ultra-short (<150 letters) technical hype on Top 3 pumping coins
 * 3. TARGET_HIT_CONGRATS (15%): Celebration post with winning emojis for hit TP targets
 * 4. GOVT_MACRO_NEWS (15%): US Government, SEC & Fed rate impact
 * 5. COIN_ECOSYSTEM_NEWS (10%): Coin ecosystem developments & catalysts
 */
function buildMultiFormatPrompt(coin, formatType = "TRADE_SIGNAL", allMovers = []) {
  const currentPrice = coin.lastPrice;
  const changePct = coin.priceChangePercent;
  const symbol = coin.baseAsset;
  const high24h = coin.highPrice;
  const low24h = coin.lowPrice;
  const isShort = coin.defaultDirection === "SHORT" || changePct >= 45.0;

  const entryPoint = formatPrice(currentPrice);
  const entryLow = formatPrice(currentPrice * 0.993);
  const entryHigh = formatPrice(currentPrice * 1.007);
  const slPrice = isShort ? formatPrice(currentPrice * 1.045) : formatPrice(currentPrice * 0.955);
  const tp1Price = isShort ? formatPrice(currentPrice * 0.955) : formatPrice(currentPrice * 1.048);
  const tp2Price = isShort ? formatPrice(currentPrice * 0.910) : formatPrice(currentPrice * 1.095);
  const tp3Price = isShort ? formatPrice(currentPrice * 0.860) : formatPrice(currentPrice * 1.155);

  const otherTopGainer = (allMovers || [])
    .filter((m) => m.baseAsset && m.baseAsset !== symbol && m.priceChangePercent > 5)
    .slice(0, 1)
    .map((m) => `$${m.baseAsset}`)[0] || "";

  if (formatType === "FOMO_PUMP_CALL") {
    return `You are a real crypto day trader on Binance Square writing an ultra-short technical micro-post (STRICTLY UNDER 135 CHARACTERS) for the top gainer $${symbol}.

CONTEXT:
- Featured Top Gainer: $${symbol} (+${changePct.toFixed(1)}%, price: $${entryPoint})
${otherTopGainer ? `- Also pumping in Top 3: ${otherTopGainer}` : ''}

CRITICAL RULES:
1. Do NOT give defined price targets (NO TP1, NO TP2, NO list).
2. Write a single punchy technical observation that creates massive buying urgency (e.g., whale absorption, breaking 4H resistance, order book cleared to upside, short squeeze).
3. DO NOT USE DASHES (-- or em-dashes). Keep it raw and human.
4. MAXIMUM LENGTH: UNDER 135 CHARACTERS TOTAL.

EXAMPLES:
🔥 $${symbol} breaking massive 4H resistance! Whales absorbing all sell orders. Next leg loading! 🚀 #Altcoins #Crypto
👀 $${symbol} volume just spiked 400%! Order book cleared to upside. Don't fade this pump 🐂 #${symbol}
⚡ $${symbol} printing god candles on 1H! Huge buy wall at $${entryLow}. Shorts getting squeezed hard! 🚀 #${symbol}

Output ONLY raw text (under 135 characters, NO dashes):`;
  }

  if (formatType === "TARGET_HIT_CONGRATS") {
    const profitPct = (Math.abs(changePct) > 5 ? Math.abs(changePct) * 0.75 : 18.5).toFixed(1);
    return `You are a real, energetic crypto day trader on Binance Square posting a short, punchy TARGET HIT celebration post.

CONTEXT:
- Coin: $${symbol}
- Current Price: $${entryPoint}
- Target Profit: +${profitPct}%
- TP1: $${tp1Price}
- TP2: $${tp2Price}

OUTPUT FORMAT TO FOLLOW (SHORT, PUNCHY, NO DASHES):

🎯 TARGET HIT! $${symbol} TP1 and TP2 SMASHED! 🚀🔥💰

Massive +${profitPct}% profit run delivered on $${symbol}! 🥂💸
Clean rejection from resistance as predicted.

✅ Entry: $${entryLow}
✅ TP1 Hit: $${tp1Price} 🎯
✅ TP2 Hit: $${tp2Price} 🎯

💡 Move SL to entry and lock partials now! Never give back profits.

Drop a '💰' in the comments if you caught this move with me! 👇
What coin should we trade next?

#${symbol} #TargetHit #CryptoProfits #BinanceSquareFamily

CRITICAL: Keep it short, authentic, and mobile-friendly. NO dashes (-- or em-dashes). Output ONLY raw text.`;
  }

  if (formatType === "GOVT_MACRO_NEWS") {
    return `You are a real crypto analyst on Binance Square posting a brief, urgent 2-sentence macro/regulatory update.

CONTEXT:
- Coin: $${symbol} ($${entryPoint})
- 24h Change: ${changePct > 0 ? "+" : ""}${changePct.toFixed(1)}%

OUTPUT FORMAT TO FOLLOW:

🚨 US MACRO and FED UPDATE: Impact on $${symbol} ⚡

Fed liquidity expectations and US regulatory clarity are shifting capital into high-momentum altcoins like $${symbol}. 
Watch support at $${entryLow}, holding this zone opens the door for a continuation toward $${tp1Price}.

How do you see US policy impacting $${symbol} this week? Drop your view below 👇

#${symbol} #CryptoNews #FedRateCuts #BinanceSquareFamily

CRITICAL: Max 3 short paragraphs. NO dashes (-- or em-dashes). Output ONLY raw text.`;
  }

  if (formatType === "WAR_GEOPOLITICS") {
    return `You are a real crypto trader on Binance Square sharing a quick macro risk update.

CONTEXT:
- Coin: $${symbol} ($${entryPoint})

OUTPUT FORMAT TO FOLLOW:

⚠️ GEOPOLITICAL TENSIONS and MARKET RISK: $${symbol} Reaction 📉

Global tensions are driving sharp volatility across altcoins while capital rotates.
$${symbol} is holding local support around $${entryLow}. If volatility spikes, protect capital and use tight stops.

Are you buying the macro dip or holding USDT? 👇

#${symbol} #MacroEconomics #CryptoTrading #BinanceSquare

CRITICAL: Super concise (under 50 words). NO dashes. Output ONLY raw text.`;
  }

  if (formatType === "COIN_ECOSYSTEM_NEWS") {
    return `You are an active crypto trader posting a fast, clickable watch setup on $${symbol} on Binance Square.

CONTEXT:
- Coin: $${symbol} ($${entryPoint}, 24h: ${changePct > 0 ? "+" : ""}${changePct.toFixed(1)}%)

OUTPUT FORMAT TO FOLLOW:

$${symbol} 👀🔥
SPOT AND FUTURE WATCH

$${symbol} is gaining strong buyer volume (+${changePct.toFixed(1)}%) with fresh ecosystem catalyst momentum.
Holding key support at $${entryLow}, looking for expansion toward $${tp1Price}.

Are you in this trade or watching from sidelines? Drop your target below 👇

#${symbol} #Altcoins #CryptoTrading #BinanceSquareFamily

CRITICAL: Concise, punchy, mobile-ready. NO dashes. Output ONLY raw text.`;
  }

  // DEFAULT: TRADE_SIGNAL (30%)
  if (isShort || changePct >= 45.0) {
    return `You are a real day trader posting a fast SHORT signal on Binance Square.

TRADE DATA:
- Coin: $${symbol}
- Current Price: $${entryPoint}
- 24h Pump: +${changePct.toFixed(1)}% (Overextended peak!)
- Resistance: $${formatPrice(high24h)}
- Entry: ${entryLow} to ${entryHigh}
- Stop Loss: ${slPrice}
- TP1: ${tp1Price}
- TP2: ${tp2Price}
- TP3: ${tp3Price}

OUTPUT FORMAT TO FOLLOW:

📉 Shorting $${symbol} at ${entryPoint} | Overextended Pump Rejection 🧱

$${symbol} pumped +${changePct.toFixed(1)}% and just hit a heavy resistance wall at ${formatPrice(high24h)}. 
Sellers are stepping in with massive profit taking.

🐻 SHORT SIGNAL
Entry: ${entryLow} to ${entryHigh}
Stop Loss: ${slPrice}
TP1: ${tp1Price}
TP2: ${tp2Price}
TP3: ${tp3Price}

High risk scalp after a parabolic move. Size small + strict SL.
Who’s shorting $${symbol} with me? 👇

Always DYOR.
#${symbol} #ShortSetup #CryptoTrading #BinanceSquareFamily

CRITICAL: Keep it crisp, urgent, and human. NO dashes (-- or em-dashes). Output ONLY raw text.`;
  }

  // LONG SIGNAL
  return `You are a real day trader posting a fast LONG momentum signal on Binance Square.

TRADE DATA:
- Coin: $${symbol}
- Current Price: $${entryPoint}
- 24h Gain: +${changePct.toFixed(1)}% (Momentum continuation)
- Support: $${formatPrice(low24h)}
- Entry: ${entryLow} to ${entryHigh}
- Stop Loss: ${slPrice}
- TP1: ${tp1Price}
- TP2: ${tp2Price}
- TP3: ${tp3Price}

OUTPUT FORMAT TO FOLLOW:

🚨 $${symbol} LONG SETUP | Momentum Breakout Confirmed 🔥

$${symbol} is holding strong above local support (+${changePct.toFixed(1)}%).
Buyers are absorbing all dips with rising spot volume.

🐂 LONG SIGNAL
Entry: ${entryLow} to ${entryHigh}
Stop Loss: ${slPrice}
TP1: ${tp1Price}
TP2: ${tp2Price}
TP3: ${tp3Price}

Structure remains clean as long as it holds above ${slPrice}.
Are you riding $${symbol} to the targets? Drop your target below 👇

Always DYOR.
#${symbol} #LongSetup #CryptoTrading #BinanceSquareFamily

CRITICAL: Keep it crisp, urgent, and human. NO dashes (-- or em-dashes). Output ONLY raw text.`;
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
 * Universal Post Generator supporting Gemini or OpenRouter with 30% Signal / 70% News & Engagement mix
 */
/**
 * Resolve high-quality relevant image URL for news, coin ecosystem, and target hit posts.
 */
export function resolvePostImageUrl(coin, formatType = "") {
  const sym = (coin?.baseAsset || "").toLowerCase();

  if (formatType === "GOVT_MACRO_NEWS") {
    const macroImages = [
      "https://images.unsplash.com/photo-1621416894569-0f39ed31d247?w=800&auto=format&fit=crop&q=80", // Bitcoin / Macro
      "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=800&auto=format&fit=crop&q=80", // Trading / Federal Reserve
      "https://images.unsplash.com/photo-1642543492481-44e81e3914a7?w=800&auto=format&fit=crop&q=80"  // Market Liquidity
    ];
    return macroImages[Math.floor(Math.random() * macroImages.length)];
  }

  if (formatType === "WAR_GEOPOLITICS") {
    const warImages = [
      "https://images.unsplash.com/photo-1639762681485-074b7f938ba0?w=800&auto=format&fit=crop&q=80", // Global Network / Crypto Shock
      "https://images.unsplash.com/photo-1622979135225-d2ba269bc1df?w=800&auto=format&fit=crop&q=80"  // Market Volatility
    ];
    return warImages[Math.floor(Math.random() * warImages.length)];
  }

  // Coin Ecosystem News & Target Hit: High-res crypto icons & graphics
  if (sym) {
    return `https://assets.coincap.io/assets/icons/${sym}@2x.png`;
  }

  return null;
}

/**
 * Universal Post Generator supporting Gemini or OpenRouter:
 * 50% Top Gainer Signals (>45% Short, <45% Long), 15% Congrats Target Hit, 35% News/Macro/War
 */
export async function generateTraderPost(coin, allMovers, options = {}) {
  // Balanced High-Reach Distribution:
  // - 30% Full Trade Signals (Entry/SL/TP)
  // - 30% Ultra-Short FOMO Tease (<150 letters, technical hype on pumping gainers)
  // - 15% Target Hit Congrats
  // - 15% US Govt / SEC / Macro
  // - 10% Coin Ecosystem Watch
  const weightedFormats = [
    "TRADE_SIGNAL",          // 30% Defined Signals
    "TRADE_SIGNAL",
    "TRADE_SIGNAL",
    "FOMO_PUMP_CALL",        // 30% Ultra-Short Technical Tease (<150 chars)
    "FOMO_PUMP_CALL",
    "FOMO_PUMP_CALL",
    "TARGET_HIT_CONGRATS",   // 15% Target Smashed
    "TARGET_HIT_CONGRATS",
    "GOVT_MACRO_NEWS",       // 15% Macro/Fed/Gov
    "COIN_ECOSYSTEM_NEWS"    // 10% Ecosystem Watch
  ];

  const formatType = options.format || weightedFormats[Math.floor(Math.random() * weightedFormats.length)];
  console.log(`[ai] Generating post content with format: [${formatType}] for $${coin.baseAsset} (24h: ${coin.priceChangePercent > 0 ? "+" : ""}${coin.priceChangePercent.toFixed(1)}%)`);

  const prompt = buildMultiFormatPrompt(coin, formatType, allMovers);
  const imageUrl = resolvePostImageUrl(coin, formatType);
  
  const rawProvider = String(options.provider || "").trim().toLowerCase();
  const isGemini = rawProvider === "1" || rawProvider === "gemini";
  const isOpenRouter = rawProvider === "openrouter" || rawProvider === "2" || (!isGemini && options.openrouterKey);

  let text = "";
  if (isOpenRouter) {
    const key = options.openrouterKey || options.geminiKey;
    if (!key) {
      throw new Error("OPENROUTER_API_KEY is missing in .env");
    }
    const model = options.model || "qwen/qwen-2.5-7b-instruct";
    text = await generateWithOpenRouter(prompt, key, model);
  } else {
    const key = options.geminiKey || options.openrouterKey;
    if (!key) {
      throw new Error("GEMINI_API_KEY is missing in .env");
    }
    text = await generateWithGemini(prompt, key, options.model);
  }

  // If caller expects a simple string, return text with metadata attached
  const result = new String(text);
  result.text = text;
  result.formatType = formatType;
  result.imageUrl = imageUrl;
  result.images = imageUrl ? [imageUrl] : [];
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
    return tag; // drop # to avoid hashtag limit
  });

  // 3. Remove all em-dashes and double-dashes to keep formatting natural and human
  sanitized = sanitized
    .replace(/--+/g, " ")
    .replace(/\s*[—–]\s*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/ \n /g, "\n")
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

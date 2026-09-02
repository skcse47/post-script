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

// Diverse watchlist of 80+ top traded & trending coins across AI, Layer 1s, Memes, DeFi, and RWA
const WATCHLIST_UNIVERSE = [
  "SOL", "SUI", "PEPE", "DOGE", "ADA", "AVAX", "NEAR", "LINK", "SHIB", "FET",
  "APT", "RENDER", "INJ", "WIF", "TIA", "ARB", "OP", "DOT", "LTC", "GALA",
  "SEI", "FLOKI", "BONK", "TON", "FTM", "JASMY", "ENA", "PENDLE", "JTO", "PYTH",
  "WLD", "ICP", "STX", "KAS", "T", "THETA", "AAVE", "CRV", "UNI", "DYDX",
  "ONDO", "OM", "BEAM", "RUNE", "CHZ", "BLUR", "STRK", "ZK", "NOT", "BANANA",
  "TAO", "TURBO", "MEW", "BRETT", "POPCAT", "NEIRO", "1000SATS", "ORDI", "TRUMP",
  "CFX", "FIL", "SAND", "MANA", "AXS", "EOS", "KSM", "FLOW", "QNT", "ALGO",
  "ZRO", "IO", "LISTA", "BB", "REZ", "NOT", "IO", "TNSR", "W", "SAGA",
  "BTC", "ETH", "BNB", "XRP"
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

// Blacklist stablecoins & leveraged tokens
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
  if (num >= 1) return num.toFixed(4);
  if (num >= 0.01) return num.toFixed(5);
  if (num >= 0.0001) return num.toFixed(6);
  return num.toFixed(8);
}

/**
 * Fetch top gainers from Binance + active market movers.
 * - >45% 24h pump: Classified as SHORT (overextended pump rejection)
 * - <45% 24h pump: Classified as LONG (momentum continuation)
 * @param {number} count Number of coins to return
 * @param {number} minVolumeUSDT Minimum 24h volume
 * @returns {Promise<{gainers: Array<object>, losers: Array<object>, queue: Array<object>}>}
 */
export async function getMarketMovers(count = 10, minVolumeUSDT = 500_000) {
  console.log("[market] Scanning real-time Binance Top Gainers & Movers...");
  
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

  // 1. Real-time Top Gainers on Binance
  const topGainers = [...validPairs]
    .filter((p) => p.priceChangePercent > 5)
    .sort((a, b) => b.priceChangePercent - a.priceChangePercent);

  // 2. High-liquidity universe coins
  const universeCoins = shuffleArray(validPairs.filter((p) => p.isUniverseCoin));

  // Build balanced queue: Top Gainers first (for 50% gainer signals) + trending universe coins
  const queue = [...topGainers.slice(0, 6), ...universeCoins.slice(0, 4)].slice(0, count);

  const gainers = queue.filter(q => q.defaultDirection === "LONG");
  const losers = queue.filter(q => q.defaultDirection === "SHORT");

  return { 
    gainers: gainers.length > 0 ? gainers : queue, 
    losers, 
    queue 
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
 * Build human-written, urgent, concise, high-converting posts.
 * Formats:
 * 1. TRADE_SIGNAL (50%): 
 *    - Pump > 45%: SHORT signal (rejection from highs)
 *    - Gain < 45%: LONG signal (momentum continuation)
 * 2. TARGET_HIT_CONGRATS (15%): Celebration post with winning emojis for hit TP targets
 * 3. GOVT_MACRO_NEWS (15%): US Government, SEC & Fed rate impact
 * 4. WAR_GEOPOLITICS (10%): War / geopolitical conflict tensions & Bitcoin volatility
 * 5. COIN_ECOSYSTEM_NEWS (10%): Coin ecosystem developments & catalysts
 */
function buildMultiFormatPrompt(coin, formatType = "TRADE_SIGNAL") {
  const currentPrice = coin.lastPrice;
  const changePct = coin.priceChangePercent;
  const symbol = coin.baseAsset;
  const high24h = coin.highPrice;
  const low24h = coin.lowPrice;
  const isShort = coin.defaultDirection === "SHORT" || changePct >= 45.0;

  const entryPoint = formatPrice(currentPrice);
  const entryLow = formatPrice(currentPrice * 0.993);
  const entryHigh = formatPrice(currentPrice * 1.007);
  const slPrice = isShort ? formatPrice(currentPrice * 1.048) : formatPrice(currentPrice * 0.952);
  const tp1Price = isShort ? formatPrice(currentPrice * 0.955) : formatPrice(currentPrice * 1.048);
  const tp2Price = isShort ? formatPrice(currentPrice * 0.910) : formatPrice(currentPrice * 1.095);
  const tp3Price = isShort ? formatPrice(currentPrice * 0.860) : formatPrice(currentPrice * 1.155);

  // Pool of related major cashtags to mention for search reach (Binance limits cashtags to max 2 per post)
  const relatedTags = symbol === "BTC" ? "$ETH" : "$BTC";

  if (formatType === "TARGET_HIT_CONGRATS") {
    const profitPct = (Math.abs(changePct) > 5 ? Math.abs(changePct) * 0.6 : 18.5).toFixed(1);
    return `You are a victorious, top-performing crypto day trader celebrating a successful trade target hit on Binance Square.

CONTEXT:
- Coin: $${symbol}
- Current Market Price: $${entryPoint}
- Estimated Profit Run: +${profitPct}%
- TP Targets Smashed: TP1 ($${tp1Price}) & TP2 ($${tp2Price})

OUTPUT FORMAT TO EXACTLY FOLLOW (CELEBRATORY WITH WINNING EMOJIS):

🎯 TARGET HIT! $${symbol} TP1 & TP2 SMASHED! 🚀🔥💰

What a clean, textbook move on $${symbol}! 
Our setup just delivered a massive +${profitPct}% profit run! 🥂💸

✅ Entry Zone: Secured around $${entryLow}
✅ TP1 Hit: $${tp1Price} 🎯
✅ TP2 Hit: $${tp2Price} 🎯
🔥 24H Peak: $${formatPrice(high24h)} 🚀

💡 Trade Plan: Move your Stop Loss to Entry now or lock partial profits to make this trade 100% risk-free. Never let a green trade turn red!

Drop a '💰' in the comments if you caught this move with me! 👇
Which coin should we snipe next? Drop your requests below! 

Market context: ${relatedTags}
#${symbol} #TargetHit #CryptoProfits #BinanceSquareFamily

CRITICAL RULES:
1. Enthusiastic, confident trader tone with great emojis (🎯 🔥 💰 🚀 🥂 💸).
2. Clean spacing, NO ASCII boxes.
3. Output ONLY the raw post text ready to publish.`;
  }

  if (formatType === "GOVT_MACRO_NEWS") {
    return `You are a savvy crypto macro analyst on Binance Square posting an urgent, human-written update on US Government, Federal Reserve, and regulatory news impact on crypto.

CONTEXT:
- Featured Coin: $${symbol} ($${entryPoint})
- Macro backdrop: US SEC regulations, Federal Reserve interest rate expectations, US Strategic Bitcoin Reserve bills, and institutional liquidity flows.

STYLE INSTRUCTIONS:
1. Make it sound urgent, realistic, fast-paced, and human.
2. Structure:
   - Punchy breaking headline with emoji (e.g. 🚨 US GOVT & FED UPDATE: What it means for $${symbol} and $BTC)
   - 3-4 short, readable sentences explaining recent US policy/regulatory moves or Fed interest rate stance and why liquidity is shifting into $${symbol} and crypto.
   - Actionable takeaway for traders (e.g., watch key support zones and volatility).
   - Ending question to prompt comments: "How do you think US regulations will impact $${symbol} this year? 👇"
   - Include related coin tags: ${relatedTags}
   - Relevant hashtags: #${symbol} #CryptoNews #USRegulation #FedRateCuts #BinanceSquareFamily

CRITICAL RULES:
- NO robotic AI filler.
- Keep it concise, punchy, and readable on mobile.
- Output ONLY the raw post text ready to publish.`;
  }

  if (formatType === "WAR_GEOPOLITICS") {
    return `You are a real crypto market analyst on Binance Square sharing a serious, concise breakdown on global geopolitics, war tensions, and their direct impact on crypto prices.

CONTEXT:
- Featured Coin: $${symbol} ($${entryPoint})
- Market dynamic: Geopolitical conflict escalations, crude oil/dollar surges, safe haven flight to Bitcoin, and liquidity shocks across altcoins.

STYLE INSTRUCTIONS:
1. Serious, urgent, professional tone.
2. Structure:
   - Punchy headline (e.g. ⚠️ GEOPOLITICAL TENSIONS & MARKET SHOCK: How $${symbol} and $BTC are reacting)
   - 2-3 crisp paragraphs on why global conflicts trigger rapid volatility, liquidation cascades, and how smart money handles risk during macro uncertainty.
   - Mention key price support/resistance levels for $${symbol} around $${entryPoint}.
   - Clear risk management warning: "In times of macro tension, protect your capital first. Size small."
   - Question to readers: "Are you holding cash or buying the macro dip on $${symbol}? Drop your view below 👇"
   - Related tags: ${relatedTags}
   - Hashtags: #${symbol} #MacroEconomics #Geopolitics #CryptoMarket #BinanceSquare

CRITICAL RULES:
- NO robotic phrases. Write like a real trader monitoring newsfeeds.
- Short paragraphs, clean line breaks.
- Output ONLY the raw post text.`;
  }

  if (formatType === "COIN_ECOSYSTEM_NEWS") {
    return `You are a real crypto trader posting a high-engagement ecosystem update on $${symbol} on Binance Square.

CONTEXT:
- Coin: $${symbol}
- Current Price: $${entryPoint} (${changePct > 0 ? "+" : ""}${changePct.toFixed(2)}%)
- Context: Ecosystem growth, scaling upgrades, on-chain adoption, institutional accumulation, or network catalysts.

STYLE INSTRUCTIONS:
Follow this natural, high-reach format (similar to popular Binance Square posts):
$${symbol} 👀🔥
SPOT AND FUTURE WATCH

[2-3 short, clean sentences about $${symbol} being back on the radar around $${entryPoint}, recent consolidation range, and fresh ecosystem/governance/utility developments]

No need to chase green candles here. Let $${symbol} confirm strength above key levels first, then we move smart.
Could be an exciting one to watch into the coming days. 👀

Related coins: ${relatedTags}
NFA. Always DYOR.
#${symbol} #Crypto #Altcoins #CryptoTrading #BinanceSquareFamily

CRITICAL RULES:
- Authentic human tone, crisp line breaks, no robotic formatting.
- Output ONLY the raw post text ready to publish.`;
  }

  // DEFAULT: TRADE_SIGNAL (50%)
  // If coin pumped > 45% -> SHORT SETUP
  if (isShort || changePct >= 45.0) {
    return `You are a real, seasoned crypto day trader posting a live SHORT trade signal on Binance Square.

TRADE DATA:
- Coin: $${symbol}
- Current Price: $${entryPoint}
- 24h Pump: +${changePct.toFixed(1)}% (Overextended blow-off top!)
- Rejection Level: $${formatPrice(high24h)}
- Entry Zone: ${entryLow} – ${entryHigh}
- Stop Loss: ${slPrice}
- TP1: ${tp1Price}
- TP2: ${tp2Price}
- TP3: ${tp3Price}

OUTPUT FORMAT TO EXACTLY FOLLOW:

🚨 $${symbol} SHORT SETUP – Overextended Pump Rejection 📉

$${symbol} is up +${changePct.toFixed(1)}% and just got rejected hard from ${formatPrice(high24h)}.
Sellers and profit-takers are stepping in with heavy volume.

🐻 SHORT SIGNAL
Entry: ${entryLow} – ${entryHigh}
Stop Loss: ${slPrice}
TP1: ${tp1Price}
TP2: ${tp2Price}
TP3: ${tp3Price}

Price failed to sustain the peak and is showing clear momentum exhaustion.
If it stays below ${entryHigh}, the next leg down can be sharp.

High risk setup after a massive pump. Size small + use strict SL.
Who’s shorting $${symbol} with me? 👇

Market context: ${relatedTags}
Always DYOR.
#${symbol} #ShortSetup #CryptoTrading #BinanceSquareFamily

CRITICAL RULES:
1. DO NOT include ASCII level charts or boxy graphics.
2. Keep it crisp, urgent, and human.
3. Always use the exact dollar prices provided.
4. Output ONLY the raw post text ready to publish.`;
  }

  // If coin gained < 45% -> LONG SETUP
  return `You are a real, seasoned crypto day trader posting a live LONG trade signal on Binance Square.

TRADE DATA:
- Coin: $${symbol}
- Current Price: $${entryPoint}
- 24h Change: +${changePct.toFixed(1)}% (Solid Momentum)
- Support Level: $${formatPrice(low24h)}
- Entry Zone: ${entryLow} – ${entryHigh}
- Stop Loss: ${slPrice}
- TP1: ${tp1Price}
- TP2: ${tp2Price}
- TP3: ${tp3Price}

OUTPUT FORMAT TO EXACTLY FOLLOW:

🚨 $${symbol} LONG SETUP – Momentum Continuation Confirmed 🔥

$${symbol} is gaining strong buyer momentum (+${changePct.toFixed(1)}%) and holding above support at ${formatPrice(low24h)}.
Buyers are absorbing dips with rising volume.

🐂 LONG SIGNAL
Entry: ${entryLow} – ${entryHigh}
Stop Loss: ${slPrice}
TP1: ${tp1Price}
TP2: ${tp2Price}
TP3: ${tp3Price}

Market structure is bullish with higher lows on local timeframes.
As long as it holds above ${slPrice}, the upside continuation targets are in play.

Manage your risk properly. Don't chase green candles + use SL.
Are you Long on $${symbol} or waiting? Drop your targets below 👇

Market context: ${relatedTags}
Always DYOR.
#${symbol} #LongSetup #CryptoTrading #BinanceSquareFamily #Altcoins

CRITICAL RULES:
1. DO NOT include ASCII level charts or boxy graphics.
2. Keep it crisp, serious, urgent, and natural.
3. Always use the exact dollar prices provided.
4. Output ONLY the raw post text ready to publish.`;
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
  // 50% Top Gainer Signals (>45% Short, <45% Long), 15% Target Hit Congrats, 35% High-Impact News/Macro
  const weightedFormats = [
    "TRADE_SIGNAL",          // 50% Gainer Signals
    "TRADE_SIGNAL",
    "TRADE_SIGNAL",
    "TRADE_SIGNAL",
    "TRADE_SIGNAL",
    "TARGET_HIT_CONGRATS",   // 15% Target Smashed Congrats
    "TARGET_HIT_CONGRATS",
    "GOVT_MACRO_NEWS",       // 15% US Govt / SEC / Fed
    "GOVT_MACRO_NEWS",
    "WAR_GEOPOLITICS",       // 10% War & Geopolitics
    "COIN_ECOSYSTEM_NEWS"    // 10% Coin Ecosystem News
  ];

  const formatType = options.format || weightedFormats[Math.floor(Math.random() * weightedFormats.length)];
  console.log(`[ai] Generating post content with format: [${formatType}] for $${coin.baseAsset} (24h: ${coin.priceChangePercent > 0 ? "+" : ""}${coin.priceChangePercent.toFixed(1)}%)`);

  const prompt = buildMultiFormatPrompt(coin, formatType);
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

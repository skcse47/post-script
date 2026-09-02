/**
 * Binance Top Movers (Gainers & Losers) Technical Analysis & Signal Generator
 * 
 * Fetches real-time 24h ticker data from Binance public API, filters USDT pairs,
 * creates a balanced rotation queue of Top 5 Gainers and Top 5 Losers,
 * and uses OpenRouter or Gemini to generate authentic trader setups (Long/Short/Scalp/Dip-Buy)
 * with dynamic catchy opening hooks, explicit dollar price levels, and clickable coin cashtags ($BTC, $SOL, etc.).
 */

const BINANCE_TICKER_24HR_URL = "https://api.binance.com/api/v3/ticker/24hr";
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
 * Fetch 24h tickers from Binance and return structured Top Gainers and Top Losers.
 * @param {number} countPerCategory Number of gainers and losers (default: 5 each)
 * @param {number} minVolumeUSDT Minimum 24h volume in USDT to filter illiquid pairs
 * @returns {Promise<{gainers: Array<object>, losers: Array<object>, queue: Array<object>}>}
 */
export async function getMarketMovers(countPerCategory = 5, minVolumeUSDT = 500000) {
  const res = await fetch(BINANCE_TICKER_24HR_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "application/json",
    },
  });
  
  if (!res.ok) {
    throw new Error(`Failed to fetch 24h tickers: ${res.status} ${res.statusText}`);
  }

  const tickers = await res.json();

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
      const priceChangePercent = parseFloat(t.priceChangePercent);
      const highPrice = parseFloat(t.highPrice);
      const lowPrice = parseFloat(t.lowPrice);
      const quoteVolume = parseFloat(t.quoteVolume);
      const baseAsset = t.symbol.replace("USDT", "");
      return {
        symbol: t.symbol,
        baseAsset,
        lastPrice,
        priceChangePercent,
        highPrice,
        lowPrice,
        quoteVolume,
      };
    });

  // Top gainers (highest % change positive)
  const gainers = [...validPairs]
    .sort((a, b) => b.priceChangePercent - a.priceChangePercent)
    .slice(0, countPerCategory)
    .map((c, i) => ({
      ...c,
      category: "gainer",
      rank: i + 1,
      defaultDirection: "LONG",
    }));

  // Top losers (lowest % change negative)
  const losers = [...validPairs]
    .sort((a, b) => a.priceChangePercent - b.priceChangePercent)
    .slice(0, countPerCategory)
    .map((c, i) => ({
      ...c,
      category: "loser",
      rank: i + 1,
      defaultDirection: i % 2 === 0 ? "SHORT" : "DIP_BUY",
    }));

  // Rotation queue: 5 Gainers in order, followed by 5 Losers in order
  const queue = [...gainers, ...losers];

  return { gainers, losers, queue };
}

/**
 * Backward compatible getTopGainers helper
 */
export async function getTopGainers(limit = 10, minVolumeUSDT = 500000) {
  const movers = await getMarketMovers(limit, minVolumeUSDT);
  return movers.gainers;
}

/**
 * Build prompt for LLM strictly enforcing catchy dynamic openings,
 * explicit dollar price levels, and clickable cashtags ($SYMBOL).
 */
function buildTraderPrompt(coin) {
  const currentPrice = coin.lastPrice;
  const changePct = coin.priceChangePercent;
  const symbol = coin.baseAsset;
  const isGainer = coin.category === "gainer" || changePct >= 0;
  const isShort = coin.defaultDirection === "SHORT";

  let entryPrice = "";
  let slPrice = "";
  let tp1Price = "";
  let tp2Price = "";
  let openingHookSuggestions = "";
  let tradeType = "";

  if (isGainer) {
    // Bullish Long Setup
    tradeType = "BULLISH LONG MOMENTUM";
    entryPrice = formatPrice(currentPrice);
    slPrice = formatPrice(currentPrice * 0.952); // ~4.8% SL
    tp1Price = formatPrice(currentPrice * 1.058); // ~5.8% TP1
    tp2Price = formatPrice(currentPrice * 1.096); // ~9.6% TP2

    openingHookSuggestions = `
- "Taking a quick Long entry on $${symbol} around $${entryPrice}..."
- "Just entered $${symbol} Long near $${entryPrice}..."
- "Riding the volume breakout on $${symbol} at $${entryPrice}..."
- "Scalp alert on $${symbol}! Entered Long at market around $${entryPrice}..."
- "Bulls stepping up on $${symbol}, buying the continuation at $${entryPrice}..."
- "Watching $${symbol} break local resistance, Longed around $${entryPrice}..."
- "Sniping an intraday Long on $${symbol} at $${entryPrice}..."
- "Quick momentum push on $${symbol}, in with Longs at $${entryPrice}..."
`;
  } else if (isShort) {
    // Bearish Short Setup
    tradeType = "BEARISH SHORT BREAKDOWN";
    entryPrice = formatPrice(currentPrice);
    slPrice = formatPrice(currentPrice * 1.048); // ~4.8% SL above entry
    tp1Price = formatPrice(currentPrice * 0.945); // ~5.5% TP1
    tp2Price = formatPrice(currentPrice * 0.898); // ~10.2% TP2

    openingHookSuggestions = `
- "Opening a Short scalp on $${symbol} around $${entryPrice}..."
- "Shorting the heavy rejection on $${symbol} near $${entryPrice}..."
- "Sellers taking over on $${symbol}, entered Short at $${entryPrice}..."
- "Fading the bounce on $${symbol}, taking a Short position at $${entryPrice}..."
- "Breakdown alert: Shorting $${symbol} at market price around $${entryPrice}..."
- "Quick Short setup on $${symbol} around $${entryPrice}..."
`;
  } else {
    // Oversold Relief Dip Buy
    tradeType = "OVERSOLD RELIEF DIP BUY";
    entryPrice = formatPrice(currentPrice);
    slPrice = formatPrice(currentPrice * 0.952);
    tp1Price = formatPrice(currentPrice * 1.062);
    tp2Price = formatPrice(currentPrice * 1.115);

    openingHookSuggestions = `
- "Bidding the dip on $${symbol} near key support at $${entryPrice}..."
- "Catching the oversold bounce on $${symbol} around $${entryPrice}..."
- "RSI deeply oversold on $${symbol}, taking a relief scalp at $${entryPrice}..."
- "High RR dip buy setup on $${symbol} around $${entryPrice}..."
- "Sniping the support retest on $${symbol} at $${entryPrice}..."
`;
  }

  return `You are a real, seasoned crypto day trader posting a live trade setup on Binance Square.

TRADE SETUP INFO:
- Coin: $${symbol}
- Trade Type: ${tradeType}
- Exact Entry Price: $${entryPrice}
- Exact Stop Loss (SL): $${slPrice}
- Exact Take Profit 1 (TP1): $${tp1Price}
- Exact Take Profit 2 (TP2): $${tp2Price}

CATCHY OPENING HOOK OPTIONS (CHOOSE OR INVENT A UNIQUE ONE, DO NOT REPEAT "I'm Longed" EVERY TIME):
${openingHookSuggestions}

STRUCTURE TO FOLLOW:
[Catchy & varied 1st line with coin cashtag $${symbol} and entry price $${entryPrice}]
My SL - $${slPrice}
My TPs - $${tp1Price}, $${tp2Price}
[1 natural sentence about chart / volume / momentum]
Bro don't go all in, Use Proper SL And TP.
[1 brief conclusion sentence e.g. "It's a quick scalp Trade Setup." or "Scalp mode active, protect your capital."]
$${symbol}

CRITICAL RULES:
1. VARY THE OPENING LINE! Do NOT start every post with "I'm Longed". Use different catchy, fast-paced trader openings from the options above.
2. ALWAYS use the exact DOLLAR PRICES ($${entryPrice}, $${slPrice}, $${tp1Price}, $${tp2Price}) in the signal lines. NEVER write percentages like "+5%" or "TP at 5%".
3. ALWAYS include the coin cashtag like $${symbol} in the opening line AND on its own standalone line at the end (creates the clickable coin widget on Binance Square).
4. Output STRICTLY the raw post text ready to publish. No title, no meta commentary, no markdown codeblocks.`;
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
    temperature: 0.9, // higher temperature for natural creative hook variety
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
 * Universal Post Generator supporting Gemini or OpenRouter
 */
export async function generateTraderPost(coin, allMovers, options = {}) {
  const prompt = buildTraderPrompt(coin);
  
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

/**
 * Binance Movers (Gainers + Losers) Round-Robin Publisher — Cloudflare Worker
 *
 * Runs every 5 minutes:
 * 1. Maintains a 10-coin rotation queue (Top 5 Gainers -> Top 5 Losers).
 * 2. Every 5 minutes, posts the next coin in the sequence.
 * 3. Once all 10 coins are posted, fetches fresh 24h market data and restarts the rotation.
 * 4. Calls Gemini or OpenRouter to generate technical trade setups (Long/Short/Dip).
 * 5. Publishes directly to Binance Square OpenAPI.
 */

import {
  getMarketMovers,
  generateTraderPost,
  publishToSquare,
  formatPrice,
} from "./topGainersBot.js";

const KV_QUEUE_KEY = "rotation_queue";
const KV_INDEX_KEY = "rotation_index";

/**
 * Validate required secrets in Cloudflare Workers environment.
 */
function validateWorkerEnv(env) {
  if (!env.GEMINI_API_KEY && !env.OPENROUTER_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY or OPENROUTER_API_KEY secret.");
  }
  if (!env.BINANCE_SQUARE_API_KEY) {
    throw new Error("Missing BINANCE_SQUARE_API_KEY secret.");
  }
}

/**
 * Helper to get JSON state from KV
 */
async function getKV(kv, key) {
  if (!kv) return null;
  try {
    const raw = await kv.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Helper to set JSON state in KV
 */
async function setKV(kv, key, value) {
  if (!kv) return;
  try {
    await kv.put(key, JSON.stringify(value));
  } catch (err) {
    console.warn(`[kv] Failed to set ${key}: ${err.message}`);
  }
}

/**
 * Main 15-minute Top 3 Altcoin Gainers Rotation Pipeline
 */
async function runRoundRobinPipeline(env) {
  validateWorkerEnv(env);

  // 1. Always fetch real-time Top Altcoin Gainers from Binance
  console.log("[pipeline] Scanning live Top 3 Altcoin Gainers from Binance API...");
  const movers = await getMarketMovers(10, 1_000_000);
  const top3 = (movers.top3 && movers.top3.length > 0) ? movers.top3 : movers.queue.slice(0, 3);

  if (!top3 || top3.length === 0) {
    throw new Error("No valid altcoin gainers found from Binance API.");
  }

  // 2. Rotate strictly across Top 1 -> Top 2 -> Top 3 (index 0, 1, 2)
  let currentIndex = Number((await getKV(env.POST_CACHE, KV_INDEX_KEY)) ?? 0);
  if (isNaN(currentIndex) || currentIndex < 0) currentIndex = 0;

  const targetIndex = currentIndex % top3.length;
  const currentCoin = top3[targetIndex];

  console.log(`[pipeline] Selected Top #${targetIndex + 1} Gainer: $${currentCoin.baseAsset} (+${currentCoin.priceChangePercent.toFixed(1)}%) at $${formatPrice(currentCoin.lastPrice)}`);

  // 3. Generate trader post for this live top gainer
  const postContent = await generateTraderPost(currentCoin, movers.queue, {
    provider: env.LLM_PROVIDER,
    geminiKey: env.GEMINI_API_KEY,
    openrouterKey: env.OPENROUTER_API_KEY,
    model: env.LLM_MODEL,
  });

  // 4. Publish to Binance Square
  const publishRes = await publishToSquare(postContent, env.BINANCE_SQUARE_API_KEY);

  // 5. Advance rotation index to next top gainer (0 -> 1 -> 2 -> 0)
  const nextIndex = (targetIndex + 1) % top3.length;
  await setKV(env.POST_CACHE, KV_INDEX_KEY, nextIndex);
  await setKV(env.POST_CACHE, KV_QUEUE_KEY, [currentCoin.baseAsset]);

  console.log(`[pipeline] ✅ Published $${currentCoin.baseAsset}. Next run will target Top #${nextIndex + 1} Gainer.`);

  return {
    success: true,
    topRank: targetIndex + 1,
    symbol: currentCoin.symbol,
    baseAsset: currentCoin.baseAsset,
    price: formatPrice(currentCoin.lastPrice),
    change: currentCoin.priceChangePercent,
    post: postContent.text || postContent,
    binanceResult: publishRes,
  };
}

export default {
  /**
   * Cron Trigger Handler (fires every 10 minutes)
   */
  async scheduled(event, env, ctx) {
    console.log(`[cron] Fired at ${new Date(event.scheduledTime).toISOString()}`);
    try {
      const res = await runRoundRobinPipeline(env);
      console.log(`[cron] Cycle complete for: ${JSON.stringify(res.symbol || "none")}`);
    } catch (err) {
      console.error(`[cron] Pipeline failed: ${err.message}`);
    }
  },

  /**
   * HTTP Handler for testing & health checks
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "healthy", time: new Date().toISOString() }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.pathname === "/movers") {
      try {
        const movers = await getMarketMovers(5, 500_000);
        return new Response(JSON.stringify(movers, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (url.pathname === "/trigger") {
      try {
        const result = await runRoundRobinPipeline(env);
        return new Response(JSON.stringify(result, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response(
      "Binance Square Gainers/Losers Round-Robin Bot — endpoints: /health, /movers, /trigger",
      { status: 200 }
    );
  },
};

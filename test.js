#!/usr/bin/env node

/**
 * Instant 1-Shot Test Script for Binance Signal Bot
 * 
 * Fetches current Top 5 Gainers & Losers from Binance, picks the #1 mover,
 * generates the signal post via OpenRouter/Gemini, and displays the result.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getMarketMovers,
  generateTraderPost,
  publishToSquare,
  formatPrice,
} from "./src/topGainersBot.js";

// Load .env
function loadDotEnv() {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const envPath = path.resolve(__dirname, ".env");
    const content = readFileSync(envPath, "utf-8");
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      val = val.replace(/^["'](.*)["']$/, "$1").trim();
      process.env[key] = val;
    }
  } catch (err) {}
}

loadDotEnv();

const BINANCE_SQUARE_API_KEY = process.env.BINANCE_SQUARE_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

let rawProvider = (process.env.LLM_PROVIDER || "").trim().toLowerCase();
let LLM_PROVIDER = "gemini";

if (rawProvider === "openrouter" || rawProvider === "2" || rawProvider.includes("openrouter")) {
  LLM_PROVIDER = "openrouter";
} else if (rawProvider === "gemini" || rawProvider === "1" || rawProvider.includes("gemini")) {
  LLM_PROVIDER = "gemini";
} else if (OPENROUTER_API_KEY) {
  LLM_PROVIDER = "openrouter";
}

const LLM_MODEL = process.env.LLM_MODEL || (LLM_PROVIDER === "openrouter" ? "qwen/qwen-2.5-7b-instruct" : "gemini-2.0-flash");

console.log("=================================================");
console.log("🧪 Running 1-Shot Test Cycle");
console.log(`🤖 Provider : ${LLM_PROVIDER.toUpperCase()}`);
console.log(`📦 Model    : ${LLM_MODEL}`);
console.log("=================================================\n");

async function runTest() {
  try {
    // 1. Fetch live market movers
    console.log("[1/3] 📡 Fetching live Top 5 Gainers & Losers from Binance API...");
    const movers = await getMarketMovers(5, 500_000);

    console.log("\n🟢 TOP 5 GAINERS:");
    movers.gainers.forEach((g, i) => {
      console.log(`   ${i + 1}. $${g.baseAsset.padEnd(8)}: $${formatPrice(g.lastPrice)} (+${g.priceChangePercent.toFixed(2)}%) Vol: $${(g.quoteVolume / 1_000_000).toFixed(2)}M`);
    });

    console.log("\n🔴 TOP 5 LOSERS:");
    movers.losers.forEach((l, i) => {
      console.log(`   ${i + 1}. $${l.baseAsset.padEnd(8)}: $${formatPrice(l.lastPrice)} (${l.priceChangePercent.toFixed(2)}%) Vol: $${(l.quoteVolume / 1_000_000).toFixed(2)}M`);
    });

    // Pick top gainer for testing
    const testCoin = movers.gainers[0];
    console.log(`\n[2/3] 🧠 Generating signal setup for $${testCoin.baseAsset} via ${LLM_PROVIDER.toUpperCase()} (${LLM_MODEL})...`);

    const postContent = await generateTraderPost(testCoin, movers.queue, {
      provider: LLM_PROVIDER,
      geminiKey: GEMINI_API_KEY,
      openrouterKey: OPENROUTER_API_KEY,
      model: LLM_MODEL,
    });

    console.log("\n═════════════════════════════════════════════════");
    console.log("📝 GENERATED SIGNAL OUTPUT:");
    console.log("═════════════════════════════════════════════════\n");
    console.log(postContent);
    console.log("\n═════════════════════════════════════════════════\n");

    // 3. Test Publishing
    console.log("[3/3] 📤 Publishing to Binance Square...");
    if (BINANCE_SQUARE_API_KEY && BINANCE_SQUARE_API_KEY !== "your_binance_square_api_key_here") {
      const pubResult = await publishToSquare(postContent, BINANCE_SQUARE_API_KEY);
      console.log("✅ Post successfully published to Binance Square!", pubResult);
    } else {
      console.log("⚠️ BINANCE_SQUARE_API_KEY is not configured or dummy in .env.");
      console.log("   (Generated post above is ready for live publishing!)");
    }

    console.log("\n🎉 Test completed successfully!");
  } catch (err) {
    console.error("\n❌ Test failed with error:", err.message);
  }
}

runTest();

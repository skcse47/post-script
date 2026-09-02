#!/usr/bin/env node

/**
 * Standalone Binance Movers (Top Gainers + Top Losers) Signal Bot
 * 
 * Round-Robin Rotation (Every 10 minutes):
 * - Fetches Top 5 Gainers + Top 5 Losers
 * - Cycles through Gainer #1..5, then Loser #1..5 every 10 minutes
 * - Refreshes market data and repeats cycle seamlessly!
 */

import cron from "node-cron";
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import {
  getMarketMovers,
  generateTraderPost,
  publishToSquare,
  formatPrice,
} from "./topGainersBot.js";

// ─── Robust .env loader ──────────────────────────────────────────────────────

function loadDotEnv() {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const envPath = path.resolve(__dirname, "..", ".env");
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

console.log("=========================================================");
console.log(`🤖 Active LLM Provider : ${LLM_PROVIDER.toUpperCase()}`);
console.log(`📦 Active Model        : ${LLM_MODEL}`);
console.log("=========================================================");

// ─── SQLite State & History Tracking ─────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "..", "gainers_history.db");
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS bot_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS post_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    category TEXT DEFAULT 'gainer',
    price REAL NOT NULL,
    change_pct REAL NOT NULL,
    post_content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

try {
  db.exec("ALTER TABLE post_history ADD COLUMN category TEXT DEFAULT 'gainer'");
} catch (e) {}

/**
 * Get state value from SQLite
 */
function getState(key) {
  const row = db.prepare("SELECT value FROM bot_state WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) : null;
}

/**
 * Set state value in SQLite
 */
function setState(key, value) {
  db.prepare(
    "INSERT INTO bot_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, JSON.stringify(value));
}

/**
 * Get timestamp of the most recent post
 */
function getLastPostTime() {
  const row = db.prepare("SELECT created_at FROM post_history ORDER BY id DESC LIMIT 1").get();
  if (!row || !row.created_at) return 0;
  return new Date(row.created_at + "Z").getTime();
}

/**
 * Record a published post in SQLite
 */
function recordPost(symbol, category, price, changePct, content) {
  db.prepare(
    "INSERT INTO post_history (symbol, category, price, change_pct, post_content) VALUES (?, ?, ?, ?, ?)"
  ).run(symbol, category, price, changePct, content);
}

// ─── Main Execution Pipeline ─────────────────────────────────────────────────

let isRunning = false;

export async function executeRoundRobinCycle() {
  if (isRunning) {
    console.log("[cycle] Previous cycle still running, skipping.");
    return;
  }

  isRunning = true;
  const startTime = new Date().toISOString();

  try {
    let cachedQueue = getState("rotation_queue");
    let currentIndex = getState("rotation_index") ?? 0;

    // If queue is empty or finished all 10 coins, fetch fresh list
    if (!cachedQueue || !Array.isArray(cachedQueue) || currentIndex >= cachedQueue.length) {
      console.log(`\n════════════════════════════════════════════════════════════`);
      console.log(`🔄 [${startTime}] Refreshing Top 5 Gainers & Top 5 Losers Queue`);
      console.log(`════════════════════════════════════════════════════════════`);

      const movers = await getMarketMovers(5, 500_000);
      cachedQueue = movers.queue;
      currentIndex = 0;

      setState("rotation_queue", cachedQueue);
      setState("rotation_index", 0);

      console.log(`\n📊 New Rotation Queue Created (10 Coins Total):`);
      console.log(`  🟢 TOP 5 GAINERS:`);
      movers.gainers.forEach((g, i) => {
        console.log(`     ${i + 1}. $${g.baseAsset.padEnd(8)} (+${g.priceChangePercent.toFixed(2)}%) at $${formatPrice(g.lastPrice)}`);
      });
      console.log(`  🔴 TOP 5 LOSERS:`);
      movers.losers.forEach((l, i) => {
        console.log(`     ${i + 1}. $${l.baseAsset.padEnd(8)} (${l.priceChangePercent.toFixed(2)}%) at $${formatPrice(l.lastPrice)}`);
      });
      console.log("");
    }

    const currentCoin = cachedQueue[currentIndex];
    const itemNum = currentIndex + 1;
    const totalItems = cachedQueue.length;
    const catUpper = currentCoin.category.toUpperCase();

    console.log(`\n🎯 [${startTime}] Processing Queue Item [${itemNum}/${totalItems}]:`);
    console.log(`   Coin: $${currentCoin.baseAsset} | Type: ${catUpper} #${currentCoin.rank} | 24h Change: ${currentCoin.priceChangePercent >= 0 ? "+" : ""}${currentCoin.priceChangePercent.toFixed(2)}% | Price: $${formatPrice(currentCoin.lastPrice)}`);

    // Generate trade setup via LLM
    console.log(`[ai] Generating ${currentCoin.defaultDirection} setup via ${LLM_PROVIDER.toUpperCase()}...`);
    const postContent = await generateTraderPost(currentCoin, cachedQueue, {
      provider: LLM_PROVIDER,
      geminiKey: GEMINI_API_KEY,
      openrouterKey: OPENROUTER_API_KEY,
      model: LLM_MODEL,
    });

    console.log(`\n📝 ─── GENERATED POST CONTENT ───\n`);
    console.log(postContent);
    console.log(`\n─────────────────────────────────\n`);

    // Publish to Binance Square
    if (BINANCE_SQUARE_API_KEY && BINANCE_SQUARE_API_KEY !== "your_binance_square_api_key_here") {
      await publishToSquare(postContent, BINANCE_SQUARE_API_KEY);
      recordPost(currentCoin.symbol, currentCoin.category, currentCoin.lastPrice, currentCoin.priceChangePercent, postContent);
      console.log(`[cycle] ✅ Post published and recorded in database.`);
    } else {
      console.log(`[publish] ⚠️ BINANCE_SQUARE_API_KEY is not configured. Post generated successfully & logged.`);
      recordPost(currentCoin.symbol, currentCoin.category, currentCoin.lastPrice, currentCoin.priceChangePercent, postContent);
    }

    // Advance queue index for the next 10-minute cycle
    const nextIndex = currentIndex + 1;
    setState("rotation_index", nextIndex);
    console.log(`[queue] Next coin in 10 minutes will be index #${nextIndex < totalItems ? nextIndex + 1 : 1} of ${totalItems}`);

  } catch (err) {
    console.error(`[cycle] ❌ Error in cycle: ${err.message}`);
  } finally {
    isRunning = false;
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

console.log("=========================================================");
console.log("⚡ Binance Square Top Gainers & Losers Round-Robin Bot");
console.log("⏱️  Cron Schedule: Every 30 minutes (*/30 * * * *)");
console.log("🔄 Queue Cycle: 5 Gainers -> 5 Losers -> Refresh & Repeat");
console.log("📁 SQLite DB: " + DB_PATH);
console.log("=========================================================\n");

// Check if a post was published very recently (< 25 minutes ago)
const lastPostTime = getLastPostTime();
const elapsedMinutes = (Date.now() - lastPostTime) / (60 * 1000);

if (lastPostTime > 0 && elapsedMinutes < 25) {
  const waitMins = Math.ceil(30 - elapsedMinutes);
  console.log(`[startup] ⏳ Last post was published ${elapsedMinutes.toFixed(1)} mins ago.`);
  console.log(`[startup] Waiting for next scheduled 30-minute cron interval (~${waitMins} min) to prevent duplicate rapid posting.\n`);
} else {
  // Otherwise run initial cycle on launch
  executeRoundRobinCycle();
}

// Schedule to run exactly every 30 minutes (:00, :30)
cron.schedule("*/3 * * * *", () => {
  executeRoundRobinCycle();
});

// Clean shutdown
process.on("SIGINT", () => {
  console.log("\n👋 Stopping Signal Bot...");
  db.close();
  process.exit(0);
});

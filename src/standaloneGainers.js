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

    // 1. Always fetch real-time Top Altcoin Gainers from Binance
    console.log(`\n════════════════════════════════════════════════════════════`);
    console.log(`🔄 [${startTime}] Scanning Live Top 3 Binance Altcoin Gainers`);
    console.log(`════════════════════════════════════════════════════════════`);

    const movers = await getMarketMovers(10, 1_000_000);
    const top3 = (movers.top3 && movers.top3.length > 0) ? movers.top3 : movers.queue.slice(0, 3);

    if (!top3 || top3.length === 0) {
      throw new Error("No valid altcoin gainers found from Binance API.");
    }

    console.log(`\n📊 Live Top Altcoin Gainers:`);
    top3.forEach((g, i) => {
      console.log(`   ${i + 1}. $${g.baseAsset.padEnd(8)} (+${g.priceChangePercent.toFixed(2)}%) at $${formatPrice(g.lastPrice)}`);
    });

    let currentIndex = Number(getState("rotation_index") ?? 0);
    if (isNaN(currentIndex) || currentIndex < 0) currentIndex = 0;

    const targetIndex = currentIndex % top3.length;
    const currentCoin = top3[targetIndex];

    console.log(`\n🎯 [${startTime}] Selected Top #${targetIndex + 1} Gainer: $${currentCoin.baseAsset} (+${currentCoin.priceChangePercent.toFixed(1)}%) at $${formatPrice(currentCoin.lastPrice)}`);

    // Generate trade setup via LLM
    console.log(`[ai] Generating post setup via ${LLM_PROVIDER.toUpperCase()}...`);
    const postContent = await generateTraderPost(currentCoin, movers.queue, {
      provider: LLM_PROVIDER,
      geminiKey: GEMINI_API_KEY,
      openrouterKey: OPENROUTER_API_KEY,
      model: LLM_MODEL,
    });

    console.log(`\n📝 ─── GENERATED POST CONTENT ───\n`);
    console.log(postContent.text || postContent);
    console.log(`\n─────────────────────────────────\n`);

    // Publish to Binance Square
    if (BINANCE_SQUARE_API_KEY && BINANCE_SQUARE_API_KEY !== "your_binance_square_api_key_here") {
      await publishToSquare(postContent, BINANCE_SQUARE_API_KEY);
      recordPost(currentCoin.symbol, currentCoin.category, currentCoin.lastPrice, currentCoin.priceChangePercent, postContent.text || postContent);
      console.log(`[cycle] ✅ Post published and recorded in database.`);
    } else {
      console.log(`[publish] ⚠️ BINANCE_SQUARE_API_KEY is not configured. Post generated successfully & logged.`);
      recordPost(currentCoin.symbol, currentCoin.category, currentCoin.lastPrice, currentCoin.priceChangePercent, postContent.text || postContent);
    }

    // Advance rotation index for next 15-minute cycle (0 -> 1 -> 2 -> 0)
    const nextIndex = (targetIndex + 1) % top3.length;
    setState("rotation_index", nextIndex);
    console.log(`[queue] Next run in 15 minutes will target Top #${nextIndex + 1} Gainer: $${top3[nextIndex].baseAsset}`);

  } catch (err) {
    console.error(`[cycle] ❌ Error in cycle: ${err.message}`);
  } finally {
    isRunning = false;
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

console.log("=========================================================");
console.log("⚡ Binance Square Top Gainers & Losers Round-Robin Bot");
console.log("⏱️  Cron Schedule: Every 15 minutes (*/15 * * * *)");
console.log("🔄 Queue Cycle: Diverse Altcoins + Macro/Gov/War News");
console.log("📁 SQLite DB: " + DB_PATH);
console.log("=========================================================\n");

// Check if a post was published very recently (< 12 minutes ago)
const lastPostTime = getLastPostTime();
const elapsedMinutes = (Date.now() - lastPostTime) / (60 * 1000);

if (lastPostTime > 0 && elapsedMinutes < 12) {
  const waitMins = Math.ceil(15 - elapsedMinutes);
  console.log(`[startup] ⏳ Last post was published ${elapsedMinutes.toFixed(1)} mins ago.`);
  console.log(`[startup] Waiting for next scheduled 15-minute cron interval (~${waitMins} min) to prevent duplicate rapid posting.\n`);
} else {
  // Otherwise run initial cycle on launch
  executeRoundRobinCycle();
}

// Schedule to run exactly every 15 minutes (:00, :15, :30, :45)
cron.schedule("*/15 * * * *", () => {
  executeRoundRobinCycle();
});

// Clean shutdown
process.on("SIGINT", () => {
  console.log("\n👋 Stopping Signal Bot...");
  db.close();
  process.exit(0);
});

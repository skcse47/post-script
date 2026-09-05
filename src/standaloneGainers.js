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
  getHotTrendingHashtags,
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
    base_asset TEXT DEFAULT '',
    format_type TEXT DEFAULT '',
    price REAL NOT NULL,
    change_pct REAL NOT NULL,
    post_content TEXT NOT NULL,
    is_trending INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS coin_performance (
    base_asset TEXT PRIMARY KEY,
    total_posts INTEGER DEFAULT 0,
    trending_hits INTEGER DEFAULT 0,
    priority_score REAL DEFAULT 0,
    last_posted_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Safe column additions for existing databases
try { db.exec("ALTER TABLE post_history ADD COLUMN category TEXT DEFAULT 'gainer'"); } catch (e) {}
try { db.exec("ALTER TABLE post_history ADD COLUMN base_asset TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE post_history ADD COLUMN format_type TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE post_history ADD COLUMN is_trending INTEGER DEFAULT 0"); } catch (e) {}

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
 * Record a published post in SQLite with full tracking
 */
function recordPost(symbol, category, price, changePct, content, baseAsset = '', formatType = '', isTrending = false) {
  db.prepare(
    "INSERT INTO post_history (symbol, category, base_asset, format_type, price, change_pct, post_content, is_trending) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(symbol, category, baseAsset, formatType, price, changePct, content, isTrending ? 1 : 0);

  // Update coin performance tracking
  if (baseAsset) {
    db.prepare(`
      INSERT INTO coin_performance (base_asset, total_posts, trending_hits, priority_score, last_posted_at)
      VALUES (?, 1, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(base_asset) DO UPDATE SET
        total_posts = total_posts + 1,
        trending_hits = trending_hits + ?,
        priority_score = priority_score + ?,
        last_posted_at = CURRENT_TIMESTAMP
    `).run(baseAsset, isTrending ? 1 : 0, isTrending ? 2.0 : 0.5, isTrending ? 1 : 0, isTrending ? 2.0 : 0.5);
  }
}

/**
 * Get coins with highest priority scores (trending overlap = high engagement proxy)
 * Returns coins sorted by priority_score DESC, only those posted in the last 48 hours
 */
function getHighPriorityCoins(limit = 5) {
  return db.prepare(`
    SELECT base_asset, total_posts, trending_hits, priority_score, last_posted_at
    FROM coin_performance
    WHERE last_posted_at > datetime('now', '-48 hours')
      AND trending_hits > 0
    ORDER BY priority_score DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Check if a coin is currently trending (appeared in hot-list recently)
 */
function isCoinTrending(baseAsset, trendingCoins = []) {
  return trendingCoins.some(c => c.toUpperCase() === baseAsset.toUpperCase());
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
    // 1. Always fetch real-time Top Altcoin Gainers from Binance
    console.log(`\n════════════════════════════════════════════════════════════`);
    console.log(`🔄 [${startTime}] Scanning Live Top 3 Binance Altcoin Gainers`);
    console.log(`════════════════════════════════════════════════════════════`);

    const movers = await getMarketMovers(10, 1_000_000);
    const top3 = (movers.top3 && movers.top3.length > 0) ? movers.top3 : movers.queue.slice(0, 3);

    if (!top3 || top3.length === 0) {
      throw new Error("No valid altcoin gainers found from Binance API.");
    }

    // 2. Fetch trending topics to detect engagement overlap
    let trendingCoins = [];
    let trendingTopic = null;
    try {
      const hotList = await getHotTrendingHashtags(3);
      if (hotList && hotList.length > 0) {
        trendingCoins = hotList.flatMap(h => h.trendingCoins || []);
        trendingTopic = hotList[Math.floor(Math.random() * hotList.length)];
        console.log(`[hot-list] 🔥 Trending coins detected: ${trendingCoins.join(", ") || "None"}`);
      }
    } catch (err) {
      console.warn(`[hot-list] Could not fetch trending data: ${err.message}`);
    }

    // 3. Check priority coins from past performance
    const priorityCoins = getHighPriorityCoins(3);
    if (priorityCoins.length > 0) {
      console.log(`\n⭐ High Priority Coins (trending overlap in last 48h):`);
      priorityCoins.forEach((p, i) => {
        console.log(`   ${i + 1}. $${p.base_asset} (score: ${p.priority_score.toFixed(1)}, trending hits: ${p.trending_hits}, posts: ${p.total_posts})`);
      });
    }

    console.log(`\n📊 Live Top Altcoin Gainers:`);
    top3.forEach((g, i) => {
      const isTrend = isCoinTrending(g.baseAsset, trendingCoins);
      console.log(`   ${i + 1}. $${g.baseAsset.padEnd(8)} (+${g.priceChangePercent.toFixed(2)}%) at $${formatPrice(g.lastPrice)}${isTrend ? ' 🔥 TRENDING' : ''}`);
    });

    // 4. Select coin: boost priority coins that are also in top gainers
    let currentIndex = Number(getState("rotation_index") ?? 0);
    if (isNaN(currentIndex) || currentIndex < 0) currentIndex = 0;

    let targetIndex = currentIndex % top3.length;
    let currentCoin = top3[targetIndex];

    // If a high-priority coin is in top3, prioritize it (50% chance to override rotation)
    if (priorityCoins.length > 0 && Math.random() < 0.5) {
      const priorityMatch = top3.find(g => 
        priorityCoins.some(p => p.base_asset === g.baseAsset)
      );
      if (priorityMatch) {
        currentCoin = priorityMatch;
        console.log(`[priority] ⭐ Boosted $${currentCoin.baseAsset} from priority list (trending overlap engagement)`);
      }
    }

    const coinIsTrending = isCoinTrending(currentCoin.baseAsset, trendingCoins);
    console.log(`\n🎯 [${startTime}] Selected: $${currentCoin.baseAsset} (+${currentCoin.priceChangePercent.toFixed(1)}%) at $${formatPrice(currentCoin.lastPrice)}${coinIsTrending ? ' [TRENDING 🔥]' : ''}`);

    // Generate trade setup via LLM
    console.log(`[ai] Generating post setup via ${LLM_PROVIDER.toUpperCase()}...`);
    const postContent = await generateTraderPost(currentCoin, movers.queue, {
      provider: LLM_PROVIDER,
      geminiKey: GEMINI_API_KEY,
      openrouterKey: OPENROUTER_API_KEY,
      model: LLM_MODEL,
      trendingTopic: trendingTopic,
    });

    const formatType = postContent.formatType || "TRADE_SIGNAL";

    console.log(`\n📝 ─── GENERATED POST [${formatType}] ───\n`);
    console.log(postContent.text || postContent);
    console.log(`\n─────────────────────────────────\n`);

    // Publish to Binance Square
    if (BINANCE_SQUARE_API_KEY && BINANCE_SQUARE_API_KEY !== "your_binance_square_api_key_here") {
      await publishToSquare(postContent, BINANCE_SQUARE_API_KEY);
      recordPost(currentCoin.symbol, currentCoin.category, currentCoin.lastPrice, currentCoin.priceChangePercent, postContent.text || postContent, currentCoin.baseAsset, formatType, coinIsTrending);
      console.log(`[cycle] ✅ Post published and recorded in database.`);
    } else {
      console.log(`[publish] ⚠️ BINANCE_SQUARE_API_KEY is not configured. Post generated successfully & logged.`);
      recordPost(currentCoin.symbol, currentCoin.category, currentCoin.lastPrice, currentCoin.priceChangePercent, postContent.text || postContent, currentCoin.baseAsset, formatType, coinIsTrending);
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

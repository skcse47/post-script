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
import { buildMarketContext, gradeSetup } from "./marketContext.js";
import {
  TRADE_CALLS_SCHEMA,
  recordCall,
  resolveOpenCalls,
  getTrackRecord,
  getRecentCloses,
  buildTrackRecordPost,
} from "./trackRecord.js";

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
      // Do not clobber variables already set in the environment. Overwriting them
      // meant `DRY_RUN=1 node src/standaloneGainers.js` silently did nothing and the
      // bot published for real, which is a bad way to find out.
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch (err) {}
}

loadDotEnv();

// DRY_RUN=1 generates and logs posts without publishing any of them.
const DRY_RUN = /^(1|true|yes)$/i.test(String(process.env.DRY_RUN || ""));

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
` + TRADE_CALLS_SCHEMA);

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
 * Whether this run is allowed to publish. Single gate so DRY_RUN cannot be
 * accidentally bypassed by one of the call sites.
 */
function canPublish() {
  if (DRY_RUN) return false;
  return Boolean(BINANCE_SQUARE_API_KEY) && BINANCE_SQUARE_API_KEY !== "your_binance_square_api_key_here";
}

/**
 * Check if a coin is currently trending (appeared in hot-list recently)
 */
function isCoinTrending(baseAsset, trendingCoins = []) {
  return trendingCoins.some(c => c.toUpperCase() === baseAsset.toUpperCase());
}

/**
 * Coins posted about within the cooldown window.
 *
 * Posting the same ticker three times in an hour is what made the feed look
 * automated. Readers who see $ABC from you twice before lunch stop reading the
 * third one, and the Square feed itself deprioritises near duplicate content from
 * one author.
 */
function recentlyPostedAssets(hours = 6) {
  return new Set(
    db
      .prepare(
        `SELECT DISTINCT base_asset FROM post_history
         WHERE base_asset != '' AND created_at > datetime('now', ?)`
      )
      .all(`-${hours} hours`)
      .map((r) => r.base_asset)
  );
}

/** Posts published in the last N hours, used to space out the recap post. */
function countRecentFormat(formatType, hours) {
  return db
    .prepare(
      `SELECT COUNT(*) c FROM post_history
       WHERE format_type = ? AND created_at > datetime('now', ?)`
    )
    .get(formatType, `-${hours} hours`).c;
}

/**
 * Publish the honest track record recap.
 *
 * Returns false when there is not enough settled history to be worth posting. That
 * restraint is the point: a "results" post covering four trades is not evidence, and
 * padding it out is the same dishonesty the old TARGET_HIT_CONGRATS format committed.
 */
async function tryPublishTrackRecord() {
  if (countRecentFormat("TRACK_RECORD", 20) > 0) return false;

  const stats = getTrackRecord(db, { days: 7, minCalls: 8 });
  if (!stats) {
    console.log("[track] Not enough settled calls yet for a recap post. Skipping.");
    return false;
  }

  const text = buildTrackRecordPost(stats, getRecentCloses(db, 6));
  if (!text) return false;

  console.log(`\n📝 ─── GENERATED POST [TRACK_RECORD] ───\n`);
  console.log(text);
  console.log(`\n─────────────────────────────────\n`);

  if (DRY_RUN) {
    console.log(`[track] 🧪 DRY_RUN is set. Recap not published and not recorded.`);
    return true;
  }

  if (canPublish()) {
    await publishToSquare({ text, images: [] }, BINANCE_SQUARE_API_KEY);
  }
  recordPost("TRACK_RECORD", "recap", 0, stats.totalR, text, "", "TRACK_RECORD", false);
  console.log(`[track] ✅ Published ${stats.days} day recap: ${stats.wins}W / ${stats.stopped}L, net ${stats.totalR.toFixed(1)}R`);
  return true;
}

// ─── Main Execution Pipeline ─────────────────────────────────────────────────

let isRunning = false;

/**
 * Run one full cycle.
 *
 * @returns {Promise<boolean>} true if the cycle completed, false if it errored.
 *   CI schedulers need this: the cycle catches its own errors so the long running
 *   scheduler survives a bad tick, which meant a one shot run always exited 0 even
 *   when nothing was posted.
 */
export async function executeRoundRobinCycle() {
  if (isRunning) {
    console.log("[cycle] Previous cycle still running, skipping.");
    return false;
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

    // 4. Settle any open calls against real candles before doing anything else, so
    //    the recap post below can never be built from unsettled or invented results.
    try {
      const { checked, settled } = await resolveOpenCalls(db);
      if (checked > 0) console.log(`[track] Checked ${checked} open calls, settled ${settled}.`);
    } catch (err) {
      console.warn(`[track] Could not resolve open calls: ${err.message}`);
    }

    // 5. Roughly once a day, post the real track record instead of another setup.
    //    Receipts convert far better than another buy call, but only real ones.
    if (Math.random() < 0.12 && (await tryPublishTrackRecord())) {
      return true;
    }

    // 6. Select a coin, skipping anything already posted about recently.
    const cooldown = recentlyPostedAssets(Number(process.env.COIN_COOLDOWN_HOURS || 6));
    const candidates = movers.queue.filter((c) => !cooldown.has(c.baseAsset));
    const pool = candidates.length > 0 ? candidates : movers.queue;
    if (candidates.length === 0) {
      console.log("[queue] Every candidate is inside its cooldown window, reusing the full queue.");
    }

    let currentIndex = Number(getState("rotation_index") ?? 0);
    if (isNaN(currentIndex) || currentIndex < 0) currentIndex = 0;
    const targetIndex = currentIndex % pool.length;
    let currentCoin = pool[targetIndex];

    // If a high-priority coin is also in the eligible pool, prefer it.
    if (priorityCoins.length > 0 && Math.random() < 0.5) {
      const priorityMatch = pool.find((g) => priorityCoins.some((p) => p.base_asset === g.baseAsset));
      if (priorityMatch) {
        currentCoin = priorityMatch;
        console.log(`[priority] ⭐ Boosted $${currentCoin.baseAsset} from priority list (trending overlap engagement)`);
      }
    }

    const coinIsTrending = isCoinTrending(currentCoin.baseAsset, trendingCoins);
    // The queue falls through to losers once the cooldown filters out the top
    // gainers, so a hardcoded "+" printed "+-3.6%".
    const changeStr = `${currentCoin.priceChangePercent >= 0 ? "+" : ""}${currentCoin.priceChangePercent.toFixed(1)}%`;
    console.log(`\n🎯 [${startTime}] Selected: $${currentCoin.baseAsset} (${changeStr}) at $${formatPrice(currentCoin.lastPrice)}${coinIsTrending ? ' [TRENDING 🔥]' : ''}`);

    // 7. Grade the chart. The verdict decides which kind of post gets written.
    const marketContext = await buildMarketContext(currentCoin);
    const grade = gradeSetup(marketContext);
    grade.ctx = marketContext;
    console.log(`[grade] $${currentCoin.baseAsset} => ${grade.verdict} (score ${grade.score})`);
    grade.reasons.forEach((r) => console.log(`   + ${r}`));
    grade.warnings.forEach((r) => console.log(`   - ${r}`));

    console.log(`[ai] Generating post via ${LLM_PROVIDER.toUpperCase()}...`);
    const postContent = await generateTraderPost(currentCoin, movers.queue, {
      provider: LLM_PROVIDER,
      geminiKey: GEMINI_API_KEY,
      openrouterKey: OPENROUTER_API_KEY,
      model: LLM_MODEL,
      trendingTopic: trendingTopic,
      marketContext,
      grade,
    });

    const formatType = postContent.formatType || "EVIDENCE_SIGNAL";

    console.log(`\n📝 ─── GENERATED POST [${formatType}] ───\n`);
    console.log(postContent.text || postContent);
    console.log(`\n─────────────────────────────────\n`);

    // Publish to Binance Square
    if (canPublish()) {
      await publishToSquare(postContent, BINANCE_SQUARE_API_KEY);
      console.log(`[cycle] ✅ Post published.`);
    } else if (DRY_RUN) {
      console.log(`[publish] 🧪 DRY_RUN is set. Nothing was published.`);
    } else {
      console.log(`[publish] ⚠️ BINANCE_SQUARE_API_KEY is not configured. Post generated successfully & logged.`);
    }

    // A dry run must not touch history. Recording an unpublished post would poison
    // the coin cooldown and, worse, feed a call into the track record that nobody
    // ever saw.
    if (!DRY_RUN) {
      recordPost(
        currentCoin.symbol,
        currentCoin.category,
        currentCoin.lastPrice,
        currentCoin.priceChangePercent,
        postContent.text || postContent,
        currentCoin.baseAsset,
        formatType,
        coinIsTrending
      );
    }

    // 8. If this post published actual levels, log it as a call so it gets graded
    //    later whether it works or not. This is what makes the recap post real.
    if (postContent.levels?.stop && !DRY_RUN) {
      const callId = recordCall(db, {
        symbol: currentCoin.symbol,
        baseAsset: currentCoin.baseAsset,
        direction: grade.direction,
        verdict: grade.verdict,
        levels: postContent.levels,
      });
      if (callId) console.log(`[track] Logged call #${callId} on $${currentCoin.baseAsset}, it will be graded against real candles.`);
    }

    const nextIndex = (targetIndex + 1) % pool.length;
    setState("rotation_index", nextIndex);
    console.log(`[queue] Next target: $${pool[nextIndex].baseAsset}`);
    return true;

  } catch (err) {
    console.error(`[cycle] ❌ Error in cycle: ${err.message}`);
    return false;
  } finally {
    isRunning = false;
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

// Posting cadence.
//
// The old default was every 15 minutes, which is 96 posts a day from one account.
// Square's feed deprioritises high frequency near duplicate posting from a single
// author, and readers who see you four times an hour mute you. Fewer, better posts
// get more total reach than more posts. 45 minutes is the new default; override with
// POST_INTERVAL_MINUTES if you want to tune it.
const POST_INTERVAL_MINUTES = Math.max(5, Number(process.env.POST_INTERVAL_MINUTES || 45));
const CRON_EXPR =
  POST_INTERVAL_MINUTES >= 60
    ? `0 */${Math.round(POST_INTERVAL_MINUTES / 60)} * * *`
    : `*/${POST_INTERVAL_MINUTES} * * * *`;

/**
 * Whether a post is too recent to publish another one.
 *
 * Used by both the long running scheduler and the one shot runner. On GitHub
 * Actions this is the only thing standing between a retried or duplicated workflow
 * run and two posts in the same minute, so it is exported rather than inlined.
 */
export function tooSoonSinceLastPost() {
  const lastPostTime = getLastPostTime();
  if (lastPostTime <= 0) return null;
  const elapsedMinutes = (Date.now() - lastPostTime) / (60 * 1000);
  if (elapsedMinutes >= POST_INTERVAL_MINUTES * 0.8) return null;
  return { elapsedMinutes, waitMins: Math.ceil(POST_INTERVAL_MINUTES - elapsedMinutes) };
}

export function closeDb() {
  try {
    db.close();
  } catch {}
}

export function printBanner(mode) {
  console.log("=========================================================");
  console.log("⚡ Binance Square Evidence Based Signal Bot");
  console.log(mode === "once" ? "🎯 Mode: single cycle, then exit" : `⏱️  Cron Schedule: every ${POST_INTERVAL_MINUTES} minutes (${CRON_EXPR})`);
  if (DRY_RUN) console.log("🧪 DRY_RUN is set. Posts will be generated and logged but NOT published.");
  console.log("🧭 Chart grade decides the format: TRADE, WATCH or NO_TRADE");
  console.log("📊 Calls are logged and graded against real candles");
  console.log("📁 SQLite DB: " + DB_PATH);
  console.log("=========================================================\n");
}

// Only start the long running scheduler when this file is the entry point.
// `src/runOnce.js` imports the cycle instead, and must not inherit a cron timer
// that would keep the process alive forever on a CI runner.
const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  printBanner("cron");

  const tooSoon = tooSoonSinceLastPost();
  if (tooSoon) {
    console.log(`[startup] ⏳ Last post was published ${tooSoon.elapsedMinutes.toFixed(1)} mins ago.`);
    console.log(`[startup] Waiting ~${tooSoon.waitMins} min for the next scheduled interval to prevent duplicate rapid posting.\n`);
  } else {
    executeRoundRobinCycle();
  }

  cron.schedule(CRON_EXPR, () => {
    executeRoundRobinCycle();
  });

  process.on("SIGINT", () => {
    console.log("\n👋 Stopping Signal Bot...");
    closeDb();
    process.exit(0);
  });
}

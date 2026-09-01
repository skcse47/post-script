#!/usr/bin/env node

/**
 * Standalone Node.js runner — uses node-cron + SQLite for deduplication
 * instead of Cloudflare Workers + KV.
 *
 * Usage:
 *   1. Copy .env.example → .env and fill in your keys.
 *   2. npm install
 *   3. npm run standalone
 */

import cron from "node-cron";
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Re-use core functions from the worker module
import {
  fetchLatestPost,
  rewriteWithGemini,
  publishToBinanceSquare,
} from "./index.js";

// ─── .env loader (zero-dep) ─────────────────────────────────────────────────

import { readFileSync } from "node:fs";

function loadDotEnv() {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const envPath = path.resolve(__dirname, "..", ".env");
    const lines = readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  } catch {
    // .env file is optional if env vars are set externally
  }
}

loadDotEnv();

// ─── Config validation ──────────────────────────────────────────────────────

const BINANCE_SQUARE_API_KEY = process.env.BINANCE_SQUARE_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TARGET_HANDLE = process.env.TARGET_HANDLE || "cryptonexus_btc";

if (!BINANCE_SQUARE_API_KEY || !GEMINI_API_KEY) {
  console.error(
    "❌ Missing required env vars: BINANCE_SQUARE_API_KEY, GEMINI_API_KEY"
  );
  console.error("   Copy .env.example → .env and fill in your API keys.");
  process.exit(1);
}

// ─── SQLite Cache (replaces Cloudflare KV) ──────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "..", "post_cache.db");
const db = new Database(DB_PATH);

// Create table if not exists
db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

/** KV-compatible adapter backed by SQLite */
const kvAdapter = {
  async get(key) {
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
    return row ? row.value : null;
  },
  async put(key, value) {
    db.prepare(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(key, value);
  },
};

// ─── Pipeline ───────────────────────────────────────────────────────────────

const KV_KEY_LATEST_POST = "latest_post_id";

async function runStandalonePipeline() {
  const now = new Date().toISOString();
  console.log(`\n[cron] ────── Cycle start: ${now} ──────`);

  try {
    // 1. Fetch
    const post = await fetchLatestPost(TARGET_HANDLE);
    if (!post) {
      console.log("[pipeline] No post found — exiting cycle.");
      return;
    }

    // 2. Dedup
    const lastId = await kvAdapter.get(KV_KEY_LATEST_POST);
    if (lastId === post.id) {
      console.log(`[pipeline] Post ${post.id} already processed — skipping.`);
      return;
    }
    console.log(
      `[pipeline] New post: ${post.id} (previous: ${lastId || "none"})`
    );

    // 3. Rewrite
    const rewritten = await rewriteWithGemini(post.text, GEMINI_API_KEY);

    // 4. Publish
    await publishToBinanceSquare(rewritten, BINANCE_SQUARE_API_KEY);

    // 5. Persist
    await kvAdapter.put(KV_KEY_LATEST_POST, post.id);
    console.log(`[pipeline] ✅ Cycle complete — stored post ID: ${post.id}`);
  } catch (err) {
    console.error(`[pipeline] ❌ Error: ${err.message}`);
  }
}

// ─── Cron Schedule ──────────────────────────────────────────────────────────

console.log("🚀 Binance Square Reposter — Standalone Mode");
console.log(`   Target handle : ${TARGET_HANDLE}`);
console.log(`   Schedule      : every 5 minutes`);
console.log(`   DB path       : ${DB_PATH}`);
console.log("");

// Run immediately on start, then schedule
runStandalonePipeline();

cron.schedule("*/5 * * * *", () => {
  runStandalonePipeline();
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n👋 Shutting down…");
  db.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  db.close();
  process.exit(0);
});

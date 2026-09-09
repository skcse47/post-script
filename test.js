#!/usr/bin/env node

/**
 * Dry run: fetch live movers, grade them, and print what would be posted.
 * Nothing is published. Pass a format name to force it, e.g.
 *
 *   node test.js NO_TRADE_CALL
 *   node test.js EVIDENCE_SIGNAL
 *   node test.js TRACK_RECORD
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { getMarketMovers, getHotTrendingHashtags, generateTraderPost } from "./src/topGainersBot.js";
import { buildMarketContext, gradeSetup, fmtPx, fmtCompact } from "./src/marketContext.js";

function loadDotEnv() {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const content = readFileSync(path.resolve(__dirname, ".env"), "utf-8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      process.env[trimmed.slice(0, eq).trim()] = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["'](.*)["']$/, "$1");
    }
  } catch {}
}
loadDotEnv();

const forcedFormat = process.argv[2] || null;

let provider = (process.env.LLM_PROVIDER || "").trim().toLowerCase();
if (!provider) provider = process.env.OPENROUTER_API_KEY ? "openrouter" : "gemini";
const model =
  process.env.LLM_MODEL || (provider === "openrouter" ? "qwen/qwen-2.5-7b-instruct" : "gemini-2.0-flash");

function line(char = "─", n = 62) {
  return char.repeat(n);
}

async function main() {
  console.log(line("═"));
  console.log(`Dry run  |  provider: ${provider}  |  model: ${model}`);
  console.log(line("═"));

  const movers = await getMarketMovers(10, 1_000_000);
  const top = (movers.top3?.length ? movers.top3 : movers.queue).slice(0, 3);

  // Grade the whole shortlist first, so you can see the verdict spread. If every
  // coin on the board grades TRADE, the thresholds in gradeSetup are too loose.
  console.log("\nCHART GRADES\n" + line());
  const graded = [];
  for (const coin of top) {
    const ctx = await buildMarketContext(coin);
    const grade = gradeSetup(ctx);
    grade.ctx = ctx;
    graded.push({ coin, ctx, grade });

    console.log(
      `$${coin.baseAsset.padEnd(9)} +${coin.priceChangePercent.toFixed(1).padStart(5)}%  ` +
        `$${fmtPx(coin.lastPrice).padEnd(11)} => ${grade.verdict.padEnd(9)} (score ${grade.score})`
    );
    if (ctx) {
      console.log(
        `           RSI ${ctx.rsi1h?.toFixed(0) ?? "n/a"} | vol ${ctx.volRatio.toFixed(1)}x avg ` +
          `($${fmtCompact(ctx.last24Vol)}) | ${ctx.rangePos.toFixed(0)}% of 24h range | ATR ${ctx.atrPct?.toFixed(1) ?? "n/a"}%`
      );
    }
    grade.reasons.forEach((r) => console.log(`           + ${r}`));
    grade.warnings.forEach((r) => console.log(`           - ${r}`));
    if (grade.levels?.stop) {
      const l = grade.levels;
      console.log(
        `           entry $${fmtPx(l.entryLow)}-$${fmtPx(l.entryHigh)} | stop $${fmtPx(l.stop)} ` +
          `(risk ${l.riskPct.toFixed(1)}%) | TP ${l.targets.map(fmtPx).join(" / ")}`
      );
    }
    console.log("");
  }

  const tradable = graded.filter((g) => g.grade.verdict !== "NO_TRADE");
  console.log(
    `${tradable.length}/${graded.length} charts graded tradable. ` +
      `A healthy feed passes on plenty of them.\n`
  );

  if (!process.env.OPENROUTER_API_KEY && !process.env.GEMINI_API_KEY) {
    console.log("No LLM key in .env, stopping before generation. Grading above still works.");
    return;
  }

  let trendingTopic = null;
  try {
    const hot = await getHotTrendingHashtags(3);
    if (hot?.length) {
      trendingTopic = hot[0];
      console.log(`Trending on Square: ${hot.map((h) => h.hashtag).join(", ")}\n`);
    }
  } catch {}

  const pick = graded[0];
  console.log(line("═"));
  console.log(`SAMPLE POST for $${pick.coin.baseAsset}${forcedFormat ? ` (forced: ${forcedFormat})` : ""}`);
  console.log(line("═") + "\n");

  const post = await generateTraderPost(pick.coin, movers.queue, {
    provider,
    geminiKey: process.env.GEMINI_API_KEY,
    openrouterKey: process.env.OPENROUTER_API_KEY,
    model,
    trendingTopic,
    marketContext: pick.ctx,
    grade: pick.grade,
    format: forcedFormat,
  });

  console.log(post.text);
  console.log("\n" + line());
  console.log(`format: ${post.formatType} | verdict: ${post.verdict} | chars: ${post.text.length}`);
  console.log(post.levels?.stop ? "This post publishes levels, so it would be logged as a gradeable call." : "No levels published, nothing logged as a call.");
  console.log("Nothing was published. This is a dry run.");
}

main().catch((err) => {
  console.error("Dry run failed:", err.message);
  process.exit(1);
});

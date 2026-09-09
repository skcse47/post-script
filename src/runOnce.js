#!/usr/bin/env node

/**
 * Single cycle runner for CI schedulers (GitHub Actions, cron, any one shot host).
 *
 * The long running `standaloneGainers.js` holds a node-cron timer open forever,
 * which never terminates on a CI runner and burns the whole job timeout. This runs
 * exactly one cycle, then exits with a status code the runner can act on.
 *
 * Exit codes:
 *   0  posted, or deliberately skipped because the last post is still recent
 *   1  the cycle failed
 */

import { executeRoundRobinCycle, tooSoonSinceLastPost, closeDb, printBanner } from "./standaloneGainers.js";

const FORCE = /^(1|true|yes)$/i.test(String(process.env.FORCE_POST || ""));

async function main() {
  printBanner("once");

  // A scheduled workflow that is delayed, retried, or manually re-run must not
  // produce a second post minutes after the first.
  const tooSoon = tooSoonSinceLastPost();
  if (tooSoon && !FORCE) {
    console.log(`[once] ⏭️  Last post was ${tooSoon.elapsedMinutes.toFixed(1)} min ago, inside the minimum spacing window.`);
    console.log(`[once] Skipping this run. Set FORCE_POST=1 to override.`);
    return 0;
  }

  const ok = await executeRoundRobinCycle();
  if (!ok) {
    console.error("[once] ❌ Cycle did not complete. Nothing was posted.");
    return 1;
  }
  console.log("[once] ✅ Cycle complete.");
  return 0;
}

main()
  .then((code) => {
    closeDb();
    process.exit(code);
  })
  .catch((err) => {
    console.error(`[once] ❌ Cycle failed: ${err.message}`);
    closeDb();
    process.exit(1);
  });

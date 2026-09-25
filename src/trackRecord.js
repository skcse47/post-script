/**
 * Track Record
 *
 * The old TARGET_HIT_CONGRATS format invented wins. It took the CURRENT price,
 * multiplied it by 1.048 and 1.095, and posted "my call just hit TP1 and TP2" for a
 * trade that had never been posted. Anyone who opened the profile and scrolled back
 * found no such call. That is the fastest way to lose a crypto audience, and it is
 * the thing to delete first if you want people to trust the account.
 *
 * This module replaces it. Every signal posted is written to `trade_calls` with its
 * real entry, stop and targets. Later cycles pull the candles that printed since the
 * call and settle it against what actually happened. Recap posts are then generated
 * from settled rows only, including the losers.
 */

import { fetchKlines, fmtPx } from "./marketContext.js";
import { humanizePunctuation } from "./topGainersBot.js";

export const TRADE_CALLS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS trade_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    base_asset TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'LONG',
    verdict TEXT NOT NULL DEFAULT 'TRADE',
    entry REAL NOT NULL,
    stop REAL NOT NULL,
    tp1 REAL NOT NULL,
    tp2 REAL NOT NULL,
    tp3 REAL NOT NULL,
    risk_pct REAL NOT NULL,
    called_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    result_r REAL,
    resolved_at INTEGER,
    resolved_price REAL
  );
  CREATE INDEX IF NOT EXISTS idx_trade_calls_status ON trade_calls(status);
`;

/** Columns added after the table first shipped. Safe to run on every start. */
export function migrateTradeCalls(db) {
  for (const col of ["share_link TEXT", "update_posted INTEGER DEFAULT 0"]) {
    try {
      db.exec(`ALTER TABLE trade_calls ADD COLUMN ${col}`);
    } catch {}
  }
}

/**
 * Record a signal at the moment it is posted, so it can be graded honestly later.
 */
export function recordCall(db, { symbol, baseAsset, direction, verdict, levels, shareLink = null }) {
  if (!levels || !levels.stop || !levels.targets || levels.targets.length < 3) return null;
  const entry = (levels.entryLow + levels.entryHigh) / 2;
  const info = db
    .prepare(
      `INSERT INTO trade_calls
       (symbol, base_asset, direction, verdict, entry, stop, tp1, tp2, tp3, risk_pct, called_at, share_link)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      symbol,
      baseAsset,
      direction,
      verdict,
      entry,
      levels.stop,
      levels.targets[0],
      levels.targets[1],
      levels.targets[2],
      levels.riskPct,
      Date.now(),
      shareLink
    );
  return info.lastInsertRowid;
}

/**
 * Settle open calls against real candles.
 *
 * Walks candles in order from the call timestamp. Whichever of stop / TP1 is touched
 * first decides the outcome; if the stop and a target are inside the same candle we
 * assume the stop hit first, because we cannot see intra-candle sequence and guessing
 * in our own favour is how fake track records get built.
 *
 * Calls older than `maxAgeHours` with neither level touched are closed at market.
 */
export async function resolveOpenCalls(db, { maxAgeHours = 48 } = {}) {
  const open = db.prepare("SELECT * FROM trade_calls WHERE status = 'OPEN' ORDER BY id ASC LIMIT 25").all();
  if (open.length === 0) return { checked: 0, settled: 0 };

  let settled = 0;
  for (const call of open) {
    try {
      const candles = await fetchKlines(call.symbol, "15m", 200);
      const since = candles.filter((c) => c.closeTime >= call.called_at);
      if (since.length === 0) continue;

      let status = null;
      let resultR = null;
      let price = null;
      // When the deciding candle closed, so the update post can say when it happened.
      let hitAt = null;

      // Shorts are the mirror image: the stop is above, targets below, and a candle's
      // high hits the stop while its low hits a target.
      const isShort = call.direction === "SHORT";
      const risk = isShort ? call.stop - call.entry : call.entry - call.stop;
      const rOf = (target) => (risk > 0 ? (isShort ? call.entry - target : target - call.entry) / risk : 0);
      const hitsStop = (c) => (isShort ? c.high >= call.stop : c.low <= call.stop);
      const hits = (c, t) => (isShort ? c.low <= t : c.high >= t);

      // Best target reached so far. Once TP1 is tagged a real trader takes partials
      // and moves the stop to entry, so a later stop no longer counts as a full loss.
      let bestTier = 0;

      for (const c of since) {
        // Stop wins ties. We cannot see intra-candle sequence, so when a candle spans
        // both the stop and a target we resolve against ourselves rather than
        // inflating the record.
        if (hitsStop(c)) {
          if (bestTier === 0) {
            status = "STOPPED";
            resultR = -1;
            price = call.stop;
            hitAt = c.closeTime;
          }
          break;
        }
        if (hits(c, call.tp3)) {
          bestTier = 3;
          status = "TP3";
          resultR = rOf(call.tp3);
          price = call.tp3;
          hitAt = c.closeTime;
          break;
        }
        if (hits(c, call.tp2) && bestTier < 2) {
          bestTier = 2;
          status = "TP2";
          resultR = rOf(call.tp2);
          price = call.tp2;
          hitAt = c.closeTime;
        } else if (hits(c, call.tp1) && bestTier < 1) {
          bestTier = 1;
          status = "TP1";
          resultR = rOf(call.tp1);
          price = call.tp1;
          hitAt = c.closeTime;
        }
      }

      const ageHours = (Date.now() - call.called_at) / 3_600_000;
      if (!status && ageHours >= maxAgeHours) {
        const last = since[since.length - 1].close;
        status = "EXPIRED";
        resultR = rOf(last);
        price = last;
      }

      if (status) {
        db.prepare(
          "UPDATE trade_calls SET status = ?, result_r = ?, resolved_at = ?, resolved_price = ? WHERE id = ?"
        ).run(status, resultR, Math.min(hitAt ?? Date.now(), Date.now()), price, call.id);
        settled++;
      }
    } catch (err) {
      console.warn(`[track] Could not resolve call #${call.id} (${call.symbol}): ${err.message}`);
    }
  }

  return { checked: open.length, settled };
}

/**
 * Honest stats over settled calls. Returns null when there is not enough history to
 * publish, which matters: a recap of three trades is not a track record, and posting
 * one anyway is the same dishonesty in a smaller costume.
 */
export function getTrackRecord(db, { days = 7, minCalls = 8 } = {}) {
  const since = Date.now() - days * 86_400_000;
  const rows = db
    .prepare("SELECT * FROM trade_calls WHERE called_at >= ? AND status != 'OPEN' ORDER BY called_at ASC")
    .all(since);

  if (rows.length < minCalls) return null;

  const wins = rows.filter((r) => r.status.startsWith("TP"));
  const stopped = rows.filter((r) => r.status === "STOPPED");
  const expired = rows.filter((r) => r.status === "EXPIRED");
  const totalR = rows.reduce((s, r) => s + (r.result_r || 0), 0);

  const best = rows.reduce((a, b) => ((b.result_r || 0) > (a.result_r || 0) ? b : a), rows[0]);
  const worst = rows.reduce((a, b) => ((b.result_r || 0) < (a.result_r || 0) ? b : a), rows[0]);

  const open = db.prepare("SELECT COUNT(*) c FROM trade_calls WHERE status = 'OPEN'").get().c;

  return {
    days,
    total: rows.length,
    wins: wins.length,
    stopped: stopped.length,
    expired: expired.length,
    open,
    winRate: (wins.length / rows.length) * 100,
    totalR,
    avgR: totalR / rows.length,
    best: { asset: best.base_asset, r: best.result_r || 0, status: best.status },
    worst: { asset: worst.base_asset, r: worst.result_r || 0, status: worst.status },
  };
}

/**
 * Build the recap post body from real settled rows.
 *
 * Deliberately assembled in code rather than by the LLM. This is the one post type
 * where a model must not be free to improvise numbers.
 */
export function buildTrackRecordPost(stats, recentRows = []) {
  if (!stats) return null;

  const sign = (r) => (r >= 0 ? `+${r.toFixed(1)}R` : `${r.toFixed(1)}R`);
  const lines = [];

  // Hook leads with the result, good or bad. A net negative week posted honestly
  // earns more trust than a green one, so it gets the same first line treatment.
  lines.push(`My last ${stats.days} days on ${stats.total} calls 📊`);
  lines.push(`${stats.wins} hit a target and ${stats.stopped} hit the stop${stats.expired ? ` with ${stats.expired} flat` : ""}`);
  lines.push(`That is net ${sign(stats.totalR)} risking the same size every time`);
  lines.push("");

  // A handful of closes, written as sentences rather than a table.
  if (recentRows.length > 0) {
    recentRows.slice(0, 4).forEach((r) => {
      const label = r.status === "STOPPED" ? "stopped out" : r.status === "EXPIRED" ? "closed flat" : `hit target ${r.status.slice(2)}`;
      lines.push(`${r.base_asset} ${label} ${sign(r.result_r || 0)} from ${fmtPx(r.entry)}`);
    });
    lines.push("");
  }

  // Cashtags on best and worst only: Square links two coins per post.
  const sameCoin = stats.best.asset === stats.worst.asset;
  lines.push(`Best was $${stats.best.asset} at ${sign(stats.best.r)} and worst ${sameCoin ? "" : "$"}${stats.worst.asset} at ${sign(stats.worst.r)}`);
  if (stats.open > 0) lines.push(`${stats.open} are still running and those get posted too`);
  lines.push("");
  lines.push(`The losers are in there on purpose`);
  lines.push(`Anyone showing you only green screenshots is selling you something`);
  lines.push("");
  lines.push("Which one do you want broken down 👇");
  lines.push("");
  lines.push("#TradingJournal #CryptoTrading");

  return humanizePunctuation(lines.join("\n"));
}

/**
 * Oldest call that hit a target or its stop in the last `maxAgeHours` and has not
 * had its follow up posted. Expired calls are skipped: "nothing happened" is not
 * worth a post. The age window stops a new install announcing week old results.
 */
export function getPendingCallUpdate(db, { maxAgeHours = 24 } = {}) {
  return (
    db
      .prepare(
        `SELECT * FROM trade_calls
         WHERE status IN ('TP1', 'TP2', 'TP3', 'STOPPED')
           AND COALESCE(update_posted, 0) = 0
           AND resolved_at >= ?
         ORDER BY resolved_at ASC LIMIT 1`
      )
      .get(Date.now() - maxAgeHours * 3_600_000) || null
  );
}

export function markCallUpdatePosted(db, id) {
  db.prepare("UPDATE trade_calls SET update_posted = 1 WHERE id = ?").run(id);
}

function hhmmUtc(ms) {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

function agoText(fromMs, toMs) {
  const h = (toMs - fromMs) / 3_600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${Math.round(h)}h`;
}

/**
 * Follow up on a call that just resolved, win or loss.
 *
 * This is the post that makes the rest of the feed believable: a call made in public,
 * with its levels, graded in public against what the candles actually did, linking
 * back to the unedited original. Built in code from the settled row so the model
 * cannot round a loss into a win.
 *
 * `nextTrade` is an optional trade block (see buildTradeBlock) for the best setup
 * right now. A result post is where readers are most ready to act, and "I missed
 * that one" is answered by the next one.
 */
export function buildCallUpdatePost(call, { nextTrade = null } = {}) {
  if (!call) return null;
  const S = `$${call.base_asset}`;
  const took = agoText(call.called_at, call.resolved_at);
  const at = hhmmUtc(call.resolved_at);
  const num = call.status === "TP3" ? 3 : call.status === "TP2" ? 2 : 1;
  const original = call.share_link ? `Same call I posted, nothing edited\n${call.share_link}` : `The original call is on my profile with its timestamp`;
  const lines = [];

  if (String(call.status).startsWith("TP")) {
    const hitPrice = num === 3 ? call.tp3 : num === 2 ? call.tp2 : call.tp1;
    lines.push(`Target ${num} done on ${S} ✅`);
    lines.push(`Called it ${took} ago and it traded there at ${at}`);
    lines.push("");
    lines.push(`Entry was ${fmtPx(call.entry)} with the stop at ${fmtPx(call.stop)}`);
    lines.push(`Target ${num} sat at ${fmtPx(hitPrice)}`);
    lines.push("");
    if (num === 1) {
      lines.push(`Next one up is ${fmtPx(call.tp2)}`);
      lines.push(`Still holding some, stop moved to entry so the rest rides free`);
    } else if (num === 2) {
      lines.push(`Last target is ${fmtPx(call.tp3)}`);
      lines.push(`Stop sits at entry now, no reason to give this back`);
    } else {
      lines.push(`All three targets done, nothing left to manage`);
    }
    lines.push("");
    lines.push(original);
    lines.push("");
    lines.push(`Stop outs get posted the same way, tap ${S} to see where it trades now`);
    if (nextTrade) lines.push("", nextTrade);
    lines.push("");
    lines.push(nextTrade ? `Did you catch ${S}` : `Did you catch this one or wait`);
  } else {
    lines.push(`Stopped out on ${S} ❌`);
    lines.push(`Posting the losers the same way I post the wins`);
    lines.push("");
    lines.push(`Entry was ${fmtPx(call.entry)} and the stop at ${fmtPx(call.stop)}`);
    lines.push(`Price went through it at ${at}, ${took} after the call`);
    lines.push("");
    lines.push(`No moving the stop and no averaging down`);
    lines.push(`It was sized small so this one costs very little`);
    lines.push("");
    lines.push(original);
    lines.push("");
    lines.push(`Tap ${S} to see exactly where it broke`);
    if (nextTrade) lines.push("", nextTrade);
    lines.push("");
    lines.push(`Do you re enter after a stop out or leave it alone`);
  }

  lines.push("");
  lines.push(`#${call.base_asset} #TradingJournal`);
  return humanizePunctuation(lines.join("\n"));
}

/** Coins with a call still open, so they are not signalled twice at once. */
export function getOpenCallAssets(db) {
  return new Set(
    db
      .prepare("SELECT DISTINCT base_asset FROM trade_calls WHERE status = 'OPEN'")
      .all()
      .map((r) => r.base_asset)
  );
}

/** Rows closed since the last recap, newest first. */
export function getRecentCloses(db, limit = 6) {
  return db
    .prepare("SELECT * FROM trade_calls WHERE status != 'OPEN' ORDER BY resolved_at DESC LIMIT ?")
    .all(limit);
}

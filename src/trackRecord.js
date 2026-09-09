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

/**
 * Record a signal at the moment it is posted, so it can be graded honestly later.
 */
export function recordCall(db, { symbol, baseAsset, direction, verdict, levels }) {
  if (!levels || !levels.stop || !levels.targets || levels.targets.length < 3) return null;
  const entry = (levels.entryLow + levels.entryHigh) / 2;
  const info = db
    .prepare(
      `INSERT INTO trade_calls
       (symbol, base_asset, direction, verdict, entry, stop, tp1, tp2, tp3, risk_pct, called_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      Date.now()
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

      const risk = call.entry - call.stop;
      const rOf = (target) => (risk > 0 ? (target - call.entry) / risk : 0);

      // Best target reached so far. Once TP1 is tagged a real trader takes partials
      // and moves the stop to entry, so a later stop no longer counts as a full loss.
      let bestTier = 0;

      for (const c of since) {
        // Stop wins ties. We cannot see intra-candle sequence, so when a candle spans
        // both the stop and a target we resolve against ourselves rather than
        // inflating the record.
        if (c.low <= call.stop) {
          if (bestTier === 0) {
            status = "STOPPED";
            resultR = -1;
            price = call.stop;
          }
          break;
        }
        if (c.high >= call.tp3) {
          bestTier = 3;
          status = "TP3";
          resultR = rOf(call.tp3);
          price = call.tp3;
          break;
        }
        if (c.high >= call.tp2 && bestTier < 2) {
          bestTier = 2;
          status = "TP2";
          resultR = rOf(call.tp2);
          price = call.tp2;
        } else if (c.high >= call.tp1 && bestTier < 1) {
          bestTier = 1;
          status = "TP1";
          resultR = rOf(call.tp1);
          price = call.tp1;
        }
      }

      const ageHours = (Date.now() - call.called_at) / 3_600_000;
      if (!status && ageHours >= maxAgeHours) {
        const last = since[since.length - 1].close;
        status = "EXPIRED";
        resultR = risk > 0 ? (last - call.entry) / risk : 0;
        price = last;
      }

      if (status) {
        db.prepare(
          "UPDATE trade_calls SET status = ?, result_r = ?, resolved_at = ?, resolved_price = ? WHERE id = ?"
        ).run(status, resultR, Date.now(), price, call.id);
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

  lines.push(`My last ${stats.days} days, every call, wins and losses 📊`);
  lines.push("");
  lines.push(
    `${stats.total} calls closed. ${stats.wins} hit a target, ${stats.stopped} stopped out${stats.expired ? `, ${stats.expired} closed flat` : ""}.`
  );
  lines.push(`Win rate ${stats.winRate.toFixed(0)}%. Net ${sign(stats.totalR)} risking 1R per idea.`);
  lines.push("");

  if (recentRows.length > 0) {
    lines.push("Recent closes:");
    recentRows.slice(0, 6).forEach((r) => {
      const label =
        r.status === "STOPPED" ? "stopped" : r.status === "EXPIRED" ? "closed flat" : `${r.status} hit`;
      lines.push(`${r.base_asset} ${label} ${sign(r.result_r || 0)} from $${fmtPx(r.entry)}`);
    });
    lines.push("");
  }

  lines.push(`Best: ${stats.best.asset} ${sign(stats.best.r)}. Worst: ${stats.worst.asset} ${sign(stats.worst.r)}.`);
  if (stats.open > 0) lines.push(`${stats.open} still open, I will post those results too.`);
  lines.push("");
  lines.push(
    `The losers are in there on purpose. Anyone showing you only green screenshots is selling you something.`
  );
  lines.push("");
  lines.push("Which of these do you want me to break down on the chart? 👇");
  lines.push("");
  lines.push("Not financial advice. I post my own levels and my own mistakes.");
  lines.push("#TradingJournal #CryptoTrading");

  return lines.join("\n");
}

/** Rows closed since the last recap, newest first. */
export function getRecentCloses(db, limit = 6) {
  return db
    .prepare("SELECT * FROM trade_calls WHERE status != 'OPEN' ORDER BY resolved_at DESC LIMIT ?")
    .all(limit);
}

/**
 * Market Context Engine
 *
 * Replaces the old "current price x fixed multiplier" level generator with real,
 * checkable market structure pulled from Binance klines.
 *
 * Why this exists: every previous post used the exact same +4.8% / +9.5% / +15.5%
 * targets and a -4.5% stop, on every coin, forever. Anyone who read two posts could
 * see the numbers were synthetic. Levels here come from swing structure and ATR, so
 * they differ per coin and can be defended if a reader asks "why that stop?".
 */

const KLINE_URLS = [
  "https://data-api.binance.vision/api/v3/klines",
  "https://api.binance.com/api/v3/klines",
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/**
 * Fetch OHLCV candles for a symbol.
 */
export async function fetchKlines(symbol, interval = "1h", limit = 200) {
  let lastErr;
  for (const base of KLINE_URLS) {
    try {
      const url = `${base}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!res.ok) {
        lastErr = new Error(`${base} => HTTP ${res.status}`);
        continue;
      }
      const raw = await res.json();
      if (!Array.isArray(raw) || raw.length === 0) {
        lastErr = new Error(`${base} => empty klines`);
        continue;
      }
      return raw.map((k) => ({
        openTime: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: k[6],
        quoteVolume: parseFloat(k[7]),
        trades: Number(k[8]),
      }));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`Failed to fetch klines for ${symbol}`);
}

/** Average True Range over the last `period` candles. */
function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

/** Wilder-smoothed RSI. */
function rsi(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

/**
 * Most recent swing low/high: the lowest low / highest high of the last `lookback`
 * candles, excluding the in-progress candle.
 */
function swing(candles, lookback = 24) {
  const window = candles.slice(-lookback - 1, -1);
  if (window.length === 0) return { low: null, high: null, lowAgo: null, highAgo: null };
  let low = Infinity;
  let high = -Infinity;
  let lowIdx = 0;
  let highIdx = 0;
  window.forEach((c, i) => {
    if (c.low < low) {
      low = c.low;
      lowIdx = i;
    }
    if (c.high > high) {
      high = c.high;
      highIdx = i;
    }
  });
  return {
    low,
    high,
    lowAgo: window.length - lowIdx,
    highAgo: window.length - highIdx,
  };
}

/** Count consecutive green closes at the end of the series. */
function consecutiveGreen(candles) {
  let n = 0;
  for (let i = candles.length - 2; i >= 0; i--) {
    if (candles[i].close > candles[i].open) n++;
    else break;
  }
  return n;
}

function pct(a, b) {
  if (!b) return 0;
  return ((a - b) / b) * 100;
}

/**
 * Build the full evidence set for a coin. Every number here is derived from real
 * candles, so each one is a claim a reader could independently verify on the chart.
 */
export async function buildMarketContext(coin) {
  let h1;
  let m15;
  try {
    [h1, m15] = await Promise.all([
      fetchKlines(coin.symbol, "1h", 200),
      fetchKlines(coin.symbol, "15m", 96),
    ]);
  } catch (err) {
    console.warn(`[context] No kline data for ${coin.symbol}: ${err.message}`);
    return null;
  }

  const price = coin.lastPrice;
  const a = atr(h1, 14);
  const r = rsi(h1, 14);
  const sw24 = swing(h1, 24);
  const sw72 = swing(h1, 72);
  const sw15 = swing(m15, 32);

  // Volume: last 24 candles vs the average 24-candle block over the prior 7 days.
  const last24Vol = h1.slice(-24).reduce((s, c) => s + c.quoteVolume, 0);
  const prior = h1.slice(-168, -24);
  const priorBlocks = Math.max(1, Math.floor(prior.length / 24));
  const priorAvgVol = prior.reduce((s, c) => s + c.quoteVolume, 0) / priorBlocks || last24Vol;
  const volRatio = priorAvgVol > 0 ? last24Vol / priorAvgVol : 1;

  // Where is price sitting inside its own 24h range? 100% = at the highs.
  const rangeHigh = coin.highPrice;
  const rangeLow = coin.lowPrice;
  const rangePos = rangeHigh > rangeLow ? ((price - rangeLow) / (rangeHigh - rangeLow)) * 100 : 50;

  const high7d = Math.max(...h1.slice(-168).map((c) => c.high));
  const low7d = Math.min(...h1.slice(-168).map((c) => c.low));

  const atrPct = a ? (a / price) * 100 : null;
  const greenStreak = consecutiveGreen(h1);

  // Has price already started rolling over from the last hourly high?
  const lastClosed = h1[h1.length - 2];
  const fadingFromHigh = lastClosed ? pct(price, lastClosed.high) : 0;

  return {
    symbol: coin.symbol,
    baseAsset: coin.baseAsset,
    price,
    changePct: coin.priceChangePercent,
    quoteVolume: coin.quoteVolume,

    atr: a,
    atrPct,
    rsi1h: r,
    volRatio,
    last24Vol,
    priorAvgVol,

    rangeHigh,
    rangeLow,
    rangePos,
    high7d,
    low7d,
    pctFrom7dHigh: pct(price, high7d),
    pctFrom7dLow: pct(price, low7d),

    swingLow1h: sw24.low,
    swingLowAgo: sw24.lowAgo,
    swingHigh1h: sw24.high,
    swingHighAgo: sw24.highAgo,
    swingLow3d: sw72.low,
    swingHigh3d: sw72.high,
    swingLow15m: sw15.low,
    swingHigh15m: sw15.high,

    greenStreak,
    fadingFromHigh,
  };
}

/**
 * Grade the setup and derive structure-based levels.
 *
 * This is the honesty valve. A good share of the time it returns verdict
 * "NO_TRADE" - the coin is extended, thin, or already distributing - and the
 * caller posts a "watching, not buying" note instead of another buy call.
 * A feed that is 100% bullish every 15 minutes reads as a bot no matter how
 * well each individual post is written.
 */
export function gradeSetup(ctx) {
  if (!ctx) {
    return {
      verdict: "NO_TRADE",
      direction: "NONE",
      score: 0,
      reasons: [],
      warnings: ["No candle data available for this pair."],
      levels: null,
    };
  }

  const reasons = [];
  const warnings = [];
  let score = 0;

  // --- Evidence for continuation -------------------------------------------
  if (ctx.volRatio >= 3) {
    score += 2;
    reasons.push(
      `24h volume is ${ctx.volRatio.toFixed(1)}x its 7 day average ($${fmtCompact(ctx.last24Vol)} vs $${fmtCompact(ctx.priorAvgVol)})`
    );
  } else if (ctx.volRatio >= 1.6) {
    score += 1;
    reasons.push(`24h volume is ${ctx.volRatio.toFixed(1)}x its 7 day average`);
  } else if (ctx.volRatio < 0.9) {
    score -= 2;
    warnings.push(
      `Volume is only ${ctx.volRatio.toFixed(1)}x average, so this move is not being funded by real participation`
    );
  }

  if (ctx.rangePos >= 80 && ctx.volRatio >= 1.6) {
    score += 1;
    reasons.push(`Holding the top ${(100 - ctx.rangePos).toFixed(0)}% of the 24h range instead of fading`);
  }

  if (ctx.pctFrom7dHigh > -1.5) {
    score += 1;
    reasons.push(`Trading at a 7 day high, prior high was $${fmtPx(ctx.high7d)}`);
  }

  if (ctx.swingLow1h && ctx.price > ctx.swingLow1h) {
    const cushion = ((ctx.price - ctx.swingLow1h) / ctx.price) * 100;
    if (cushion < 12) {
      score += 1;
      reasons.push(
        `Last 1h swing low at $${fmtPx(ctx.swingLow1h)} is ${cushion.toFixed(1)}% away, so invalidation is close and cheap`
      );
    }
  }

  // --- Evidence against ----------------------------------------------------
  if (ctx.rsi1h !== null && ctx.rsi1h >= 78) {
    score -= 2;
    warnings.push(`1h RSI is ${ctx.rsi1h.toFixed(0)}, which is deep into overbought`);
  } else if (ctx.rsi1h !== null && ctx.rsi1h >= 70) {
    score -= 1;
    warnings.push(`1h RSI is ${ctx.rsi1h.toFixed(0)}, so momentum is stretched`);
  }

  if (ctx.changePct >= 40) {
    score -= 2;
    warnings.push(
      `Already up ${ctx.changePct.toFixed(0)}% in 24h. Buying here means buying from whoever bought ${ctx.changePct.toFixed(0)}% lower`
    );
  } else if (ctx.changePct >= 20) {
    score -= 1;
    warnings.push(`Already up ${ctx.changePct.toFixed(0)}% in 24h, so most of the easy move is gone`);
  }

  if (ctx.atrPct !== null && ctx.atrPct > 6) {
    warnings.push(
      `1h ATR is ${ctx.atrPct.toFixed(1)}% of price, so any stop tighter than that gets hit by noise alone`
    );
  }

  if (ctx.quoteVolume < 3_000_000) {
    score -= 1;
    warnings.push(
      `Only $${fmtCompact(ctx.quoteVolume)} of 24h volume, so size moves this book and exits are not guaranteed`
    );
  }

  if (ctx.rangePos < 45 && ctx.changePct > 15) {
    score -= 2;
    warnings.push(`Price has already given back into the lower half of the 24h range, so the pump is being distributed`);
  }

  if (ctx.fadingFromHigh < -4) {
    score -= 1;
    warnings.push(`Already ${Math.abs(ctx.fadingFromHigh).toFixed(1)}% off the last hourly high`);
  }

  // --- Verdict -------------------------------------------------------------
  let verdict;
  let direction;
  if (score >= 3) {
    verdict = "TRADE";
    direction = "LONG";
  } else if (score >= 1) {
    verdict = "WATCH";
    direction = "LONG";
  } else {
    verdict = "NO_TRADE";
    direction = "NONE";
  }

  const levels = verdict === "NO_TRADE" ? buildInvalidationOnly(ctx) : buildLevels(ctx);

  return { verdict, direction, score, reasons, warnings, levels };
}

/**
 * Levels from structure, not from a fixed percentage.
 *
 * The stop sits below the real invalidation point (recent swing low, padded by half
 * an ATR so it is not clipped by noise). Targets are then plain multiples of that
 * risk, which is why the R:R printed in the post is an actual ratio rather than
 * decoration.
 */
function buildLevels(ctx) {
  const price = ctx.price;
  const a = ctx.atr || price * 0.02;

  const structuralStop = ctx.swingLow15m && ctx.swingLow15m < price ? ctx.swingLow15m : ctx.swingLow1h;
  let stop = structuralStop && structuralStop < price ? structuralStop - a * 0.5 : price - a * 2;

  // Never let the stop drift more than 12% away; past that the position size needed
  // to keep risk sane is too small to be worth the fees.
  const maxStopDist = price * 0.12;
  if (price - stop > maxStopDist) stop = price - maxStopDist;

  const risk = price - stop;
  const entryLow = Math.max(stop + risk * 0.15, price - a * 0.6);
  const entryHigh = price + a * 0.15;

  const targets = [1.5, 2.5, 4].map((r) => price + risk * r);

  // Flag targets that sit beyond obvious overhead supply.
  const notes = [];
  if (ctx.high7d && targets[1] > ctx.high7d && price < ctx.high7d) {
    notes.push(`TP2 sits above the 7 day high at $${fmtPx(ctx.high7d)}, which is where sellers are waiting`);
  }

  return {
    entryLow,
    entryHigh,
    stop,
    riskPct: (risk / price) * 100,
    targets,
    targetR: [1.5, 2.5, 4],
    invalidation: structuralStop,
    notes,
  };
}

function buildInvalidationOnly(ctx) {
  return {
    entryLow: null,
    entryHigh: null,
    stop: null,
    riskPct: null,
    targets: [],
    targetR: [],
    invalidation: ctx.swingLow1h,
    // What would have to happen for this to become interesting.
    trigger: ctx.swingHigh1h,
    reclaim: ctx.swingLow1h,
    notes: [],
  };
}

/**
 * Grade a short (dump) setup: a coin that pumped hard and is already rolling over.
 *
 * Only real pumps qualify. Shorting something that is still printing new highs is
 * how accounts get run over, so that counts against the setup rather than for it.
 * Levels mirror buildLevels: the stop sits above the recent swing high, padded by
 * half an ATR, and targets are multiples of that risk below entry.
 */
export function gradeShortSetup(ctx) {
  const none = { verdict: "NO_TRADE", direction: "SHORT", score: 0, reasons: [], warnings: [], levels: null };
  if (!ctx || !(ctx.changePct >= 15)) return none;

  const reasons = [];
  const warnings = [];
  let score = 0;

  if (ctx.changePct >= 40) {
    score += 2;
    reasons.push(`Up ${ctx.changePct.toFixed(0)}% in 24h, so most buyers are already in`);
  } else {
    score += 1;
    reasons.push(`Up ${ctx.changePct.toFixed(0)}% in 24h`);
  }

  if (ctx.fadingFromHigh <= -3) {
    score += 1;
    reasons.push(`Already ${Math.abs(ctx.fadingFromHigh).toFixed(1)}% off the last hourly high`);
  }
  if (ctx.rangePos < 65) {
    score += 1;
    reasons.push(`Price has slipped back to ${ctx.rangePos.toFixed(0)}% of the 24h range`);
  }
  if (ctx.rsi1h !== null && ctx.rsi1h >= 75) {
    score += 1;
    reasons.push(`1h RSI is ${ctx.rsi1h.toFixed(0)}, deep overbought`);
  }

  if (ctx.rangePos >= 90 && ctx.fadingFromHigh > -1.5) {
    score -= 2;
    warnings.push(`Still trading at the highs, so shorting here is shorting strength`);
  }
  if (ctx.quoteVolume < 3_000_000) {
    score -= 1;
    warnings.push(`Only $${fmtCompact(ctx.quoteVolume)} of 24h volume`);
  }

  const verdict = score >= 3 ? "TRADE" : score >= 2 ? "WATCH" : "NO_TRADE";
  return {
    verdict,
    direction: "SHORT",
    score,
    reasons,
    warnings,
    levels: verdict === "NO_TRADE" ? null : buildShortLevels(ctx),
  };
}

function buildShortLevels(ctx) {
  const price = ctx.price;
  const a = ctx.atr || price * 0.02;

  const structural = ctx.swingHigh15m && ctx.swingHigh15m > price ? ctx.swingHigh15m : ctx.swingHigh1h;
  let stop = structural && structural > price ? structural + a * 0.5 : price + a * 2;
  const maxStopDist = price * 0.12;
  if (stop - price > maxStopDist) stop = price + maxStopDist;

  const risk = stop - price;
  const entryLow = price - a * 0.15;
  const entryHigh = Math.min(stop - risk * 0.15, price + a * 0.6);
  // A target can never be at or below zero; floor it at 5% of price.
  const targets = [1.5, 2.5, 4].map((r) => Math.max(price - risk * r, price * 0.05));

  return {
    entryLow,
    entryHigh,
    stop,
    riskPct: (risk / price) * 100,
    targets,
    targetR: [1.5, 2.5, 4],
    invalidation: structural,
    notes: [],
  };
}

/**
 * Reasons in plain words for a signal post, strongest first. Short sentences a new
 * trader understands, each carrying its real number. Used as the fallback when the
 * model is unavailable, and handed to the model as the facts to rephrase.
 */
export function plainReasons(ctx, direction = "LONG") {
  if (!ctx) return [];
  const out = [];
  if (direction === "SHORT") {
    out.push(`It pumped ${ctx.changePct.toFixed(0)}% in one day. Most buyers are already in.`);
    if (ctx.fadingFromHigh <= -3) out.push(`Price already fell ${Math.abs(ctx.fadingFromHigh).toFixed(1)}% from the top.`);
    if (ctx.rsi1h !== null && ctx.rsi1h >= 70) out.push(`RSI is ${ctx.rsi1h.toFixed(0)}. That is very overbought.`);
    if (ctx.rangePos < 65) out.push(`It dropped back to the middle of today's range. Sellers are stepping in.`);
    if (ctx.volRatio >= 1.6) out.push(`Volume is ${ctx.volRatio.toFixed(1)}x normal, so a drop can move fast.`);
  } else {
    if (ctx.volRatio >= 1.6) out.push(`Volume is ${ctx.volRatio.toFixed(1)}x higher than normal. Big buyers are active.`);
    if (ctx.rangePos >= 80) out.push(`Price is holding near today's high, not falling back.`);
    if (ctx.pctFrom7dHigh > -1.5) out.push(`It is pushing through its 7 day high.`);
    if (ctx.rsi1h !== null && ctx.rsi1h >= 50 && ctx.rsi1h < 70) out.push(`RSI is ${ctx.rsi1h.toFixed(0)}. Strong, but not overheated yet.`);
    if (ctx.changePct > 0) out.push(`It is up ${ctx.changePct.toFixed(0)}% today and still holding.`);
  }
  return out.slice(0, 3);
}

export function fmtCompact(n) {
  if (!n && n !== 0) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

export function fmtPx(num) {
  if (num === null || num === undefined || Number.isNaN(num)) return "n/a";
  if (num >= 1000) return num.toFixed(2);
  if (num >= 1) return num.toFixed(4);
  if (num >= 0.01) return num.toFixed(5);
  if (num >= 0.0001) return num.toFixed(6);
  return num.toFixed(8);
}

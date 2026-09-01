# Binance Square Top Movers (Gainers + Losers) Signal Bot

An automated service that fetches live **24h Top 5 USDT Gainers** and **Top 5 USDT Losers** directly from the official public Binance API, creates a **10-coin Round-Robin queue**, and posts one unique technical setup every **10 minutes** to **Binance Square** using **OpenRouter** or **Google Gemini**.

---

## 🔄 10-Minute Round-Robin Rotation Schedule

```
[00 min] 🟢 Gainer #1  ->  Bullish Momentum / Long Breakout Scalp
[10 min] 🟢 Gainer #2  ->  Bullish Long Continuation
[20 min] 🟢 Gainer #3  ->  Bullish Support Retest
[30 min] 🟢 Gainer #4  ->  Bullish Volume Breakout
[40 min] 🟢 Gainer #5  ->  Bullish Scalp Setup
[50 min] 🔴 Loser #1   ->  Bearish Short Breakdown Scalp
[60 min] 🔴 Loser #2   ->  Oversold Relief Bounce (Dip Buy)
[70 min] 🔴 Loser #3   ->  Bearish Short Breakdown Scalp
[80 min] 🔴 Loser #4   ->  Oversold Relief Bounce (Dip Buy)
[90 min] 🔴 Loser #5   ->  Bearish Short Scalp
────────────────────────────────────────────────────────────
[100 min] 🔄 Refreshes fresh Top 5 Gainers & Losers and restarts rotation!
```

---

## 🚀 Quick Start

### 1. Configure `.env`
```ini
# Binance Square OpenAPI Key
BINANCE_SQUARE_API_KEY=your_binance_square_api_key_here

# LLM Provider ('openrouter' or 'gemini')
LLM_PROVIDER=openrouter

# OpenRouter Configuration
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxxxxxxxxxx
LLM_MODEL=qwen/qwen-2.5-7b-instruct

# Gemini Configuration (Optional if using OpenRouter)
GEMINI_API_KEY=your_gemini_api_key_here
```

### 2. Run Standalone (Node.js)
```bash
# Start the 10-minute automated cron runner
npm run gainers
# or
npm start
```

### 3. Quick 1-Shot Test
```bash
npm test
```

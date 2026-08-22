# Dip Hunter Crypto Bot - Algorithmic Trading System

**Modern, full-featured algorithmic trading system for Binance Futures Testnet with web dashboard, risk engine, and 7/24 autonomous operation.**

---

## 🏗️ Architecture

```
[Web Dashboard] <--REST API--> [Node.js Server] <--CCXT--> [Binance Testnet]
     ↑                                   ↑
  Settings                            Technical Analysis
  Persistence                           (RSI + Bollinger + Regime)
```

---

## ✨ Features

### Core Trading

- **Strategy**: RSI + Bollinger Bands (core) — Stoch RSI removed from core, available as optional confirmation
- **LONG + SHORT**: Full support for both long and short positions
- **Multi-timeframe**: 
  - Execution timeframe (default: 15m) — signal generation
  - Higher timeframe (default: 1h) — trend/regime filtering
  - Regime timeframe (default: 4h) — market regime detection
  - All configurable via web dashboard
- **Market Regime Engine**: STRONG_BULL | BULL | RANGE | BEAR | HIGH_VOLATILITY | RANGE | CHOPPY | UNKNOWN
  - UNKNOWN regime: NO TRADE
  - Filters out choppy/range markets
- **Signal Score**: 0-100 scale with core conditions + filters + confirmations
- **Risk Engine**: Position sizing based on risk % / stop distance, max daily loss, max consecutive losses, max trades per day
- **Stop Loss / Take Profit**: ATR-based trailing stop, TP1/TP2 with partial close, break-even support
- **Cooldown**: Persistent cooldown tracking between trades

### Risk Management

- **Risk per trade**: Configurable percentage of capital (default: 0.5%)
- **Position sizing**: `risk_budget / stop_distance`
- **Maximum leverage**: Configurable (default: 5x)
- **Maximum daily loss**: Percentage limit per day
- **Maximum consecutive losses**: Stop after N losing trades
- **Maximum trades per day**: Trade count limit
- **Volatility-adjusted risk**: Risk reduced when volatility is high

### Persistence & State

- **Persistent state**: `data/settings.json` — survives restarts and redeploys
- **Order reconciliation**: On startup, compares local state with Binance actual positions
- **Audit log**: Every setting change logged with timestamp, old value, new value
- **Strategy versioning**: `strategyVersion` field tracks strategy iterations

### Web Dashboard

- **Settings panel**: Configure all trading parameters from the UI
- **Live analysis panel**: RSI, Bollinger, regime, score, decision display
- **Trade journal**: Complete trade history with PnL, fees, regime, reasons
- **Equity curve**: Equity over time visualization
- **Performance reports**: Daily/7D/30D/All-time metrics
- **Emergency stop**: Stop new trades, close all positions, or both
- **System states**: ANALYZING | WAITING | COOLDOWN | SIGNAL_DETECTED | RISK_REJECTED | POSITION_OPEN | EMERGENCY_STOP | API_ERROR | DATA_STALE | MARKET_CLOSED | RECOVERY | DISABLED

### Configuration

- **Trading parameters**: ALL configurable from web dashboard — NO need to edit ENV
- **Secrets**: Binance API keys, Telegram tokens — remain in ENV only
- **Defaults**: Strategy: RSI+Bollinger, RSI: 20, Bollinger: 30/2, Timeframes: 15m/1h/4h, Risk: 0.5%, Leverage: 5x

### Environment Variables (SECRETS ONLY)

| Variable | Purpose |
|---|---|
| `BINANCE_TESTNET_API_KEY` | Binance testnet API key |
| `BINANCE_TESTNET_SECRET_KEY` | Binance testnet secret key |
| `USE_TESTNET` | `true` = testnet, `false` = real account |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Telegram chat ID |
| `PORT` | Server port |
| `COMMISSION_RATE` | Trade commission % |
| `NODE_ENV` | Environment mode |

⚠️ **Trading parameters (timeframe, RSI, Bollinger, risk, etc.) MUST NOT be set in ENV — use the web dashboard instead.**

---

## 📦 Installation

```bash
npm install
cp .env.example .env
# Edit .env with your Binance testnet credentials
npm run dev  # development with nodemon
npm start    # production
```

---

## 🎛️ Web Dashboard Endpoints

### GET /api/settings - Get all settings
### PUT /api/settings - Update settings (body: `{ riskPerTrade: 0.35, bbLength: 34, ... }`)
### GET /api/settings/change-log - Audit log of all changes
### GET /api/settings/defaults - Default configuration values

### GET /api/trader - Bot status, position, last analysis
### POST /api/trader/check - Run immediate analysis cycle
### POST /api/trader/analyze - Run analysis only
### GET /api/trader/price - Current price
### GET /api/trader/history - Trade history and performance summary
### POST /api/trader/reset - Reset bot state
### POST /api/trader/close - Close existing position
### POST /api/trader/open - Manual order (advanced)

### POST /api/webhook - TradingView webhook receiver
### GET /api/health - Health check

---

## 📸 Dashboard Screenshots

### Main Dashboard

```
┌───────────────────────────────────────┐
│  DIP HUNTER CRYPTO BOT                 │
│  Status: ONLINE | DRY-RUN | TESTNET   │
├───────────────────────────────────────┤
│  BTC/USDT: $104,250                    │
│  4H: BULLISH | 1H: BULLISH | 15M: LONG │
│                                        │
│  RSI: 31.4 | RSI MA: 28.7              │
│  Bollinger: LOWER → MIDDLE             │
│  Volume: 1.42x | Volatility: NORMAL    │
│  Chop: PASS                              │
│                                        │
│  Signal: 84/100                        │
│  Decision: LONG                        │
├───────────────────────────────────────┤
│  STRATEGY                                │
│  RSI Length: 20                        │
│  RSI MA Length: 20                     │
│  Bollinger Length: 30                  │
│  Bollinger Std: 2                      │
│  Execution: 15m | Higher: 1h           │
│  Regime: 4h                            │
│                                        │
│  RISK                                    │
│  Risk/Trade: 0.5%                      │
│  Max Leverage: 5x                      │
│  Daily Loss: 2%                        │
│  Max Trades/Day: 10                    │
│                                        │
│  SAFETY                                  │
│  Dry Run: ON | Trading: ON             │
│  Emergency Stop: [BUTTON]              │
├───────────────────────────────────────┤
│  LAST DECISION                           │
│  DECISION: NO TRADE                      │
│  RSI CROSS: PASS | BOLLINGER: PASS      │
│  TREND: FAIL | REGIME: CHOPPY           │
│  VOLUME: PASS | RISK: PASS             │
│  FINAL: REJECTED                        │
│  REASON: Market regime is CHOPPY.       │
└───────────────────────────────────────┘
```

### Settings Panel

```
STRATEGY
├── Strategy Version: 1.0.0 (read-only)
├── Strategy: RSI + Bollinger (core)
├── RSI Length: [20] "RSI hesaplama periyodu."
├── RSI MA Length: [20] "RSI hareketli ortalamasi periyodu."
├── Bollinger Length: [30] "Bollinger Band uzunlugu (SMA periyodu)."
├── Bollinger Std: [2] "Standart sapma katsayisi."
├── Execution Timeframe: [15m] "Emir calistirilacak timeframe."
├── Higher Timeframe: [1h] "Piyasay regimi icin higher timeframe."
└── Regime Timeframe: [4h] "Market regimi tespiti icin timeframe."

RISK
├── Risk Per Trade: [0.5%] "Bir islemde kaybedilecek maksimum sermaye yuzdesi."
├── Maximum Leverage: [5x] "Botun kullanabilecegi maksimum kaldıraç."
├── Maximum Daily Loss: [2%] "Gunluk maksimum kaybetilebilir loss percentage."
├── Maximum Drawdown: [8%] "Maksimum drawdown orani (%8 = %8'e ucertan sonra dur)."
├── Maximum Consecutive Losses: [3] "Ard arda kaybedilen islem sayisi limiti."
├── Cooldown (minutes): [60] "Pozisyon kapandıktan sonra yeni pozisyon acmadanonce beklenecek sure."
└── Maximum Trades Per Day: [10] "Gun içinde maksimum islem sayisi."

SAFETY
├── Dry Run: [ON/OFF] "Gerçek emir gönderip göndermeyecegi."
├── Trading Enabled: [ON/OFF] "Botun otonom olarak trade etmesine izin ver."
└── Allow Short: [ON] "Kısa (short) pozisyon açmaya izin ver."
```

---

## 🔒 Security

- **API keys never sent to frontend** — remain on server, masked in ENV
- **Manual trading endpoints** protected — use `/api/trader/open` and `/api/trader/close` with care
- **Webhook secret verification** — TradingView webhook must include valid signature
- **Admin actions** require explicit confirmation
- **Fail-closed behavior** — system defaults to NO TRADE on any error

---

## 🚀 Deployment

### Render.com

1. Create new Web Service from GitHub repo
2. Build Command: `npm install`
3. Start Command: `node server.js`
4. Add Environment Variables (secrets only):
   - `BINANCE_TESTNET_API_KEY`
   - `BINANCE_TESTNET_SECRET_KEY`
   - `USE_TESTNET=true`
   - `TELEGRAM_BOT_TOKEN` (optional)
   - `TELEGRAM_CHAT_ID` (optional)
   - `COMMISSION_RATE=0.001`
5. Deploy — dashboard available at `https://your-app.onrender.com`

### Railway / Fly.io / VPS

Same setup — just ensure `node server.js` starts the application.

---

## 🧪 Testing

### Unit Tests (recommended)

```bash
# Run existing test scripts
node test_settings.js    # Settings service
node test_risk.js        # Risk engine
node test_strategy.js    # Strategy logic
```

### Integration Points

- Web dashboard → API → Settings service → Persistent state
- Trading engine → Risk engine → Position sizing → Order service → Binance
- Market regime filtering → Signal score → Entry logic → Cooldown

---

## 📜 License

MIT
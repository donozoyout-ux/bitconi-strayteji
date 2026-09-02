# Railway TESTNET Deployment

This project is configured for Binance Futures TESTNET/Demo forward execution with Google Sheets as persistent storage.

## 1. Railway services

Create one Railway web service from this GitHub repository.

A Railway PostgreSQL service is **not required**. `DATABASE_URL` can be removed.

Before deploying, complete `SHEETS_SETUP.md` and create the Google Sheets Apps Script backend.

## 2. Required web-service variables

```text
NODE_ENV=production
DEPLOY_CONFIG=canonical
USE_TESTNET=true
DRY_RUN=false
EMERGENCY_STOP=false
TRADING_MODE=on
ALLOW_LIVE_TRADING=false

BINANCE_TESTNET_API_KEY=<secret>
BINANCE_TESTNET_SECRET_KEY=<secret>

GOOGLE_SHEETS_WEBAPP_URL=<Apps Script /exec URL>
GOOGLE_SHEETS_SECRET=<same secret as BOT_SHEETS_SECRET>
SHEET_REQUIRED=true

ADMIN_API_TOKEN=<long-random-secret>
WEBHOOK_SECRET=<different-long-random-secret>

TELEGRAM_BOT_TOKEN=<optional-secret>
TELEGRAM_CHAT_ID=<optional-id>
```

## 3. Railway deploy settings

Build: automatic Railpack / Node detection (Node 22.x).

Pre-deploy command:

```text
npm run railway:predeploy
```

Start command:

```text
npm start
```

Healthcheck path:

```text
/ready
```

`/health` is liveness only. `/ready` returns HTTP 200 only when canonical config parity, TESTNET safety and required Google Sheets storage are healthy.

## 4. Storage layout

The Apps Script automatically creates:

```text
STATE
TRADES
ORDERS
DECISIONS
CHECKPOINTS
CANDIDATES
```

`STATE` keeps restart-recovery runtime data. Trade/order history is stored in its own tabs so the runtime JSON never grows beyond a single-cell limit.

## 5. Expected runtime

```text
GET /ready
GET /api/runtime
GET /api/status
GET /api/learning
```

Expected `/ready` storage state:

```json
{
  "storage": {
    "mode": "google_sheets",
    "connected": true,
    "required": true,
    "error": null
  }
}
```

Expected strategy candidate:

```text
strategy: trend_capture_v3_a
strategyVersion: EXIT_B3_M3_SHORT_H1_ADX25
execution: 15m
higher: 1h
regime: 4h
riskPerTrade: 0.5%
shortAdxFloor: 25
exitStrategy: trend
ATR trailing multiplier: 3.0
hard SL: 2.5%
```

## 6. Learning loop

- Every 7 closed trades: new checkpoint in `CHECKPOINTS`.
- Every 21 trades: repeated candidate pattern confirmation.
- Candidate strategy changes go to `CANDIDATES`.
- `autoApply=false`: the bot never edits the active strategy by itself.

## 7. Admin protection

Mutating routes require `X-Admin-Token`.

The trading webhook requires `X-Webhook-Secret`.

Do not commit secrets to GitHub.

## 8. Forward-test rule

Do not force manual trades to create a sample. Allow authentic strategy signals to open TESTNET trades. Keep strategy/risk parameters frozen while collecting the first forward sample.

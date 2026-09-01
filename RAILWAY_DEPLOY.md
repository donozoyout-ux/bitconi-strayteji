# Railway TESTNET Deployment

This project is intentionally configured for Binance Futures TESTNET forward execution.

## 1. Railway services

Create one Railway project with:

- Web service from this GitHub repository
- PostgreSQL service

Expose `DATABASE_URL` from the PostgreSQL service to the web service.

## 2. Required web-service variables

Set these in Railway Variables:

```text
NODE_ENV=production
DEPLOY_CONFIG=canonical
USE_TESTNET=true
DRY_RUN=false
EMERGENCY_STOP=false
TRADING_MODE=on

BINANCE_TESTNET_API_KEY=<secret>
BINANCE_TESTNET_SECRET_KEY=<secret>

ADMIN_API_TOKEN=<long-random-secret>
WEBHOOK_SECRET=<different-long-random-secret>

TELEGRAM_BOT_TOKEN=<optional-secret>
TELEGRAM_CHAT_ID=<optional-id>
```

`ALLOW_LIVE_TRADING` must remain unset/false for TESTNET. The application forces TESTNET unless that separate live-trading switch is explicitly enabled.

## 3. Railway deploy settings

Build: automatic Railpack / Node detection.

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

The `/health` route is only a liveness check. `/ready` returns HTTP 200 only after the startup gate confirms DB health, canonical config parity and TESTNET safety.

## 4. Expected runtime

Read-only status:

```text
GET /api/runtime
GET /api/status
GET /ready
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

## 5. Admin protection

Mutating routes require:

```text
X-Admin-Token: <ADMIN_API_TOKEN>
```

The trading webhook requires:

```text
X-Webhook-Secret: <WEBHOOK_SECRET>
```

Do not put either secret in frontend JavaScript or commit them to GitHub.

## 6. Forward-test rule

Do not force manual trades to create a sample. Allow authentic strategy signals to open TESTNET trades. Keep strategy/risk parameters frozen while collecting the first forward sample.

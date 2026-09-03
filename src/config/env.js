const dotenv = require('dotenv');

dotenv.config();

const env = {};

const requestedTestnet = (process.env.USE_TESTNET || 'true') === 'true';
const allowLiveTrading = process.env.ALLOW_LIVE_TRADING === 'true';

// Safety default: TESTNET. Live Binance requires explicit opt-in.
const useTestnet = requestedTestnet || !allowLiveTrading;

env.environment = process.env.NODE_ENV || 'development';
env.platform = process.env.RAILWAY_ENVIRONMENT ? 'railway' : 'local';
env.useTestnet = useTestnet;
env.isTestnet = useTestnet;
env.allowLiveTrading = allowLiveTrading;

// Binance credentials always come from Railway/environment variables.
env.binanceApiKey = useTestnet
  ? (process.env.BINANCE_TESTNET_API_KEY || process.env.BINANCE_API_KEY || '')
  : (process.env.BINANCE_API_KEY || '');
env.binanceSecret = useTestnet
  ? (process.env.BINANCE_TESTNET_SECRET_KEY || process.env.BINANCE_SECRET_KEY || '')
  : (process.env.BINANCE_SECRET_KEY || '');

env.telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
env.telegramChatId = process.env.TELEGRAM_CHAT_ID || '';

// Google Sheets is OFF by default. Old/stale Google credentials on Railway are ignored
// unless GOOGLE_SHEETS_ENABLED=true is explicitly set. Sheets can never block TESTNET trades.
env.googleSheetsEnabled = process.env.GOOGLE_SHEETS_ENABLED === 'true';
env.googleServiceAccountEmail = env.googleSheetsEnabled ? (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '') : '';
env.googlePrivateKey = env.googleSheetsEnabled ? (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n') : '';
env.googleSheetsSpreadsheetId = env.googleSheetsEnabled ? (process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '') : '';
env.googleSheetsSyncMinutes = Math.max(1, parseInt(process.env.GOOGLE_SHEETS_SYNC_MINUTES || '5', 10) || 5);
env.sheetRequired = false;

// TESTNET execution is intentionally enabled and non-dry-run for the current forward test.
// Live mode still requires explicit safety switches.
env.tradingEnabled = useTestnet ? true : (process.env.TRADING_MODE || 'off') === 'on';
env.dryRun = useTestnet ? false : process.env.DRY_RUN !== 'false';
env.emergencyStop = useTestnet ? false : process.env.EMERGENCY_STOP === 'true';

// Runtime configuration
env.analysisTimeframe = process.env.ANALYSIS_TIMEFRAME || '15m';
env.port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
env.checkIntervalMin = parseInt(process.env.CHECK_INTERVAL_MIN || '5', 10);
env.budgetUsdt = parseFloat(process.env.BUDGET_USDT || '500');
env.tpPercent = parseFloat(process.env.TP_PERCENT || '5');
env.slPercent = parseFloat(process.env.SL_PERCENT || '2.5');
env.commissionRate = parseFloat(process.env.COMMISSION_RATE || '0.001');
env.cooldownMin = parseInt(process.env.COOLDOWN_MIN || '60', 10);
env.tradingSymbol = process.env.TRADING_SYMBOL || 'BTC/USDT';
env.oversoldLevel = parseInt(process.env.STOCH_OVERSOLD || '20', 10);
env.useRsi2 = process.env.USE_RSI2 === 'true';
env.strategyMode = process.env.STRATEGY_MODE || 'regime';

// Risk engine defaults remain active.
env.adxMin = 18;
env.atrStopMult = 2.0;
env.atrTrailMult = 2.5;
env.timeExitCandles = 5;
env.partialTpPercent = 50;
env.maxBudgetMultiplier = 3;
env.allowSymbols = ['BTC/USDT'];

if (!env.binanceApiKey || !env.binanceSecret) {
  console.warn('[WARN] Binance TESTNET API credentials are missing. Orders cannot be sent until keys are configured.');
}

if (!env.telegramBotToken || !env.telegramChatId) {
  console.warn('[WARN] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing. Trade notifications are disabled.');
}

if (!env.googleSheetsEnabled) {
  console.log('[STORAGE] Google Sheets disabled. Local runtime persistence active; TESTNET trading unaffected.');
} else if (!env.googleServiceAccountEmail || !env.googlePrivateKey || !env.googleSheetsSpreadsheetId) {
  console.warn('[STORAGE] Google Sheets enabled but credentials are incomplete; local fallback active.');
}

if (!requestedTestnet && !allowLiveTrading) {
  console.warn('[SAFETY] USE_TESTNET=false requested without ALLOW_LIVE_TRADING=true. TESTNET forced on.');
}

if (!useTestnet && env.tradingEnabled && !env.dryRun) {
  console.warn('[WARNING] LIVE BINANCE TRADING IS ENABLED.');
}

module.exports = env;

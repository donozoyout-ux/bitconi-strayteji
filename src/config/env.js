const dotenv = require('dotenv');

dotenv.config();

const env = {};

const requestedTestnet = (process.env.USE_TESTNET || 'true') === 'true';
const allowLiveTrading = process.env.ALLOW_LIVE_TRADING === 'true';

// Safety default: TESTNET. Production/live Binance requires an explicit second switch.
const useTestnet = requestedTestnet || !allowLiveTrading;

env.environment = process.env.NODE_ENV || 'development';
env.platform = process.env.RAILWAY_ENVIRONMENT ? 'railway' : (process.env.RENDER === 'true' ? 'render' : 'local');
env.useTestnet = useTestnet;
env.isTestnet = useTestnet;
env.allowLiveTrading = allowLiveTrading;

// Secrets must come from the hosting environment. Never keep credentials in source code.
env.binanceApiKey = useTestnet
  ? (process.env.BINANCE_TESTNET_API_KEY || process.env.BINANCE_API_KEY || '')
  : (process.env.BINANCE_API_KEY || '');
env.binanceSecret = useTestnet
  ? (process.env.BINANCE_TESTNET_SECRET_KEY || process.env.BINANCE_SECRET_KEY || '')
  : (process.env.BINANCE_SECRET_KEY || '');

env.telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
env.telegramChatId = process.env.TELEGRAM_CHAT_ID || '';

// Google Sheets persistent storage (replaces PostgreSQL).
env.googleSheetsWebAppUrl = process.env.GOOGLE_SHEETS_WEBAPP_URL || '';
env.googleSheetsSecret = process.env.GOOGLE_SHEETS_SECRET || '';
env.sheetRequired = (process.env.SHEET_REQUIRED || (env.environment === 'production' ? 'true' : 'false')) === 'true';

// Trading control flags
env.tradingEnabled = (process.env.TRADING_MODE || 'on') !== 'off';
env.dryRun = process.env.DRY_RUN !== 'false';
env.emergencyStop = process.env.EMERGENCY_STOP === 'true';

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

// Risk engine defaults. Canonical strategy settings are resolved by settings.service.
env.adxMin = 18;
env.atrStopMult = 2.0;
env.atrTrailMult = 2.5;
env.timeExitCandles = 5;
env.partialTpPercent = 50;
env.maxBudgetMultiplier = 3;
env.allowSymbols = ['BTC/USDT'];

if (!env.binanceApiKey || !env.binanceSecret) {
  console.warn('[WARN] Binance API credentials are missing. Trading/exchange-auth checks will stay unavailable.');
}

if (!env.telegramBotToken || !env.telegramChatId) {
  console.warn('[WARN] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured. Notifications disabled.');
}

if (!env.googleSheetsWebAppUrl || !env.googleSheetsSecret) {
  console.warn('[WARN] Google Sheets storage is not configured. Set GOOGLE_SHEETS_WEBAPP_URL and GOOGLE_SHEETS_SECRET.');
}

if (!requestedTestnet && !allowLiveTrading) {
  console.warn('[SAFETY] USE_TESTNET=false was requested but ALLOW_LIVE_TRADING is not true. TESTNET forced on.');
}

if (!useTestnet && env.tradingEnabled && !env.dryRun) {
  console.warn('[WARNING] LIVE BINANCE TRADING IS ENABLED.');
}

// Legacy Google Form bridge remains optional during migration.
env.googleFormUrl = process.env.GOOGLE_FORM_URL || '';
try {
  if (process.env.GOOGLE_FORM_FIELDS) env.googleFormFields = JSON.parse(process.env.GOOGLE_FORM_FIELDS);
} catch (e) {
  console.warn('[WARN] GOOGLE_FORM_FIELDS is not valid JSON.');
}

module.exports = env;

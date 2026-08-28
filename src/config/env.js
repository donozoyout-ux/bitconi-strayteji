const dotenv = require('dotenv');

dotenv.config();

const env = {};
const useTestnet = (process.env.USE_TESTNET || 'true') === 'true';

// Runtime / infrastructure
env.environment = process.env.NODE_ENV || 'development';
env.useTestnet = useTestnet;
env.isTestnet = useTestnet;
env.port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Secrets MUST come from environment variables. Never hardcode exchange credentials.
env.binanceApiKey = process.env.BINANCE_API_KEY || process.env.BINANCE_TESTNET_API_KEY || '';
env.binanceSecret = process.env.BINANCE_SECRET_KEY || process.env.BINANCE_TESTNET_SECRET_KEY || '';
env.telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
env.telegramChatId = process.env.TELEGRAM_CHAT_ID || '';
env.adminApiToken = process.env.ADMIN_API_TOKEN || '';
env.webhookSecret = process.env.WEBHOOK_SECRET || '';

// Trading control flags
env.tradingEnabled = (process.env.TRADING_MODE || 'on') !== 'off';
env.dryRun = process.env.DRY_RUN !== 'false';
env.emergencyStop = process.env.EMERGENCY_STOP === 'true';

// Trading configuration
env.analysisTimeframe = process.env.ANALYSIS_TIMEFRAME || '1d';
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

// Risk engine defaults
env.adxMin = 18;
env.atrStopMult = 2.0;
env.atrTrailMult = 2.5;
env.timeExitCandles = 5;
env.partialTpPercent = 50;
env.maxBudgetMultiplier = 3;
env.allowSymbols = ['BTC/USDT'];

// Database configuration. Empty in production means DB health gate will fail closed.
env.databaseUrl = process.env.DATABASE_URL || (env.environment === 'production' ? '' : 'postgresql://localhost:5432/dip_hunter');

if (!env.binanceApiKey || !env.binanceSecret) {
  console.warn('[WARN] Binance API credentials missing. Configure BINANCE_API_KEY/BINANCE_SECRET_KEY or TESTNET equivalents in the environment.');
}

if (!env.telegramBotToken || !env.telegramChatId) {
  console.warn('[WARN] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured. Notifications are disabled.');
}

if (env.environment === 'production' && !env.adminApiToken) {
  console.warn('[WARN] ADMIN_API_TOKEN is not configured. Mutating admin API endpoints will remain locked.');
}

if (env.environment === 'production' && !env.webhookSecret) {
  console.warn('[WARN] WEBHOOK_SECRET is not configured. Trading webhook will remain locked.');
}

if (!useTestnet && env.tradingEnabled && !env.dryRun) {
  console.warn('[UYARI] LIVE ACCOUNT MODE ACTIVE. Real-money trading is possible.');
}

env.googleFormUrl = process.env.GOOGLE_FORM_URL || '';
try {
  if (process.env.GOOGLE_FORM_FIELDS) {
    env.googleFormFields = JSON.parse(process.env.GOOGLE_FORM_FIELDS);
  }
} catch (e) {
  console.warn('[WARN] GOOGLE_FORM_FIELDS is not valid JSON.');
}

module.exports = env;

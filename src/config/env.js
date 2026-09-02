const dotenv = require('dotenv');

dotenv.config();

const env = {};
// SECRETS: Only infrastructure secrets from .env
// ----------------------------
const FALLBACK = {
  binanceTestnetApiKey: 'lVs9EHMUmNfdoDoqjBmqFUIeL2rcEPiKUSVjQMpp21H6i9Hj2QF58EcCvMDARc6g',
  binanceTestnetSecret: 'KpRDeOi5nNwqwvAI0U0i6ooTPDsPomPQx7yS5S8jz9EK7Ilrfm2tq36Ft49xbYvK',
};

const useTestnet = (process.env.USE_TESTNET || 'true') === 'true';

// Non-trading env vars (populated by deployment infrastructure)
env.environment = process.env.NODE_ENV || 'development';
env.useTestnet = useTestnet;
env.isTestnet = useTestnet;

// Secrets - Flexible resolution from .env or deployment environment variables
env.binanceApiKey = process.env.BINANCE_API_KEY || process.env.BINANCE_TESTNET_API_KEY || (useTestnet ? FALLBACK.binanceTestnetApiKey : '');
env.binanceSecret = process.env.BINANCE_SECRET_KEY || process.env.BINANCE_TESTNET_SECRET_KEY || (useTestnet ? FALLBACK.binanceTestnetSecret : '');

env.telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
env.telegramChatId = process.env.TELEGRAM_CHAT_ID || '';

// Trading control flags (from .env, can be overridden by settings/service at runtime)
env.tradingEnabled = (process.env.TRADING_MODE || 'on') !== 'off';
const deployMode = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true' || process.env.DEPLOY_CONFIG === 'canonical';
if (process.env.DRY_RUN === 'false') env.dryRun = false;
else if (process.env.DRY_RUN === 'true') env.dryRun = true;
else env.dryRun = !deployMode; // Railway/production default: real orders; local default: dry-run
env.emergencyStop = process.env.EMERGENCY_STOP === 'true';

// Trading Configuration - Single source of truth
env.analysisTimeframe = process.env.ANALYSIS_TIMEFRAME || '1d';
env.port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
env.checkIntervalMin = parseInt(process.env.CHECK_INTERVAL_MIN) || 5;
env.budgetUsdt = parseFloat(process.env.BUDGET_USDT) || 500;
env.tpPercent = parseFloat(process.env.TP_PERCENT) || 5;
env.slPercent = parseFloat(process.env.SL_PERCENT) || 2.5;
env.commissionRate = parseFloat(process.env.COMMISSION_RATE) || 0.001;
env.cooldownMin = parseInt(process.env.COOLDOWN_MIN) || 60;
env.tradingSymbol = process.env.TRADING_SYMBOL || 'BTC/USDT';
env.oversoldLevel = parseInt(process.env.STOCH_OVERSOLD || '20');
env.useRsi2 = process.env.USE_RSI2 === 'true';
env.strategyMode = process.env.STRATEGY_MODE || 'regime';

// Risk engine defaults (can be overridden by settings.json at runtime)
env.adxMin = 18;
env.atrStopMult = 2.0;
env.atrTrailMult = 2.5;
env.timeExitCandles = 5;
env.partialTpPercent = 50;
env.maxBudgetMultiplier = 3;
env.allowSymbols = ['BTC/USDT'];

// Database configuration
env.databaseUrl = process.env.DATABASE_URL || 'postgresql://localhost:5432/dip_hunter';

// Validate secrets are present
if (!env.binanceApiKey || !env.binanceSecret) {
  console.warn(
    '[WARN] Binance API anahtarlari eksik. .env dosyasina BINANCE_API_KEY / BINANCE_SECRET_KEY yazin.'
  );
}

if (!env.telegramBotToken || !env.telegramChatId) {
  console.warn('[WARN] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID tanimli degil. Bildirimler gonderilmez.');
}

if (!useTestnet && env.tradingEnabled && !env.dryRun) {
  console.warn(
    '[UYARI] GERCEK HESAP MODU AKTIF - gercek para ile islem yapilacak. Durdurmak icin TRADING_MODE=off yapin.'
  );
}

// Non-trading env vars
env.googleFormUrl = process.env.GOOGLE_FORM_URL || '';

try {
  if (process.env.GOOGLE_FORM_FIELDS) {
    env.googleFormFields = JSON.parse(process.env.GOOGLE_FORM_FIELDS);
  }
} catch (e) {
  console.warn('[WARN] GOOGLE_FORM_FIELDS gecerli bir JSON degil.');
}

module.exports = env;

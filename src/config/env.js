const dotenv = require('dotenv');

dotenv.config();

// ----------------------------
// SECRETS: Only infrastructure secrets from ENV
// ----------------------------
const FALLBACK = {
  binanceTestnetApiKey: 'F73g8dnhf97ffrTws1QlxDTaRJNHTBKKOH5hfuKbc7vjhdsB51A81MPJRDomlnFA',
  binanceTestnetSecret: '92FODDyMiMm0gzhW63ySyica6kLAoL37pK6vXYAWF2pO9jWVANWGUwdvy4tMLUGv',
};

const useTestnet = (process.env.USE_TESTNET || 'true') === 'true';

const env = {
  // Infrastructure / Secrets
  port: process.env.PORT || 3000,
  useTestnet,
  binanceApiKey: useTestnet
    ? process.env.BINANCE_TESTNET_API_KEY || FALLBACK.binanceTestnetApiKey
    : process.env.BINANCE_API_KEY || '',
  binanceSecret: useTestnet
    ? process.env.BINANCE_TESTNET_SECRET_KEY || FALLBACK.binanceTestnetSecret
    : process.env.BINANCE_SECRET_KEY || '',
  commissionRate: parseFloat(process.env.COMMISSION_RATE) || 0.001,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  tradingEnabled: (process.env.TRADING_MODE || 'on') !== 'off',
  dryRun: (process.env.DRY_RUN || 'false') === 'true',

  // Trading Configuration (loaded from persistent storage, defaults below)
  // These are OVERRIDDEN by settings service at runtime
  analysisTimeframe: '1d',
  checkIntervalMin: 5,
  budgetUsdt: 500,
  tpPercent: 5,
  slPercent: 2.5,
  cooldownMin: 60,
  tradingSymbol: 'BTC/USDT',
  oversoldLevel: 20,
  useRsi2: false,
  strategyMode: 'regime',

  // Risk engine defaults
  adxMin: 18,
  atrStopMult: 2.0,
  atrTrailMult: 2.5,
  timeExitCandles: 5,
  partialTpPercent: 50,
  maxBudgetMultiplier: 3,
  allowSymbols: ['BTC/USDT'],
};

// Non-trading env vars (populated by deployment infrastructure)
env.environment = process.env.NODE_ENV || 'development';
env.isTestnet = env.useTestnet;

try {
  if (process.env.GOOGLE_FORM_FIELDS) {
    env.googleFormFields = JSON.parse(process.env.GOOGLE_FORM_FIELDS);
  }
} catch (e) {
  console.warn('[WARN] GOOGLE_FORM_FIELDS gecerli bir JSON degil.');
}
env.googleFormUrl = process.env.GOOGLE_FORM_URL || '';

function sanitizeFloat(value, min, max, fallback) {
  const v = parseFloat(value);
  if (Number.isNaN(v) || v < min || v > max) return fallback;
  return v;
}

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

module.exports = env;

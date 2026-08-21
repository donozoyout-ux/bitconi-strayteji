const dotenv = require('dotenv');

dotenv.config();

// Binance anahtarlari: USE_TESTNET=true ise testnet anahtarlari, degilse gercek hesap anahtarlari kullanilir.
const FALLBACK = {
  binanceTestnetApiKey: 'F73g8dnhf97ffrTws1QlxDTaRJNHTBKKOH5hfuKbc7vjhdsB51A81MPJRDomlnFA',
  binanceTestnetSecret: '92FODDyMiMm0gzhW63ySyica6kLAoL37pK6vXYAWF2pO9jWVANWGUwdvy4tMLUGv',
};

// Varsayilan DEMO (testnet). Gercek hesap icin .env'de USE_TESTNET=false + gercek anahtarlar gerekir.
const useTestnet = (process.env.USE_TESTNET || 'true') === 'true';

const env = {
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
  analysisTimeframe: process.env.ANALYSIS_TIMEFRAME || '15m',
  checkIntervalMin: parseInt(process.env.CHECK_INTERVAL_MIN) || 5,
  budgetUsdt: sanitizeFloat(process.env.BUDGET_USDT, 5, 10000, 1000),
  tpPercent: sanitizeFloat(process.env.TP_PERCENT, 0.5, 20, 5),
  slPercent: sanitizeFloat(process.env.SL_PERCENT, 0.5, 9.9, 2.5),
  cooldownMin: parseInt(process.env.COOLDOWN_MIN) || 60,
  tradingSymbol: process.env.TRADING_SYMBOL || 'BTC/USDT',
  oversoldLevel: parseInt(process.env.STOCH_OVERSOLD) || 20,
  useRsi2: (process.env.USE_RSI2_FILTER || 'false') === 'true',
  allowSymbols: ['BTC/USDT'],
};

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

const dotenv = require('dotenv');

dotenv.config();

// Binance Testnet anahtarlari (.env bos olsa bile kod icindeki varsayilanlari kullan)
// NOT: Bunlar TESTNET anahtarlaridir (sahte para). Gercek hesap kullanilacaksa degistirin!
const FALLBACK = {
  binanceTestnetApiKey: 'F73g8dnhf97ffrTws1QlxDTaRJNHTBKKOH5hfuKbc7vjhdsB51A81MPJRDomlnFA',
  binanceTestnetSecret: '92FODDyMiMm0gzhW63ySyica6kLAoL37pK6vXYAWF2pO9jWVANWGUwdvy4tMLUGv',
};

const env = {
  port: process.env.PORT || 3000,
  binanceTestnetApiKey: process.env.BINANCE_TESTNET_API_KEY || FALLBACK.binanceTestnetApiKey,
  binanceTestnetSecret: process.env.BINANCE_TESTNET_SECRET_KEY || FALLBACK.binanceTestnetSecret,
  commissionRate: parseFloat(process.env.COMMISSION_RATE) || 0.001,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  tradingEnabled: (process.env.TRADING_MODE || 'on') !== 'off',
  dryRun: (process.env.DRY_RUN || 'false') === 'true',
  analysisTimeframe: process.env.ANALYSIS_TIMEFRAME || '1d',
  checkIntervalMin: parseInt(process.env.CHECK_INTERVAL_MIN) || 15,
  budgetUsdt: parseFloat(process.env.BUDGET_USDT) || 30,
  tpPercent: parseFloat(process.env.TP_PERCENT) || 5,
  slPercent: parseFloat(process.env.SL_PERCENT) || 2.5,
  cooldownMin: parseInt(process.env.COOLDOWN_MIN) || 1440,
  tradingSymbol: process.env.TRADING_SYMBOL || 'BTC/USDT',
  oversoldLevel: parseInt(process.env.STOCH_OVERSOLD) || 20,
  useRsi2: (process.env.USE_RSI2_FILTER || 'false') === 'true',
};

if (!env.telegramBotToken || !env.telegramChatId) {
  console.warn('[WARN] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID tanimli degil. Bildirimler gonderilmez.');
}

module.exports = env;

const dotenv = require('dotenv');

dotenv.config();

const env = {
  port: process.env.PORT || 3000,
  binanceTestnetApiKey: process.env.BINANCE_TESTNET_API_KEY || '',
  binanceTestnetSecret: process.env.BINANCE_TESTNET_SECRET_KEY || '',
  commissionRate: parseFloat(process.env.COMMISSION_RATE) || 0.001,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
};

if (!env.binanceTestnetApiKey || !env.binanceTestnetSecret) {
  console.warn('[WARN] Binance Testnet API anahtarlari .env icerisinde tanimli degil. Emir gonderimi basarisiz olur.');
}

if (!env.telegramBotToken || !env.telegramChatId) {
  console.warn('[WARN] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID tanimli degil. Bildirimler gonderilmez.');
}

module.exports = env;

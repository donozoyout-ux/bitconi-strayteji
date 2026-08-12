const dotenv = require('dotenv');

dotenv.config();

const env = {
  port: process.env.PORT || 3000,
  binanceTestnetApiKey: process.env.BINANCE_TESTNET_API_KEY || '',
  binanceTestnetSecret: process.env.BINANCE_TESTNET_SECRET_KEY || '',
  commissionRate: parseFloat(process.env.COMMISSION_RATE) || 0.001,
};

if (!env.binanceTestnetApiKey || !env.binanceTestnetSecret) {
  console.warn('[WARN] Binance Testnet API anahtarlari .env icerisinde tanimli degil. Emir gonderimi basarisiz olur.');
}

module.exports = env;

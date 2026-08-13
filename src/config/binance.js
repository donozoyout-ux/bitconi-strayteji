const ccxt = require('ccxt');
const env = require('./env');

if (!env.binanceTestnetApiKey || !env.binanceTestnetSecret) {
  throw new Error(
    'Binance Testnet API anahtarlari eksik. Lutfen .env dosyasini doldurun (BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_SECRET_KEY).'
  );
}

const exchange = new ccxt.binance({
  apiKey: env.binanceTestnetApiKey,
  secret: env.binanceTestnetSecret,
  enableRateLimit: true,
  timeout: 15000,
  options: {
    defaultType: 'spot',
  },
});

exchange.setSandboxMode(true);

module.exports = exchange;

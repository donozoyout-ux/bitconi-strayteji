const ccxt = require('ccxt');
const env = require('./env');

if (!env.binanceApiKey || !env.binanceSecret) {
  throw new Error(
    'Binance API anahtarlari eksik. Lutfen .env dosyasini doldurun (BINANCE_API_KEY / BINANCE_SECRET_KEY).'
  );
}

const exchange = new ccxt.binance({
  apiKey: env.binanceApiKey,
  secret: env.binanceSecret,
  enableRateLimit: true,
  timeout: 15000,
  options: {
    defaultType: 'spot',
    adjustForTimeDifference: true,
    recvWindow: 10000,
  },
});

exchange.setSandboxMode(env.useTestnet);

module.exports = exchange;

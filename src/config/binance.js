const ccxt = require('ccxt');
const env = require('./env');
const logger = require('../utils/logger');

if (!env.binanceApiKey || !env.binanceSecret) {
  logger.warn(
    '[WARN] Binance API anahtarlari eksik. Borsa bakiyesi veya emri gerektiren islemler API anahtari olmadan basarisiz olabilir.'
  );
}

const exchange = new ccxt.binance({
  apiKey: env.binanceApiKey || '',
  secret: env.binanceSecret || '',
  enableRateLimit: true,
  timeout: 15000,
  options: {
    defaultType: 'future',
    adjustForTimeDifference: true,
    recvWindow: 60000,
    fetchMarkets: ['linear', 'inverse'],
    fetchCurrencies: false,
  },
});

if (env.useTestnet) {
  // Binance Demo Futures (demo.binance.com) endpoint configuration
  exchange.urls['api'] = exchange.urls['demo'];
}

module.exports = exchange;

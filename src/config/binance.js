const env = require('./env');
const logger = require('../utils/logger');

if (!env.binanceApiKey || !env.binanceSecret) {
  logger.warn(
    '[WARN] Binance API anahtarlari eksik. Borsa bakiyesi veya emri gerektiren islemler API anahtari olmadan basarisiz olabilir.'
  );
}

let clientPromise = null;

async function createClient() {
  // CCXT 4.5.x ships an ESM entry and a CommonJS bundle. The CommonJS bundle
  // currently pulls ESM-only @noble/curves through require(), which crashes at
  // process startup with ERR_REQUIRE_ESM. Dynamic import selects CCXT's ESM
  // export while allowing the rest of this application to remain CommonJS.
  const ccxtModule = await import('ccxt');
  const Binance = ccxtModule.binance || (ccxtModule.default && ccxtModule.default.binance);

  if (!Binance) {
    throw new Error('CCXT Binance sinifi yuklenemedi.');
  }

  const exchange = new Binance({
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
    // Binance deprecated the old Futures sandbox and moved Futures testing to
    // Demo Trading. CCXT 4.5.6+ exposes enableDemoTrading() for this environment.
    if (typeof exchange.enableDemoTrading === 'function') {
      exchange.enableDemoTrading(true);
      logger.info('[BINANCE] Demo Trading modu CCXT enableDemoTrading(true) ile aktif.');
    } else if (exchange.urls && exchange.urls.demo) {
      // Compatibility fallback for intermediate CCXT builds.
      exchange.urls.api = exchange.urls.demo;
      logger.warn('[BINANCE] enableDemoTrading yok; demo URL fallback kullaniliyor.');
    } else if (typeof exchange.setSandboxMode === 'function') {
      // Last-resort compatibility fallback for older CCXT releases.
      exchange.setSandboxMode(true);
      logger.warn('[BINANCE] Demo Trading API yok; eski sandbox fallback kullaniliyor.');
    } else {
      throw new Error('Bu CCXT surumu Binance TESTNET/Demo modunu desteklemiyor.');
    }
  }

  logger.info(`[BINANCE] CCXT ${ccxtModule.version || exchange.version || 'unknown'} istemcisi hazir.`);
  return exchange;
}

function getClient() {
  if (!clientPromise) {
    clientPromise = createClient().catch((err) => {
      // Allow a later retry instead of permanently caching a rejected promise.
      clientPromise = null;
      logger.error('[BINANCE] CCXT istemcisi baslatilamadi:', { error: err.message });
      throw err;
    });
  }
  return clientPromise;
}

// Existing services expect a synchronous-looking exchange object and await its
// network methods (fetchBalance, fetchTicker, createMarketOrder, ...). A proxy
// preserves that API while lazily resolving the ESM CCXT client on first use.
const exchangeProxy = new Proxy({}, {
  get(_target, prop) {
    if (prop === 'getClient') return getClient;
    if (prop === 'then') return undefined;

    return async (...args) => {
      const exchange = await getClient();
      const member = exchange[prop];
      if (typeof member !== 'function') {
        if (args.length > 0) {
          throw new Error(`CCXT ozelligi fonksiyon degil: ${String(prop)}`);
        }
        return member;
      }
      return member.apply(exchange, args);
    };
  },
});

module.exports = exchangeProxy;

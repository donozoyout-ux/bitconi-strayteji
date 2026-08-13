const app = require('./src/app');
const env = require('./src/config/env');
const logger = require('./src/utils/logger');
const tradingEngine = require('./src/services/trading.engine');

app.listen(env.port, () => {
  logger.info(`Dip Hunter Crypto Bot calisiyor -> http://localhost:${env.port}`);
  logger.info('Binance Testnet (sandbox) modu AKTIF.');
  tradingEngine.start();
});

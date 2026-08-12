const app = require('./src/app');
const env = require('./src/config/env');
const logger = require('./src/utils/logger');

app.listen(env.port, () => {
  logger.info(`Dip Hunter Crypto Bot calisiyor -> http://localhost:${env.port}`);
  logger.info('Binance Testnet (sandbox) modu AKTIF.');
});

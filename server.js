const app = require('./src/app');
const env = require('./src/config/env');
const logger = require('./src/utils/logger');
const tradingEngine = require('./src/services/trading.engine');
const telegramBot = require('./src/services/telegram.bot');

app.listen(env.port, () => {
  logger.info(`Dip Hunter Crypto Bot calisiyor -> http://localhost:${env.port}`);
  logger.info(
    env.useTestnet
      ? 'Binance TESTNET (demo) modu AKTIF.'
      : 'Binance GERCEK HESAP modu AKTIF - gercek para ile islem yapilacak!'
  );
  tradingEngine.start();
  telegramBot.start();
});

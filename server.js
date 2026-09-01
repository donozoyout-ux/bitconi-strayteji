const app = require('./src/app');
const env = require('./src/config/env');
const logger = require('./src/utils/logger');
const tradingEngine = require('./src/services/trading.engine');
const learningEngine = require('./src/services/learning-engine.service');
const stateService = require('./src/services/state.service');
const telegramBot = require('./src/services/telegram.bot');

const port = process.env.PORT || env.port || 3000;

app.listen(port, '0.0.0.0', async () => {
  logger.info(`Dip Hunter Crypto Bot calisiyor -> port ${port}`);
  logger.info(
    env.useTestnet
      ? 'Binance TESTNET (demo) modu AKTIF.'
      : 'Binance GERCEK HESAP modu AKTIF - gercek para ile islem yapilacak!'
  );

  try {
    await stateService.hydrateFromSheet();
  } catch (err) {
    logger.warn('[SHEET-STATE] startup hydration atlandi: ' + err.message);
  }

  tradingEngine.start();
  learningEngine.start();
  telegramBot.start();
});

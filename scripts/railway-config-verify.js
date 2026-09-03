// Railway TESTNET configuration verification. Read-only; places no orders.
const env = require('../src/config/env');
const settingsService = require('../src/services/settings.service');

(async () => {
  await settingsService.initializeSettings();
  const settings = settingsService.get();
  const parity = settingsService.assertConfigParity(settings);

  console.log('=== RAILWAY TESTNET VERIFY ===');
  console.log('platform          :', env.platform);
  console.log('USE_TESTNET       :', env.useTestnet);
  console.log('TRADING_ENABLED   :', env.tradingEnabled);
  console.log('DRY_RUN           :', env.dryRun);
  console.log('BINANCE_KEYS      :', env.binanceApiKey && env.binanceSecret ? 'CONFIGURED' : 'MISSING');
  console.log('TELEGRAM          :', env.telegramBotToken && env.telegramChatId ? 'CONFIGURED' : 'MISSING');
  console.log('GOOGLE_SHEETS     :', env.googleSheetsEnabled ? 'OPTIONAL_ENABLED' : 'DISABLED');
  console.log('CONFIG_PARITY     :', parity.ok ? 'PASS' : 'FAIL');
  console.log('STRATEGY          :', settings.strategy);
  console.log('STRATEGY_VERSION  :', settings.strategyVersion);
  console.log('TIMEFRAMES        :', `${settings.executionTimeframe}/${settings.higherTimeframe}/${settings.regimeTimeframe}`);

  if (!env.useTestnet) {
    console.error('VERIFY FAIL: Railway deployment must remain on TESTNET for this forward run.');
    process.exit(1);
  }

  if (!parity.ok) {
    console.error('VERIFY FAIL: canonical strategy parity mismatch:', parity.mismatches.join(' | '));
    process.exit(1);
  }

  if (!env.binanceApiKey || !env.binanceSecret) {
    console.warn('VERIFY WARN: Binance TESTNET keys are missing; app can start but cannot place orders.');
  }
  if (!env.telegramBotToken || !env.telegramChatId) {
    console.warn('VERIFY WARN: Telegram credentials are missing; trading can continue but notifications will not arrive.');
  }

  console.log('VERIFY PASS: Railway runtime can start. Persistence is not a trading prerequisite.');
})().catch((err) => {
  console.error('VERIFY ERROR:', err.message);
  process.exit(1);
});

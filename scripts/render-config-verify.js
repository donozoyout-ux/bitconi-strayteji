// TESTNET deployment verification (read-only; places no orders).
const settingsService = require('../src/services/settings.service');
const startup = require('../src/services/startup');
const sheetStore = require('../src/services/sheet-store.service');
const env = require('../src/config/env');
const exchangeProxy = require('../src/config/binance');

const SECTION = (s) => console.log('\n=== ' + s + ' ===');

async function safe(fn, label) {
  try { return { ok: true, value: await fn() }; }
  catch (e) { return { ok: false, error: e.message, label }; }
}

(async () => {
  const gate = await startup.runStartupChecks();
  const eff = settingsService.get();
  const deploy = settingsService.isDeployMode();
  const storage = await sheetStore.healthCheck();

  SECTION('CONFIG SOURCE');
  console.log('deployMode        :', deploy);
  console.log('strategy source   : CANONICAL_CANDIDATE (version-controlled)');
  console.log('persistent memory : Google Sheets');
  console.log('data/settings.json:', deploy ? 'IGNORED (deploy mode)' : 'used (dev)');

  SECTION('CONFIG PARITY');
  console.log(gate.configOk ? 'PASS' : 'FAIL');
  if (!gate.configOk) console.log('mismatches:', gate.parity.mismatches.join(' | '));

  SECTION('GOOGLE SHEETS STORAGE');
  console.log(storage.ok ? 'PASS' : 'FAIL');
  console.log('configured       :', storage.configured);
  console.log('spreadsheet      :', storage.spreadsheetName || 'n/a');
  if (storage.error) console.log('error            :', storage.error);

  const exchange = await exchangeProxy.getClient();
  const candles15 = await safe(() => exchange.fetchOHLCV('BTC/USDT', '15m', undefined, 2), '15m');
  const candles1h = await safe(() => exchange.fetchOHLCV('BTC/USDT', '1h', undefined, 2), '1h');
  const candles4h = await safe(() => exchange.fetchOHLCV('BTC/USDT', '4h', undefined, 2), '4h');
  const positions = await safe(() => exchange.fetchPositions(['BTC/USDT']), 'positions');
  const orders = await safe(() => exchange.fetchOpenOrders('BTC/USDT'), 'orders');

  SECTION('BINANCE TESTNET/DEMO (read-only)');
  console.log('15m candles       :', candles15.ok ? 'ok (n=' + candles15.value.length + ')' : 'FAIL ' + candles15.error);
  console.log('1h context        :', candles1h.ok ? 'ok' : 'FAIL ' + candles1h.error);
  console.log('4h context        :', candles4h.ok ? 'ok' : 'FAIL ' + candles4h.error);
  console.log('position sync     :', positions.ok ? 'ok (open=' + ((positions.value || []).filter(p => p && Math.abs(p.contracts || 0) > 0).length) + ')' : 'FAIL ' + positions.error);
  console.log('open order sync   :', orders.ok ? 'ok (open=' + ((orders.value || []).length) + ')' : 'FAIL ' + orders.error);

  SECTION('RUNTIME FLAGS');
  console.log('USE_TESTNET :', env.useTestnet);
  console.log('DRY_RUN     :', env.dryRun);
  console.log('SHEET_REQ   :', env.sheetRequired);
  console.log('STRATEGY    :', eff.strategy);
  console.log('STRATEGY VER:', eff.strategyVersion);
  console.log('TIMEFRAMES  :', JSON.stringify({ execution: eff.executionTimeframe, higher: eff.higherTimeframe, regime: eff.regimeTimeframe }));
  console.log('BB          :', JSON.stringify({ length: eff.bbLength, std: eff.bbStd }));
  console.log('SHORT ADX FL:', eff.shortAdxFloor);
  console.log('EXIT MODE   :', eff.exitStrategy, '(atrMult=' + eff.trendTrailingAtrMult + ', tp=' + eff.trendUseTP + ', timeExit=' + eff.trendTimeExitCandles + ')');

  const storageBlocked = env.sheetRequired && !storage.ok;
  const pipelineBlocked = storageBlocked || !gate.configOk || !env.useTestnet || env.emergencyStop;

  SECTION('FINAL OUTPUT');
  console.log('CONFIG PARITY        : ' + (gate.configOk ? 'PASS' : 'FAIL'));
  console.log('SHEET STORAGE        : ' + (storage.ok ? 'PASS' : 'FAIL'));
  console.log('USE_TESTNET          : ' + env.useTestnet);
  console.log('DRY_RUN              : ' + env.dryRun);
  console.log('STRATEGY             : ' + eff.strategy);
  console.log('STRATEGY VERSION     : ' + eff.strategyVersion);
  console.log('ORDER PIPELINE       : ' + (pipelineBlocked ? 'BLOCKED' : 'READY'));
  console.log('FINAL STATUS         : ' + (pipelineBlocked ? 'DEPLOY BLOCKED' : 'TESTNET FORWARD EXECUTION READY'));

  process.exit(pipelineBlocked ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });

// Render / TESTNET forward-test deployment verification (READ-ONLY, places NO orders).
// Resolves the deterministic config, asserts parity, runs a DB read/write health check,
// and verifies sandbox exchange connectivity (15m/1h/4h candles, position + order sync,
// forward-journal writability). Prints the required final output block.
const settingsService = require('../src/services/settings.service');
const startup = require('../src/services/startup');
const db = require('../src/db');
const env = require('../src/config/env');
const exchange = require('../src/config/binance');
const fs = require('fs');
const path = require('path');

const SECTION = (s) => console.log('\n=== ' + s + ' ===');

async function safe(fn, label) {
  try { return { ok: true, value: await fn() }; }
  catch (e) { return { ok: false, error: e.message, label }; }
}

(async () => {
  const gate = await startup.runStartupChecks();
  const eff = settingsService.get();
  const canonical = settingsService.getCanonical();
  const deploy = settingsService.isDeployMode();
  const dbKeys = (gate.dbBootstrap && gate.dbBootstrap.keys) || [];

  SECTION('CONFIG SOURCE');
  console.log('deployMode        :', deploy);
  console.log('base source       :', 'CANONICAL_CANDIDATE (version-controlled)');
  console.log('db settings overlay:', gate.dbBootstrap && gate.dbBootstrap.applied ? 'applied (' + dbKeys.length + ' keys)' : 'not applied (' + ((gate.dbBootstrap && gate.dbBootstrap.error) || 'n/a') + ')');
  console.log('data/settings.json:', deploy ? 'IGNORED (deploy mode)' : 'used (dev)');

  SECTION('CONFIG PARITY');
  console.log(gate.configOk ? 'PASS' : 'FAIL');
  if (!gate.configOk) console.log('mismatches: ' + gate.parity.mismatches.join(' | '));

  SECTION('PRECEDENCE AUDIT (per candidate key)');
  for (const k of settingsService.CANDIDATE_KEYS) {
    let src;
    if (!deploy) src = 'data/settings.json or DEFAULT_SETTINGS';
    else if (dbKeys.includes(k)) src = 'DB settings table';
    else src = 'CANONICAL (code fallback)';
    console.log(k.padEnd(22) + '= ' + String(JSON.stringify(eff[k])).padEnd(28) + ' <- ' + src);
  }
  console.log('\n(env wins for: USE_TESTNET, DRY_RUN, EMERGENCY_STOP, TRADING_MODE — infra flags)');

  SECTION('DB');
  console.log(gate.dbOk ? 'PASS' : 'FAIL');
  if (gate.db) {
    const d = gate.db.details || {};
    console.log('databaseUrlPresent:', d.databaseUrlPresent);
    console.log('connect/select1    :', d.connect, d.select1);
    console.log('settingsReadable  :', d.settingsReadable);
    console.log('botStateReadable  :', d.botStateReadable);
    console.log('writeOk           :', d.writeOk);
    console.log('allTablesPresent  :', d.allTablesPresent);
    if (d.error) console.log('dbError:', d.error);
  }

  // Read-only sandbox exchange checks
  const candles15 = await safe(() => exchange.fetchOHLCV('BTC/USDT', '15m', undefined, 2), '15m');
  const candles1h = await safe(() => exchange.fetchOHLCV('BTC/USDT', '1h', undefined, 2), '1h');
  const candles4h = await safe(() => exchange.fetchOHLCV('BTC/USDT', '4h', undefined, 2), '4h');
  const positions = await safe(() => exchange.fetchPositions(['BTC/USDT']), 'positions');
  const orders = await safe(() => exchange.fetchOpenOrders('BTC/USDT'), 'orders');

  SECTION('SANDBOX EXCHANGE (read-only)');
  console.log('endpoint          :', JSON.stringify(exchange.urls.api && exchange.urls.api.fapiPublic ? exchange.urls.api.fapiPublic : exchange.urls.api));
  console.log('15m candles       :', candles15.ok ? 'ok (n=' + candles15.value.length + ')' : 'FAIL ' + candles15.error);
  console.log('1h context        :', candles1h.ok ? 'ok' : 'FAIL ' + candles1h.error);
  console.log('4h context        :', candles4h.ok ? 'ok' : 'FAIL ' + candles4h.error);
  console.log('position sync      :', positions.ok ? 'ok (open=' + ((positions.value || []).filter(p=>p&&Math.abs(p.contracts||0)>0).length) + ')' : 'FAIL ' + positions.error);
  console.log('open order sync    :', orders.ok ? 'ok (open=' + ((orders.value||[]).length) + ')' : 'FAIL ' + orders.error);

  // Forward journal writability
  const journalDir = path.join(__dirname, '..', 'data');
  let journalWritable = false;
  try { fs.accessSync(journalDir, fs.constants.W_OK); journalWritable = true; } catch (e) {}
  SECTION('FORWARD JOURNAL');
  console.log('dir        :', journalDir);
  console.log('writable   :', journalWritable);

  SECTION('RUNTIME FLAGS');
  console.log('USE_TESTNET :', env.useTestnet);
  console.log('DRY_RUN     :', env.dryRun);
  console.log('STRATEGY    :', eff.strategy);
  console.log('STRATEGY VER:', eff.strategyVersion);
  console.log('TIMEFRAMES  :', JSON.stringify({ execution: eff.executionTimeframe, higher: eff.higherTimeframe, regime: eff.regimeTimeframe }));
  console.log('BB          :', JSON.stringify({ length: eff.bbLength, std: eff.bbStd }));
  console.log('SHORT ADX FL:', eff.shortAdxFloor);
  console.log('EXIT MODE   :', eff.exitStrategy, '(atrMult=' + eff.trendTrailingAtrMult + ', tp=' + eff.trendUseTP + ', timeExit=' + eff.trendTimeExitCandles + ')');

  const pipelineBlocked = !gate.dbOk || !gate.configOk || !env.useTestnet || env.emergencyStop;
  SECTION('DEPLOYMENT LOG');
  console.log('DB SETTINGS BOOTSTRAP : ' + ((gate.dbOk && gate.configOk) ? 'PASS' : 'FAIL'));
  console.log('CONFIG PARITY         : ' + (gate.configOk ? 'PASS' : 'FAIL'));
  console.log('DB HEALTH             : ' + (gate.dbOk ? 'PASS' : 'FAIL'));
  console.log('USE_TESTNET           : ' + env.useTestnet);
  console.log('DRY_RUN               : ' + env.dryRun);
  console.log('STRATEGY VERSION      : ' + eff.strategyVersion);
  console.log('ORDER PIPELINE        : ' + (pipelineBlocked ? 'BLOCKED' : 'READY'));

  SECTION('FINAL OUTPUT');
  console.log('RENDER CONFIG SOURCE : ' + (deploy ? 'CANONICAL (code) + DB overlay; settings.json ignored' : 'data/settings.json'));
  console.log('CONFIG PARITY        : ' + (gate.configOk ? 'PASS' : 'FAIL'));
  console.log('DB                   : ' + (gate.dbOk ? 'PASS' : 'FAIL'));
  console.log('USE_TESTNET          : ' + env.useTestnet);
  console.log('DRY_RUN              : ' + env.dryRun);
  console.log('STRATEGY             : ' + eff.strategy);
  console.log('STRATEGY VERSION     : ' + eff.strategyVersion);
  console.log('TIMEFRAMES           : ' + JSON.stringify({ execution: eff.executionTimeframe, higher: eff.higherTimeframe, regime: eff.regimeTimeframe }));
  console.log('BB                   : ' + JSON.stringify({ length: eff.bbLength, std: eff.bbStd }));
  console.log('SHORT ADX FLOOR      : ' + eff.shortAdxFloor);
  console.log('EXIT MODE            : ' + eff.exitStrategy);
  console.log('ORDER PIPELINE       : ' + (pipelineBlocked ? 'BLOCKED' : 'READY'));
  console.log('FINAL STATUS         : ' + (pipelineBlocked ? 'RENDER BLOCKED' : 'RENDER TESTNET FORWARD EXECUTION READY'));

  // No orders placed. Exit nonzero if blocked (CI gate).
  process.exit(pipelineBlocked ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });

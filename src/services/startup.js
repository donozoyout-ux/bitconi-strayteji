// Startup configuration + persistent-storage gate for TESTNET forward execution.
// PostgreSQL has been removed from the runtime path. Google Sheets is the durable
// state/trade/checkpoint store; strategy rules remain version-controlled.
const settingsService = require('./settings.service');
const sheetStore = require('./sheet-store.service');
const env = require('../config/env');
const logger = require('../utils/logger');

let gate = null;

function snapshot(effective) {
  return {
    strategy: effective.strategy,
    strategyVersion: effective.strategyVersion,
    riskPerTrade: effective.riskPerTrade,
    timeframes: {
      execution: effective.executionTimeframe,
      higher: effective.higherTimeframe,
      regime: effective.regimeTimeframe,
    },
    bb: { length: effective.bbLength, std: effective.bbStd },
    shortAdxFloor: effective.shortAdxFloor,
    exitStrategy: effective.exitStrategy,
    trendTrailingAtrMult: effective.trendTrailingAtrMult,
    trendUseTP: effective.trendUseTP,
    trendTimeExitCandles: effective.trendTimeExitCandles,
    slPercent: effective.slPercent,
    maxLeverage: effective.maxLeverage,
    commissionRate: effective.commissionRate,
    USE_TESTNET: env.useTestnet,
    DRY_RUN: env.dryRun,
    EMERGENCY_STOP: env.emergencyStop,
    storageMode: 'google_sheets',
  };
}

async function runStartupChecks() {
  await settingsService.initializeSettings();
  const effective = settingsService.get();
  const parity = settingsService.assertConfigParity(effective);
  const storage = await sheetStore.healthCheck();

  let blockReason = null;
  if (env.sheetRequired && !storage.ok) blockReason = storage.configured ? 'SHEET_UNHEALTHY' : 'SHEET_NOT_CONFIGURED';
  else if (!parity.ok) blockReason = 'CONFIG_PARITY_FAIL';
  if (!env.useTestnet) blockReason = blockReason || 'USE_TESTNET_FALSE';
  if (env.emergencyStop) blockReason = blockReason || 'EMERGENCY_STOP';

  gate = {
    storageMode: 'google_sheets',
    storageOk: Boolean(storage.ok),
    sheetOk: Boolean(storage.ok),
    sheetRequired: Boolean(env.sheetRequired),
    configOk: parity.ok,
    blockReason,
    parity,
    storage,
    snapshot: snapshot(effective),
  };

  logger.info('[STARTUP] canonical config snapshot: ' + JSON.stringify(gate.snapshot));
  if (blockReason) {
    logger.error('[STARTUP] ' + blockReason + ' -> TRADING BLOCKED. ' + (parity.mismatches || []).join('; '));
  } else {
    logger.info(`[STARTUP] config parity PASS; storage=${storage.ok ? 'SHEET_READY' : 'LOCAL_FALLBACK'}; TESTNET execution READY.`);
  }
  return gate;
}

function getGate() {
  return gate;
}

module.exports = { runStartupChecks, getGate, snapshot };

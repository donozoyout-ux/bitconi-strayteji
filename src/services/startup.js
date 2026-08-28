// Startup configuration + DB gate for deterministic TESTNET forward-test deployment.
// Runs once at boot: resolves effective config (canonical candidate, DB-overlaid in
// deploy), asserts parity, and performs a read/write DB health check. Exposes a gate
// that blocks all trading if config parity fails or DB is unhealthy. No orders placed.
const settingsService = require('./settings.service');
const db = require('../db');
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
  };
}

async function runStartupChecks() {
  const dbBootstrap = await settingsService.bootstrapDbSettings();
  const effective = settingsService.get();
  const parity = settingsService.assertConfigParity(effective);
  const dbh = await db.healthCheck();

  let blockReason = null;
  if (!dbh.ok) blockReason = 'DB_UNHEALTHY';
  else if (!parity.ok) blockReason = 'CONFIG_PARITY_FAIL';
  if (!env.useTestnet) blockReason = blockReason || 'USE_TESTNET_FALSE';
  if (env.emergencyStop) blockReason = blockReason || 'EMERGENCY_STOP';

  gate = { dbOk: dbh.ok, configOk: parity.ok, blockReason, parity, db: dbh, dbBootstrap, snapshot: snapshot(effective) };

  logger.info('[STARTUP] canonical config snapshot: ' + JSON.stringify(gate.snapshot));
  if (blockReason) {
    logger.error('[STARTUP] ' + blockReason + ' -> TRADING BLOCKED. ' + (parity.mismatches || []).join('; '));
  } else {
    logger.info('[STARTUP] config parity PASS; DB healthy; TESTNET forward execution READY.');
  }
  return gate;
}

function getGate() {
  return gate;
}

module.exports = { runStartupChecks, getGate, snapshot };

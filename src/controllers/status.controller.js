const fs = require('fs');
const path = require('path');
const exchange = require('../config/binance');
const env = require('../config/env');
const logger = require('../utils/logger');
const startup = require('../services/startup');
const settingsService = require('../services/settings.service');

const WATCH_ASSETS = ['USDT', 'BTC', 'ETH', 'BNB'];

function getRuntime(req, res) {
  const gate = startup.getGate();
  const settings = settingsService.get();

  res.status(200).json({
    success: true,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: env.environment,
    useTestnet: Boolean(env.useTestnet),
    dryRun: Boolean(env.dryRun),
    emergencyStop: Boolean(env.emergencyStop),
    tradingEnabled: Boolean(env.tradingEnabled),
    strategy: {
      name: settings.strategy,
      version: settings.strategyVersion,
      riskPerTrade: settings.riskPerTrade,
      maxLeverage: settings.maxLeverage,
      shortAdxFloor: settings.shortAdxFloor,
      exitStrategy: settings.exitStrategy,
      slPercent: settings.slPercent,
      commissionRate: settings.commissionRate,
      timeframes: {
        execution: settings.executionTimeframe,
        higher: settings.higherTimeframe,
        regime: settings.regimeTimeframe,
      },
    },
    startupGate: gate
      ? {
          dbOk: Boolean(gate.dbOk),
          configOk: Boolean(gate.configOk),
          blockReason: gate.blockReason || null,
          parityMismatches: gate.parity && gate.parity.mismatches ? gate.parity.mismatches : [],
        }
      : {
          dbOk: false,
          configOk: false,
          blockReason: 'STARTUP_CHECKS_NOT_RUN',
          parityMismatches: [],
        },
    orderPipeline: !gate || gate.blockReason
      ? 'BLOCKED'
      : env.dryRun
        ? 'DRY_RUN'
        : env.useTestnet
          ? 'TESTNET_READY'
          : 'LIVE_MODE_BLOCKED',
  });
}

async function getStatus(req, res) {
  let dbConnected = false;
  let dbError = null;
  try {
    const db = require('../db');
    await db.query('SELECT NOW()');
    dbConnected = true;
  } catch (dbErr) {
    dbError = dbErr.message;
  }

  const gate = startup.getGate();
  const settings = settingsService.get();

  try {
    const balance = await exchange.fetchBalance();
    const assets = {};
    for (const asset of WATCH_ASSETS) {
      const entry = balance[asset];
      assets[asset] = entry
        ? {
            free: entry.free,
            used: entry.used,
            total: entry.total,
          }
        : { free: 0, used: 0, total: 0 };
    }

    res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      sandbox: Boolean(env.useTestnet),
      balance: assets,
      dbConnected,
      dbError,
      binanceConnected: true,
      emergencyStop: Boolean(env.emergencyStop),
      tradingEnabled: Boolean(env.tradingEnabled),
      dryRun: Boolean(env.dryRun),
      strategy: settings.strategy,
      strategyVersion: settings.strategyVersion,
      startupGate: gate
        ? {
            dbOk: Boolean(gate.dbOk),
            configOk: Boolean(gate.configOk),
            blockReason: gate.blockReason || null,
          }
        : null,
    });
  } catch (err) {
    logger.error('Bakiye cekilemedi', { error: err.message });
    res.status(200).json({
      success: false,
      error: err.message,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      sandbox: Boolean(env.useTestnet),
      balance: {},
      dbConnected,
      dbError,
      binanceConnected: false,
      emergencyStop: Boolean(env.emergencyStop),
      tradingEnabled: Boolean(env.tradingEnabled),
      dryRun: Boolean(env.dryRun),
      strategy: settings.strategy,
      strategyVersion: settings.strategyVersion,
      startupGate: gate
        ? {
            dbOk: Boolean(gate.dbOk),
            configOk: Boolean(gate.configOk),
            blockReason: gate.blockReason || null,
          }
        : null,
    });
  }
}

function getLogs(req, res) {
  try {
    const logPath = path.join(__dirname, '..', '..', 'logs', 'app.log');
    if (!fs.existsSync(logPath)) {
      return res.status(200).json({ success: true, logs: [] });
    }
    const data = fs.readFileSync(logPath, 'utf8');
    const lines = data.split('\n').filter(Boolean);
    const lastLines = lines.slice(-50).reverse();
    res.status(200).json({ success: true, logs: lastLines });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { getStatus, getRuntime, getLogs };

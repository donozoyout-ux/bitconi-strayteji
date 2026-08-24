const fs = require('fs');
const path = require('path');
const exchange = require('../config/binance');
const env = require('../config/env');
const logger = require('../utils/logger');

const WATCH_ASSETS = ['USDT', 'BTC', 'ETH', 'BNB'];

async function getStatus(req, res) {
  let dbConnected = false;
  try {
    const db = require('../db');
    await db.query('SELECT NOW()');
    dbConnected = true;
  } catch (dbErr) {
    // Database connection failed or database module not initialised
  }

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
      binanceConnected: true,
      emergencyStop: Boolean(env.emergencyStop),
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
      binanceConnected: false,
      emergencyStop: Boolean(env.emergencyStop),
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

module.exports = { getStatus, getLogs };

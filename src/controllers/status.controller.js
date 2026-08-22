const exchange = require('../../config/binance');
const logger = require('../../utils/logger');

const WATCH_ASSETS = ['USDT', 'BTC', 'ETH', 'BNB'];

async function getStatus(req, res) {
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
      sandbox: true,
      balance: assets,
    });
  } catch (err) {
    logger.error('Bakiye cekilemedi', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { getStatus };

const env = require('../config/env');
const analyzer = require('../services/analyzer.service');
const logger = require('../utils/logger');

const BB_LENGTH = 20;
const BB_MULT = 2;
const STOCH_LEN = 14;
const SMOOTH_K = 3;
const SMOOTH_D = 3;

async function getChart(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 160, 500);
    const symbol = env.tradingSymbol || 'BTC/USDT';
    const candles = await analyzer.fetchCandles(symbol, env.analysisTimeframe, limit + 1);

    const closed = candles.slice(0, -1);
    const closes = closed.map((c) => c[4]);

    const bb = analyzer.bollinger(closes, BB_LENGTH, BB_MULT);
    const kd = analyzer.stochRsi(closes, STOCH_LEN, SMOOTH_K, SMOOTH_D);

    const data = closed.map((c, i) => ({
      t: Math.floor(c[0] / 1000),
      o: c[1],
      h: c[2],
      l: c[3],
      c: c[4],
      bbBasis: bb.basis[i],
      bbLower: bb.lower[i],
      bbUpper: bb.upper[i],
      k: kd.k[i],
      d: kd.d[i],
    }));

    res.status(200).json({
      success: true,
      symbol,
      timeframe: env.analysisTimeframe,
      data,
    });
  } catch (err) {
    logger.error('Grafik verisi hatasi', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { getChart };

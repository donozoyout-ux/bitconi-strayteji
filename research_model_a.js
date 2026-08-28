// Model A: Early Trend Participation
// Research variant — relaxes RSI crossover requirement
// Original blocker was "NO RSI CROSSOVER" at 87.5%
// Model A: enter if rsi > 50 (LONG) or rsi < 50 (SHORT) WITHOUT requiring crossover

const fs = require('fs');

// Load the 19604 dataset (array format)
const rawData = JSON.parse(fs.readFileSync('./reports/btc_usdt_15m_3m6m_raw.json', 'utf8'));
const rawCandles = rawData.candles;

// Convert from {timestamp, open, high, low, close, volume} to [timestamp, open, high, low, close, volume]
const converted = rawCandles.map(c => [c.timestamp, c.open, c.high, c.low, c.close, c.volume]);

console.log('Candle count:', converted.length);

// ============================================================
// Model A signal logic (RESEARCH VARIANT only)
// ============================================================

// NOTE: This is a RESEARCH analysis using the existing detectSignal function.
// We modify the signal conditions by passing different parameters.

// The existing detectSignal requires rsiCrossUp/rsiCrossDown internally.
// To implement Model A, we need to run the backtest with relaxed conditions.

// Since we cannot modify strategy.service.js, we will run the backtest engine
// with the original strategy, then separately analyze which trends would 
// have been caught under Model A conditions using the audit data.

// Alternative approach: Run backtest with original strategy, then 
// post-analyze using the trend events data.

// Let me first run the baseline backtest to establish results
const { backtest } = require('./src/backtest/engine');

const result = backtest('default', converted, 10000, {
  riskPerTrade: 0.5,
  maxLeverage: 5,
  commissionRate: 0.001,
  slPercent: 2.5,
  tpPercent: 5,
});

console.log('\n=== BASELINE RESULTS (19,604 candles) ===');
console.log('Total Trades:', result.totalTrades);
console.log('Win Rate:', result.winRate);
console.log('Profit Factor:', result.profitFactor);
console.log('Net PnL:', result.netPnL);
console.log('Max Drawdown:', result.maxDrawdown);
console.log('Total Fees:', result.totalFees);
console.log('Long Trades:', result.longTrades);
console.log('Short Trades:', result.shortTrades);

// Show trade details
console.log('\n=== FIRST 10 TRADES ===');
result.tradeDetails.slice(0, 10).forEach((t, i) => {
  console.log('Trade ' + (i+1) + ': side=' + t.side + ', pnl=' + t.pnl.toFixed(2) + ', reason=' + t.exitReason);
});

// Show trade side distribution
const longTrades = result.tradeDetails.filter(t => t.side === 'LONG');
const shortTrades = result.tradeDetails.filter(t => t.side === 'SHORT');
console.log('\nLONG trades:', longTrades.length);
console.log('SHORT trades:', shortTrades.length);

// Show all trades
console.log('\n=== ALL TRADES ===');
result.tradeDetails.forEach((t, i) => {
  console.log('Trade ' + (i+1) + ': side=' + t.side + ', pnl=' + t.pnl.toFixed(2) + ', reason=' + t.exitReason + ', score=' + t.signalScore);
});
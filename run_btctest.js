const fs = require('fs');
const { backtest } = require('./src/backtest/engine');

// Load the 19604 dataset
const data = JSON.parse(fs.readFileSync('./reports/btc_usdt_15m_3m6m_raw.json', 'utf8'));
const candles = data.candles;

console.log('Candle count:', candles.length);
console.log('First candle timestamp:', new Date(candles[0][0]).toISOString());
console.log('Last candle timestamp:', new Date(candles[candles.length-1][0]).toISOString());

const result = backtest('default', candles, 10000, {
  riskPerTrade: 0.5,
  maxLeverage: 5,
  commissionRate: 0.001,
  slPercent: 2.5,
  tpPercent: 5,
});

console.log('\n=== BASELINE RESULTS ===');
console.log('Total Trades:', result.totalTrades);
console.log('Win Rate:', result.winRate);
console.log('Profit Factor:', result.profitFactor);
console.log('Net PnL:', result.netPnL);
console.log('Max Drawdown:', result.maxDrawdown);
console.log('Total Fees:', result.totalFees);
console.log('Long Trades:', result.longTrades);
console.log('Short Trades:', result.shortTrades);

// Show first 10 trades
console.log('\n=== FIRST 10 TRADES ===');
result.tradeDetails.slice(0, 10).forEach((t, i) => {
  console.log('Trade ' + (i+1) + ': side=' + t.side + ', pnl=' + t.pnl.toFixed(2) + ', reason=' + t.exitReason);
});
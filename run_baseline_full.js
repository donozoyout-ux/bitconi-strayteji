const fs = require('fs');
const data = JSON.parse(fs.readFileSync('./full_6month_data.json', 'utf8'));
const candles = data.candles;

// Use the backtest engine
const { backtest } = require('./src/backtest/engine');

const result = backtest('default', candles, 10000, {
  riskPerTrade: 0.5,
  maxLeverage: 5,
  commissionRate: 0.001,
  slPercent: 2.5,
  tpPercent: 5,
});

console.log('=== BASELINE BACKTEST RESULTS ===');
console.log('Initial Capital:', result.initialCapital);
console.log('Final Capital:', result.finalCapital);
console.log('Net PnL:', result.netPnL);
console.log('Total Trades:', result.totalTrades);
console.log('Win Rate:', result.winRate);
console.log('Profit Factor:', result.profitFactor);
console.log('Max Drawdown:', result.maxDrawdown);
console.log('Total Fees:', result.totalFees);
console.log('Long Trades:', result.longTrades);
console.log('Short Trades:', result.shortTrades);
console.log('Expectancy:', result.expectancy);

// Detailed trade info
console.log('\n=== FIRST 10 TRADES ===');
result.tradeDetails.slice(0, 10).forEach((t, i) => {
  console.log(`Trade ${i+1}: side=${t.side}, entry=${t.entryPrice.toFixed(2)}, exit=${t.exitPrice?.toFixed(2)}, pnl=${t.pnl.toFixed(2)}, reason=${t.exitReason}`);
});

console.log('\n=== ALL TRADES SUMMARY ===');
console.log('Trades:', result.totalTrades);
console.log('LONG:', result.longTrades, 'SHORT:', result.shortTrades);
console.log('Win rate:', result.winRate.toFixed(2) + '%');
console.log('Profit factor:', result.profitFactor.toFixed(2));
console.log('Gross PnL (before fees):', ((result.finalCapital - result.initialCapital) + result.totalFees).toFixed(2));
console.log('Fees:', result.totalFees.toFixed(2));
console.log('Net PnL:', result.netPnL.toFixed(2));
console.log('Max DD:', result.maxDrawdown.toFixed(2));

// Trade distribution
const longTrades = result.tradeDetails.filter(t => t.side === 'LONG');
const shortTrades = result.tradeDetails.filter(t => t.side === 'SHORT');
console.log('\nLONG trades PnL avg:', longTrades.length > 0 ? longTrades.reduce((a, b) => a + b.pnl, 0) / longTrades.length : 'N/A');
console.log('SHORT trades PnL avg:', shortTrades.length > 0 ? shortTrades.reduce((a, b) => a + b.pnl, 0) / shortTrades.length : 'N/A');

// Show all trade details
console.log('\n=== ALL TRADES DETAILS ===');
result.tradeDetails.forEach((t, i) => {
  console.log(`Trade ${i+1}: side=${t.side}, entry=${t.entryPrice.toFixed(2)}, exit=${t.exitPrice?.toFixed(2)}, pnl=${t.pnl.toFixed(2)}, reason=${t.exitReason}, score=${t.signalScore}, regime=${t.regime}`);
});
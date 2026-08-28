const fs = require('fs');
const data = JSON.parse(fs.readFileSync('./full_6month_data.json', 'utf8'));
const candles = data.candles;

// Convert to the format expected by the backtest engine: each candle is [timestamp, open, high, low, close, volume]
// The data from Binance is already in this format

// We need to use the backtest engine
const { backtest } = require('./src/backtest/engine');

// Run backtest with default config matching the strategy parameters
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
console.log('Avg Win:', result.avgWin);
console.log('Avg Loss:', result.avgLoss);
console.log('Avg Trade:', result.avgTrade);

// Detailed trade info
console.log('\n=== FIRST 10 TRADES ===');
result.tradeDetails.slice(0, 10).forEach((t, i) => {
  console.log(`Trade ${i+1}: side=${t.side}, entry=${t.entryPrice.toFixed(2)}, exit=${t.exitPrice?.toFixed(2)}, pnl=${t.pnl.toFixed(2)}, reason=${t.exitReason}`);
});

console.log('\n=== ALL TRADES SUMMARY ===');
console.log('Trades:', result.totalTrades);
console.log('LONG:', result.longTrades, 'SHORT:', result.shortTrades);
console.log('Win rate:', result.winRate + '%');
console.log('Profit factor:', result.profitFactor);
console.log('Gross PnL (before fees):', (result.finalCapital - result.initialCapital + result.totalFees).toFixed(2));
console.log('Fees:', result.totalFees.toFixed(2));
console.log('Net PnL:', result.netPnL.toFixed(2));
console.log('Max DD:', result.maxDrawdown.toFixed(2));
// Convert from {timestamp, open, high, low, close, volume} to [timestamp, open, high, low, close, volume]
const fs = require('fs');
const rawData = JSON.parse(fs.readFileSync('./reports/btc_usdt_15m_3m6m_raw.json', 'utf8'));
const rawCandles = rawData.candles;

// Convert from {timestamp, open, high, low, close, volume} to [timestamp, open, high, low, close, volume]
const converted = rawCandles.map(c => [c.timestamp, c.open, c.high, c.low, c.close, c.volume]);

// Write converted dataset
fs.writeFileSync('./reports/btc_usdt_15m_3m6m_converted.json', JSON.stringify({candles: converted}));

console.log('Converted candle count:', converted.length);
console.log('First candle:', converted[0]);
console.log('Last candle:', converted[converted.length-1]);

// Now run baseline
const { backtest } = require('./src/backtest/engine');

const result = backtest('default', converted, 10000, {
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
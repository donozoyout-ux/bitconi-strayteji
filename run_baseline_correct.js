const fs = require('fs');
const data = JSON.parse(fs.readFileSync('./reports/btc_usdt_15m_3m6m_raw.json', 'utf8'));
const candles = data.candles;

// Verify candle format
console.log('Candle format: timestamp, open, high, low, close, volume');
console.log('Total candles:', candles.length);
console.log('First candle:', JSON.stringify(candles[0]));
console.log('Last candle:', JSON.stringify(candles[candles.length-1]));

// Run baseline backtest
const { backtest } = require('./src/backtest/engine');

const result = backtest('default', candles, 10000, {
  riskPerTrade: 0.5,
  maxLeverage: 5,
  commissionRate: 0.001,
  slPercent: 2.5,
  tpPercent: 5,
});

console.log('\n=== BASELINE BACKTEST RESULTS ===');
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

// Compare with expected baseline
console.log('\n=== COMPARISON WITH EXPECTED BASELINE ===');
const expected = {
  totalTrades: 38,
  winRate: 54.2,
  profitFactor: 1.68,
  grossPnL: 184.37,
  fees: 1.25,
  netPnL: 183.12,
  maxDD: 45.00
};

const actualGross = result.finalCapital - result.initialCapital + result.totalFees;
console.log('Expected total trades:', expected.totalTrades, 'Actual:', result.totalTrades);
console.log('Expected win rate:', expected.winRate + '%, Actual:', result.winRate + '%');
console.log('Expected profit factor:', expected.profitFactor, 'Actual:', result.profitFactor);
console.log('Expected gross PnL:', expected.grossPnL, 'Actual gross:', actualGross.toFixed(2));
console.log('Expected fees:', expected.fees, 'Actual:', result.totalFees.toFixed(2));
console.log('Expected net PnL:', expected.netPnL, 'Actual net:', result.netPnL.toFixed(2));
console.log('Expected max DD:', expected.maxDD, 'Actual:', result.maxDrawdown.toFixed(2));
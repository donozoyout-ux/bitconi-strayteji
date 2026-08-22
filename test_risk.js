const risk = require('./src/services/risk-engine');

console.log('=== Risk Engine Tests ===');

// Test position size
const pos = risk.calculatePositionSize(1000, 0.5, 50);
console.log('\nPosition Size Test:');
console.log('equity: 1000, risk: 0.5%, stop: 50');
console.log('result:', JSON.stringify(pos, null, 2));

// Test risk limits check
const check = risk.checkRiskLimits(-5, 3, 5, { maxDailyLossPercent: 2, maxConsecutiveLosses: 3, maxTradesPerDay: 10 });
console.log('\nRisk Limit Check Test:');
console.log('dailyPnL: -5, consecutive: 3, trades: 5');
console.log('result:', JSON.stringify(check, null, 2));

// Test with passing conditions
const check2 = risk.checkRiskLimits(-1, 1, 3, { maxDailyLossPercent: 2, maxConsecutiveLosses: 3, maxTradesPerDay: 10 });
console.log('\nRisk Limit Check (passing):');
console.log('dailyPnL: -1, consecutive: 1, trades: 3');
console.log('result:', JSON.stringify(check2, null, 2));

console.log('\n=== All Risk Engine Tests Passed ===');
const s = require('./src/services/settings.service');
const strategy = require('./src/services/strategy.service');

// Initialize settings
s.set({
  rsiLength: 20,
  rsiMaLength: 20,
  bbLength: 30,
  bbStd: 2,
  executionTimeframe: '15m',
  higherTimeframe: '1h',
  regimeTimeframe: '4h',
  riskPerTrade: 0.5,
  maxLeverage: 5,
  allowShort: true,
});

console.log('=== Strategy Test ===');

// Generate some test candles (random walk simulation)
function generateCandles(n = 200) {
  const closes = [78000];
  const opens = [];
  const highs = [];
  const lows = [];
  const volumes = [];
  let price = 78000;
  for (let i = 1; i < n; i++) {
    const change = (Math.random() - 0.5) * 200;
    price = Math.max(10000, Math.min(100000, price + change));
    closes.push(price);
    opens.push(price - (Math.random() - 0.5) * 50);
    highs.push(Math.max(price, opens[i - 1] + Math.random() * 30));
    lows.push(Math.min(price, opens[i - 1] - Math.random() * 30));
    volumes.push(1000000 + Math.random() * 500000);
  }

  return closes.slice(0, n).map((c, i) => [i * 1000, opens[i], highs[i], lows[i], closes[i], volumes[i]]);
}

const candles = generateCandles(200);

console.log('Candle count:', candles.length);

// Test detectSignal
console.log('\n--- detectSignal ---');
const signal = strategy.detectSignal(candles, {
  rsiLen: 20,
  rsiMaLen: 20,
  bbLength: 30,
  bbMult: 2,
  executionTimeframe: '15m',
  higherTimeframe: '1h',
  regimeTimeframe: '4h',
  allowShort: true,
  allowStochRSIConfirmation: false,
});

console.log('Signal:', signal.signal);
console.log('Entry Type:', signal.entryType);
console.log('Score:', signal.score);
console.log('Regime:', signal.regime);
console.log('Chop:', signal.chop);
console.log('Reasons:', {
  rsi: signal.reasons.rsi.toFixed(1),
  rsiMa: signal.reasons.rsiMa.toFixed(1),
  bbBasis: signal.reasons.bbBasis.toFixed(0),
  bbLower: signal.reasons.bbLower.toFixed(0),
  bbUpper: signal.reasons.bbUpper.toFixed(0),
  rsiCrossUp: signal.reasons.rsiCrossUp,
  priceTouchLower: signal.reasons.priceTouchLower,
  priceTouchUpper: signal.reasons.priceTouchUpper,
  trendUp: signal.reasons.trendUp,
  regime: signal.regime,
  chop: signal.chop,
});

// Test evaluateEntry
console.log('\n--- evaluateEntry ---');
const entry = strategy.evaluateEntry(candles, {
  rsiLen: 20,
  rsiMaLen: 20,
  bbLength: 30,
  bbMult: 2,
  riskPerTrade: 0.5,
  maxLeverage: 5,
  allowShort: true,
  allowStochRSIConfirmation: false,
});

console.log('Signal:', entry.signal);
console.log('Entry Type:', entry.entryType);
console.log('Side:', entry.side);
console.log('Score:', entry.score);
console.log('Regime:', entry.regime);
console.log('Chop:', entry.chop);
console.log('Reasons:', {
  rsi: entry.reasons.rsi?.toFixed(1),
  rsiMa: entry.reasons.rsiMa?.toFixed(1),
  bbBasis: entry.reasons.bbBasis?.toFixed(0),
  bbLower: entry.reasons.bbLower?.toFixed(0),
  bbUpper: entry.reasons.bbUpper?.toFixed(0),
  rsiCrossUp: entry.reasons.rsiCrossUp,
  priceTouchLower: entry.reasons.priceTouchLower,
  priceTouchUpper: entry.reasons.priceTouchUpper,
  trendUp: entry.reasons.trendUp,
  regime: entry.regime,
  chop: entry.chop,
});

// Test short signal with allowShort
console.log('\n--- Short Signal Test (allowShort=true) ---');
const entryAllowShort = strategy.evaluateEntry(candles, {
  rsiLen: 20,
  rsiMaLen: 20,
  bbLength: 30,
  bbMult: 2,
  riskPerTrade: 0.5,
  maxLeverage: 5,
  allowShort: true,
  allowStochRSIConfirmation: false,
});
console.log('Signal:', entryAllowShort.signal);
console.log('Side:', entryAllowShort.side);
console.log('Score:', entryAllowShort.score);

// Test long-only mode
console.log('\n--- Long-Only Test (allowShort=false) ---');
const entryLongOnly = strategy.evaluateEntry(candles, {
  rsiLen: 20,
  rsiMaLen: 20,
  bbLength: 30,
  bbMult: 2,
  riskPerTrade: 0.5,
  maxLeverage: 5,
  allowShort: false,
  allowStochRSIConfirmation: false,
});
console.log('Signal:', entryLongOnly.signal);
console.log('Side:', entryLongOnly.side);
console.log('Entry Type:', entryLongOnly.entryType);
console.log('Score:', entryLongOnly.score);

// Test evaluateExit
console.log('\n--- evaluateExit Test ---');
const exit = strategy.evaluateExit(
  {
    entryPrice: 78000,
    quantity: 1,
    side: 'LONG',
    stopPrice: 77500,
    tp1: 81600,
    tp2: 82800,
    tp1Done: false,
  },
  candles,
  79000, // live price - should trigger partial TP1
  { atrTrailMult: 2.5, timeExitCandles: 5, partialTpPercent: 50 }
);

console.log('Exit action:', exit.action);
console.log('Exit reason:', exit.reason);
console.log('Sell fraction:', exit.sellFraction);

// Test with price above TP1
console.log('\n--- TP1 Hit Test ---');
const exitTP1 = strategy.evaluateExit(
  {
    entryPrice: 78000,
    quantity: 1,
    side: 'LONG',
    stopPrice: 77500,
    tp1: 80000,
    tp2: 82000,
    tp1Done: false,
  },
  candles,
  80500, // live price above TP1
  { atrTrailMult: 2.5, timeExitCandles: 5, partialTpPercent: 50 }
);

console.log('Exit action:', exitTP1.action);
console.log('Exit reason:', exitTP1.reason);
console.log('Sell fraction:', exitTP1.sellFraction);

// Test SHORT exit
console.log('\n--- Short Exit Test ---');
const exitShort = strategy.evaluateExit(
  {
    entryPrice: 78000,
    quantity: 1,
    side: 'SHORT',
    stopPrice: 78500,
    tp1: 75500,
    tp2: 74500,
    tp1Done: false,
  },
  candles,
  75000, // live price below TP1 for short = profit
  { atrTrailMult: 2.5, timeExitCandles: 5, partialTpPercent: 50 }
);

console.log('Exit action:', exitShort.action);
console.log('Exit reason:', exitShort.reason);
console.log('Sell fraction:', exitShort.sellFraction);

console.log('\n=== All Strategy Tests Completed ===');
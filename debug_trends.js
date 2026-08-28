const fs = require('fs');

// Load data
const t = JSON.parse(fs.readFileSync('./trend-events.json', 'utf8'));
const trends = t.trends;
const data = JSON.parse(fs.readFileSync('./full_6month_data.json', 'utf8'));
const candles = data.candles;

// Use the closes from the full 6m data in array format
// The full_6month_data.json candles are [timestamp, open, high, low, close, volume]
const closes = candles.map(c => c[4]);

console.log('Candle count:', candles.length);
console.log('First close:', typeof closes[0], closes[0]);
console.log('Close at trend 0 start (1300):', typeof closes[1300], closes[1300]);

const { detectSignal } = require('./src/services/strategy.service');

// Check first 5 trends in detail
for (let ti = 0; ti < 5; ti++) {
  const trend = trends[ti];
  const startIdx = trend.startIdx;
  const direction = trend.direction;
  
  console.log('\n=== Trend', ti, ': direction=', direction, 'candle', startIdx, '===');
  
  // RSI at trend start from quick calculation
  const lookback = startIdx;
  const closePrices = [];
  for (let j = 1; j <= lookback; j++) closePrices.push(closes[lookback - j]);
  closePrices.reverse();
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= 20; i++) {
    const change = closePrices[i] - closePrices[i - 1];
    if (change >= 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= 20; avgLoss /= 20;
  const rsiVal = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  console.log('RSI at start (quick calc):', rsiVal?.toFixed(2));
  
  // detectSignal
  const bs = detectSignal(candles, {
    rsiLen: 20,
    rsiMaLen: 20,
    bbLength: 30,
    bbMult: 2,
    executionTimeframe: '15m',
    higherTimeframe: '1h',
    regimeTimeframe: '4h',
    volumeThreshold: 1.0,
    chopThreshold: 35,
  });
  console.log('detectSignal:', bs.signal, 'score:', bs.score, 'regime:', bs.regime, 'chop:', bs.chop);
  if (bs.rsi != null) console.log('  rsi:', bs.rsi.toFixed(1));
  if (bs.rsiMa != null) console.log('  rsiMa:', bs.rsiMa.toFixed(1));
  if (bs.bbLower != null) console.log('  bbLower:', bs.bbLower.toFixed(2));
  if (bs.bbUpper != null) console.log('  bbUpper:', bs.bbUpper.toFixed(2));
  if (bs.bbBasis != null) console.log('  bbBasis:', bs.bbBasis.toFixed(2));
  console.log('  priceTouchLower:', bs.priceTouchLower, 'priceTouchUpper:', bs.priceTouchUpper);
  console.log('  rsiCrossUp:', bs.reasons.rsiCrossUp, 'rsiCrossDown:', bs.reasons.rsiCrossDown);
  console.log('  regime:', bs.regime, 'chop:', bs.chop);
}
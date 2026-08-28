const { detectSignal } = require('./src/services/strategy.service');
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('./reports/btc_usdt_15m_converted.json', 'utf8')).candles;
const candles = data.length;

console.log('Candle count:', candles);

// Check signals in last 200
let longCount = 0, shortCount = 0;
for (let i = candles - 200; i < candles; i++) {
  const result = detectSignal(data, {
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
  if (result.signal === 'LONG') longCount++;
  if (result.signal === 'SHORT') shortCount++;
}
console.log('Last 200 - LONG:', longCount, 'SHORT:', shortCount);

// Check total signals
longCount = 0; shortCount = 0;
for (let i = 35; i < candles; i++) {
  const result = detectSignal(data, {
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
  if (result.signal === 'LONG') longCount++;
  if (result.signal === 'SHORT') shortCount++;
}
console.log('Total - LONG:', longCount, 'SHORT:', shortCount, 'Total signals:', longCount + shortCount);
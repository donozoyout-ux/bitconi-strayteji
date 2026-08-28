const { detectSignal } = require('./src/services/strategy.service');
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('./reports/btc_usdt_15m_3m6m_raw.json', 'utf8'));
const candles = data.candles;

// Search entire dataset for signals
let longCount = 0, shortCount = 0, total = 0;
const signalPositions = [];

for (let i = 35; i < candles.length; i++) {
  const result = detectSignal(candles, {
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
  if (result.signal) {
    total++;
    if (result.signal === 'LONG') longCount++;
    if (result.signal === 'SHORT') shortCount++;
    if (signalPositions.length < 20) {
      signalPositions.push({idx: i, signal: result.signal, score: result.score, rsi: result.rsi, regime: result.regime});
    }
  }
  if (i % 2000 === 0) console.log('Processed', i, '/', candles.length, 'candles, signals so far:', total);
}
console.log('\n=== RESULTS ===');
console.log('Total signals found:', total);
console.log('LONG:', longCount, 'SHORT:', shortCount);
console.log('Catch rate:', (longCount + shortCount) / (candles.length - 35) * 100 + '%');

// Show first 20 signals
signalPositions.slice(0, 20).forEach((p, i) => {
  console.log('Signal ' + (i+1) + ' at candle ' + p.idx + ':' + p.signal + ' score:' + p.score + ' rsi:' + p.rsi.toFixed(1) + ' regime:' + p.regime);
});
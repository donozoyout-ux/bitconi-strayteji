// Quick dataset analysis - just read first/last and basic stats
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('./reports/btc_usdt_15m_converted.json', 'utf8'));
const candles = data.candles;

const closes = candles.map(c => c[4]);
const first = new Date(candles[0][0]);
const last = new Date(candles[candles.length-1][0]);

console.log('Candle count:', candles.length);
console.log('First date:', first.toISOString());
console.log('Last date:', last.toISOString());
console.log('First close:', closes[0].toFixed(2));
console.log('Last close:', closes[closes.length-1].toFixed(2));
const priceChange = ((closes[closes.length-1] - closes[0]) / closes[0] * 100).toFixed(2);
console.log('Price change %:', priceChange);

// Very quick RSI check on just a few points
// Check if RSI goes above/below 50 in the data
let rsiCount = 0;
for (let i = 20; i < Math.min(closes.length, 100); i++) {
  let sumGain = 0, sumLoss = 0;
  for (let j = 1; j <= 20; j++) {
    const change = closes[i - j + 1] - closes[i - j];
    if (change >= 0) sumGain += change;
    else sumLoss -= change;
  }
  const avgGain = sumGain / 20;
  const avgLoss = sumLoss / 20;
  if (avgLoss > 0) {
    const rsi = 100 - 100 / (1 + avgGain / avgLoss);
    if (rsi > 55 || rsi < 45) {
      rsiCount++;
      if (rsiCount <= 3) {
        console.log('RSI at', i, ':', rsi.toFixed(1), '(>55 or <45)');
      }
    }
  }
}
console.log('RSI extremes (>55 or <45) in first 100 candles:', rsiCount);
const fs = require('fs');

// Load data - use the converted 19604 dataset (array format)
const rawData = JSON.parse(fs.readFileSync('./reports/btc_usdt_15m_3m6m_raw.json', 'utf8'));
const rawCandles = rawData.candles;
const converted = rawCandles.map(c => [c.timestamp, c.open, c.high, c.low, c.close, c.volume]);
const candles = converted;

// Use closes from the 19604 data
const closes = candles.map(c => c[4]);
console.log('Candle count:', candles.length);
console.log('First close:', closes[0]);
console.log('Close type at 0:', typeof closes[0]);

// Test BB calculation with just a few candles
function sma(values, length) {
  const out = new Array(values.length).fill(null);
  for (let i = length - 1; i < values.length; i++) {
    let sum = 0;
    let ok = true;
    for (let j = i - length + 1; j <= i; j++) {
      if (values[j] == null) { ok = false; break; }
      sum += values[j];
    }
    if (ok) out[i] = sum / length;
  }
  return out;
}

function bollinger(closes, length, mult) {
  console.log('BB function called with length:', length, 'mult:', mult);
  console.log('closes.length:', closes.length);
  console.log('first few closes:', closes.slice(0, 5));
  
  const basis = sma(closes, length);
  console.log('basis[29] (index 29):', basis[29]);
  console.log('basis[30] (index 30):', basis[30]);
  
  if (basis[length - 1] == null) {
    console.log('basis[length-1] is null, returning early');
    return { basis, lower: new Array(closes.length).fill(null), upper: new Array(closes.length).fill(null) };
  }
  
  let sum = 0;
  for (let j = length - 1; j <= length; j++) {
    console.log('j=', j, 'closes[j]=', closes[j], 'basis[', j, ']=', basis[j]);
    const diff = closes[j] - basis[j];
    sum += diff * diff;
  }
  const sd = Math.sqrt(sum / length);
  console.log('sd:', sd);
  
  const lower = basis.map((b, i) => b - mult * sd);
  const upper = basis.map((b, i) => b + mult * sd);
  
  return { basis, lower, upper };
}

// Test with first 35 candles (need at least 30 + 5)
const result = bollinger(closes, 30, 2);
console.log('result.basis[30]:', result.basis[30]);
console.log('result.lower[30]:', result.lower[30]);
console.log('result.upper[30]:', result.upper[30]);
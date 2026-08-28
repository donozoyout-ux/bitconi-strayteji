// Trend Miss Audit Analysis
// Analyzes 6-month BTC/USDT 15m dataset for missed strong trends

const fs = require('fs');

// Load data
const data = JSON.parse(fs.readFileSync('./full_6month_data.json', 'utf8'));
const candles = data.candles;

// Convert to close prices array
const closes = candles.map(c => c[4]);
const timestamps = candles.map(c => c[0]);

// ============================================================
// Helper functions - Technical Indicators
// ============================================================

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

function ema(values, length) {
  const out = new Array(values.length).fill(null);
  if (values.length < length) return out;
  const k = 2 / (length + 1);
  let sum = 0;
  let count = 0;
  let prev = null;
  let started = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null || Number.isNaN(v)) continue;
    if (!started) {
      sum += v;
      count++;
      if (count === length) {
        prev = sum / length;
        out[i] = prev;
        started = true;
      }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

function rsi(closes, length) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < length + 1) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= length;
  avgLoss /= length;
  out[length] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = length + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (length - 1) + gain) / length;
    avgLoss = (avgLoss * (length - 1) + loss) / length;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function rsiMa(closes, length) {
  const rsiSeries = rsi(closes, length);
  const ma = ema(rsiSeries, length);
  return ma;
}

function bollinger(closes, length, mult) {
  const basis = sma(closes, length);
  const lower = new Array(closes.length).fill(null);
  const upper = new Array(closes.length).fill(null);
  for (let i = length - 1; i < closes.length; i++) {
    if (basis[i] == null) continue;
    let sum = 0;
    for (let j = i - length + 1; j <= i; j++) {
      const diff = closes[j] - basis[i];
      sum += diff * diff;
    }
    const sd = Math.sqrt(sum / length);
    lower[i] = basis[i] - mult * sd;
    upper[i] = basis[i] + mult * sd;
  }
  return { basis, lower, upper };
}

function adx(candles, length) {
  const n = candles.length;
  const adx = new Array(n).fill(null);
  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  if (n < length * 2 + 2) return { adx, plusDI, minusDI };

  const tr = [];
  const plusDM = [];
  const minusDM = [];
  for (let i = 1; i < n; i++) {
    const high = candles[i][2];
    const low = candles[i][3];
    const prevClose = candles[i - 1][4];
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    const upMove = high - candles[i - 1][2];
    const downMove = candles[i - 1][3] - low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  let str = 0, sPlus = 0, sMinus = 0;
  for (let i = 0; i < length; i++) {
    str += tr[i];
    sPlus += plusDM[i];
    sMinus += minusDM[i];
  }

  const dxArr = new Array(n).fill(null);
  for (let i = length; i < tr.length; i++) {
    if (i > length) {
      str = str - str / length + tr[i];
      sPlus = sPlus - sPlus / length + plusDM[i];
      sMinus = sMinus - sMinus / length + minusDM[i];
    }
    const pdi = str > 0 ? (100 * sPlus) / str : 0;
    const mdi = str > 0 ? (100 * sMinus) / str : 0;
    plusDI[i + 1] = pdi;
    minusDI[i + 1] = mdi;
    dxArr[i + 1] = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
  }

  let firstIdx = null;
  for (let i = 0; i < n; i++) {
    if (dxArr[i] != null) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx == null || firstIdx + length >= n) return { adx, plusDI, minusDI };

  let sum = 0;
  for (let i = firstIdx; i < firstIdx + length; i++) sum += dxArr[i];
  adx[firstIdx + length - 1] = sum / length;
  for (let i = firstIdx + length; i < n; i++) {
    adx[i] = (adx[i - 1] * (length - 1) + dxArr[i]) / length;
  }
  return { adx, plusDI, minusDI };
}

// ============================================================
// Trend Detection
// ============================================================

// Define a strong trend:
// - Price moves at least 3% from start price in forward window
// - Trend confirmed by ADX > 20
// - Not just random noise (sustained move)

// For each candle, identify if there's a strong trend starting after it

function findStrongTrends(startIdx, direction, minPct = 0.03, lookAheadCandles = 40) {
  const startPrice = closes[startIdx];
  const endIdx = Math.min(startIdx + lookAheadCandles, closes.length - 1);
  
  let extremePrice;
  
  if (direction === 'LONG') {
    extremePrice = startPrice;
    for (let i = startIdx; i <= endIdx; i++) {
      if (closes[i] > extremePrice) extremePrice = closes[i];
    }
    const movePct = (extremePrice - startPrice) / startPrice;
    if (movePct < minPct) return null;
  } else {
    extremePrice = startPrice;
    for (let i = startIdx; i <= endIdx; i++) {
      if (closes[i] < extremePrice) extremePrice = closes[i];
    }
    const movePct = (startPrice - extremePrice) / startPrice;
    if (movePct < minPct) return null;
  }
  
  // Check ADX for trend strength
  const adxResult = adx(candles, 14);
  const adxVal = adxResult.adx[Math.min(startIdx + 5, adxResult.adx.length - 1)];
  
  if (adxVal == null || adxVal < 20) return null;
  
  return {
    startIdx,
    startPrice,
    endPrice: direction === 'LONG' ? extremePrice : startPrice,
    movePct: direction === 'LONG' ? (extremePrice - startPrice) / startPrice : (startPrice - extremePrice) / startPrice,
    adx: adxVal,
    direction: direction,
    durationBars: lookAheadCandles
  };
}

// ============================================================
// Main Analysis: Identify all strong trend events
// ============================================================

console.log('Identifying strong trend events in 6-month dataset...');
console.log('Dataset:', candles.length, 'candles');
console.log('Period:', new Date(candles[0][0]).toISOString(), 'to', new Date(candles[candles.length-1][0]).toISOString());

const allTrends = [];

// Configuration
const lookAheadCandles = 100; // Look ahead 100 15m candles (~25 hours)
const searchStep = 100; // Check every 100 candles (25 hours)

// First pass: find all potential trend starts
for (let i = 0; i < candles.length - lookAheadCandles; i += searchStep) {
  // Check LONG
  const longTrend = findStrongTrends(i, 'LONG', 0.03, 100);
  if (longTrend) {
    allTrends.push(longTrend);
  }
  // Check SHORT  
  const shortTrend = findStrongTrends(i, 'SHORT', 0.03, 100);
  if (shortTrend) {
    allTrends.push(shortTrend);
  }
}

console.log('\nTotal potential trend events found:', allTrends.length);

// Deduplicate: remove trends that overlap significantly
// Sort by start index
allTrends.sort((a, b) => a.startIdx - b.startIdx);

const filteredTrends = [];
for (let t of allTrends) {
  const hasOverlap = filteredTrends.some(existing => {
    // Trends are too close if start indices are within 50 candles
    const startDiff = Math.abs(existing.startIdx - t.startIdx);
    const overlap = Math.min(existing.startIdx + 100, t.startIdx + 100) - Math.max(existing.startIdx, t.startIdx);
    return startDiff < 50 && overlap > 0;
  });
  if (!hasOverlap) {
    filteredTrends.push(t);
  }
}

console.log('After deduplication:', filteredTrends.length);

const longTrends = filteredTrends.filter(t => t.direction === 'LONG');
const shortTrends = filteredTrends.filter(t => t.direction === 'SHORT');

console.log('LONG trends:', longTrends.length);
console.log('SHORT trends:', shortTrends.length);

// Detailed output
console.log('\n=== LONG TRENDS ===');
longTrends.forEach((t, i) => {
  const sp = typeof t.startPrice === 'number' ? t.startPrice : 0;
  const ep = typeof t.endPrice === 'number' ? t.endPrice : 0;
  console.log(` ${i+1}. Start: candle ${t.startIdx}, Move: ${(t.movePct*100).toFixed(2)}%, ADX: ${t.adx.toFixed(1)}, Start price: $${sp.toFixed(2)}, End price: $${ep.toFixed(2)}`);
});

console.log('\n=== SHORT TRENDS ===');
shortTrends.forEach((t, i) => {
  const sp = typeof t.startPrice === 'number' ? t.startPrice : 0;
  const ep = typeof t.endPrice === 'number' ? t.endPrice : 0;
  console.log(` ${i+1}. Start: candle ${t.startIdx}, Move: ${(t.movePct*100).toFixed(2)}%, ADX: ${t.adx.toFixed(1)}, Start price: $${sp.toFixed(2)}, End price: $${ep.toFixed(2)}`);
});

// Save results
fs.writeFileSync('./trend-events.json', JSON.stringify({
  trends: filteredTrends,
  longTrends: longTrends,
  shortTrends: shortTrends,
  datasetInfo: {
    candleCount: candles.length,
    startDate: new Date(candles[0][0]).toISOString(),
    endDate: new Date(candles[candles.length-1][0]).toISOString()
  }
}, null, 2));

console.log('\nResults saved to trend-events.json');
const fs = require('fs');

// Load data - use the 19604 converted dataset (array format)
const rawData = JSON.parse(fs.readFileSync('./reports/btc_usdt_15m_3m6m_raw.json', 'utf8'));
const rawCandles = rawData.candles;

// Convert from {timestamp, open, high, low, close, volume} to [timestamp, open, high, low, close, volume]
const converted = rawCandles.map(c => [c.timestamp, c.open, c.high, c.low, c.close, c.volume]);

// Load trend events
const t = JSON.parse(fs.readFileSync('./trend-events.json', 'utf8'));
const trends = t.trends;

// Use the converted 19604 candles
const candles = converted;
const closes = candles.map(c => c[4]);

console.log('Candle count:', candles.length);
console.log('First candle:', candles[0]);
console.log('Last candle:', candles[candles.length-1]);

// Helper: RSI calculation
function rsi(closes, length) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < length + 1) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= length; avgLoss /= length;
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

// Helper: SMA
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

// Helper: BB
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

// Check first 10 trends in detail
for (let ti = 0; ti < Math.min(10, trends.length); ti++) {
  const trend = trends[ti];
  const startIdx = trend.startIdx;
  const direction = trend.direction;
  
  console.log('\n=== Trend', ti, ': direction=', direction, 'candle', startIdx, '===');
  
  // Make sure startIdx is valid
  if (startIdx < 30 || startIdx >= candles.length) {
    console.log('  startIdx out of valid range [30, candles.length-1]');
    console.log('  startIdx:', startIdx, 'candles.length:', candles.length);
    continue;
  }
  
  // RSI at trend start
  const rsiSeries = rsi(closes, 20);
  const rsiVal = rsiSeries[startIdx];
  console.log('RSI at start:', rsiVal?.toFixed(2));
  
  // BB at trend start
  const bb = bollinger(closes, 30, 2);
  console.log('BB basis at start:', bb.basis[startIdx]?.toFixed(2));
  console.log('BB upper at start:', bb.upper[startIdx]?.toFixed(2));
  console.log('BB lower at start:', bb.lower[startIdx]?.toFixed(2));
  
  // Close at trend start
  const closeVal = closes[startIdx];
  console.log('Close at start:', typeof closeVal === 'number' ? closeVal.toFixed(2) : closeVal);
  console.log('Close >= basis:', closeVal >= bb.basis[startIdx]?.null ? 'N/A' : closeVal >= bb.basis[startIdx]);
  console.log('Close <= basis:', closeVal <= bb.basis[startIdx]?.null ? 'N/A' : closeVal <= bb.basis[startIdx]);
  console.log('Close < lower:', bb.lower[startIdx] != null && closeVal < bb.lower[startIdx]);
  console.log('Close > upper:', bb.upper[startIdx] != null && closeVal > bb.upper[startIdx]);
  
  // priceTouchLower / priceTouchUpper logic
  // Original strategy.service.js logic:
  // priceTouchLower = bbLower != null && (close < bbLower || (close != null && (close - bbLower) / bbBasis < -0.005));
  // priceTouchUpper = bbUpper != null && (close > bbUpper || (close != null && (close - bbUpper) / bbBasis > 0.005));
  
  const bbBasis = bb.basis[startIdx];
  const bbLower = bb.lower[startIdx];
  const bbUpper = bb.upper[startIdx];
  
  let priceTouchLower = false;
  let priceTouchUpper = false;
  
  if (bbLower != null) {
    if (closeVal < bbLower) {
      priceTouchLower = true;
    } else if (bbBasis != null && bbBasis != 0) {
      const ratio = (closeVal - bbLower) / bbBasis;
      if (ratio < -0.005) {
        priceTouchLower = true;
      }
    }
  }
  
  if (bbUpper != null) {
    if (closeVal > bbUpper) {
      priceTouchUpper = true;
    } else if (bbBasis != null && bbBasis != 0) {
      const ratio = (closeVal - bbUpper) / bbBasis;
      if (ratio > 0.005) {
        priceTouchUpper = true;
      }
    }
  }
  
  console.log('priceTouchLower:', priceTouchLower);
  console.log('priceTouchUpper:', priceTouchUpper);
  
  // Now let me check what detectSignal returns
  const { detectSignal } = require('./src/services/strategy.service');
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
  console.log('detectSignal result:', bs.signal, 'score:', bs.score);
  if (bs.rsi != null) console.log('  rsi:', bs.rsi.toFixed(1));
  if (bs.rsiMa != null) console.log('  rsiMa:', bs.rsiMa.toFixed(1));
  if (bs.bbLower != null) console.log('  bbLower:', bs.bbLower.toFixed(2));
  if (bs.bbUpper != null) console.log('  bbUpper:', bs.bbUpper.toFixed(2));
  if (bs.bbBasis != null) console.log('  bbBasis:', bs.bbBasis.toFixed(2));
  console.log('  priceTouchLower:', bs.priceTouchLower, 'priceTouchUpper:', bs.priceTouchUpper);
  console.log('  rsiCrossUp:', bs.reasons.rsiCrossUp, 'rsiCrossDown:', bs.reasons.rsiCrossDown);
}
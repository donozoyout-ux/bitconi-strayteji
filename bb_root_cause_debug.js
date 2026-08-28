const fs = require('fs');

// Load data
const candles = JSON.parse(fs.readFileSync('./full_6month_data.json', 'utf8')).candles;
const closes = candles.map(c => c[4]);
const t = JSON.parse(fs.readFileSync('./trend-events.json', 'utf8'));
const trends = t.trends;

// Helper: RSI
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

// Helper: BB
function bollinger(closes, length, mult) {
  const sma = (values, len) => {
    const out = new Array(values.length).fill(null);
    for (let i = len - 1; i < values.length; i++) {
      let sum = 0, ok = true;
      for (let j = i - len + 1; j <= i; j++) {
        if (values[j] == null) { ok = false; break; }
        sum += values[j];
      }
      if (ok) out[i] = sum / len;
    }
    return out;
  };
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

// DEBUG: Check first 10 trends with CORRECT property access
console.log('=== ROOT CAUSE DEBUG: priceTouchLower/Upper ===');
console.log();

for (let ti = 0; ti < Math.min(10, trends.length); ti++) {
  const trend = trends[ti];
  const startIdx = trend.startIdx;
  const direction = trend.direction;
  
  // Calculate RSI
  const rsiSeries = rsi(closes, 20);
  const rsiVal = rsiSeries[startIdx];
  
  // Calculate BB
  const bb = bollinger(closes, 30, 2);
  const bbBasis = bb.basis[startIdx];
  const bbLower = bb.lower[startIdx];
  const bbUpper = bb.upper[startIdx];
  const closeVal = closes[startIdx];
  
  // Calculate priceTouchLower/Upper using STRATEGY SERVICE EXACT logic
  // From strategy.service.js lines 243-244:
  // priceTouchLower = bbLower != null && (close < bbLower || (close != null && (close - bbLower) / bbBasis < -0.005));
  // priceTouchUpper = bbUpper != null && (close > bbUpper || (close != null && (close - bbUpper) / bbUpper > 0.005));
  
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
  
  // Now get detectSignal and access reasons property
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
  
  // Correct access: bs.reasons.priceTouchLower / bs.reasons.priceTouchUpper
  const rtl = bs.reasons?.priceTouchLower;
  const rtu = bs.reasons?.priceTouchUpper;
  
  console.log(`Trend ${ti}: dir=${direction} candle=${startIdx}`);
  const closeStr = typeof closeVal === 'number' ? closeVal.toFixed(2) : closeVal;
  console.log(`  RSI: ${rsiVal?.toFixed(2)}, Close: ${closeStr}`);
  console.log(`  BB: basis=${bbBasis?.toFixed(2)}, upper=${bbUpper?.toFixed(2)}, lower=${bbLower?.toFixed(2)}`);
  console.log(`  closePriceTouchLower(calc): ${priceTouchLower}, priceTouchUpper(calc): ${priceTouchUpper}`);
  console.log(`  detectSignal.reasons.priceTouchLower: ${rtl}`);
  console.log(`  detectSignal.reasons.priceTouchUpper: ${rtu}`);
  console.log(`  signal: ${bs.signal}, score: ${bs.score}`);
  console.log(`  reasons.rsiCrossUp: ${bs.reasons.rsiCrossUp}, rsiCrossDown: ${bs.reasons.rsiCrossDown}`);
  console.log(`  rsi: ${bs.rsi?.toFixed(2)}, rsiMa: ${bs.rsiMa?.toFixed(2)}`);
  console.log(`  regime: ${bs.regime}, chop: ${bs.chop}`);
  console.log();
}
// Trend vs Strategy Analysis
// Checks each strong trend event against the strategy signal generation

const fs = require('fs');

// Load trend events
const trendData = JSON.parse(fs.readFileSync('./trend-events.json', 'utf8'));
const trends = trendData.trends;

// Load the full candle data
const data = JSON.parse(fs.readFileSync('./full_6month_data.json', 'utf8'));
const candles = data.candles;
const closes = candles.map(c => c[4]);

// ============================================================
// Strategy Signal Detection (matches strategy.service.js logic)
// ============================================================

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

function bollinger(closes, length, mult) {
  // Simple SMA-based BB
  const smaFunc = (values, len) => {
    const out = new Array(values.length).fill(null);
    for (let i = len - 1; i < values.length; i++) {
      let sum = 0;
      let ok = true;
      for (let j = i - len + 1; j <= i; j++) {
        if (values[j] == null) { ok = false; break; }
        sum += values[j];
      }
      if (ok) out[i] = sum / len;
    }
    return out;
  };
  const basis = smaFunc(closes, length);
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
  // Same as before
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
  for (let i = 0; i < length; i++) { str += tr[i]; sPlus += plusDM[i]; sMinus += minusDM[i]; }
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
  for (let i = 0; i < n; i++) { if (dxArr[i] != null) { firstIdx = i; break; } }
  if (firstIdx == null || firstIdx + length >= n) return { adx, plusDI, minusDI };
  let sum = 0;
  for (let i = firstIdx; i < firstIdx + length; i++) sum += dxArr[i];
  adx[firstIdx + length - 1] = sum / length;
  for (let i = firstIdx + length; i < n; i++) { adx[i] = (adx[i - 1] * (length - 1) + dxArr[i]) / length; }
  return { adx, plusDI, minusDI };
}

// Helper: calculate signal at candle index i
function detectSignalAt(candles, i, rsiLen = 20, bbLen = 30, bbMult = 2, regimeTimeframe = '4h') {
  // Get data up to candle i
  const lookback = i;
  const closePrices = [], highs = [], lows = [];
  for (let j = 1; j <= lookback; j++) {
    closePrices.push(candles[lookback - j][4]);
    highs.push(candles[lookback - j][2]);
    lows.push(candles[lookback - j][3]);
  }
  closePrices.reverse(); highs.reverse(); lows.reverse();
  
  const currentClose = closePrices[closePrices.length - 1];
  
  // RSI
  const rsiSeriesResult = rsi(closePrices, rsiLen);
  const rsiVal = rsiSeriesResult[rsiSeriesResult.length - 1];
  const rsiMaVal = rsiMa(closePrices, rsiLen)[rsiMa(closePrices, rsiLen).length - 1];
  
  // Bollinger
  const bbResult = bollinger(closePrices, bbLen, bbMult);
  const bbLower = bbResult.lower[bbResult.lower.length - 1];
  const bbUpper = bbResult.upper[bbResult.upper.length - 1];
  const bbBasis = bbResult.basis[bbResult.basis.length - 1];
  const currentLow = lows[lows.length - 1];
  
  // Price relative to BB
  const priceAboveBasis = currentClose >= bbBasis;
  const priceBelowBasis = currentClose <= bbBasis;
  const priceTouchLower = bbLower != null && (currentLow < bbLower || (currentClose != null && (currentClose - bbLower) / bbBasis < -0.005));
  const priceTouchUpper = bbUpper != null && (currentClose > bbUpper || (currentClose != null && (currentClose - bbUpper) / bbUpper > 0.005));
  
  // Regime
  const adxResult = adx(candles, 14);
  const adxVal = adxResult.adx[adxResult.adx.length - 1];
  const ema20v = ema(closePrices, 20)[ema(closePrices, 20).length - 1];
  const ema50v = ema(closePrices, 50)[ema(closePrices, 50).length - 1];
  const trendUp = ema20v > ema50v;
  
  let regime = 'UNKNOWN';
  let chop = false;
  if (adxVal != null) {
    const adxStrong = adxVal > 25;
    const adxModerate = adxVal > 20;
    if (adxStrong && trendUp) regime = 'STRONG_BULL';
    else if (adxStrong && !trendUp) regime = 'STRONG_BEAR';
    else if (adxModerate && trendUp) regime = 'BULL';
    else if (adxModerate && !trendUp) regime = 'BEAR';
    if (bbUpper - bbLower > bbBasis * 0.4) regime = 'HIGH_VOLATILITY';
    else if ((bbUpper - bbLower) / bbBasis * 100 < 15) regime = 'RANGE';
    // Chop filter
    let crossovers = 0;
    const lookbackWindow = Math.min(30, lookback);
    for (let j = 1; j < lookbackWindow; j++) {
      const ema20j = ema(closePrices, 20)[j - 1] || 0;
      const ema50j = ema(closePrices, 50)[j - 1] || 0;
      if (ema20j > ema50j && ema(closePrices, 20)[j] <= ema(closePrices, 50)[j]) crossovers++;
      if (ema20j < ema50j && ema(closePrices, 20)[j] >= ema(closePrices, 50)[j]) crossovers++;
    }
    chop = crossovers > 35;
    if (!chop && regime === 'UNKNOWN') {
      if (trendUp) regime = 'BULL';
      else regime = 'BEAR';
    }
  }
  
  // RSI crossover
  const rsiPrev = rsiSeriesResult[rsiSeriesResult.length - 2];
  const rsiMaPrev = rsiMaVal; // simplified
  const rsiCrossUp = rsiPrev != null && rsiMaPrev != null && rsiPrev <= rsiMaPrev && rsiVal > rsiMaVal;
  const rsiCrossDown = rsiPrev != null && rsiMaPrev != null && rsiPrev >= rsiMa && rsiVal < rsiMa;
  
  // Core signal logic (from strategy.service.js)
  const rsiPassBull = rsiCrossUp && rsiVal != null && rsiVal > 50;
  const rsiPassBear = rsiCrossDown && rsiVal != null && rsiVal < 50;
  const bbConfirmationLong = priceTouchLower || (priceAboveBasis && rsiVal > rsiMaVal);
  const bbConfirmationShort = priceTouchUpper || (priceBelowBasis && rsiVal < rsiMaVal);
  
  let signal = null;
  let score = 0;
  
  if (regime !== 'CHOPPY' && !chop) {
    if (rsiPassBull && bbConfirmationLong) {
      signal = 'LONG';
      // Calculate score
      let signalScore = 0;
      const rsiDistance = Math.abs(rsiVal - rsiMaVal) / 10;
      if (rsiVal > rsiMaVal && rsiVal > 50) signalScore += 30 - rsiDistance * 2;
      else if (rsiVal < rsiMaVal && rsiVal < 50) signalScore += 30 - rsiDistance * 2;
      
      const pctB = bbBasis != null && bbLower != null && bbUpper != null ? ((currentClose - bbLower) / (bbUpper - bbLower) * 100) : null;
      if (pctB != null && pctB < 5) signalScore += 20;
      else if (pctB != null && pctB > 95) signalScore += 20;
      else if (pctB != null && pctB > 30 && pctB < 70) signalScore += 10;
      
      if (regime && regime !== 'UNKNOWN' && regime !== 'CHOPPY') {
        signalScore += 20;
        if (regime === 'STRONG_BULL' || regime === 'STRONG_BEAR') signalScore += 10;
      } else if (regime === 'CHOPPY') signalScore -= 20;
      
      if (trendUp != null) signalScore += trendUp ? 15 : 5;
      if (chop) signalScore -= 30;
      score = Math.max(0, Math.min(100, signalScore));
    } else if (rsiPassBear && bbConfirmationShort) {
      signal = 'SHORT';
      let signalScore = 0;
      const rsiDistance = Math.abs(rsiVal - rsiMaVal) / 10;
      if (rsiVal < rsiMaVal && rsiVal < 50) signalScore += 30 - rsiDistance * 2;
      
      const pctB = bbBasis != null && bbLower != null && bbUpper != null ? ((currentClose - bbLower) / (bbUpper - bbLower) * 100) : null;
      if (pctB != null && pctB > 95) signalScore += 20;
      else if (pctB != null && pctB < 30 && pctB > 70) signalScore += 10;
      
      if (regime && regime !== 'UNKNOWN' && regime !== 'CHOPPY') {
        signalScore += 20;
        if (regime === 'STRONG_BULL' || regime === 'STRONG_BEAR') signalScore += 10;
      } else if (regime === 'CHOPPY') signalScore -= 20;
      
      if (ema20v != null) signalScore += !trendUp ? 15 : 5;
      if (chop) signalScore -= 30;
      score = Math.max(0, Math.min(100, signalScore));
    }
  }
  
  return { signal, score, regime, chop, rsi: rsiVal, rsiMa: rsiMaVal, bbLower, bbUpper, bbBasis, priceTouchLower, priceTouchUpper, rsiCrossUp, rsiCrossDown };
}

// ============================================================
// Analyze each trend against strategy signals
// ============================================================

console.log('=== TREND vs STRATEGY ANALYSIS ===');
console.log('Total strong trends:', trends.length);

const results = [];

for (let t of trends) {
  const direction = t.direction;
  const startIdx = t.startIdx;
  const movePct = t.movePct;
  
  // The trend spans from startIdx to startIdx + 100 (lookAheadCandles)
  // We need to check strategy signals within this window
  // But also check if signal occurred before the trend "start"
  
  let strategySignalIdx = null; // When strategy first signaled
  let strategySignal = null;
  let signalScore = 0;
  let signalRegime = null;
  let signalChop = false;
  
  // Check for signals from candle 35 before startIdx up to startIdx + 100
  // We look at a window: [startIdx - 50, startIdx + 100]
  const searchStart = Math.max(35, startIdx - 50);
  const searchEnd = Math.min(candles.length - 1, startIdx + 100);
  
  let firstSignalIdx = null;
  let firstSignalScore = 0;
  
  for (let i = searchStart; i <= searchEnd; i++) {
    const result = detectSignalAt(candles, i);
    if (result.signal) {
      if (firstSignalIdx === null) {
        firstSignalIdx = i;
        firstSignalScore = result.score;
        strategySignal = result.signal;
        signalScore = result.score;
        signalRegime = result.regime;
        signalChop = result.chop;
      }
      // Track highest score or first signal
    }
  }
  
  strategySignalIdx = firstSignalIdx;
  
  // Categorize the trend
  let category;
  let reason;
  
  if (strategySignalIdx === null) {
    // No signal at all in the window
    // Check if there was any signal before the trend period
    const beforeWindowStart = Math.max(35, 0);
    const beforeWindowEnd = startIdx - 1;
    let anySignalBefore = false;
    for (let i = beforeWindowEnd; i >= beforeWindowStart; i--) {
      const r = detectSignalAt(candles, i);
      if (r.signal) { anySignalBefore = true; break; }
    }
    category = anySignalBefore ? 'CAUGHT_EARLY' : 'MISSED';
    reason = anySignalBefore ? 'Signal before trend' : 'No signal ever generated';
  } else {
    const sigIdx = strategySignalIdx;
    const trendStartRelative = sigIdx - startIdx;
    
    if (trendStartRelative <= 0) {
      // Strategy signaled before or at trend start - caught early
      category = 'CAUGHT_EARLY';
      reason = 'Strategy signaled ' + Math.abs(trendStartRelative) + ' candle(s) before trend start';
    } else if (trendStartRelative <= 20) {
      // Strategy signaled during trend but early enough
      category = 'CAUGHT_DURING_TREND';
      reason = 'Strategy signaled ' + trendStartRelative + ' candle(s) after trend start';
    } else if (trendStartRelative <= 50) {
      // Strategy signaled late in the trend
      category = 'CAUGHT_LATE';
      reason = 'Strategy signaled ' + trendStartRelative + ' candle(s) after trend start (too late)';
    } else {
      // Never signaled during relevant period
      category = 'MISSED';
      reason = 'Strategy signaled ' + trendStartRelative + ' candle(s) after trend start (never during trend)';
    }
  }
  
  // Also check the score - was it above minSignalScore (75)?
  const scoreInfo = strategySignalIdx !== null 
    ? ` Score: ${signalScore.toFixed(1)}${signalScore >= 75 ? ' (above 75)' : ' (below 75)'}`
    : ' No signal';
  
  results.push({
    trendId: t.trendId || (t.direction + '_' + startIdx),
    direction: direction,
    startIdx: startIdx,
    movePct: movePct,
    adx: t.adx,
    strategySignalIdx: strategySignalIdx,
    strategySignal: strategySignal,
    signalScore: signalScore,
    category: category,
    reason: reason + scoreInfo,
    movePctStr: (movePct * 100).toFixed(2) + '%'
  });
  
  if (results.length % 10 === 0) {
    console.log('Processed', results.length, '/', trends.length);
  }
}

// ============================================================
// Categorize and report
// ============================================================

const categories = {
  CAUGHT_EARLY: 0,
  CAUGHT_DURING_TREND: 0,
  CAUGHT_LATE: 0,
  MISSED: 0,
  FALSE_NOT_ACTIONABLE: 0
};

const categoryReasons = {
  CAUGHT_EARLY: [],
  CAUGHT_DURING_TREND: [],
  CAUGHT_LATE: [],
  MISSED: [],
  FALSE_NOT_ACTIONABLE: []
};

results.forEach(r => {
  categories[r.category]++;
  categoryReasons[r.category].push(r.reason);
});

console.log('\n=== CATEGORY SUMMARY ===');
console.log('CAUGHT EARLY:', categories.CAUGHT_EARLY);
console.log('CAUGHT DURING TREND:', categories.CAUGHT_DURING_TREND);
console.log('CAUGHT LATE:', categories.CAUGHT_LATE);
console.log('MISSED:', categories.MISSED);
console.log('FALSE/NOT ACTIONABLE:', categories.FALSE_NOT_ACTIONABLE);

const total = categories.CAUGHT_EARLY + categories.CAUGHT_DURING_TREND + categories.CAUGHT_LATE + categories.MISSED + categories.FALSE_NOT_ACTIONABLE;
const catchRate = (categories.CAUGHT_EARLY + categories.CAUGHT_DURING_TREND + categories.CAUGHT_LATE) / total * 100;
const missRate = categories.MISSED / total * 100;

console.log('\nCatch rate:', catchRate.toFixed(1) + '%');
console.log('Miss rate:', missRate.toFixed(1) + '%');

// Show details for MISSED trends
console.log('\n=== MISSED TREND DETAILS ===');
const missed = results.filter(r => r.category === 'MISSED');
missed.slice(0, 10).forEach(r => {
  console.log(`Trend at candle ${r.startIdx}, ${r.direction} move ${r.movePctStr}, ADX: ${r.adx}`);
  console.log(`  ${r.reason}`);
});

// Show reasons breakdown
console.log('\n=== MISSED REASONS ===');
const reasonCounts = {};
categoryReasons.MISSED.forEach(r => {
  // Extract main reason
  if (r.includes('below 75')) reasonCounts['SCORE < 75'] = (reasonCounts['SCORE < 75'] || 0) + 1;
  if (r.includes('CHOPPY') || r.includes('chop')) reasonCounts['REGIME/CHOPPY'] = (reasonCounts['REGIME/CHOPPY'] || 0) + 1;
  if (r.includes('no crossover')) reasonCounts['NO RSI CROSSOVER'] = (reasonCounts['NO RSI CROSSOVER'] || 0) + 1;
  if (r.includes('touch')) reasonCounts['NO BB TOUCH'] = (reasonCounts['NO BB TOUCH'] || 0) + 1;
  if (!reasonCounts['SCORE < 75'] && !reasonCounts['REGIME/CHOPPY'] && !reasonCounts['NO RSI CROSSOVER'] && !reasonCounts['NO BB TOUCH']) {
    reasonCounts['OTHER'] = (reasonCounts['OTHER'] || 0) + 1;
  }
});

Object.entries(reasonCounts).forEach(([reason, count]) => {
  console.log(`${reason}: ${count} (${(count / missed.length * 100).toFixed(1)}%)`);
});

// Save results
fs.writeFileSync('./missed-analysis.json', JSON.stringify({
  results: results,
  categories: categories,
  categoryReasons: categoryReasons,
  catchRate: catchRate,
  missRate: missRate,
  totalTrends: trends.length
}, null, 2));

console.log('\nAnalysis saved to missed-analysis.json');
const fs = require('fs');

// Load data
const t = JSON.parse(fs.readFileSync('./trend-events.json', 'utf8'));
const trends = t.trends;
const data = JSON.parse(fs.readFileSync('./full_6month_data.json', 'utf8'));
const candles = data.candles;
const closes = candles.map(c => c[4]);

console.log('Total trends to analyze:', trends.length);

// ============================================================
// Helper: detectSignal using strategy.service (research mode)
// ============================================================

const { detectSignal } = require('./src/services/strategy.service');

// ============================================================
// Helper: quickRsi
// ============================================================

function quickRsi(closes, length, startIdx) {
  const lookback = startIdx;
  const closePrices = [];
  for (let j = 1; j <= lookback; j++) closes[lookback - j];
  closePrices.reverse();
  if (closePrices.length < length + 1) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= length; i++) {
    const change = closePrices[i] - closePrices[i - 1];
    if (change >= 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= length; avgLoss /= length;
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

// ============================================================
// Helper: quick BB
// ============================================================

function quickBb(closes, length, mult, startIdx) {
  const sma = closes.slice(startIdx - length + 1, startIdx + 1)
    .filter((v, i) => v != null)
    .reduce((a, b) => a + b, 0) / length;
  let sqSum = 0;
  for (let j = startIdx - length + 1; j <= startIdx; j++) {
    if (closes[j] == null) continue;
    sqSum += Math.pow(closes[j] - sma, 2);
  }
  const sd = Math.sqrt(sqSum / length);
  return { basis: sma, lower: sma - mult * sd, upper: sma + mult * sd };
}

// ==========================================================//
// Model A: Early Trend Participation
// Relax RSI crossover — enter if rsi > 50 (LONG) or rsi < 50 (SHORT)
// WITHOUT requiring rsiCrossUp/rsiCrossDown
// ============================================================

function modelASignal(candles, i, rsiLen = 20, bbLen = 30, bbMult = 2, regimeTimeframe = '4h') {
  const lookback = i;
  const closePrices = [], highs = [], lows = [];
  for (let j = 1; j <= lookback; j++) {
    closePrices.push(candles[lookback - j][4]);
    highs.push(candles[lookback - j][2]);
    lows.push(candles[lookback - j][3]);
  }
  closePrices.reverse(); highs.reverse(); lows.reverse();
  
  const currentClose = closePrices[closePrices.length - 1];
  
  const rsiVal = quickRsi(closePrices, rsiLen, lookback);
  if (rsiVal == null) return { signal: null, side: null, score: 0 };
  
  const bb = quickBb(closePrices, bbLen, bbMult, lookback);
  if (bb.basis == null) return { signal: null, side: null, score: 0 };
  
  const priceAboveBasis = currentClose >= bb.basis;
  const priceBelowBasis = currentClose <= bb.basis;
  const priceTouchLower = bb.lower != null && currentClose < bb.lower;
  const priceTouchUpper = bb.upper != null && currentClose > bb.upper;
  
  const adxVal = 25;
  const regime = adxVal > 25 ? (currentClose > closes[i] ? 'STRONG_BULL' : 'STRONG_BEAR') :
                adxVal > 20 ? (currentClose > closes[i] ? 'BULL' : 'BEAR') : 'UNKNOWN';
  const chop = false;
  
  // Model A: NO crossover requirement
  const rsiPassBullModelA = rsiVal > 50;
  const rsiPassBearModelA = rsiVal < 50;
  
  const bbConfirmationLong = priceTouchLower || (priceAboveBasis && rsiVal > (rsiVal - 5));
  const bbConfirmationShort = priceTouchUpper || (priceBelowBasis && rsiVal < (rsiVal + 5));
  
  let signal = null;
  let side = null;
  let score = 0;
  
  if (regime !== 'CHOPPY' && !chop) {
    if (rsiPassBullModelA && bbConfirmationLong) {
      signal = 'LONG';
      side = 'LONG';
      const rsiDistance = Math.abs(rsiVal - (rsiVal - 5)) / 10;
      if (rsiVal > (rsiVal - 5) && rsiVal > 50) score += 30 - rsiDistance * 2;
      const pctB = ((currentClose - bb.lower) / (bb.upper - bb.lower) * 100);
      if (pctB != null && pctB < 5) score += 20;
      else if (pctB != null && pctB > 95) score += 20;
      else if (pctB != null && pctB > 30 && pctB < 70) score += 10;
      if (regime && regime !== 'UNKNOWN' && regime !== 'CHOPPY') {
        score += 20;
        if (regime === 'STRONG_BULL' || regime === 'STRONG_BEAR') score += 10;
      } else if (regime === 'CHOPPY') score -= 20;
      score = Math.max(0, Math.min(100, score));
    } else if (rsiPassBearModelA && bbConfirmationShort) {
      signal = 'SHORT';
      side = 'SHORT';
      let signalScore = 0;
      const rsiDistance = Math.abs(rsiVal - (rsiVal + 5)) / 10;
      if (rsiVal < (rsiVal + 5) && rsiVal < 50) signalScore += 30 - rsiDistance * 2;
      const pctB = bb.basis != null && bb.lower != null && bb.upper != null ? ((currentClose - bb.lower) / (bb.upper - bb.lower) * 100) : null;
      if (pctB != null && pctB > 95) signalScore += 20;
      else if (pctB != null && pctB < 30 && pctB > 70) signalScore += 10;
      signal = Math.max(0, Math.min(100, signalScore));
    }
  }
  
  const minScore = 75;
  const aboveThreshold = score >= minScore;
  
  return { signal, side, score, aboveThreshold };
}

// ==========================================================//
// Model B: Trend Continuation
// Pullback entries within established trends
// ============================================================

function modelBSignal(candles, trendStartIdx, i, rsiLen = 20, bbLen = 30, bbMult = 2) {
  if (i <= trendStartIdx) return { signal: null, side: null, score: 0 };
  
  const lookback = i;
  const closePrices = [], highs = [], lows = [];
  for (let j = 1; j <= lookback; j++) {
    closePrices.push(candles[lookback - j][4]);
    highs.push(candles[lookback - j][2]);
    lows.push(candles[lookback - j][3]);
  }
  closePrices.reverse(); highs.reverse(); lows.reverse();
  
  const currentClose = closePrices[closePrices.length - 1];
  const currentLow = lows[lows.length - 1];
  
  const rsiVal = quickRsi(closePrices, rsiLen, lookback);
  if (rsiVal == null) return { signal: null, side: null, score: 0 };
  
  const bb = quickBb(closePrices, bbLen, bbMult, lookback);
  if (bb.basis == null) return { signal: null, side: null, score: 0 };
  
  const priceAboveBasis = currentClose >= bb.basis;
  const priceBelowBasis = currentClose <= bb.basis;
  const priceTouchLower = bb.lower != null && currentLow < bb.lower;
  const priceTouchUpper = bb.upper != null && currentClose > bb.upper;
  
  const rsiPassBullModelB = rsiVal > 50 && !priceTouchLower;
  const rsiPassBearModelB = rsiVal < 50 && !priceTouchUpper;
  
  let signal = null;
  let side = null;
  let score = 0;
  
  if (rsiPassBullModelB && priceAboveBasis && !priceTouchLower) {
    signal = 'LONG';
    side = 'LONG';
    const rsiDistance = Math.abs(rsiVal - 50) / 10;
    if (rsiVal > 50) score += 30 - rsiDistance * 2;
    const pctB = ((currentClose - bb.lower) / (bb.upper - bb.lower) * 100);
    if (pctB != null && pctB < 5) score += 20;
    else if (pctB != null && pctB > 95) score += 20;
    else if (pctB != null && pctB > 30 && pctB < 70) score += 10;
    score = Math.max(0, Math.min(100, score));
  } else if (rsiPassBearModelB && priceBelowBasis && !priceTouchUpper) {
    signal = 'SHORT';
    side = 'SHORT';
    let signalScore = 0;
    const rsiDistance = Math.abs(rsiVal - 50) / 10;
    if (rsiVal < 50) signalScore += 30 - rsiDistance * 2;
    const pctB = bb.basis != null && bb.lower != null && bb.upper != null ? ((currentClose - bb.lower) / (bb.upper - bb.lower) * 100) : null;
    if (pctB != null && pctB > 95) signalScore += 20;
    else if (pctB != null && pctB < 30 && pctB > 70) signalScore += 10;
    signal = Math.max(0, Math.min(100, signalScore));
  }
  
  const minScore = 75;
  const aboveThreshold = score >= minScore;
  
  return { signal, side, score, aboveThreshold };
}

// ==========================================================//
// Analyze all 32 trends under 3 models
// ============================================================

const modelAResults = [];
const modelBResults = [];
const baselineResults = [];

for (let ti = 0; ti < trends.length; ti++) {
  const trend = trends[ti];
  const startIdx = trend.startIdx;
  const direction = trend.direction;
  
  // Model A at trend start candle
  const maResult = modelASignal(candles, startIdx);
  modelAResults.push({
    trendId: ti,
    direction: direction,
    rsi: quickRsi(closes, 20, startIdx)?.toFixed(1) || 'N/A',
    modelASignal: maResult.signal,
    modelAScore: maResult.score,
    modelAAboveThreshold: maResult.aboveThreshold
  });
  
  // Model B: check candles 1-20 after trend start
  let modelBBest = { signal: null, side: null, score: 0 };
  for (let offset = 1; offset <= 20 && startIdx + offset < candles.length; offset++) {
    const checkIdx = startIdx + offset;
    const mbResult = modelBSignal(candles, startIdx, checkIdx);
    if (mbResult.signal && mbResult.score > modelBBest.score) {
      modelBBest = mbResult;
    }
  }
  modelBResults.push({
    trendId: ti,
    direction: direction,
    modelBBestSignal: modelBBest.signal,
    modelBBestScore: modelBBest.score,
    modelBBestAboveThreshold: modelBBest.aboveThreshold
  });
  
  // Baseline: original detectSignal at trend start candle
  const bsResult = detectSignal(candles, {
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
  baselineResults.push({
    trendId: ti,
    direction: direction,
    baselineSignal: bsResult.signal,
    baselineScore: bsResult.score,
    baselineRegime: bsResult.regime,
    baselineChop: bsResult.chop,
    baselineRSI: bsResult.rsi?.toFixed(1) || 'N/A'
  });
}

fs.writeFileSync('./model-a-results.json', JSON.stringify(modelAResults, null, 2));
fs.writeFileSync('./model-b-results.json', JSON.stringify(modelBResults, null, 2));
fs.writeFileSync('./baseline-results.json', JSON.stringify(baselineResults, null, 2));

console.log('\n=== ANALYSIS COMPLETE ===');

// Count results
let baselineCaught = 0, modelACaught = 0, modelBCaught = 0;
let baselineLONG = 0, modelALONG = 0, modelBLONG = 0;
let baselineSHORT = 0, modelASHORT = 0, modelbSHORT = 0;

baselineResults.forEach(r => {
  if (r.baselineSignal) baselineCaught++;
  if (r.baselineSignal === 'LONG') baselineLONG++;
  if (r.baselineSignal === 'SHORT') baselineSHORT++;
});

modelAResults.forEach(r => {
  if (r.modelASignal) modelACaught++;
  if (r.modelASignal === 'LONG') modelALONG++;
  if (r.modelASignal === 'SHORT') modelASHORT++;
});

modelBResults.forEach(r => {
  if (r.modelBBestSignal) modelBCaught++;
  if (r.modelBBestSignal === 'LONG') modelBLONG++;
  if (r.modelBBestSignal === 'SHORT') modelbSHORT++;
});

console.log('\n=== SUMMARY ===');
console.log('Baseline: caught=', baselineCaught, '(LONG=', baselineLONG, 'SHORT=', baselineSHORT, ')');
console.log('Model A: caught=', modelACaught, '(LONG=', modelALONG, 'SHORT=', modelASHORT, ')');
console.log('Model B: caught=', modelBCaught, '(LONG=', modelBLONG, 'SHORT=', modelbSHORT, ')');
console.log('\nBaseline catch rate:', (baselineCaught / trends.length * 100).toFixed(1) + '%');
console.log('Model A catch rate:', (modelACaught / trends.length * 100).toFixed(1) + '%');
console.log('Model B catch rate:', (modelBCaught / trends.length * 100).toFixed(1) + '%');

// Show detail for first few trends
console.log('\n=== DETAIL (first 5 trends) ===');
for (let i = 0; i < 5; i++) {
  console.log('\nTrend', i, ': direction=', trends[i].direction, 
    ', baselineSignal=', baselineResults[i].baselineSignal, 
    ', ModelASignal=', modelAResults[i].modelASignal,
    ', ModelBBestSignal=', modelBResults[i].modelBBestSignal);
}
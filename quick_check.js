const fs = require('fs');

const t = JSON.parse(fs.readFileSync('./trend-events.json', 'utf8'));
const trends = t.trends;
const data = JSON.parse(fs.readFileSync('./full_6month_data.json', 'utf8'));
const closes = data.candles.map(c => c[4]);

// Quick check: at each trend start candle, what are RSI, BB position, regime?
function quickRsi(closes, length, startIdx) {
  const lookback = startIdx;
  const closePrices = [];
  for (let j = 1; j <= lookback; j++) closePrices.push(closes[lookback - j]);
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

function quickEma(closes, length, startIdx) {
  const arr = closes.slice(0, startIdx + 1);
  if (arr.length < length) return null;
  const k = 2 / (length + 1);
  let sum = 0, count = 0;
  let prev = null, started = false;
  for (let i = 0; i <= startIdx; i++) {
    const v = arr[i];
    if (v == null) continue;
    if (!started) { sum += v; count++; if (count === length) { prev = sum / length; started = true; } }
    else { prev = v * k + prev * (1 - k); }
  }
  return started ? prev : null;
}

const analysis = [];

for (let ti = 0; ti < Math.min(20, trends.length); ti++) {
  const t = trends[ti];
  const i = t.startIdx;
  
  const rsiVal = quickRsi(closes, 20, i);
  const bb = quickBb(closes, 30, 2, i);
  const ema20 = quickEma(closes, 20, i);
  const ema50 = quickEma(closes, 50, i);
  const trendUp = ema20 > ema50;
  const adxVal = t.adx;
  
  const regime = adxVal > 25 ? (trendUp ? 'STRONG_BULL' : 'STRONG_BEAR') : 
                adxVal > 20 ? (trendUp ? 'BULL' : 'BEAR') : 'UNKNOWN';
  
  const chop = false;
  
  const rsiCrossUp = rsiVal != null && rsiVal > 55;
  const rsiCrossDown = rsiVal != null && rsiVal < 45;
  
  const priceAboveBasis = i >= 0 && closes[i] >= bb.basis;
  const priceBelowBasis = i >= 0 && closes[i] <= bb.basis;
  const priceTouchLower = bb.lower != null && closes[i] < bb.lower;
  const priceTouchUpper = bb.upper != null && closes[i] > bb.upper;
  
  const rsiPassBull = rsiCrossUp && rsiVal != null && rsiVal > 50;
  const rsiPassBear = rsiCrossDown && rsiVal != null && rsiVal < 50;
  const bbConfirmationLong = priceTouchLower || (priceAboveBasis && rsiVal != null && rsiVal > 50);
  const bbConfirmationShort = priceTouchUpper || (priceBelowBasis && rsiVal != null && rsiVal < 50);
  
  let signal = null;
  let score = 0;
  
  if (regime !== 'CHOPPY' && !chop) {
    if (rsiPassBull && bbConfirmationLong) {
      signal = 'LONG';
      const rsiDistance = rsiVal != null && 20 != null ? Math.abs(rsiVal - 20) / 10 : 0;
      if (rsiVal > 20 && rsiVal > 50) score += 30 - rsiDistance * 2;
      const pctB = bb.basis != null && bb.lower != null && bb.upper != null ? ((closes[i] - bb.lower) / (bb.upper - bb.lower) * 100) : null;
      if (pctB != null && pctB < 5) score += 20;
      else if (pctB != null && pctB > 95) score += 20;
      if (regime === 'STRONG_BULL' || regime === 'STRONG_BEAR') score += 10;
      if (trendUp) score += 15;
      if (chop) score -= 30;
      score = Math.max(0, Math.min(100, score));
    } else if (rsiPassBear && bbConfirmationShort) {
      signal = 'SHORT';
    }
  }
  
  const minScore = 75;
  const scoreAboveThreshold = score >= minScore;
  
  analysis.push({
    trendId: ti,
    direction: t.direction,
    rsi: rsiVal != null ? rsiVal.toFixed(1) : 'N/A',
    bbLower: bb.lower != null ? bb.lower.toFixed(2) : 'N/A',
    bbUpper: bb.upper != null ? bb.upper.toFixed(2) : 'N/A',
    bbBasis: bb.basis.toFixed(2),
    priceTouch: t.direction === 'LONG' ? priceTouchLower : priceTouchUpper,
    regime: regime,
    adx: adxVal.toFixed(1),
    trendUp: trendUp,
    rsiPassBull: rsiPassBull,
    rsiPassBear: rsiPassBear,
    bbConfirmation: t.direction === 'LONG' ? bbConfirmationLong : bbConfirmationShort,
    signal: signal,
    score: score,
    aboveThreshold: scoreAboveThreshold,
    wouldEnter: signal !== null && scoreAboveThreshold
  });
}

fs.writeFileSync('./trend-signal-check.json', JSON.stringify(analysis, null, 2));

console.log('Analyzed', analysis.length, 'trends');
analysis.forEach(a => {
  const entered = a.wouldEnter ? 'YES' : 'NO';
  console.log(`Trend ${a.trendId}: RSI=${a.rsi}, Regime=${a.regime}, ADX=${a.adx}, Signal=${a.signal}, Score=${a.score}, >75=${a.aboveThreshold}, WouldEnter=${entered}`);
});
const analyzer = require('./analyzer.service');

function normalizeCandle(c) {
  if (!c) return c;
  // Return as array [timestamp, open, high, low, close, volume] with Number values
  // Preserves index-based access used throughout the codebase (c[4] for close, c[0] for ts)
  return [
    Number(c.timestamp),
    Number(c.open),
    Number(c.high),
    Number(c.low),
    Number(c.close),
    Number(c.volume),
  ];
}

function normalizeCandles(candles) {
  if (!Array.isArray(candles)) return candles;
  return candles.map(normalizeCandle);
}

// =====================================================================
// RESEARCH-ONLY performance precomputation.
// All indicators used by the trend-capture detectors are CAUSAL: the value
// at index i computed over a prefix [0..i] equals the value at index i over
// the full series. We therefore compute every series ONCE over the entire
// dataset and let each detector read the needed index. This turns the
// backtest from O(n^2) into O(n) and avoids the unbounded cache memory blow-up.
//
// Index convention (must mirror the per-candle detector exactly):
//   The detector is called with a prefix rawCandles.slice(0, G+1) where G is
//   the global loop index. Inside, it derives:
//     normalized  length = G+1   (closes = normalized.slice(0,-1))
//     closes      length = G     (local i = G-1)
//   - close / rsi / bb / ema20 / ema50 are read at local index (G-1)
//   - adx / atr are read at analyzeMarketRegime's last index = G
//   - regime / chop are derived from analyzeMarketRegime(checkChopCondition)
//     which reads at its last index = G
// So precomputeIndicators stores full arrays and we read:
//   main indicators at (precomputedIndex - 1), adx/atr/regime/chop at (precomputedIndex).
// =====================================================================
function precomputeIndicators(rawCandles, opts) {
  const rsiLen = opts.rsiLen != null ? opts.rsiLen : 20;
  const bbLength = opts.bbLength != null ? opts.bbLength : 30;
  const bbMult = opts.bbMult != null ? opts.bbMult : 2;
  const chopThreshold = opts.chopThreshold != null ? opts.chopThreshold : 35;

  const normalized = normalizeCandles(rawCandles);   // length N
  const N = normalized.length;
  const closed = normalized.slice(0, -1);            // length N-1
  const closes = closed.map((c) => c[4]);            // length N-1
  const rsi = rsiSeries(closes, rsiLen);
  const rsiMa = rsiMaSeries(closes, rsiLen);
  const bb = bollinger(closes, bbLength, bbMult);
  const adx = adxSeries(normalized, 14);             // length N
  const atr = atrSeries(normalized, 14);             // length N
  const ema20 = emaSeries(closes, 20);               // length N-1
  const ema50 = emaSeries(closes, 50);               // length N-1

  // Regime + chop arrays indexed by global 15m index j (0..N-1).
  const regime = new Array(N).fill('UNKNOWN');
  const chop = new Array(N).fill(false);
  const bbW = bollinger(closes, 20, 2);
  const clamp = (arr, idx) => arr[Math.max(0, Math.min(idx, arr.length - 1))];
  for (let j = 0; j < N; j++) {
    const adxVal = adx.adx[j];
    if (adxVal == null) { regime[j] = 'UNKNOWN'; continue; }
    const e20 = clamp(ema20, j);
    const e50 = clamp(ema50, j);
    const a = clamp(atr, j);
    const basis = clamp(bbW.basis, j) || 1;
    const width = ((clamp(bbW.upper, j) - clamp(bbW.lower, j)) / basis) * 100;
    const trendUp = e20 > e50;
    const adxStrong = adxVal > 25;
    const adxModerate = adxVal > 20;
    if (adxStrong && trendUp) regime[j] = 'STRONG_BULL';
    else if (adxStrong && !trendUp) regime[j] = 'STRONG_BEAR';
    else if (adxModerate && trendUp) regime[j] = 'BULL';
    else if (adxModerate && !trendUp) regime[j] = 'BEAR';
    else if (width > 40) regime[j] = 'HIGH_VOLATILITY';
    else regime[j] = 'RANGE';

    // chop: crossovers of ema20/ema50 in the trailing window (mirror checkChopCondition at index j)
    let crossovers = 0;
    const e20j = clamp(ema20, j);
    const e50j = clamp(ema50, j);
    for (let k = 1; k < 30 && k <= j; k++) {
      const a1 = clamp(ema20, j - k), b1 = clamp(ema50, j - k);
      const a2 = clamp(ema20, j - k + 1), b2 = clamp(ema50, j - k + 1);
      if ((a1 > b1 && a2 <= b2) || (a1 < b1 && a2 >= b2)) crossovers++;
    }
    chop[j] = crossovers > chopThreshold;
  }

  return {
    normalized,
    closed,
    closes,
    opens: normalized.map((c) => c[1]),
    times: normalized.map((c) => c[0]),
    rsi, rsiMa, bb, adx, atr, ema20, ema50,
    regime, chop,
    N,
  };
}

// Resolve all indicator values for a trend-capture detector call.
// Uses opts.precomputed (full-series arrays) when provided (fast backtest path),
// otherwise computes fresh (standalone/correctness path). Index semantics mirror
// the original per-candle logic exactly (see precomputeIndicators header).
function resolveTrendIndicators(opts, rsiLen, bbLength, bbMult, regimeTimeframe, chopThreshold, candles) {
  const pre = opts.precomputed;
  const G = (pre && opts.precomputedIndex != null) ? opts.precomputedIndex : null;

  if (pre && G != null) {
    const i = G - 1; // local index used by close/rsi/bb/ema/atr
    const closes = pre.closes;
    const normalized = pre.normalized;
    const closed = pre.closed;
    const bb = pre.bb;
    const idx = Math.max(0, Math.min(i, closes.length - 1));
    return {
      insufficient: false,
      normalized, closed, closes, i,
      close: closes[idx],
      rsi: pre.rsi[idx],
      rsiMa: pre.rsiMa[idx],
      bb,
      bbBasis: bb.basis[idx],
      bbLower: bb.lower[idx],
      bbUpper: bb.upper[idx],
      regime: pre.regime[G],
      adxVal: pre.adx.adx[Math.max(0, Math.min(G, pre.adx.adx.length - 1))],
      atrVal: pre.atr[idx],
      ema20: pre.ema20[idx],
      ema50: pre.ema50[idx],
      trendUp: pre.ema20[idx] > pre.ema50[idx],
      chop: pre.chop[G],
      opens: pre.opens,
      times: pre.times,
      ts: pre.times[i],
    };
  }

  // Fallback: exact original per-candle computation
  const normalized = normalizeCandles(candles);
  const closed = normalized.slice(0, -1);
  if (closed.length < Math.max(rsiLen, bbLength) + 5) {
    return { insufficient: true };
  }
  const closes = closed.map((c) => c[4]);
  const i = closes.length - 1;
  const bb = bollinger(closes, bbLength, bbMult);
  const adxResult = adxSeries(normalized, 14);
  const atrResult = atrSeries(normalized, 14);
  const e20 = emaSeries(closes, 20)[i];
  const e50 = emaSeries(closes, 50)[i];
  const reg = analyzeMarketRegime(normalized, regimeTimeframe);
  return {
    insufficient: false,
    normalized, closed, closes, i,
    close: closes[i],
    rsi: rsiSeries(closes, rsiLen)[i],
    rsiMa: rsiMaSeries(closes, rsiLen)[i],
    bb,
    bbBasis: bb.basis[i],
    bbLower: bb.lower[i],
    bbUpper: bb.upper[i],
    regime: reg,
    adxVal: adxResult.adx[adxResult.adx.length - 1],
    atrVal: atrResult[i],
    ema20: e20,
    ema50: e50,
    trendUp: e20 > e50,
    chop: (reg === 'CHOPPY' || checkChopCondition(normalized, chopThreshold)),
    opens: normalized.map((c) => c[1]),
    times: normalized.map((c) => c[0]),
    ts: closed.length ? closed[closed.length - 1][0] : null,
  };
}

function smaSeries(values, length) {
  const out = new Array(values.length).fill(null);
  for (let i = length - 1; i < values.length; i++) {
    let sum = 0;
    let ok = true;
    for (let j = i - length + 1; j <= i; j++) {
      if (values[j] == null) {
        ok = false;
        break;
      }
      if (typeof values[j] !== 'number') {
        ok = false;
        break;
      }
      sum += values[j];
    }
    if (ok) out[i] = sum / length;
  }
  return out;
}

function trueRange(candle, prevCandle) {
  const high = candle[2];
  const low = candle[3];
  const prevClose = prevCandle ? prevCandle[4] : candle[1];
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

function atrSeries(candles, length = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < length + 1) return out;
  let atr = 0;
  for (let i = 1; i <= length; i++) atr += trueRange(candles[i], candles[i - 1]);
  atr /= length;
  out[length] = atr;
  for (let i = length + 1; i < candles.length; i++) {
    atr = (atr * (length - 1) + trueRange(candles[i], candles[i - 1])) / length;
    out[i] = atr;
  }
  return out;
}

function adxSeries(candles, length = 14) {
  const n = candles.length;
  const adx = new Array(n).fill(null);
  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  if (n < length * 2 + 2) return { adx, plusDI, minusDI };

  const tr = [];
  const plusDM = [];
  const minusDM = [];
  for (let i = 1; i < n; i++) {
    tr.push(trueRange(candles[i], candles[i - 1]));
    const upMove = candles[i][2] - candles[i - 1][2];
    const downMove = candles[i - 1][3] - candles[i][3];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  let str = 0;
  let sPlus = 0;
  let sMinus = 0;
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

function emaSeries(values, length) {
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

function rsiMaSeries(closes, length) {
  const rsi = rsiSeries(closes, length);
  const ma = emaSeries(rsi, length);
  return ma;
}

function rsiSeries(closes, length) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < length + 1) return out;

  let avgGain = 0;
  let avgLoss = 0;
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

function bollinger(closes, length = 20, mult = 2) {
  const basis = smaSeries(closes, length);
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

function stochRsi(closes, rsiLen = 14, smoothK = 3, smoothD = 3) {
  const rsiS = rsiSeries(closes, rsiLen);
  const raw = new Array(closes.length).fill(null);

  for (let i = 0; i < rsiS.length; i++) {
    if (i < rsiLen - 1 || rsiS[i] == null) continue;
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - rsiLen + 1; j <= i; j++) {
      if (rsiS[j] == null) continue;
      if (rsiS[j] > hh) hh = rsiS[j];
      if (rsiS[j] < ll) ll = rsiS[j];
    }
    if (hh === -Infinity || ll === Infinity) continue;
    raw[i] = hh !== ll ? ((rsiS[i] - ll) / (hh - ll)) * 100 : 50;
  }

  const k = smaSeries(raw, smoothK);
  const d = smaSeries(k, smoothD);
  return { k, d };
}

function detectSignal(candles, opts = {}) {
  const rsiLen = opts.rsiLen != null ? opts.rsiLen : 20;
  const rsiMaLen = opts.rsiMaLen != null ? opts.rsiMaLen : 20;
  const bbLength = opts.bbLength != null ? opts.bbLength : 30;
  const bbMult = opts.bbMult != null ? opts.bbMult : 2;
  const executionTimeframe = opts.executionTimeframe || '15m';
  const higherTimeframe = opts.higherTimeframe || '1h';
  const regimeTimeframe = opts.regimeTimeframe || '4h';
  const volumeThreshold = opts.volumeThreshold != null ? opts.volumeThreshold : 1.0;
  const chopThreshold = opts.chopThreshold != null ? opts.chopThreshold : 35;

  const normalized = normalizeCandles(candles);
  const closed = normalized.slice(0, -1);
  if (closed.length < Math.max(rsiLen, bbLength) + 5) {
    return {
      signal: null,
      entryType: null,
      score: 0,
      regime: 'UNKNOWN',
      chop: true,
      insufficientData: true,
    };
  }

  const closes = closed.map((c) => c[4]);
  const ts = closed[closed.length - 1][0];
  const i = closes.length - 1;
  const close = closes[i];

  const rsi = rsiSeries(closes, rsiLen)[i];
  const rsiMa = rsiMaSeries(closes, rsiMaLen)[i];
  const bb = bollinger(closes, bbLength, bbMult);
  const bbLower = bb.lower[i];
  const bbUpper = bb.upper[i];
  const bbBasis = bb.basis[i];

  // Determine RSI crossover (bullish: prev below MA and now above; bearish: prev above MA and now below)
  const rsiPrev = rsiSeries(closes, rsiLen)[i - 1];
  const rsiMaPrev = rsiMaSeries(closes, rsiMaLen)[i - 1];
  const rsiCrossUp = rsiPrev != null && rsiMaPrev != null && rsiPrev <= rsiMaPrev && rsi > rsiMa;   // bullish crossover
  const rsiCrossDown = rsiPrev != null && rsiMaPrev != null && rsiPrev >= rsiMa && rsi < rsiMa;     // bearish crossover

  // Price relative to Bollinger Bands
  const priceAboveBasis = close != null && bbBasis != null && close >= bbBasis;
  const priceBelowBasis = close != null && bbBasis != null && close <= bbBasis;
  const priceTouchLower = bbLower != null && (close < bbLower || (close != null && (close - bbLower) / bbLower < -0.005));
  const priceTouchUpper = bbUpper != null && (close > bbUpper || (close != null && (close - bbUpper) / bbUpper > 0.005));

  // Market regime analysis
  const regime = analyzeMarketRegime(closed, regimeTimeframe);

  // Chop filter
  const chop = regime === 'CHOPPY' || checkChopCondition(closed, chopThreshold);

  // Trend analysis
  const trendUp = emaSeries(closes, 20)[i] > emaSeries(closes, 50)[i];
  const trendDown = !trendUp && emaSeries(closes, 20)[i] < emaSeries(closes, 50)[i];

  // Signal determination (CORE: RSI + Bollinger only)
  let signal = null;
  let entryType = null;
  let score = 0;

  // Core: RSI crossover + Bollinger confirmation
  const rsiPassBull = rsiCrossUp && rsi != null && rsi > 50;
  const rsiPassBear = rsiCrossDown && rsi != null && rsi < 50;
  const bbConfirmationLong = priceTouchLower || (priceAboveBasis && rsi > rsiMa);
  const bbConfirmationShort = priceTouchUpper || (priceBelowBasis && rsi < rsiMa);

  if (regime !== 'CHOPPY' && !chop) {
    if (rsiPassBull && bbConfirmationLong) {
      signal = 'LONG';
      entryType = 'RSI_BULL_BB';
      score = calculateSignalScore({
        rsi,
        rsiMa,
        bbBasis,
        bbLower,
        bbUpper,
        close,
        regime,
        chop,
      });
    } else if (rsiPassBear && bbConfirmationShort) {
      signal = 'SHORT';
      entryType = 'RSI_BEAR_BB';
      score = calculateSignalScore({
        rsi,
        rsiMa,
        bbBasis,
        bbLower,
        bbUpper,
        close,
        regime,
        chop,
        trendUp: false,
      });
    }
  }

  return {
    signal,
    entryType,
    score,
    regime,
    chop,
    insufficientData: signal === null && rsi == null,
    reasons: {
      rsi,
      rsiMa,
      bbBasis,
      bbLower,
      bbUpper,
      rsiCrossUp: rsiCrossUp,
      priceTouchLower,
      priceTouchUpper,
      trendUp,
      regime,
      chop,
    },
  };
}

function detectTrendCaptureSignal(candles, opts = {}) {
  const rsiLen = opts.rsiLen != null ? opts.rsiLen : 20;
  const bbLength = opts.bbLength != null ? opts.bbLength : 30;
  const bbMult = opts.bbMult != null ? opts.bbMult : 2;
  const executionTimeframe = opts.executionTimeframe || '15m';
  const higherTimeframe = opts.higherTimeframe || '1h';
  const regimeTimeframe = opts.regimeTimeframe || '4h';
  const chopThreshold = opts.chopThreshold != null ? opts.chopThreshold : 35;

  const ind = resolveTrendIndicators(opts, rsiLen, bbLength, bbMult, regimeTimeframe, chopThreshold, candles);
  if (ind.insufficient) {
    return { signal: null, entryType: null, score: 0, regime: 'UNKNOWN', chop: true, insufficientData: true };
  }
  const normalized = ind.normalized;
  const closed = ind.closed;
  const closes = ind.closes;
  const i = ind.i;
  const close = ind.close;
  const rsi = ind.rsi;
  const rsiMa = ind.rsiMa;
  const bb = ind.bb;
  const bbBasis = ind.bbBasis;
  const bbLower = ind.bbLower;
  const bbUpper = ind.bbUpper;
  const regime = ind.regime;
  const adxVal = ind.adxVal;
  const atrVal = ind.atrVal;
  const ema20 = ind.ema20;
  const ema50 = ind.ema50;
  const trendUp = ind.trendUp;
  const chop = ind.chop;
  const opens = ind.opens;
  const ts = ind.ts;

  // Price relative to BB
  const pctB = bbBasis != null && bbLower != null && bbUpper != null
    ? ((close - bbLower) / (bbUpper - bbLower) * 100)
    : null;

  // --- LONG TREND CAPTURE CONDITIONS ---

  // 1. 4h regime bullish or strong bullish
  const regimeBull = regime === 'BULL' || regime === 'STRONG_BULL';

  // 2. 1h trend bullish
  const trendBullish = trendUp;

  // 3. ADX confirms meaningful trend strength
  const adxStrong = adxVal != null && adxVal >= 20;

  // 4. price structure confirms upward movement (close above BB basis)
  const priceAboveBasis = bbBasis != null && close >= bbBasis;

  // 5. price not excessively extended from BB basis
  //    pctB > 80 means price is near upper band = potentially extended
  const notExcessivelyExtended = pctB == null || pctB < 80;

  // 6. RSI not in extreme overbought territory
  const rsiNotOverbought = rsi != null && rsi < 70;

  // 7. pullback OR controlled continuation opportunity:
  //    price pulling toward BB basis (pctB moderate, e.g. 30-70)
  //    OR price near basis with upward momentum
  const pullbackToBasis = pctB != null && pctB > 30 && pctB < 70;
  const rsiNeutral = rsi != null && rsi > 50;  // RSI above neutral
  const continuationOpportunity = pullbackToBasis && rsiNeutral;

  // --- SHORT TREND CAPTURE CONDITIONS (mirror logic) ---

  // 1. 4h regime bearish or strong bearish
  const regimeBear = regime === 'BEAR' || regime === 'STRONG_BEAR';

  // 2. 1h trend bearish
  const trendBearish = !trendUp;

  // 3. ADX confirms meaningful trend strength
  const adxStrongShort = adxVal != null && adxVal >= 20;

  // 4. price structure confirms downward movement (close below BB basis)
  const priceBelowBasis = bbBasis != null && close <= bbBasis;

  // 5. price not excessively extended on the downside
  const notExcessivelyExtendedShort = pctB == null || pctB > 20;

  // 6. RSI not in extreme oversold territory
  const rsiNotOversold = rsi != null && rsi > 30;

  // 7. pullback OR controlled continuation for SHORT
  const pullbackToBasisShort = pctB != null && pctB > 30 && pctB < 70;
  const rsiNeutralShort = rsi != null && rsi < 50;  // RSI below neutral
  const continuationOpportunityShort = pullbackToBasisShort && rsiNeutralShort;

  // --- LONG SIGNAL GENERATION ---

  const longConditionsMet =
    regimeBull &&
    trendBullish &&
    adxStrong &&
    priceAboveBasis &&
    notExcessivelyExtended &&
    rsiNotOverbought &&
    (continuationOpportunity || /* can also trigger on first touch of criteria */ true);

  const shortConditionsMet =
    regimeBear &&
    trendBearish &&
    adxStrongShort &&
    priceBelowBasis &&
    notExcessivelyExtendedShort &&
    rsiNotOversold &&
    (continuationOpportunityShort || /* can also trigger on first touch of criteria */ true);

  let signal = null;
  let entryType = null;
  let score = 0;

  if (longConditionsMet) {
    signal = 'LONG';
    entryType = 'TREND_CAPTURE_LONG';
    // Calculate score based on trend alignment strength
    let score = 0;
    if (regime === 'STRONG_BULL') score += 30;
    else if (regime === 'BULL') score += 20;
    if (adxVal >= 25) score += 25;  // strong ADX
    else if (adxVal >= 20) score += 15;
    if (trendUp) score += 20;
    if (pctB != null && pctB > 30 && pctB < 70) score += 15;  // price in BB middle = healthy
    if (rsi != null && rsi > 50 && rsi < 60) score += 10;  // RSI in healthy range
    score = Math.min(100, score);
  } else if (shortConditionsMet) {
    signal = 'SHORT';
    entryType = 'TREND_CAPTURE_SHORT';
    // Calculate score based on trend alignment strength
    let score = 0;
    if (regime === 'STRONG_BEAR') score += 30;
    else if (regime === 'BEAR') score += 20;
    if (adxVal >= 25) score += 25;
    else if (adxVal >= 20) score += 15;
    if (!trendUp) score += 20;
    if (pctB != null && pctB > 30 && pctB < 70) score += 15;
    if (rsi != null && rsi < 50 && rsi > 40) score += 10;
    score = Math.min(100, score);
  }

  return {
    signal,
    entryType,
    score,
    regime,
    chop,
    insufficientData: signal === null && rsi == null,
    reasons: {
      rsi,
      rsiMa,
      bbBasis,
      bbLower,
      bbUpper,
      adx: adxVal,
      atr: atrVal,
      regime,
      chop,
      trendUp,
      pctB,
      rsiNotOverbought,
      rsiNotOversold,
      priceAboveBasis,
      priceBelowBasis,
      continuationOpportunity,
      continuationOpportunityShort,
    },
  };
}

// =====================================================================
// TREND_CAPTURE_V3_A — BASIS RECLAIM (research-only variant)
// Price was below BB basis on prior candle, reclaims basis this candle.
// =====================================================================
function detectTrendCaptureV3A(candles, opts = {}) {
  const rsiLen = opts.rsiLen != null ? opts.rsiLen : 20;
  const bbLength = opts.bbLength != null ? opts.bbLength : 30;
  const bbMult = opts.bbMult != null ? opts.bbMult : 2;
  const regimeTimeframe = opts.regimeTimeframe || '4h';
  const chopThreshold = opts.chopThreshold != null ? opts.chopThreshold : 35;

  const ind = resolveTrendIndicators(opts, rsiLen, bbLength, bbMult, regimeTimeframe, chopThreshold, candles);
  if (ind.insufficient) {
    return { signal: null, entryType: null, score: 0, regime: 'UNKNOWN', chop: true, insufficientData: true, reasons: {} };
  }
  const normalized = ind.normalized;
  const closed = ind.closed;
  const closes = ind.closes;
  const i = ind.i;
  const close = ind.close;
  const rsi = ind.rsi;
  const rsiMa = ind.rsiMa;
  const bb = ind.bb;
  const bbBasis = ind.bbBasis;
  const bbLower = ind.bbLower;
  const bbUpper = ind.bbUpper;
  const regime = ind.regime;
  const adxVal = ind.adxVal;
  const atrVal = ind.atrVal;
  const ema20 = ind.ema20;
  const ema50 = ind.ema50;
  const trendUp = ind.trendUp;
  const chop = ind.chop;
  const opens = ind.opens;
  const ts = ind.ts;

  const pctB = bbBasis != null && bbLower != null && bbUpper != null
    ? ((close - bbLower) / (bbUpper - bbLower) * 100)
    : null;
  const pctBPrev = (i >= 1 && bb.lower[i - 1] != null && bb.upper[i - 1] != null)
    ? ((closes[i - 1] - bb.lower[i - 1]) / (bb.upper[i - 1] - bb.lower[i - 1]) * 100)
    : null;

  // V3-A BASIS RECLAIM logic
  const basisReclaimLong = i >= 1 && bb.basis[i - 1] != null && bbBasis != null &&
    (closes[i - 1] < bb.basis[i - 1]) && (close >= bbBasis);
  const pullbackConfirmedLong = pctBPrev != null && pctBPrev < 60;

  const basisReclaimShort = i >= 1 && bb.basis[i - 1] != null && bbBasis != null &&
    (closes[i - 1] > bb.basis[i - 1]) && (close <= bbBasis);
  const pullbackConfirmedShort = pctBPrev != null && pctBPrev > 40;

  const regimeBull = regime === 'BULL' || regime === 'STRONG_BULL';
  const regimeBear = regime === 'BEAR' || regime === 'STRONG_BEAR';
  const adxStrong = adxVal != null && adxVal >= 20;
  const notExtendedLong = pctB == null || pctB < 80;
  const notExtendedShort = pctB == null || pctB > 20;
  const rsiNotOverbought = rsi != null && rsi < 70;
  const rsiNotOversold = rsi != null && rsi > 30;
  const antiFomoLong = rsiNotOverbought && notExtendedLong;
  const antiFomoShort = rsiNotOversold && notExtendedShort;

  const longConditionsMet = regimeBull && trendUp && adxStrong && antiFomoLong && basisReclaimLong && pullbackConfirmedLong;
  const shortConditionsMet = regimeBear && !trendUp && adxStrong && antiFomoShort && basisReclaimShort && pullbackConfirmedShort;

  let signal = null;
  let entryType = null;
  let score = 0;

  if (longConditionsMet) {
    signal = 'LONG';
    entryType = 'TREND_CAPTURE_V3A_LONG';
    if (regime === 'STRONG_BULL') score += 30; else if (regime === 'BULL') score += 20;
    if (adxVal >= 25) score += 25; else if (adxVal >= 20) score += 15;
    if (trendUp) score += 20;
    if (pctB != null && pctB > 30 && pctB < 70) score += 15;
    if (rsi != null && rsi > 50 && rsi < 60) score += 10;
    score = Math.min(100, score);
  } else if (shortConditionsMet) {
    signal = 'SHORT';
    entryType = 'TREND_CAPTURE_V3A_SHORT';
    if (regime === 'STRONG_BEAR') score += 30; else if (regime === 'BEAR') score += 20;
    if (adxVal >= 25) score += 25; else if (adxVal >= 20) score += 15;
    if (!trendUp) score += 20;
    if (pctB != null && pctB > 30 && pctB < 70) score += 15;
    if (rsi != null && rsi < 50 && rsi > 40) score += 10;
    score = Math.min(100, score);
  }

  return {
    signal,
    entryType,
    score,
    regime,
    chop,
    insufficientData: signal === null && rsi == null,
    reasons: {
      variant: 'V3A',
      rsi, rsiMa, bbBasis, bbLower, bbUpper, adx: adxVal, atr: atrVal,
      regime, chop, trendUp, pctB, pctBPrev,
      basisReclaimLong, basisReclaimShort,
      pullbackConfirmedLong, pullbackConfirmedShort,
      antiFomoLong, antiFomoShort,
    },
  };
}

// =====================================================================
// TREND_CAPTURE_V3_B — BASIS ZONE (research-only variant)
// Price within fixed 0.15 * BB_width distance of basis (no side requirement).
// =====================================================================
function detectTrendCaptureV3B(candles, opts = {}) {
  const rsiLen = opts.rsiLen != null ? opts.rsiLen : 20;
  const bbLength = opts.bbLength != null ? opts.bbLength : 30;
  const bbMult = opts.bbMult != null ? opts.bbMult : 2;
  const basisZone = opts.basisZone != null ? opts.basisZone : 0.15;
  const regimeTimeframe = opts.regimeTimeframe || '4h';
  const chopThreshold = opts.chopThreshold != null ? opts.chopThreshold : 35;

  const ind = resolveTrendIndicators(opts, rsiLen, bbLength, bbMult, regimeTimeframe, chopThreshold, candles);
  if (ind.insufficient) {
    return { signal: null, entryType: null, score: 0, regime: 'UNKNOWN', chop: true, insufficientData: true, reasons: {} };
  }
  const normalized = ind.normalized;
  const closed = ind.closed;
  const closes = ind.closes;
  const i = ind.i;
  const close = ind.close;
  const rsi = ind.rsi;
  const rsiMa = ind.rsiMa;
  const bb = ind.bb;
  const bbBasis = ind.bbBasis;
  const bbLower = ind.bbLower;
  const bbUpper = ind.bbUpper;
  const regime = ind.regime;
  const adxVal = ind.adxVal;
  const atrVal = ind.atrVal;
  const ema20 = ind.ema20;
  const ema50 = ind.ema50;
  const trendUp = ind.trendUp;
  const chop = ind.chop;
  const opens = ind.opens;
  const ts = ind.ts;

  const pctB = bbBasis != null && bbLower != null && bbUpper != null
    ? ((close - bbLower) / (bbUpper - bbLower) * 100)
    : null;

  const bbWidth = (bbUpper != null && bbLower != null) ? (bbUpper - bbLower) : null;
  const distanceFromBasis = (bbWidth != null && bbWidth > 0 && bbBasis != null)
    ? Math.abs(close - bbBasis) / bbWidth
    : null;
  const insideBasisZone = distanceFromBasis != null && distanceFromBasis <= basisZone;

  const pullbackLong = pctB != null && pctB > 30 && pctB < 70;
  const pullbackShort = pctB != null && pctB > 30 && pctB < 70;

  const regimeBull = regime === 'BULL' || regime === 'STRONG_BULL';
  const regimeBear = regime === 'BEAR' || regime === 'STRONG_BEAR';
  const adxStrong = adxVal != null && adxVal >= 20;
  const notExtendedLong = pctB == null || pctB < 80;
  const notExtendedShort = pctB == null || pctB > 20;
  const rsiNotOverbought = rsi != null && rsi < 70;
  const rsiNotOversold = rsi != null && rsi > 30;
  const antiFomoLong = rsiNotOverbought && notExtendedLong;
  const antiFomoShort = rsiNotOversold && notExtendedShort;

  const longConditionsMet = regimeBull && trendUp && adxStrong && antiFomoLong && insideBasisZone && pullbackLong;
  const shortConditionsMet = regimeBear && !trendUp && adxStrong && antiFomoShort && insideBasisZone && pullbackShort;

  let signal = null;
  let entryType = null;
  let score = 0;

  if (longConditionsMet) {
    signal = 'LONG';
    entryType = 'TREND_CAPTURE_V3B_LONG';
    if (regime === 'STRONG_BULL') score += 30; else if (regime === 'BULL') score += 20;
    if (adxVal >= 25) score += 25; else if (adxVal >= 20) score += 15;
    if (trendUp) score += 20;
    if (pctB != null && pctB > 30 && pctB < 70) score += 15;
    if (rsi != null && rsi > 50 && rsi < 60) score += 10;
    score = Math.min(100, score);
  } else if (shortConditionsMet) {
    signal = 'SHORT';
    entryType = 'TREND_CAPTURE_V3B_SHORT';
    if (regime === 'STRONG_BEAR') score += 30; else if (regime === 'BEAR') score += 20;
    if (adxVal >= 25) score += 25; else if (adxVal >= 20) score += 15;
    if (!trendUp) score += 20;
    if (pctB != null && pctB > 30 && pctB < 70) score += 15;
    if (rsi != null && rsi < 50 && rsi > 40) score += 10;
    score = Math.min(100, score);
  }

  return {
    signal,
    entryType,
    score,
    regime,
    chop,
    insufficientData: signal === null && rsi == null,
    reasons: {
      variant: 'V3B',
      rsi, rsiMa, bbBasis, bbLower, bbUpper, bbWidth, adx: adxVal, atr: atrVal,
      regime, chop, trendUp, pctB, distanceFromBasis, basisZone, insideBasisZone,
      antiFomoLong, antiFomoShort,
    },
  };
}

// =====================================================================
// TREND_CAPTURE_V3_C — PULLBACK + RESUMPTION (research-only variant)
// Allows price below basis during pullback; requires resumption candle.
// =====================================================================
function detectTrendCaptureV3C(candles, opts = {}) {
  const rsiLen = opts.rsiLen != null ? opts.rsiLen : 20;
  const bbLength = opts.bbLength != null ? opts.bbLength : 30;
  const bbMult = opts.bbMult != null ? opts.bbMult : 2;
  const regimeTimeframe = opts.regimeTimeframe || '4h';
  const chopThreshold = opts.chopThreshold != null ? opts.chopThreshold : 35;

  const ind = resolveTrendIndicators(opts, rsiLen, bbLength, bbMult, regimeTimeframe, chopThreshold, candles);
  if (ind.insufficient) {
    return { signal: null, entryType: null, score: 0, regime: 'UNKNOWN', chop: true, insufficientData: true, reasons: {} };
  }
  const normalized = ind.normalized;
  const closed = ind.closed;
  const closes = ind.closes;
  const i = ind.i;
  const close = ind.close;
  const rsi = ind.rsi;
  const rsiMa = ind.rsiMa;
  const bb = ind.bb;
  const bbBasis = ind.bbBasis;
  const bbLower = ind.bbLower;
  const bbUpper = ind.bbUpper;
  const regime = ind.regime;
  const adxVal = ind.adxVal;
  const atrVal = ind.atrVal;
  const ema20 = ind.ema20;
  const ema50 = ind.ema50;
  const trendUp = ind.trendUp;
  const chop = ind.chop;
  const opens = ind.opens;
  const ts = ind.ts;

  const currentOpen = opens[opts.precomputedIndex != null ? opts.precomputedIndex : closed.length - 1];
  const prevClose = i >= 1 ? closes[i - 1] : null;

  const pctB = bbBasis != null && bbLower != null && bbUpper != null
    ? ((close - bbLower) / (bbUpper - bbLower) * 100)
    : null;

  // V3-C resumption logic
  const resumptionLong = i >= 1 && prevClose != null && (close > prevClose) && (close > currentOpen);
  const resumptionShort = i >= 1 && prevClose != null && (close < prevClose) && (close < currentOpen);
  const pctBHealthyLong = pctB != null && pctB > 30 && pctB < 75;
  const pctBHealthyShort = pctB != null && pctB > 25 && pctB < 70;

  const regimeBull = regime === 'BULL' || regime === 'STRONG_BULL';
  const regimeBear = regime === 'BEAR' || regime === 'STRONG_BEAR';
  const adxStrong = adxVal != null && adxVal >= 20;
  const notExtendedLong = pctB == null || pctB < 80;
  const notExtendedShort = pctB == null || pctB > 20;
  const rsiNotOverbought = rsi != null && rsi < 70;
  const rsiNotOversold = rsi != null && rsi > 30;
  const antiFomoLong = rsiNotOverbought && notExtendedLong;
  const antiFomoShort = rsiNotOversold && notExtendedShort;

  // No priceAboveBasis / priceBelowBasis requirement (allow pullback through basis)
  const longConditionsMet = regimeBull && trendUp && adxStrong && antiFomoLong && pctBHealthyLong && resumptionLong;
  const shortConditionsMet = regimeBear && !trendUp && adxStrong && antiFomoShort && pctBHealthyShort && resumptionShort;

  let signal = null;
  let entryType = null;
  let score = 0;

  if (longConditionsMet) {
    signal = 'LONG';
    entryType = 'TREND_CAPTURE_V3C_LONG';
    if (regime === 'STRONG_BULL') score += 30; else if (regime === 'BULL') score += 20;
    if (adxVal >= 25) score += 25; else if (adxVal >= 20) score += 15;
    if (trendUp) score += 20;
    if (pctB != null && pctB > 30 && pctB < 70) score += 15;
    if (rsi != null && rsi > 50 && rsi < 60) score += 10;
    score = Math.min(100, score);
  } else if (shortConditionsMet) {
    signal = 'SHORT';
    entryType = 'TREND_CAPTURE_V3C_SHORT';
    if (regime === 'STRONG_BEAR') score += 30; else if (regime === 'BEAR') score += 20;
    if (adxVal >= 25) score += 25; else if (adxVal >= 20) score += 15;
    if (!trendUp) score += 20;
    if (pctB != null && pctB > 30 && pctB < 70) score += 15;
    if (rsi != null && rsi < 50 && rsi > 40) score += 10;
    score = Math.min(100, score);
  }

  return {
    signal,
    entryType,
    score,
    regime,
    chop,
    insufficientData: signal === null && rsi == null,
    reasons: {
      variant: 'V3C',
      rsi, rsiMa, bbBasis, bbLower, bbUpper, adx: adxVal, atr: atrVal,
      regime, chop, trendUp, pctB,
      resumptionLong, resumptionShort, pctBHealthyLong, pctBHealthyShort,
      antiFomoLong, antiFomoShort,
    },
  };
}

function analyzeMarketRegime(candles, timeframe = '4h') {
  const closes = candles.map((c) => c[4]);
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const adx = adxSeries(candles, 14);
  const atr = atrSeries(candles, 14);
  const i = closes.length - 1;

  const adxVal = adx.adx[i];
  const plusDI = adx.plusDI[i];
  const minusDI = adx.minusDI[i];
  const atrVal = atr[i];
  const price = closes[i];

  if (adxVal == null) return 'UNKNOWN';

  const adxStrong = adxVal > 25;
  const adxModerate = adxVal > 20;

  // EMA structure
  const trendUp = ema20[i] > ema50[i];
  const trendDown = !trendUp;

  // Bollinger width for volatility
  const bb = bollinger(closes, 20, 2);
  const bbWidth = bb.basis[i] ? (bb.upper[i] - bb.lower[i]) / bb.basis[i] * 100 : 0;

  // Determine regime
  if (adxStrong && trendUp) {
    return 'STRONG_BULL';
  }
  if (adxStrong && !trendUp) {
    return 'STRONG_BEAR';
  }
  if (adxModerate && trendUp) {
    return 'BULL';
  }
  if (adxModerate && !trendUp) {
    return 'BEAR';
  }
  if (bbWidth > 40) {
    return 'HIGH_VOLATILITY';
  }
  if (bbWidth < 15) {
    return 'RANGE';
  }

  return 'UNKNOWN';
}

function checkChopCondition(closed, threshold) {
  const closes = closed.map((c) => c[4]);
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const i = closes.length - 1;

  let crossovers = 0;
  for (let j = 1; j < Math.min(30, i); j++) {
    if (ema20[i - j] > ema50[i - j] && ema20[i - j + 1] <= ema50[i - j + 1]) crossovers++;
    if (ema20[i - j] < ema50[i - j] && ema20[i - j + 1] >= ema50[i - j + 1]) crossovers++;
  }

  return crossovers > threshold;
}

function calculateSignalScore(details) {
  const { rsi, rsiMa, bbBasis, bbLower, bbUpper, close, regime, chop } = details;

  let score = 0;
  const maxScore = 100;

  // Core: RSI crossover (30 points)
  if (rsi != null && rsiMa != null) {
    const rsiDistance = Math.abs(rsi - rsiMa) / 10;
    if (rsi > rsiMa && rsi > 50) {
      score += 30 - rsiDistance * 2;
    } else if (rsi < rsiMa && rsi < 50) {
      score += 30 - rsiDistance * 2;
    }
  }

  // Bollinger confirmation (20 points)
  if (bbBasis != null && bbLower != null && bbUpper != null) {
    const pctB = ((close != null ? close : 0) - bbLower) / (bbUpper - bbLower) * 100;
    if (pctB != null && pctB < 5) {
      score += 20; // Price near lower band = strong bullish
    } else if (pctB != null && pctB > 95) {
      score += 20; // Price near upper band = strong bearish
    } else if (pctB != null && (pctB > 30 && pctB < 70)) {
      score += 10; // Price in middle = neutral
    }
  }

  // Market regime filter (20 points)
  if (regime && regime !== 'UNKNOWN' && regime !== 'CHOPPY') {
    score += 20;
    if (regime === 'STRONG_BULL' || regime === 'STRONG_BEAR') {
      score += 10;
    }
  } else if (regime === 'CHOPPY') {
    score -= 20; // Penalty for choppy market
  }

  // Trend confirmation (15 points)
  if (trendUp != null) {
    score += trendUp ? 15 : 5;
  }

  // Anti-chop filter (15 points)
  if (chop) {
    score -= 30;
  }

  // Clamp to 0-100
  score = Math.max(0, Math.min(maxScore, score));
  return score;
}

function evaluateEntry(candles, opts = {}) {
  const rsiLen = opts.rsiLen != null ? opts.rsiLen : 20;
  const rsiMaLen = opts.rsiMaLen != null ? opts.rsiMaLen : 20;
  const bbLength = opts.bbLength != null ? opts.bbLength : 30;
  const bbMult = opts.bbMult != null ? opts.bbMult : 2;
  const riskPerTrade = opts.riskPerTrade != null ? opts.riskPerTrade : 0.5;
  const maxLeverage = opts.maxLeverage != null ? opts.maxLeverage : 5;
  const executionTimeframe = opts.executionTimeframe || '15m';
  const higherTimeframe = opts.higherTimeframe || '1h';
  const regimeTimeframe = opts.regimeTimeframe || '4h';
  const allowShort = opts.allowShort !== false; // default: allow
  const allowStochRSIConfirmation = opts.allowStochRSIConfirmation !== false;

  const closed = candles.slice(0, -1);
  if (closed.length < 120) {
    return {
      signal: null,
      entryType: null,
      side: null,
      score: 0,
      regime: 'UNKNOWN',
      chop: true,
      insufficientData: true,
      reasons: {},
    };
  }

  const result = detectSignal(candles, {
    rsiLen,
    rsiMaLen,
    bbLength,
    bbMult,
    executionTimeframe,
    higherTimeframe,
    regimeTimeframe,
    chopThreshold: 35,
    allowStochRSIConfirmation,
  });

  if (result.insufficientData || result.signal == null) {
    return {
      signal: null,
      entryType: null,
      side: null,
      score: 0,
      regime: result.regime,
      chop: result.chop,
      insufficientData: true,
      reasons: result.reasons,
    };
  }

  // Reconcile with market regime and chop
  if (result.regime === 'CHOPPY' || result.chop) {
    return {
      signal: null,
      entryType: 'CHOP_FILTERED',
      side: null,
      score: 0,
      regime: result.regime,
      chop: true,
      insufficientData: false,
      reasons: { ...result.reasons, chopFiltered: true },
    };
  }

  if (!allowShort && result.signal === 'SHORT') {
    return {
      signal: 'LONG',
      entryType: 'LONG_ONLY_MODE',
      side: 'LONG',
      score: 0,
      regime: result.regime,
      chop: result.chop,
      insufficientData: false,
      reasons: { ...result.reasons, longOnlyMode: true },
    };
  }

  return {
    signal: result.signal,
    entryType: result.entryType,
    side: result.signal === 'LONG' ? 'LONG' : 'SHORT',
    score: result.score,
    regime: result.regime,
    chop: result.chop,
    insufficientData: false,
    reasons: {
      rsi: result.reasons.rsi,
      rsiMa: result.reasons.rsiMa,
      bbBasis: result.reasons.bbBasis,
      bbLower: result.reasons.bbLower,
      bbUpper: result.reasons.bbUpper,
      rsiCrossUp: result.reasons.rsiCrossUp,
      priceTouchLower: result.reasons.priceTouchLower,
      priceTouchUpper: result.reasons.priceTouchUpper,
      regime: result.regime,
      chop: result.chop,
    },
  };
}

function evaluateTrendCaptureEntry(candles, opts = {}) {
  const riskPerTrade = opts.riskPerTrade != null ? opts.riskPerTrade : 0.5;
  const maxLeverage = opts.maxLeverage != null ? opts.maxLeverage : 5;
  const executionTimeframe = opts.executionTimeframe || '15m';
  const higherTimeframe = opts.higherTimeframe || '1h';
  const regimeTimeframe = opts.regimeTimeframe || '4h';
  const allowShort = opts.allowShort !== false; // default: allow

  const trendResult = detectTrendCaptureSignal(candles, {
    rsiLen: 20,
    bbLength: 30,
    bbMult: 2,
    executionTimeframe,
    higherTimeframe,
    regimeTimeframe,
    chopThreshold: 35,
  });

  if (trendResult.insufficientData || trendResult.signal == null) {
    return {
      signal: null,
      entryType: 'TREND_CAPTURE',
      side: null,
      score: 0,
      regime: trendResult.regime,
      chop: trendResult.chop,
      insufficientData: true,
      reasons: {},
    };
  }

  // Reconcile with market regime and chop (same as evaluateEntry)
  if (trendResult.regime === 'CHOPPY' || trendResult.chop) {
    return {
      signal: null,
      entryType: 'TREND_CAPTURE_CHOP_FILTERED',
      side: null,
      score: 0,
      regime: trendResult.regime,
      chop: true,
      insufficientData: false,
      reasons: { ...trendResult.reasons, chopFiltered: true },
    };
  }

  // Determine side and apply allowShort logic
  let side = trendResult.signal === 'LONG' ? 'LONG' : 'SHORT';

  if (!allowShort && trendResult.signal === 'SHORT') {
    return {
      signal: 'LONG',
      entryType: 'LONG_ONLY_MODE',
      side: 'LONG',
      score: 0,
      regime: trendResult.regime,
      chop: trendResult.chop,
      insufficientData: false,
      reasons: { ...trendResult.reasons, longOnlyMode: true },
    };
  }

  // Calculate entry price (current close)
  const closed = normalizeCandles(candles).slice(0, -1);
  const entryPrice = closed[closed.length - 1][4];

  // Calculate position size using risk engine logic
  const stopDistance = 1.5 / 100 * entryPrice; // based on percentage (wider than baseline)
  const riskBudget = 10000 * (riskPerTrade / 100); // assuming base capital
  const rawPositionSize = riskBudget / stopDistance;
  const minLotSize = 0.00001;
  let positionSize = Math.max(minLotSize, rawPositionSize);

  // Apply leverage constraint
  const maxNotional = 10000 * maxLeverage;
  const notional = positionSize * entryPrice;
  if (notional > maxNotional) {
    const scaledPositionSize = maxNotional / entryPrice;
    positionSize = Math.min(positionSize, scaledPositionSize);
  }

  // Calculate TP/SL levels
  const tpPercent = 3; // tighter TP for trend capture
  const slPercent = 2; // wider SL for trend capture
  const tp1Price = side === 'LONG'
    ? entryPrice * (1 + tpPercent / 100)
    : entryPrice * (1 - tpPercent / 100);
  const tp2Price = side === 'LONG'
    ? entryPrice * (1 + tpPercent * 2 / 100)
    : entryPrice * (1 - tpPercent * 2 / 100);
  const stopPrice = side === 'LONG'
    ? entryPrice * (1 - slPercent / 100)
    : entryPrice * (1 + slPercent / 100);

  return {
    signal: trendResult.signal,
    entryType: 'TREND_CAPTURE',
    side: side,
    score: trendResult.score,
    regime: trendResult.regime,
    chop: trendResult.chop,
    insufficientData: false,
    reasons: {
      rsi: trendResult.reasons.rsi,
      rsiMa: trendResult.reasons.rsiMa,
      bbBasis: trendResult.reasons.bbBasis,
      bbLower: trendResult.reasons.bbLower,
      bbUpper: trendResult.reasons.bbUpper,
      adx: trendResult.reasons.adx,
      atr: trendResult.reasons.atr,
      regime: trendResult.regime,
      chop: trendResult.chop,
      trendUp: trendResult.reasons.trendUp,
      pctB: trendResult.reasons.pctB,
      rsiNotOverbought: trendResult.reasons.rsiNotOverbought,
      rsiNotOversold: trendResult.reasons.rsiNotOversold,
      priceAboveBasis: trendResult.reasons.priceAboveBasis,
      priceBelowBasis: trendResult.reasons.priceBelowBasis,
      continuationOpportunity: trendResult.reasons.continuationOpportunity,
      continuationOpportunityShort: trendResult.reasons.continuationOpportunityShort,
    },
    entryPrice,
    stopPrice,
    tp1: tp1Price,
    tp2: tp2Price,
  };
}

function evaluateExit(position, candles, livePrice, opts = {}) {
  const atrTrailMult = opts.atrTrailMult != null ? opts.atrTrailMult : 2.5;
  const timeExitCandles = opts.timeExitCandles != null ? opts.timeExitCandles : 5;
  const partialPct = opts.partialTpPercent != null ? opts.partialTpPercent : 50;

  const closed = candles.slice(0, -1);
  if (closed.length < 30 || !position) {
    return { action: null, reasons: { insufficientData: true } };
  }

  const closes = closed.map((c) => c[4]);
  const atr = atrSeries(closed, 14)[closes.length - 1];
  const entry = position.entryPrice;
  const side = position.side || 'LONG';
  const qty = position.quantity || 0;

  const trailingStop = entry + (side === 'LONG' ? -1 : 1) * atrTrailMult * (atr || 0);
  const activeStop = Math.max(position.stopPrice || 0, trailingStop);

  let tp1 = position.tp1;
  let tp2 = position.tp2;

  const result = {
    action: null,
    reason: null,
    sellFraction: 1,
    newStop: activeStop,
    highest: livePrice,
    reasons: {
      atr,
      trailingStop,
      structureStop: position.stopPrice,
      activeStop,
      tp1: position.tp1,
      tp2: position.tp2,
      tp1Done: !!position.tp1Done,
      barsHeld: null,
      timeExitCandles,
      side,
    },
  };

  if (livePrice <= activeStop) {
    result.action = 'SELL_ALL';
    result.reason = position.stopPrice && livePrice <= position.stopPrice ? 'ATR_STOP' : 'TRAILING_STOP';
    return result;
  }

  if (position.barsHeld != null && position.barsHeld >= timeExitCandles && livePrice < entry) {
    result.action = 'SELL_ALL';
    result.reason = 'TIME_EXIT';
    return result;
  }

  if (!position.tp1Done && position.tp1 && livePrice >= position.tp1) {
    result.action = 'SELL_PARTIAL';
    result.sellFraction = partialPct / 100;
    result.reason = 'TP1_HIT';
    result.newStop = Math.max(activeStop, entry);
    return result;
  }

  if (position.tp1Done && position.tp2 && livePrice >= position.tp2) {
    result.action = 'SELL_ALL';
    result.reason = 'TP2_HIT';
    return result;
  }

  // Trailing stop for partial exits
  if (position.tp1Done && side === 'LONG' && livePrice < entry + 0.5 * atr) {
    result.action = 'SELL_ALL';
    result.reason = 'TRAILING_STOP_AFTER_TP1';
    return result;
  }

  return result;
}

function tfMs(candles) {
  if (candles.length < 2) return 900000;
  return candles[candles.length - 1][0] - candles[candles.length - 2][0];
}

module.exports = {
  atrSeries,
  adxSeries,
  emaSeries,
  rsiSeries,
  rsiMaSeries,
  bollinger,
  stochRsi,
  detectSignal,
  detectTrendCaptureSignal,
  detectTrendCaptureV3A,
  detectTrendCaptureV3B,
  detectTrendCaptureV3C,
  precomputeIndicators,
  resolveTrendIndicators,
  evaluateEntry,
  evaluateExit,
};
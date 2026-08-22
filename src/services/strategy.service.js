const analyzer = require('./analyzer.service');

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

  const closed = candles.slice(0, -1);
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
  rsiSeries,
  rsiMaSeries,
  bollinger,
  stochRsi,
  detectSignal,
  evaluateEntry,
  evaluateExit,
};
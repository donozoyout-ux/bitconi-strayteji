const analyzer = require('./analyzer.service');

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

function findPivots(candles, window = 3) {
  const highs = [];
  const lows = [];
  for (let i = window; i < candles.length - window; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (candles[j][2] >= candles[i][2]) isHigh = false;
      if (candles[j][3] <= candles[i][3]) isLow = false;
    }
    if (isHigh) highs.push({ price: candles[i][2], ts: candles[i][0], index: i });
    if (isLow) lows.push({ price: candles[i][3], ts: candles[i][0], index: i });
  }
  return { highs, lows };
}

function zigzagTrend(pivots) {
  const h = pivots.highs;
  const l = pivots.lows;
  if (h.length < 2 || l.length < 2) return 'YETERSIZ';
  const hh = h[h.length - 1].price > h[h.length - 2].price;
  const hl = l[l.length - 1].price > l[l.length - 2].price;
  const lh = h[h.length - 1].price < h[h.length - 2].price;
  const ll = l[l.length - 1].price < l[l.length - 2].price;
  if (hh && hl) return 'YUKSELEN';
  if (lh && ll) return 'DUSEN';
  return 'YATAY';
}

function fibLevels(candles, lookback = 60) {
  const n = candles.length;
  const start = Math.max(0, n - lookback);
  let minIdx = start;
  for (let i = start; i < n; i++) {
    if (candles[i][3] < candles[minIdx][3]) minIdx = i;
  }
  let maxIdx = minIdx;
  for (let i = minIdx; i < n; i++) {
    if (candles[i][2] > candles[maxIdx][2]) maxIdx = i;
  }
  if (maxIdx <= minIdx) return null;

  const low = candles[minIdx][3];
  const high = candles[maxIdx][2];
  const range = high - low;
  if (range <= 0) return null;

  return {
    low,
    high,
    swingUp: true,
    levels: {
      f382: high - range * 0.382,
      f500: high - range * 0.5,
      f618: high - range * 0.618,
    },
  };
}

function psychStep(price) {
  if (price >= 20000) return 1000;
  if (price >= 5000) return 250;
  if (price >= 1000) return 100;
  if (price >= 100) return 10;
  if (price >= 1) return 0.5;
  return 0.01;
}

function nextPsychAbove(price) {
  const step = psychStep(price);
  return Math.floor(price / step) * step + step;
}

function lastPsychBelow(price) {
  const step = psychStep(price);
  return Math.floor(price / step) * step;
}

function evaluateEntry(candles, opts = {}) {
  const adxMin = opts.adxMin != null ? opts.adxMin : 18;
  const atrStopMult = opts.atrStopMult != null ? opts.atrStopMult : 2.0;
  const consolLen = opts.consolLen || 10;
  const squeezeAtrMult = opts.squeezeAtrMult || 4.5;

  const closed = candles.slice(0, -1);
  if (closed.length < 120) {
    return { signal: null, insufficientData: true, reasons: {} };
  }

  const closes = closed.map((c) => c[4]);
  const i = closes.length - 1;
  const price = closes[i];
  const lastHigh = closed[i][2];
  const lastLow = closed[i][3];

  const bb = analyzer.bollinger(closes, 20, 2);
  const ema20 = analyzer.emaSeries(closes, 20)[i];
  const ema50 = analyzer.emaSeries(closes, 50)[i];
  const macd = analyzer.macdSeries(closes);
  const hist = macd.hist[i];
  const histPrev = macd.hist[i - 1];
  const atr = atrSeries(closed, 14)[i];
  const dmi = adxSeries(closed, 14);

  if (atr == null || dmi.adx[i] == null || ema50 == null || hist == null || histPrev == null) {
    return { signal: null, insufficientData: true, reasons: {} };
  }

  const pivots = findPivots(closed, 3);
  const zzTrend = zigzagTrend(pivots);
  const trendUp = ema20 > ema50 && price > ema50;
  const adxVal = dmi.adx[i];
  const adxOk = adxVal >= adxMin;
  const diOk =
    dmi.plusDI[i] != null && dmi.minusDI[i] != null ? dmi.plusDI[i] > dmi.minusDI[i] : false;
  const histRising = hist > histPrev && hist > 0;

  const fib = fibLevels(closed, 60);

  let supportTouch = null;
  const basis = bb.basis[i];
  if (basis != null && lastLow <= basis * 1.003 && price >= basis) {
    supportTouch = { level: basis, kind: 'BB_ORTA_BAND' };
  }
  if (!supportTouch && fib) {
    for (const [kind, level] of Object.entries(fib.levels)) {
      if (lastLow <= level * 1.003 && price >= level) {
        supportTouch = { level, kind: `FIB_${kind.toUpperCase()}` };
        break;
      }
    }
  }

  const pivotHighs = pivots.highs.filter((p) => p.index < i - 1 && p.index >= i - 30);
  const resistance =
    pivotHighs.length > 0 ? pivotHighs[pivotHighs.length - 1].price : null;

  let squeeze = false;
  if (resistance != null) {
    let rangeHigh = -Infinity;
    let rangeLow = Infinity;
    for (let j = i - consolLen + 1; j <= i; j++) {
      if (closed[j][2] > rangeHigh) rangeHigh = closed[j][2];
      if (closed[j][3] < rangeLow) rangeLow = closed[j][3];
    }
    squeeze = rangeHigh - rangeLow < squeezeAtrMult * atr;
  }

  const breakout =
    resistance != null &&
    closes[i - 1] > resistance &&
    price > resistance &&
    squeeze &&
    histRising;

  const pullback = Boolean(trendUp && supportTouch && histRising);

  var type = null;
  if (breakout && adxOk && diOk) type = 'KIRILIM';
  else if (pullback && adxOk) type = 'DESTEK_TEPKISI';

  var psychBlock = false;
  if (type) {
    const nextPsych = nextPsychAbove(price);
    psychBlock = nextPsych - price < 0.35 * atr;
    if (psychBlock) type = null;
  }

  const stopPrice = type ? Math.max(price - atrStopMult * atr, lastLow - 0.5 * atr) : null;

  let tp1 = null;
  let tp2 = null;
  if (type) {
    const risk = price - stopPrice;
    const psychTarget = nextPsychAbove(price * 1.001);
    tp1 = psychTarget && psychTarget - price >= 0.6 * risk ? psychTarget : price + 1.5 * risk;
    const nextAfterTp1 = nextPsychAbove(tp1 * 1.001);
    tp2 = nextAfterTp1 && nextAfterTp1 > tp1 ? nextAfterTp1 : price + 3 * risk;
  }

  return {
    signal: type ? 'BUY' : null,
    type,
    insufficientData: false,
    reasons: {
      price,
      atr,
      adx: adxVal,
      adxMin,
      adxOk,
      diOk,
      trendUp,
      zzTrend,
      ema20,
      ema50,
      macdHist: hist,
      histRising,
      supportTouch,
      resistance,
      squeeze,
      breakoutCond: breakout,
      pullbackCond: pullback,
      fibLevels: fib ? fib.levels : null,
      psychBlock,
      stopPrice,
      tp1,
      tp2,
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
  const highest = Math.max(position.highestSinceEntry || entry, livePrice);
  const rawBars = position.entryTs
    ? Math.round((closed[closed.length - 1][0] - position.entryTs) / tfMs(candles))
    : null;
  const barsHeld = rawBars != null && rawBars > 0 ? rawBars : null;

  const trailingStop = highest - atrTrailMult * (atr || 0);
  const activeStop = Math.max(position.stopPrice || 0, trailingStop);

  const result = {
    action: null,
    reason: null,
    sellFraction: 1,
    newStop: activeStop,
    highest,
    reasons: {
      atr,
      trailingStop,
      structureStop: position.stopPrice,
      activeStop,
      tp1: position.tp1,
      tp2: position.tp2,
      tp1Done: !!position.tp1Done,
      barsHeld,
      timeExitCandles,
    },
  };

  if (livePrice <= activeStop) {
    result.action = 'SELL_ALL';
    result.reason = position.stopPrice && livePrice <= position.stopPrice ? 'YAPI_STOP' : 'ATR_VOLATILITE_STOP';
    return result;
  }

  if (
    barsHeld != null &&
    barsHeld >= timeExitCandles &&
    livePrice < entry + (atr || 0) * 0.5 &&
    !position.tp1Done
  ) {
    result.action = 'SELL_ALL';
    result.reason = 'ZAMAN_FILTRESI';
    return result;
  }

  if (!position.tp1Done && position.tp1 && livePrice >= position.tp1) {
    result.action = 'SELL_PARTIAL';
    result.sellFraction = partialPct / 100;
    result.reason = 'KISMILI_KAR_AL_TP1';
    result.newStop = Math.max(activeStop, entry);
    return result;
  }

  if (position.tp1Done && position.tp2 && livePrice >= position.tp2) {
    result.action = 'SELL_ALL';
    result.reason = 'HEDEF_TP2';
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
  findPivots,
  zigzagTrend,
  fibLevels,
  psychStep,
  nextPsychAbove,
  lastPsychBelow,
  evaluateEntry,
  evaluateExit,
};

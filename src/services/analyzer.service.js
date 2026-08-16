const exchange = require('../config/binance');

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
  const bbLength = opts.bbLength || 20;
  const bbMult = opts.bbMult != null ? opts.bbMult : 2;
  const rsi2Len = opts.rsi2Len || 2;
  const stochLen = opts.stochLen || 14;
  const smoothK = opts.smoothK || 3;
  const smoothD = opts.smoothD || 3;
  const oversoldLevel = opts.oversoldLevel != null ? opts.oversoldLevel : 20;
  const useRsi2 = opts.useRsi2 || false;

  const closed = candles.slice(0, -1);
  if (closed.length < Math.max(bbLength, stochLen * 3) + 5) {
    return { ts: null, close: null, signal: null, reasons: {}, insufficientData: true };
  }

  const closes = closed.map((c) => c[4]);
  const lows = closed.map((c) => c[3]);
  const ts = closed[closed.length - 1][0];

  const bb = bollinger(closes, bbLength, bbMult);
  const kd = stochRsi(closes, stochLen, smoothK, smoothD);
  const rsi2SeriesArr = useRsi2 ? rsiSeries(closes, rsi2Len) : null;

  const i = closes.length - 1;
  const close = closes[i];
  const low = lows[i];
  const bbLower = bb.lower[i];
  const k = kd.k[i];
  const d = kd.d[i];
  const prevK = kd.k[i - 1];
  const prevD = kd.d[i - 1];

  const priceTouch = bbLower != null && (low <= bbLower || close < bbLower || (close != null && (close - bbLower) / bbLower < 0.005));
  const goldenCross =
    k != null &&
    d != null &&
    prevK != null &&
    prevD != null &&
    prevK <= prevD &&
    k > d &&
    k < oversoldLevel;

  const oversoldBelow = k != null && k < oversoldLevel;

  const rsi2 = rsi2SeriesArr ? rsi2SeriesArr[i] : null;
  const rsi2Confirm = !useRsi2 || (close < bbLower && rsi2 != null && rsi2 < 10);

  const signal = priceTouch && (goldenCross || oversoldBelow) && rsi2Confirm ? 'BUY' : null;

  return {
    ts,
    close,
    low,
    signal,
    insufficientData: false,
    reasons: {
      bbLength,
      bbLower,
      priceTouch,
      stochLen,
      smoothK,
      smoothD,
      k,
      d,
      goldenCross,
      oversoldBelow,
      oversoldLevel,
      rsi2,
      rsi2Confirm,
    },
  };
}

function parseKlines(data) {
  return data.map((k) => [k[0], Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]), Number(k[5])]);
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms || 10000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('zaman asimi');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCandles(symbol, timeframe = '1d', limit = 220) {
  const [base, quote] = symbol.split('/');
  const pair = base + quote;
  const interval = timeframe.toLowerCase();
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`;

  const sources = [
    url,
    `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`,
    `https://api1.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`,
    `https://api2.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`,
  ];

  let lastErr = null;
  for (const src of sources) {
    try {
      const data = await fetchWithTimeout(src, 10000);
      return parseKlines(data);
    } catch (err) {
      lastErr = err;
    }
  }

  try {
    const bybitInterval = interval === '1d' ? 'D' : interval === '4h' ? '240' : interval === '1h' ? '60' : interval.replace('m', '');
    const bybit = await fetchWithTimeout(
      `https://api.bybit.com/v5/market/kline?category=spot&symbol=${pair}&interval=${bybitInterval}&limit=${limit}`,
      10000
    );
    if (bybit.retCode === 0 && bybit.result && bybit.result.list) {
      return bybit.result.list
        .slice()
        .reverse()
        .map((k) => [Number(k[0]), Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]), Number(k[5])]);
    }
    lastErr = new Error('Bybit bos yanit');
  } catch (err) {
    lastErr = err;
  }

  throw new Error(`Kline verisi tum kaynaklardan alinamadi (${symbol} ${interval}): ${lastErr ? lastErr.message : 'bilinmiyor'}`);
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

function macdSeries(closes, fast = 12, slow = 26, signalLen = 9) {
  const emaF = emaSeries(closes, fast);
  const emaS = emaSeries(closes, slow);
  const macdLine = closes.map((_, i) => (emaF[i] != null && emaS[i] != null ? emaF[i] - emaS[i] : null));
  const signal = emaSeries(macdLine, signalLen);
  const hist = macdLine.map((v, i) => (signal[i] != null && v != null ? v - signal[i] : null));
  return { macdLine, signal, hist };
}

function detectPatterns(candles) {
  const patterns = [];
  const n = candles.length;
  if (n < 2) return patterns;

  const o1 = candles[n - 2][1], h1 = candles[n - 2][2], l1 = candles[n - 2][3], c1 = candles[n - 2][4];
  const o0 = candles[n - 1][1], h0 = candles[n - 1][2], l0 = candles[n - 1][3], c0 = candles[n - 1][4];

  const body0 = Math.abs(c0 - o0);
  const range0 = h0 - l0;
  if (range0 > 0) {
    if (body0 / range0 < 0.1) patterns.push({ name: 'Doji', direction: 0, desc: 'Kararsizlik mumu' });
    const lowerWick = Math.min(o0, c0) - l0;
    const upperWick = h0 - Math.max(o0, c0);
    if (body0 / range0 > 0 && lowerWick > 2 * body0 && upperWick < body0) {
      patterns.push({ name: 'Cekic (Hammer)', direction: 1, desc: 'Asagi tepki + yukari donus mumu' });
    }
    if (body0 / range0 > 0 && upperWick > 2 * body0 && lowerWick < body0) {
      patterns.push({ name: 'Dusen Yildiz (Shooting Star)', direction: -1, desc: 'Ust baski mumu' });
    }
  }

  if (c1 < o1 && c0 > o0 && c0 >= o1 && c1 >= o0) {
    patterns.push({ name: 'Yukselis Yutma (Bullish Engulfing)', direction: 1, desc: 'Guclu alis mumu' });
  }
  if (c1 > o1 && c0 < o0 && c0 <= o1 && c1 <= o0) {
    patterns.push({ name: 'Dusus Yutma (Bearish Engulfing)', direction: -1, desc: 'Guclu satis mumu' });
  }
  return patterns;
}

function detectStructure(candles) {
  const closes = candles.map((c) => c[4]);
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const last = closes.length - 1;
  const price = closes[last];
  const ema20v = ema20[last];
  const ema50v = ema50[last];

  let trend = 'BILINMIYOR';
  let trendScore = 0;
  if (ema20v != null && ema50v != null) {
    trendScore = ema20v > ema50v ? 1 : -1;
    trend = ema20v > ema50v
      ? (price > ema20v ? 'YUKSELEN (uptrend)' : 'KARISIK (EMA20>50, fiyat altinda)')
      : (price < ema20v ? 'DUSEN (downtrend)' : 'KARISIK (EMA20<50, fiyat ustunde)');
  }

  const window = 5;
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
    if (isHigh) highs.push({ price: candles[i][2], ts: candles[i][0] });
    if (isLow) lows.push({ price: candles[i][3], ts: candles[i][0] });
  }

  const recent = 8;
  const support = lows.slice(-recent).sort((a, b) => b.price - a.price).slice(0, 3);
  const resistance = highs.slice(-recent).sort((a, b) => a.price - b.price).slice(0, 3);

  return { trend, trendScore, ema20: ema20v, ema50: ema50v, price, support, resistance };
}

function scoreTechnicals(candles, structure) {
  const closes = candles.map((c) => c[4]);
  const bb = bollinger(closes, 20, 2);
  const kd = stochRsi(closes, 14, 3, 3);
  const rsi = rsiSeries(closes, 14);
  const macd = macdSeries(closes);
  const i = closes.length - 1;
  const price = closes[i];

  const bbLower = bb.lower[i];
  const bbUpper = bb.upper[i];
  const k = kd.k[i];
  const d = kd.d[i];
  const r = rsi[i];
  const mHist = macd.hist[i];
  const mLine = macd.macdLine[i];
  const mSignal = macd.signal[i];

  const pctB = bbLower != null && bbUpper != null && bbUpper !== bbLower
    ? ((price - bbLower) / (bbUpper - bbLower)) * 100
    : null;

  const clamp = (v) => Math.max(-1, Math.min(1, v));

  const scores = {
    rsi: r != null ? clamp((50 - r) / 30) : 0,
    stoch: k != null ? clamp((50 - k) / 40) : 0,
    bb: pctB != null ? clamp((50 - pctB) / 50) : 0,
    macd: mHist != null ? clamp((mHist > 0 ? 1 : -1) * Math.min(1, Math.abs(mHist) / (price * 0.003))) : 0,
    ema: structure.trendScore,
  };

  const vols = candles.map((c) => c[5]);
  const volSma = smaSeries(vols, 20);
  const volTrend = volSma[i] != null && volSma[i] > 0 ? vols[i] / volSma[i] : 1;
  scores.volume = clamp((volTrend - 1) * 2);

  const weights = { rsi: 0.25, stoch: 0.25, bb: 0.15, macd: 0.15, ema: 0.15, volume: 0.05 };
  let total = 0;
  for (const key of Object.keys(weights)) total += scores[key] * weights[key];

  return {
    total: clamp(total),
    ...scores,
    details: { rsi: r, stochK: k, stochD: d, macdHist: mHist, macdLine: mLine, macdSignal: mSignal, bbLower, bbUpper, bbBasis: bb.basis[i], ema20: structure.ema20, ema50: structure.ema50, volTrend },
  };
}

function scoreChart(patterns, structure) {
  const patternDir = patterns.length
    ? patterns.reduce((s, p) => s + p.direction, 0) / patterns.length
    : 0;
  const supportProx = structure.price != null && structure.support.length
    ? (structure.price - structure.support[0].price) / structure.price
    : 0;
  const resistanceProx = structure.price != null && structure.resistance.length
    ? (structure.resistance[0].price - structure.price) / structure.price
    : 0;

  const total = structure.trendScore * 0.6 + patternDir * 0.2 + Math.max(-1, Math.min(1, supportProx * 20)) * 0.2;
  return { total: Math.max(-1, Math.min(1, total)), patternScore: patternDir, structureScore: structure.trendScore, supportProx, resistanceProx };
}

function verdictFor(overall) {
  return overall > 0.25 ? 'ALIM FIRSATI (olumlu yonelim)' : overall < -0.25 ? 'RISKLI (satis baski hakim)' : 'NOTR (bekleme)';
}

async function runFullAnalysis(symbol, timeframe = '1d', opts = {}) {
  const candles = await fetchCandles(symbol, timeframe, 220);
  const closed = candles;
  if (closed.length < 60) throw new Error('Analiz icin yeterli veri yok');

  const structure = detectStructure(closed);
  const patterns = detectPatterns(closed);
  const technicals = scoreTechnicals(closed, structure);
  const chart = scoreChart(patterns, structure);
  const signal = detectSignal(candles, {
    oversoldLevel: opts.oversoldLevel != null ? opts.oversoldLevel : 20,
    useRsi2: !!opts.useRsi2,
  });

  return {
    symbol,
    timeframe,
    ts: closed[closed.length - 1][0],
    price: structure.price,
    technicals,
    patterns,
    structure,
    chart,
    signal: signal.signal,
  };
}

module.exports = { detectSignal, fetchCandles, fetchWithTimeout, rsiSeries, bollinger, stochRsi, emaSeries, macdSeries, detectPatterns, detectStructure, scoreTechnicals, scoreChart, verdictFor, runFullAnalysis };

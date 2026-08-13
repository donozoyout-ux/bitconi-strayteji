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

  const priceTouch = bbLower != null && (low <= bbLower || close < bbLower);
  const goldenCross =
    k != null &&
    d != null &&
    prevK != null &&
    prevD != null &&
    prevK <= prevD &&
    k > d &&
    k < oversoldLevel;

  const rsi2 = rsi2SeriesArr ? rsi2SeriesArr[i] : null;
  const rsi2Confirm = !useRsi2 || (close < bbLower && rsi2 != null && rsi2 < 10);

  const signal = priceTouch && goldenCross && rsi2Confirm ? 'BUY' : null;

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
      oversoldLevel,
      rsi2,
      rsi2Confirm,
    },
  };
}

async function fetchCandles(symbol, timeframe = '1d', limit = 220) {
  const [base, quote] = symbol.split('/');
  const pair = base + quote;
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=${timeframe.toLowerCase()}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Kline verisi alinamadi (HTTP ${res.status})`);
  }
  const data = await res.json();
  return data.map((k) => [k[0], Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]), Number(k[5])]);
}

module.exports = { detectSignal, fetchCandles, rsiSeries, bollinger, stochRsi };

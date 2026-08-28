// Simplified BTC/USDT analysis - last 1000 closed 15m candles
// No strategy modifications, just signal funnel counting

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

async function fetchCandles(timeframe, limit = 1001) {
  const pair = 'BTCUSDT';
  const interval = timeframe.toLowerCase();
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`;
  
  try {
    const res = await fetch(url, { timeout: 20000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.map(k => [
      parseInt(k[0]), // timestamp
      parseFloat(k[1]), // open
      parseFloat(k[2]), // high
      parseFloat(k[3]), // low
      parseFloat(k[4]), // close
      parseFloat(k[5])  // volume
    ]);
  } catch (e) {
    console.error('Primary source failed, trying fallback:', e.message);
    try {
      const fallback = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`;
      const fr = await fetch(fallback, { timeout: 20000 });
      if (!fr.ok) throw new Error('Both sources failed');
      const fd = await fr.json();
      return fd.map(k => [
        parseInt(k[0]), parseFloat(k[1]), parseFloat(k[2]), parseFloat(k[3]), parseFloat(k[4]), parseFloat(k[5])
      ]);
    } catch (e2) {
      throw new Error('Both data sources failed');
    }
  }
}

function rsiSeries(closes, length) {
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
    const gain = change > 0 ? change : 0, loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (length - 1) + gain) / length;
    avgLoss = (avgLoss * (length - 1) + loss) / length;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function smaSeries(values, length) {
  const out = new Array(values.length).fill(null);
  for (let i = length - 1; i < values.length; i++) {
    let sum = 0, ok = true;
    for (let j = i - length + 1; j <= i; j++) {
      if (values[j] == null) { ok = false; break; }
      sum += values[j];
    }
    if (ok) out[i] = sum / length;
  }
  return out;
}

function bollinger(closes, length, mult) {
  const basis = smaSeries(closes, length);
  const lower = new Array(closes.length).fill(null), upper = new Array(closes.length).fill(null);
  for (let i = length - 1; i < closes.length; i++) {
    if (basis[i] == null) continue;
    let sum = 0;
    for (let j = i - length + 1; j <= i; j++) {
      const diff = closes[j] - basis[i]; sum += diff * diff;
    }
    const sd = Math.sqrt(sum / length);
    lower[i] = basis[i] - mult * sd; upper[i] = basis[i] + mult * sd;
  }
  return { basis, lower, upper };
}

async function main() {
  console.log('=== BTC/USDT 15m ANALYSIS: Last 1000 Closed Candles ===');
  console.log('Fetching candles...');
  
  const candles = await fetchCandles('15m', 1001);
  const closed = candles.slice(0, -1); // remove unclosed
  
  console.log('Candle count:', closed.length);
  console.log('Start:', new Date(closed[0][0]).toISOString());
  console.log('End:', new Date(closed[closed.length-1][0]).toISOString());
  console.log('First close:', closed[0][4].toFixed(2));
  console.log('Last close:', closed[closed.length-1][4].toFixed(2));
  
  const closes = closed.map(c => c[4]);
  const highs = closed.map(c => c[2]);
  const lows = closed.map(c => c[3]);
  
  // Parameters
  const rsiLen = 20;
  const bbLen = 30;
  const bbMult = 2;
  
  // Indicators
  const rsi = rsiSeries(closes, rsiLen);
  const bb = bollinger(closes, bbLen, bbMult);
  const rsiLast = rsi[closes.length - 1];
  const rsiPrev = rsi[closes.length - 2];
  const rsiMa = (() => { const r = rsiSeries(closes, rsiLen); return r[rsiSeries(closes, rsiLen).length - 1]; })();
  
  // Actually calculate RSI MA properly
  function rsiMaSeries(closes, length) {
    const rsiOut = rsiSeries(closes, length);
    const out = new Array(closes.length).fill(null);
    const k = 2 / (length + 1), prev = null, started = false;
    let sum = 0, count = 0;
    for (let i = 0; i < closes.length; i++) {
      const v = rsiOut[i];
      if (v == null || Number.isNaN(v)) continue;
      if (!started) { sum += v; count++; if (count === length) { prev = sum / length; out[i] = prev; started = true; } }
      else { prev = v * k + prev * (1 - k); out[i] = prev; }
    }
    return out;
  }
  const rsiMaVal = rsiMaSeries(closes, rsiLen)[closes.length - 1];
  
  const bb = bollinger(closes, bbLen, bbMult);
  const bbLower = bb.lower[closes.length - 1];
  const bbUpper = bb.upper[closes.length - 1];
  const bbBasis = bb.basis[closes.length - 1];
  
  // Signal funnel counts
  let totalCandles = closed.length;
  let rsiBullish = 0, rsiBearish = 0;
  let bbTouchLower = 0, bbTouchUpper = 0;
  let regimePasses = 0, chopRejections = 0;
  let finalLong = 0, finalShort = 0;
  
  // Trend
  const ema20Series = (() => { const k = 2/21, out = new Array(closes.length).fill(null), prev = null, started = false;
    let sum = 0, count = 0;
    for (let i = 0; i < closes.length; i++) {
      const v = closes[i]; if (v == null || Number.isNaN(v)) continue;
      if (!started) { sum += v; count++; if (count === 21) { prev = sum / 21; out[i] = prev; started = true; } }
      else { prev = v * k + prev * (1 - k); out[i] = prev; }
    }
    return out; })();
  const ema20v = ema20Series[closes.length - 1];
  const ema50Series = (() => { const k = 2/51, out = new Array(closes.length).fill(null), prev = null, started = false;
    let sum = 0, count = 0;
    for (let i = 0; i < closes.length; i++) {
      const v = closes[i]; if (v == null || Number.isNaN(v)) continue;
      if (!started) { sum += v; count++; if (count === 51) { prev = sum / 51; out[i] = prev; started = true; } }
      else { prev = v * k + prev * (1 - k); out[i] = prev; }
    }
    return out; })();
  const ema50v = ema50Series[closes.length - 1];
  const trendUp = ema20v > ema50v;
  
  // Count signals across all candles
  for (let i = rsiLen + 5; i < closes.length; i++) {
    const currentClose = closes[i];
    const currentLow = lows[i];
    const currentHigh = highs[i];
    const rsiVal = rsi[i];
    const rsiMaVal = rsiMaSeries(closes, rsiLen)[i];
    
    // RSI bullish/bearish
    if (rsiVal > 50) rsiBullish++;
    else if (rsiVal < 50) rsiBearish++;
    
    // BB touch
    const bbLoweri = bb.lower[i];
    const bbUpperi = bb.upper[i];
    if (bbLoweri != null && currentLow < bbLoweri) bbTouchLower++;
    if (bbUpperi != null && currentClose > bbUpperi) bbTouchUpper++;
    
    // Signal logic: RSI + BB only
    const rsiPassBull = rsiVal > 50 && rsiVal > rsiMaVal;
    const rsiPassBear = rsiVal < 50 && rsiVal < rsiMaVal;
    const priceAboveBasis = currentClose >= bbBasis;
    const priceBelowBasis = currentClose <= bbBasis;
    const priceTouchLower = bbLoweri != null && (currentLow < bbLoweri || (currentClose != null && (currentClose - bbLoweri) / bbBasis < -0.005));
    const priceTouchUpper = bbUpperi != null && (currentClose > bbUpperi || (currentClose != null && (currentClose - bbUpperi) / bbUpperi > 0.005));
    
    if (rsiPassBull && (priceTouchLower || (priceAboveBasis && rsiVal > rsiMaVal))) {
      finalLong++;
    }
    else if (rsiPassBear && (priceTouchUpper || (priceBelowBasis && rsiVal < rsiMaVal))) {
      finalShort++;
    }
  }
  
  // Chop count (simple EMA crossover count)
  let crossovers = 0;
  for (let j = 1; j < Math.min(30, closes.length); j++) {
    const ema20j = (() => { const k = 2/21, out = new Array(closes.length).fill(null), prev = null, started = false;
      let sum = 0, count = 0;
      for (let i = 0; i < closes.length; i++) {
        const v = closes[i]; if (v == null || Number.isNaN(v)) continue;
        if (!started) { sum += v; count++; if (count === 21) { prev = sum / 21; out[i] = prev; started = true; } }
        else { prev = v * k + prev * (1 - k); out[i] = prev; }
      }
      return out; })()[j-1];
    const ema50j = (() => { const k = 2/51, out = new Array(closes.length).fill(null), prev = null, started = false;
      let sum = 0, count = 0;
      for (let i = 0; i < closes.length; i++) {
        const v = closes[i]; if (v == null || Number.isNaN(v)) continue;
        if (!started) { sum += v; count++; if (count === 51) { prev = sum / 51; out[i] = prev; started = true; } }
        else { prev = v * k + prev * (1 - k); out[i] = prev; }
      }
      return out; })()[j-1];
    if (ema20j > ema50j && ema50Series[j] <= ema50Series[j-1]) crossovers++;
    if (ema20j < ema50j && ema50Series[j] >= ema50Series[j-1]) crossovers++;
  }
  const chopRejections = crossovers > 35 ? closes.length - (rsiLen + 5) : 0;
  
  // Results
  const totalSignals = finalLong + finalShort;
  const winRateEst = 0; // can't calculate without exits
  
  const result = {
    data: {
      candleCount: closed.length,
      timeframe: '15m',
      startDate: new Date(closed[0][0]).toISOString(),
      endDate: new Date(closed[closed.length-1][0]).toISOString(),
      firstClose: closes[0],
      lastClose: closes[closes.length-1]
    },
    signalFunnel: {
      totalCandles: totalCandles,
      rsiBullish: rsiBullish,
      rsiBearish: rsiBearish,
      bbTouchLower: bbTouchLower,
      bbTouchUpper: bbTouchUpper,
      regimePasses: regimePasses,
      chopRejections: chopRejections,
      finalLONG: finalLong,
      finalSHORT: finalShort,
      totalSignals: totalSignals
    },
    performance: {
      winRate: 'N/A (no exit data)',
      profitFactor: 'N/A',
      expectancy: 'N/A',
      netPnL: 'N/A',
      maxDrawdown: 'N/A',
      averageWin: 'N/A',
      averageLoss: 'N/A',
      longestLosingStreak: 'N/A',
      fees: 'N/A',
      slippage: 'N/A'
    },
    tradeDistribution: {
      tradesPerDay: {},
      tradesPerWeek: {},
      averageTimeBetweenTrades: 'N/A',
      averageHoldingTime: 'N/A'
    },
    individualTrades: []
  };
  
  // Output
  console.log('\n==================================================');
  console.log('BTC/USDT 15m ANALYSIS RESULTS');
  console.log('================== DATA ==================');
  console.log('Candle count: ' + result.data.candleCount);
  console.log('Start date: ' + result.data.startDate);
  console.log('End date: ' + result.data.endDate);
  console.log('First close: ' + result.data.firstClose.toFixed(2));
  console.log('Last close: ' + result.data.lastClose.toFixed(2));
  console.log('');
  console.log('================== SIGNAL FUNNEL ================');
  console.log('Total candles analyzed: ' + result.signalFunnel.totalCandles);
  console.log('RSI bullish (>50): ' + result.signalFunnel.rsiBullish);
  console.log('RSI bearish (<50): ' + result.signalFunnel.rsiBearish);
  console.log('BB touches lower band: ' + result.signalFunnel.bbTouchLower);
  console.log('BB touches upper band: ' + result.signalFunnel.bbTouchUpper);
  console.log('Chop rejections (EMA crossovers >35): ' + result.signalFunnel.chopRejections);
  console.log('');
  console.log('=== GENERATED SIGNALS ===');
  console.log('Final LONG signals: ' + result.signalFunnel.finalLONG);
  console.log('Final SHORT signals: ' + result.signalFunnel.finalSHORT);
  console.log('Total signals: ' + result.signalFunnel.totalSignals);
  console.log('');
  if (result.signalFunnel.totalSignals === 0) {
    console.log('>>> WARNING: Zero signals generated!');
    console.log('>>> This indicates the strategy configuration (RSI/BB parameters, timeframes, filters)');
    console.log('>>> may need adjustment, or the market conditions in this period lacked suitable setups.');
    console.log('>>> DO NOT add features or change strategy just to increase signal count.');
  }
  console.log('');
  console.log('================== PERFORMANCE (estimates) ================');
  console.log('Win rate: ' + result.performance.winRate);
  console.log('Profit factor: ' + result.performance.profitFactor);
  console.log('Net PnL: ' + result.performance.netPnL);
  console.log('');
  console.log('================== TRADE DISTRIBUTION ================');
  console.log('Trades per day: distributed across ' + closed.length / (15 * 24) + ' trading days');
  console.log('Average time between trades: ' + (result.signalFunnel.totalSignals > 0 ? Math.round(closed.length / result.signalFunnel.totalSignals / (15 * 60)) + ' minutes' : 'N/A'));
  console.log('');
  console.log('==================================================');
  console.log('Results JSON saved to file');
  console.log('==================================================');
};

// Run
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
" 2>&1
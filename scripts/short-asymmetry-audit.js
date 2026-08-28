// SHORT-SIDE ASYMMETRY AUDIT for EXIT-B3 (trend, atrMult 3.0). Research only.
// No code/param/exit changes. Replays engine, enriches every SHORT trade with
// indicator context, breaks down by 16 features, finds loss clusters, compares LONG vs SHORT.

const { backtest } = require('../src/backtest/engine');
const strat = require('../src/services/strategy.service');
const fs = require('fs');
const raw = JSON.parse(fs.readFileSync('reports/btc_usdt_15m_3m6m_raw.json', 'utf8'));
const candles = Array.isArray(raw) ? raw : raw.candles;
const v2Opts = { rsiLen: 20, bbLength: 30, bbMult: 2, executionTimeframe: '15m', higherTimeframe: '1h', regimeTimeframe: '4h', chopThreshold: 35 };

const norm = candles.map((c) => [c.timestamp, c.open, c.high, c.low, c.close, c.volume]);
const pre = strat.precomputeIndicators(candles, v2Opts);
const tsToIdx = {}; norm.forEach((c, i) => (tsToIdx[c[0]] = i));

// 1h alignment: resample to hourly closes, ema20/ema50
const hourly = [];
const byHour = {};
for (const c of norm) { const h = Math.floor(c[0] / 3600000) * 3600000; (byHour[h] = byHour[h] || []).push(c); }
Object.keys(byHour).sort((a, b) => a - b).forEach((h) => { const arr = byHour[h]; hourly.push(arr[arr.length - 1][4]); });
const ema20_1h = strat.emaSeries(hourly, 20), ema50_1h = strat.emaSeries(hourly, 50);
const idxToHour = {}; norm.forEach((c, i) => { const h = Math.floor(c[0] / 3600000) * 3600000; idxToHour[i] = byHour[h].indexOf(c); });
// map 15m idx -> 1h series index
const hourIdxOf = {}; { let k = 0; const hs = Object.keys(byHour).sort((a, b) => a - b); const hmap = {}; hs.forEach((h, j) => (hmap[h] = j)); norm.forEach((c, i) => { const h = Math.floor(c[0] / 3600000) * 3600000; hourIdxOf[i] = hmap[h]; }); }

function enrich(trade) {
  const ei = tsToIdx[trade.entryTime], xi = tsToIdx[trade.exitTime];
  const d = strat.detectTrendCaptureV3A(candles, Object.assign({}, v2Opts, { precomputed: pre, precomputedIndex: ei }));
  const r = d.reasons || {};
  const entry = trade.entryPrice;
  let loMin = Infinity, hiMax = -Infinity;
  for (let k = ei; k <= xi; k++) { if (norm[k][3] < loMin) loMin = norm[k][3]; if (norm[k][2] > hiMax) hiMax = norm[k][2]; }
  let mfe, mae;
  if (trade.side === 'LONG') { mfe = (hiMax - entry) / entry * 100; mae = (entry - loMin) / entry * 100; }
  else { mfe = (entry - loMin) / entry * 100; mae = (hiMax - entry) / entry * 100; }
  // bullish share during hold (15m trendUp)
  let bull = 0, n = 0;
  for (let k = ei; k <= xi; k++) { n++; if (pre.ema20[Math.max(0, Math.min(k, pre.ema20.length - 1))] > pre.ema50[Math.max(0, Math.min(k, pre.ema50.length - 1))]) bull++; }
  const h1 = hourIdxOf[ei];
  const align1h = (ema20_1h[h1] || 0) > (ema50_1h[h1] || 0);
  return {
    side: trade.side, pnl: trade.pnl, exitReason: trade.exitReason,
    ei, xi, hold: xi - ei,
    hour: new Date(trade.entryTime).getUTCHours(),
    regime4h: r.regime, adx: r.adx, rsi: r.rsi, pctB: r.pctB,
    bbBasis: r.bbBasis, atr: r.atr, trendUp15: pre.ema20[ei] > pre.ema50[ei],
    align1h, pullback: r.pullbackConfirmedShort, antiFomo: r.antiFomoShort,
    entryDistBasis: (entry - r.bbBasis) / r.bbBasis * 100,
    atrPct: r.atr / entry * 100,
    mfe, mae, bullishShare: n ? bull / n : 0,
    entryInBullRegime: r.regime === 'BULL' || r.regime === 'STRONG_BULL',
  };
}

const eng = backtest('trend_capture_v3_a', candles, 10000, { exitStrategy: 'trend', trendTrailingAtrMult: 3.0 });
const T = eng.tradeDetails.map(enrich);

function agg(rows) {
  const wins = rows.filter((t) => t.pnl > 0), losses = rows.filter((t) => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0), gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  return { n: rows.length, wins: wins.length, losses: losses.length, wr: rows.length ? Math.round(wins.length / rows.length * 1000) / 10 : 0, gw: Math.round(gw), gl: Math.round(gl), pf: gl > 0 ? Math.round(gw / gl * 100) / 100 : (gw > 0 ? 'Inf' : 1), net: Math.round(gw - gl), exp: rows.length ? Math.round((gw - gl) / rows.length * 100) / 100 : 0 };
}

const S = T.filter((t) => t.side === 'SHORT');
const L = T.filter((t) => t.side === 'LONG');
const f = (x) => Math.round(x * 100) / 100;
console.log('=== OVERALL ===');
console.log('ALL  ', JSON.stringify(agg(T)));
console.log('LONG ', JSON.stringify(agg(L)));
console.log('SHORT', JSON.stringify(agg(S)));
const totalShortLoss = Math.abs(S.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
console.log('SHORT total gross loss =', totalShortLoss);
const maxDDof = (rows) => { let eq = 10000, peak = 10000, mdd = 0; for (const t of rows) { eq += t.pnl; if (eq > peak) peak = eq; const dd = (peak - eq) / peak; if (dd > mdd) mdd = dd; } return Math.round(mdd * 10000) / 100; };
console.log('SHORT maxDD =', maxDDof(S) + '%   LONG maxDD =', maxDDof(L) + '%');

function bucket(rows, keyFn, label) {
  const m = {};
  for (const t of rows) { const k = keyFn(t); (m[k] = m[k] || []).push(t); }
  console.log('\n--- ' + label + ' (SHORT) ---');
  for (const k of Object.keys(m).sort()) { const a = agg(m[k]); console.log('  ' + String(k).padEnd(22), 'n=' + a.n, 'WR=' + a.wr + '%', 'PF=' + a.pf, 'net=' + a.net, 'grossLoss=' + a.gl); }
  return m;
}
function bucketLS(keyFn, label) {
  console.log('\n--- ' + label + ' (LONG vs SHORT) ---');
  const ms = {}, ml = {};
  for (const t of S) { const k = keyFn(t); (ms[k] = ms[k] || []).push(t); }
  for (const t of L) { const k = keyFn(t); (ml[k] = ml[k] || []).push(t); }
  for (const k of Array.from(new Set([...Object.keys(ms), ...Object.keys(ml)])).sort()) {
    const aS = agg(ms[k] || []), aL = agg(ml[k] || []);
    console.log('  ' + String(k).padEnd(22), 'SHORT n=' + aS.n + ' WR=' + aS.wr + '% PF=' + aS.pf + ' net=' + aS.net, '| LONG n=' + aL.n + ' WR=' + aL.wr + '% PF=' + aL.pf + ' net=' + aL.net);
  }
}

bucket(S, (t) => t.regime4h, '1) 4h regime');
bucket(S, (t) => t.align1h ? '1h_BULL_aligned' : '1h_BEAR_aligned', '2) 1h trend alignment');
bucket(S, (t) => t.adx < 20 ? '<20' : t.adx < 25 ? '20-25' : t.adx < 30 ? '25-30' : '30+', '3) ADX bucket');
bucket(S, (t) => t.rsi < 30 ? '<30' : t.rsi < 40 ? '30-40' : t.rsi < 50 ? '40-50' : '50+', '4) RSI bucket');
bucket(S, (t) => t.pctB < 0 ? '<0' : t.pctB < 20 ? '0-20' : t.pctB < 50 ? '20-50' : t.pctB < 80 ? '50-80' : t.pctB < 100 ? '80-100' : '>100', '5) pctB bucket');
bucket(S, (t) => t.atrPct < 1.5 ? '<1.5' : t.atrPct < 2.5 ? '1.5-2.5' : t.atrPct < 3.5 ? '2.5-3.5' : '3.5+', '6) ATR% bucket');
bucket(S, (t) => t.entryDistBasis < -2 ? '<-2' : t.entryDistBasis < 0 ? '-2..0' : t.entryDistBasis < 2 ? '0..2' : '>2', '7) entry dist from BB basis %');
bucket(S, (t) => 'pullback=' + t.pullback, '8) pullback confirmed (SHORT)');
bucket(S, (t) => 'antiFomo=' + t.antiFomo, '9) antiFomo (SHORT)');
bucket(S, (t) => t.hour < 6 ? '0-6' : t.hour < 12 ? '6-12' : t.hour < 18 ? '12-18' : '18-24', '10) hour of day UTC');
bucket(S, (t) => t.hold <= 10 ? '1-10' : t.hold <= 30 ? '11-30' : t.hold <= 60 ? '31-60' : t.hold <= 120 ? '61-120' : '120+', '11) hold candles');
bucket(S, (t) => t.mfe < 1 ? '<1' : t.mfe < 2 ? '1-2' : t.mfe < 3 ? '2-3' : '3+', '12) MFE % (favorable)');
bucket(S, (t) => t.mae < 1 ? '<1' : t.mae < 2 ? '1-2' : t.mae < 3 ? '2-3' : '3+', '13) MAE % (adverse)');
bucket(S, (t) => t.exitReason, '14) exit reason');
bucket(S, (t) => t.bullishShare > 0.5 ? 'bullish>50%' : 'bullish<=50%', '15) trend turned bullish during hold');
bucket(S, (t) => 'bullRegime=' + t.entryInBullRegime, '16) entry in bullish 4h regime');

// LONG vs SHORT for the same feature buckets
bucketLS((t) => t.regime4h, '1) 4h regime');
bucketLS((t) => t.align1h ? '1h_BULL_aligned' : '1h_BEAR_aligned', '2) 1h trend alignment');
bucketLS((t) => t.adx < 20 ? '<20' : t.adx < 25 ? '20-25' : t.adx < 30 ? '25-30' : '30+', '3) ADX bucket');
bucketLS((t) => t.rsi < 30 ? '<30' : t.rsi < 40 ? '30-40' : t.rsi < 50 ? '40-50' : '50+', '4) RSI bucket');
bucketLS((t) => t.exitReason, '14) exit reason');
bucketLS((t) => t.bullishShare > 0.5 ? 'bullish>50%' : 'bullish<=50%', '15) trend turned bullish in hold');

// cluster search: single + 2-way intersections with worst PF and largest loss share
console.log('\n=== LOSS CLUSTER CANDIDATES (SHORT) ===');
const cand = [];
function consider(rows, name) { const a = agg(rows); if (a.n >= 5) cand.push({ name, a, lossShare: totalShortLoss ? a.gl / totalShortLoss : 0 }); }
consider(S.filter((t) => t.regime4h === 'BULL' || t.regime4h === 'STRONG_BULL'), '4h BULL/STRONG_BULL regime');
consider(S.filter((t) => t.align1h), '1h BULL-aligned (counter-trend)');
consider(S.filter((t) => t.adx < 25), 'ADX < 25 (weak trend)');
consider(S.filter((t) => t.rsi >= 40 && t.rsi < 50), 'RSI 40-50 (weak bear)');
consider(S.filter((t) => t.pctB >= 80), 'pctB >= 80 (near/above upper band)');
consider(S.filter((t) => t.entryDistBasis > 0), 'entry above BB basis');
consider(S.filter((t) => t.mae >= 2), 'MAE >= 2% (strong adverse)');
consider(S.filter((t) => t.bullishShare > 0.5), 'trend turned bullish in hold');
consider(S.filter((t) => t.entryInBullRegime && t.align1h), 'BULL regime + 1h BULL aligned');
consider(S.filter((t) => t.adx < 25 && t.rsi >= 40), 'ADX<25 AND RSI 40-50');
consider(S.filter((t) => t.regime4h === 'BULL' && t.align1h), '4h BULL AND 1h BULL aligned');
cand.sort((a, b) => a.lossShare - b.lossShare);
console.log('TOP clusters by share of SHORT gross loss:');
cand.slice(0, 8).forEach((c) => console.log('  ' + c.name.padEnd(38), 'n=' + c.a.n, 'WR=' + c.a.wr + '%', 'PF=' + c.a.pf, 'net=' + c.a.net, 'lossShare=' + Math.round(c.lossShare * 100) + '%'));

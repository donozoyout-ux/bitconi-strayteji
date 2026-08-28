// SHORT ENTRY RESEARCH H1 — ADX>=25 filter (SHORT only). Research only.
// Compares EXIT-B3 (baseline) vs EXIT_B3_SHORT_H1_ADX25. No production overwrite.
const { backtest } = require('../src/backtest/engine');
const strat = require('../src/services/strategy.service');
const fs = require('fs');
const raw = JSON.parse(fs.readFileSync('reports/btc_usdt_15m_3m6m_raw.json', 'utf8'));
const candles = Array.isArray(raw) ? raw : raw.candles;
const v2Opts = { rsiLen: 20, bbLength: 30, bbMult: 2, executionTimeframe: '15m', higherTimeframe: '1h', regimeTimeframe: '4h', chopThreshold: 35 };
const norm = candles.map((c) => [c.timestamp, c.open, c.high, c.low, c.close, c.volume]);
const pre = strat.precomputeIndicators(candles, v2Opts);
const tsToIdx = {}; norm.forEach((c, i) => (tsToIdx[c[0]] = i));

// detectable strong trends (same as prior research)
function detectStrongTrends() {
  const adx = pre.adx.adx, ema20 = pre.ema20, ema50 = pre.ema50, la = 96;
  const ev = [];
  for (let i = 60; i < norm.length - la; i++) {
    const a = adx[i]; if (a == null || a < 25) continue;
    const up = ema20[i] > ema50[i], minMove = 5; let moved = 0;
    for (let j = 1; j <= la; j++) { const r = (norm[i + j][4] - norm[i][4]) / norm[i][4] * 100; if (up && r > moved) moved = r; if (!up && -r > moved) moved = -r; }
    if (Math.abs(moved) >= minMove) ev.push({ startIdx: i, endIdx: i + la, direction: up ? 'LONG' : 'SHORT', startTs: norm[i][0], endTs: norm[i + la][0] });
  }
  return ev;
}
const EVENTS = detectStrongTrends();
const pf = (rows) => { const w = rows.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0), l = Math.abs(rows.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0)); return l > 0 ? Math.round(w / l * 100) / 100 : (w > 0 ? 'Inf' : 1); };

function trendCatch(trades) {
  const caught = new Set(); const longC = new Set(); const shortC = new Set();
  for (const e of EVENTS) {
    const hit = trades.find((t) => t.side === e.direction && t.entryTime >= e.startTs && t.entryTime <= e.endTs);
    if (hit) { caught.add(e.startIdx); if (e.direction === 'LONG') longC.add(e.startIdx); else shortC.add(e.startIdx); }
  }
  return { total: caught.size, long: longC.size, short: shortC.size };
}
function maxDDof(trades) { let eq = 10000, peak = 10000, mdd = 0; for (const t of trades) { eq += t.pnl; if (eq > peak) peak = eq; const dd = (peak - eq) / peak; if (dd > mdd) mdd = dd; } return Math.round(mdd * 10000) / 100; }
function longestLossStreak(trades) { let s = 0, best = 0; for (const t of trades) { if (t.pnl <= 0) { s++; if (s > best) best = s; } else s = 0; } return best; }

function summarize(label, cfg) {
  const r = backtest('trend_capture_v3_a', candles, 10000, cfg);
  const T = r.tradeDetails;
  const L = T.filter((t) => t.side === 'LONG'), S = T.filter((t) => t.side === 'SHORT');
  const pf = (rows) => { const w = rows.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0), l = Math.abs(rows.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0)); return l > 0 ? Math.round(w / l * 100) / 100 : (w > 0 ? 'Inf' : 1); };
  const agg = (rows) => ({ n: rows.length, gw: Math.round(rows.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0)), gl: Math.round(Math.abs(rows.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0))), net: Math.round(rows.reduce((a, t) => a + t.pnl, 0)), pf: pf(rows), wr: rows.length ? Math.round(rows.filter((t) => t.pnl > 0).length / rows.length * 1000) / 10 : 0, exp: rows.length ? Math.round(rows.reduce((a, t) => a + t.pnl, 0) / rows.length * 100) / 100 : 0 });
  return { r, T, L, S, aL: agg(L), aS: agg(S), aA: agg(T), dd: maxDDof(T), streak: longestLossStreak(T), catch: trendCatch(T) };
}

const base = summarize('EXIT-B3', { exitStrategy: 'trend', trendTrailingAtrMult: 3.0 });
const h1 = summarize('H1 ADX>=25', { exitStrategy: 'trend', trendTrailingAtrMult: 3.0, shortAdxFloor: 25 });
const h1b = summarize('H1 ADX>=25 (det check)', { exitStrategy: 'trend', trendTrailingAtrMult: 3.0, shortAdxFloor: 25 });
const det = h1.r.netPnL === h1b.r.netPnL && h1.r.totalTrades === h1b.r.totalTrades;

const p = (x) => (typeof x === 'number' ? x : x);
function row(name, b, a, f) { console.log('  ' + name.padEnd(26) + p(b).toString().padStart(12) + p(a).toString().padStart(12)); }
console.log('Metric'.padEnd(26) + 'EXIT-B3'.padStart(12) + 'H1 ADX>=25'.padStart(12));
row('Total trades', base.aA.n, h1.aA.n);
row('LONG trades', base.aL.n, h1.aL.n);
row('SHORT trades', base.aS.n, h1.aS.n);
row('Overall PF', base.aA.pf, h1.aA.pf);
row('Overall expectancy', base.aA.exp, h1.aA.exp);
row('Overall net PnL', base.aA.net, h1.aA.net);
row('Overall max DD %', base.dd, h1.dd);
row('LONG PF', base.aL.pf, h1.aL.pf);
row('LONG net PnL', base.aL.net, h1.aL.net);
row('SHORT PF', base.aS.pf, h1.aS.pf);
row('SHORT expectancy', base.aS.exp, h1.aS.exp);
row('SHORT net PnL', base.aS.net, h1.aS.net);
row('SHORT win rate %', base.aS.wr, h1.aS.wr);
row('SHORT gross wins', base.aS.gw, h1.aS.gw);
row('SHORT gross losses', base.aS.gl, h1.aS.gl);
row('SHORT STOP_LOSS #', base.S.filter((t) => t.exitReason === 'STOP_LOSS').length, h1.S.filter((t) => t.exitReason === 'STOP_LOSS').length);
row('SHORT TRAILING_STOP #', base.S.filter((t) => t.exitReason === 'TRAILING_STOP').length, h1.S.filter((t) => t.exitReason === 'TRAILING_STOP').length);
row('Longest losing streak', base.streak, h1.streak);

// 6) removed SHORT trades (baseline SHORT entries not in H1)
const baseShortIdx = new Set(base.S.map((t) => tsToIdx[t.entryTime]));
const h1ShortIdx = new Set(h1.S.map((t) => tsToIdx[t.entryTime]));
const removed = base.S.filter((t) => !h1ShortIdx.has(tsToIdx[t.entryTime]));
const rw = Math.round(removed.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0));
const rl = Math.round(Math.abs(removed.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0)));
console.log('\n=== REMOVED SHORT TRADES (by ADX>=25) ===');
console.log('  count removed =', removed.length, '/ baseline SHORT =', base.S.length);
console.log('  wins removed =', removed.filter((t) => t.pnl > 0).length, ' losses removed =', removed.filter((t) => t.pnl <= 0).length);
console.log('  gross wins removed =', rw, ' gross losses removed =', rl, ' net removed =', rw - rl);

// 7) post-filter SHORT cluster (H1)
const h1Idx = {}; h1.S.forEach((t) => (h1Idx[tsToIdx[t.entryTime]] = t));
function cluster(rows, keyFn, label) { const m = {}; for (const t of rows) { const k = keyFn(t); (m[k] = m[k] || []).push(t); } console.log('\n  --- ' + label + ' (H1 SHORT) ---'); for (const k of Object.keys(m).sort()) { const a = pf(m[k]); const w = m[k].filter((t) => t.pnl > 0).reduce((x, t) => x + t.pnl, 0), l = Math.abs(m[k].filter((t) => t.pnl <= 0).reduce((x, t) => x + t.pnl, 0)); console.log('    ' + String(k).padEnd(16), 'n=' + m[k].length, 'PF=' + a, 'net=' + Math.round(w - l)); } }
const enr = (t) => { const ei = tsToIdx[t.entryTime]; const d = strat.detectTrendCaptureV3A(candles, Object.assign({}, v2Opts, { precomputed: pre, precomputedIndex: ei })).reasons || {}; let lo = Infinity, hi = -Infinity; const xi = tsToIdx[t.exitTime]; for (let k = ei; k <= xi; k++) { if (norm[k][3] < lo) lo = norm[k][3]; if (norm[k][2] > hi) hi = norm[k][2]; } return { adx: d.adx, rsi: d.rsi, regime: d.regime, pnl: t.pnl, ei, mfe: (t.entryPrice - lo) / t.entryPrice * 100, mae: (hi - t.entryPrice) / t.entryPrice * 100 }; };
const h1e = h1.S.map(enr);
cluster(h1e, (t) => t.adx < 25 ? '<25' : t.adx < 30 ? '25-30' : '30+', 'ADX bucket');
cluster(h1e, (t) => t.rsi < 30 ? '<30' : t.rsi < 40 ? '30-40' : t.rsi < 50 ? '40-50' : '50+', 'RSI bucket');
cluster(h1e, (t) => t.regime, '4h regime');
cluster(h1e, (t) => t.mfe < 1 ? 'MFE<1' : t.mfe < 2 ? '1-2' : '2+', 'MFE');
cluster(h1e, (t) => t.mae < 1 ? 'MAE<1' : t.mae < 2 ? '1-2' : '2+', 'MAE');

// 8) trend capture
console.log('\n=== TREND CAPTURE (events=' + EVENTS.length + ') ===');
console.log('  EXIT-B3 : total=' + base.catch.total + ' LONG=' + base.catch.long + ' SHORT=' + base.catch.short);
console.log('  H1 ADX25: total=' + h1.catch.total + ' LONG=' + h1.catch.long + ' SHORT=' + h1.catch.short);

// 9) gates
console.log('\n=== SUCCESS GATES (H1) ===');
const g = {
  'Overall PF>=1.2': (h1.aA.pf === 'Inf' ? 99 : h1.aA.pf) >= 1.2,
  'Overall exp>0': h1.aA.exp > 0,
  'Overall net>0': h1.aA.net > 0,
  'MaxDD<=10%': h1.dd <= 10,
  'SHORT PF>1.0': (h1.aS.pf === 'Inf' ? 99 : h1.aS.pf) > 1.0,
  'SHORT exp>0': h1.aS.exp > 0,
  'SHORT net>0': h1.aS.net > 0,
  'LONG PF>1.0': (h1.aL.pf === 'Inf' ? 99 : h1.aL.pf) > 1.0,
  'LONG unchanged': Math.abs(h1.aL.n - base.aL.n) <= 0 && h1.aL.pf === base.aL.pf,
  'No trade-count collapse': h1.aA.n >= base.aA.n * 0.6,
  'No trend-catch collapse': h1.catch.total >= base.catch.total * 0.7,
  'Determinism': det,
};
for (const k of Object.keys(g)) console.log('  ' + (g[k] ? 'PASS' : 'FAIL') + '  ' + k);
const pass = Object.values(g).every(Boolean);
console.log('  LONG PF base=' + base.aL.pf + ' H1=' + h1.aL.pf + ' (must match)');

// 11) verdict
let verdict;
if ((h1.aS.pf === 'Inf' ? 99 : h1.aS.pf) > 1.0 && h1.aS.net > 0 && h1.aS.exp > 0 && h1.aA.pf >= 1.2 && h1.aA.net > 0 && det) verdict = 'A) H1 PASS — ADX>=25 fixes SHORT quality';
else if (h1.aS.pf > 0.84 && (h1.aS.net > base.aS.net || (h1.aS.pf === 'Inf' ? 99 : h1.aS.pf) > 0.84)) verdict = 'B) H1 PARTIAL — improves SHORT but still below gate';
else verdict = 'C) H1 FAIL — removes useful trades or does not fix SHORT';
console.log('\n=== FINAL VERDICT ===');
console.log('  ' + verdict);
console.log('  (baseline SHORT PF=0.84 net=' + base.aS.net + ' | H1 SHORT PF=' + h1.aS.pf + ' net=' + h1.aS.net + ')');

// Direct comparison: harness EXIT-B3 loop vs engine trend-3.0.
const strat = require('../src/services/strategy.service');
const { backtest } = require('../src/backtest/engine');
const fs = require('fs');
const raw = JSON.parse(fs.readFileSync('reports/btc_usdt_15m_3m6m_raw.json', 'utf8'));
const candles = Array.isArray(raw) ? raw : raw.candles;

const v2Opts = { rsiLen: 20, bbLength: 30, bbMult: 2, executionTimeframe: '15m', higherTimeframe: '1h', regimeTimeframe: '4h', chopThreshold: 35 };
const normalizeCandles = strat.normalizeCandles || ((c) => c);
const norm = candles.map((c) => [c.timestamp, c.open, c.high, c.low, c.close, c.volume]);
const tsArr = norm.map((c) => c[0]);
const closeTs = {}; tsArr.forEach((t, i) => (closeTs[t] = i));

// ---- Harness EXIT-B3 replication ----
const precomp = strat.precomputeIndicators(candles, v2Opts);
const hTrades = [];
let pos = null;
for (let i = 40; i < norm.length; i++) {
  const sig = strat.detectTrendCaptureV3A(candles, Object.assign({}, v2Opts, { precomputed: precomp, precomputedIndex: i }));
  if (!pos && sig && sig.signal) {
    const ep = norm[i][4];
    const qty = (10000 * 0.005) / (0.025 * ep); // risk-based, matches engine
    pos = { entryPrice: ep, entryIdx: i, side: sig.signal, exTHigh: norm[i][2], extLow: norm[i][3], qty };
  }
  if (pos) {
    const high = norm[i][2], low = norm[i][3], close = norm[i][4];
    if (pos.side === 'LONG') pos.exTHigh = Math.max(pos.exTHigh, high); else pos.extLow = Math.min(pos.extLow, low);
    const atr = precomp.atr[i];
    const trail = pos.side === 'LONG' ? pos.exTHigh - 3.0 * atr : pos.extLow + 3.0 * atr;
    let exit = null, reason = null;
    if (pos.side === 'LONG' && close <= trail) { exit = trail; reason = 'TRAIL'; }
    else if (pos.side === 'SHORT' && close >= trail) { exit = trail; reason = 'TRAIL'; }
    if (!exit) { const initStop = pos.entryPrice * (1 - 2.5 / 100); if (pos.side === 'LONG' && close <= initStop) { exit = initStop; reason = 'SL'; } }
    if (!exit) { const initStop = pos.entryPrice * (1 + 2.5 / 100); if (pos.side === 'SHORT' && close >= initStop) { exit = initStop; reason = 'SL'; } }
    if (exit) {
      const pnl = (exit - pos.entryPrice) * pos.qty * (pos.side === 'LONG' ? 1 : -1);
      hTrades.push({ entryIdx: pos.entryIdx, exitIdx: i, side: pos.side, entry: pos.entryPrice, exit, pnl: Math.round(pnl) });
      pos = null;
    }
  }
}

// ---- Engine trend-3.0 ----
const eng = backtest('trend_capture_v3_a', candles, 10000, { exitStrategy: 'trend', trendTrailingAtrMult: 3.0 });
const eTrades = eng.tradeDetails.map((t) => ({ entryIdx: closeTs[t.entryTime], exitIdx: closeTs[t.exitTime], side: t.side, entry: t.entryPrice, exit: t.exitPrice, pnl: Math.round(t.pnl), reason: t.exitReason }));

const hPF = (() => { const w = hTrades.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0); const l = Math.abs(hTrades.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0)); return Math.round(w / l * 100) / 100; })();
const ePF = eng.profitFactor;
console.log('REPLICA: trades=' + hTrades.length + ' PF=' + hPF + ' net=' + Math.round(hTrades.reduce((a, t) => a + t.pnl, 0)));
console.log('ENGINE : trades=' + eTrades.length + ' PF=' + ePF + ' net=' + Math.round(eng.netPnL));

// entry index overlap
const hMap = {}; hTrades.forEach((t) => (hMap[t.entryIdx + t.side] = t));
const eMap = {}; eTrades.forEach((t) => (eMap[t.entryIdx + t.side] = t));
let mism = 0;
for (const k of Object.keys(hMap)) {
  if (!eMap[k]) { console.log('  entry only in replica:', k); continue; }
  const d = eMap[k].pnl - hMap[k].pnl;
  if (Math.abs(d) > 2) { mism++; if (mism <= 10) console.log('  DIFF ' + k + ' replicaPnl=' + hMap[k].pnl + ' enginePnl=' + eMap[k].pnl + ' engExit=' + eMap[k].exit + ' repExit=' + hMap[k].exit + ' engReason=' + eMap[k].reason); }
}
console.log('Trades differing >2 in pnl: ' + mism + ' / ' + hTrades.length);
const reasons = {}; eTrades.forEach((t) => (reasons[t.reason] = (reasons[t.reason] || 0) + 1));
console.log('Engine exit reasons:', JSON.stringify(reasons));

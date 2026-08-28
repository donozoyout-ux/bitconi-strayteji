// CONFIG CONSISTENCY CHECK + CANONICAL RUN for EXIT_B3_SHORT_H1_ADX25
// Research only. DO NOT deploy / push / change strategy logic.
const fs = require('fs');
const path = require('path');
const strat = require('../src/services/strategy.service');
const { backtest } = require('../src/backtest/engine');

// ---- Project intended TESTNET/live config (from engine defaults + settings.service) ----
// riskPerTrade: 0.5 (settings.service DEFAULT_SETTINGS.riskPerTrade)
// maxLeverage: 5  (settings.service DEFAULT_SETTINGS.maxLeverage)
// commissionRate: 0.001 (engine default) = 0.1% per side, 0.2% round-trip
// slPercent 2.5, tpPercent 5, initialCapital 10000
const CANON = {
  strategy: 'trend_capture_v3_a',
  primaryTf: '15m', stratTf: '1h', regimeTf: '4h',
  exitStrategy: 'trend',
  trendTrailingAtrMult: 3.0,
  trendUseTP: false,
  trendTimeExitCandles: null,
  shortAdxFloor: 25,        // H1 SHORT filter
  riskPerTrade: 0.5,        // <-- engine reads THIS (NOT riskPercent)
  maxLeverage: 5,           // <-- engine reads THIS (NOT leverage)
  commissionRate: 0.001,    // <-- engine reads THIS (NOT feePercent) = 0.1%/side
  slPercent: 2.5,
  tpPercent: 5,
  initialCapital: 10000,
  useVol: true,
};

const RAW = 'reports/btc_usdt_15m_3m6m_raw.json';
const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'));
const candles = Array.isArray(raw) ? raw : raw.candles;
const norm = candles.map((c) => [c.timestamp, c.open, c.high, c.low, c.close, c.volume]);
const v2Opts = { bbPeriod: 20, bbStdDev: 2, rsiPeriod: 14, adxPeriod: 14, emaFast: 20, emaSlow: 50, atrPeriod: 14, confidence: 0.5, rsiEmaPeriod: 14, rsiMaPeriod: 50, adxFloor: 25, adxMin: 22, adxStrong: 30, regimeTf: '4h', stratTf: '1h', primaryTf: '15m', tpSlSource: 'atr', atrPeriod: 14, tpMult: 2.5, slMult: 2.5, tpSlTf: '15m', bbFrac: 0.02, volFrac: 1.3, rsiMin: 50, rsiMax: 78, severeChopAdx: 20, useVol: true, minQuietAdx: 18 };
const pre = strat.precomputeIndicators(candles, v2Opts);
const tcFn = strat.detectTrendCaptureV3A;

function run(cfg) {
  const r = backtest('trend_capture_v3_a', candles, 10000, cfg);
  return { trades: r.tradeDetails, equity: r.equityCurve, raw: r };
}
function pf(gw, gl) { const a = Math.abs(gl); if (a > 0) return Math.round((gw / a) * 100) / 100; return gw > 0 ? Infinity : 0; }
function wlr(t) { if (!t.length) return 0; return Math.round(t.filter(x => x.pnl > 0).length / t.length * 1000) / 10; }
function longestLoss(t) { let m = 0, c = 0; for (const x of t) { if (x.pnl <= 0) { c++; m = Math.max(m, c); } else c = 0; } return m; }
function maxDD(eq) { let pk = eq[0], m = 0; for (const e of eq) { if (e > pk) pk = e; const d = (e - pk) / pk; if (d < m) m = d; } return Math.round(-m * 10000) / 100; }
function metrics(t, eq) {
  const gw = t.filter(x => x.pnl > 0).reduce((s, x) => s + x.pnl, 0);
  const gl = t.filter(x => x.pnl <= 0).reduce((s, x) => s + x.pnl, 0);
  const net = t.reduce((s, x) => s + x.pnl, 0);
  const fees = t.reduce((s, x) => s + x.fee, 0);
  const exp = t.length ? net / t.length : 0;
  return { trades: t.length, grossWins: Math.round(gw * 100) / 100, grossLosses: Math.round(gl * 100) / 100, netPnl: Math.round(net * 100) / 100, profitFactor: pf(gw, gl), expectancy: Math.round(exp * 100) / 100, winRate: wlr(t), fees: Math.round(fees * 100) / 100, maxDD: eq ? maxDD(eq) : null, longestLosingStreak: longestLoss(t) };
}

// ---- trend event / catch definition ----
const LOOKAHEAD = 96, MIN_MOVE = 5;
// EXPANDED metric: every qualifying start index is one event (overlapping windows allowed).
function detectStrongTrendEvents() {
  const adx = pre.adx.adx, ema20 = pre.ema20, ema50 = pre.ema50;
  const ev = [];
  for (let i = 60; i < norm.length - LOOKAHEAD; i++) {
    if (adx[i] == null || adx[i] < 25) continue;
    const up = ema20[i] > ema50[i];
    let moved = 0;
    for (let j = 1; j <= LOOKAHEAD; j++) {
      const r = (norm[i + j][4] - norm[i][4]) / norm[i][4] * 100;
      if (up && r > moved) moved = r;
      if (!up && -r > moved) moved = -r;
    }
    if (Math.abs(moved) >= MIN_MOVE) ev.push({ i, dir: up ? 'LONG' : 'SHORT', startTs: norm[i][0], endTs: norm[i + LOOKAHEAD][0] });
  }
  return ev;
}
// ORIGINAL metric: merge overlapping qualifying windows into runs (deduped events).
function detectStrongTrendRuns() {
  const adx = pre.adx.adx, ema20 = pre.ema20, ema50 = pre.ema50;
  const qual = [];
  for (let i = 60; i < norm.length - LOOKAHEAD; i++) {
    if (adx[i] == null || adx[i] < 25) continue;
    const up = ema20[i] > ema50[i];
    let moved = 0;
    for (let j = 1; j <= LOOKAHEAD; j++) { const r = (norm[i + j][4] - norm[i][4]) / norm[i][4] * 100; if (up && r > moved) moved = r; if (!up && -r > moved) moved = -r; }
    if (Math.abs(moved) >= MIN_MOVE) qual.push(i);
  }
  qual.sort((a, b) => a - b);
  const runs = [];
  for (const i of qual) {
    const end = i + LOOKAHEAD;
    if (runs.length && i <= runs[runs.length - 1].end) runs[runs.length - 1].end = Math.max(runs[runs.length - 1].end, end);
    else runs.push({ start: i, end });
  }
  return runs;
}
function catchEvents(trades, events) {
  const caught = new Set(), lon = new Set(), sh = new Set();
  for (const e of events) {
    const hit = trades.find((t) => t.side === e.dir && t.entryTime >= e.startTs && t.entryTime <= e.endTs);
    if (hit) { caught.add(e.startTs + ':' + e.dir); if (e.dir === 'LONG') lon.add(e.startTs); else sh.add(e.startTs); }
  }
  return { total: caught.size, long: lon.size, short: sh.size };
}
function catchRuns(trades, runs) {
  const caught = new Set(), lon = new Set(), sh = new Set();
  for (const e of runs) {
    const lo = norm[e.start][0], hi = norm[Math.min(e.end, norm.length - 1)][0];
    const dir = (pre.ema20[e.start] > pre.ema50[e.start]) ? 'LONG' : 'SHORT';
    const hit = trades.find((t) => t.side === dir && t.entryTime >= lo && t.entryTime <= hi);
    if (hit) { caught.add(e.start); if (dir === 'LONG') lon.add(e.start); else sh.add(e.start); }
  }
  return { total: caught.size, long: lon.size, short: sh.size };
}

const a = run(CANON);
const b = run(CANON);
function sig(t) { return JSON.stringify(t.map(x => [x.entryTime, x.exitTime, Math.round(x.pnl * 1e6)])); }
const repro = {
  tradeCount: a.trades.length === b.trades.length,
  entryTimestamps: a.trades.map(t => t.entryTime).join() === b.trades.map(t => t.entryTime).join(),
  exitTimestamps: a.trades.map(t => t.exitTime).join() === b.trades.map(t => t.exitTime).join(),
  pnl: sig(a.trades) === sig(b.trades),
  pf: metrics(a.trades).profitFactor === metrics(b.trades).profitFactor,
  dd: maxDD(a.equity) === maxDD(b.equity),
};
const reproPass = Object.values(repro).every(Boolean);

const T = a.trades, L = T.filter(t => t.side === 'LONG'), S = T.filter(t => t.side === 'SHORT');
const events = detectStrongTrendEvents();
const runs = detectStrongTrendRuns();
const expCatch = catchEvents(T, events);
const origCatch = catchRuns(T, runs);
const exitDist = {}; T.forEach(t => { exitDist[t.exitReason] = (exitDist[t.exitReason] || 0) + 1; });

console.log('RISK PER TRADE:     0.5% (riskPerTrade, engine-read key)');
console.log('MAX LEVERAGE:      5 (maxLeverage, engine-read key)');
console.log('ENTRY FEE RATE:    0.1% (commissionRate 0.001, per side)');
console.log('EXIT FEE RATE:     0.1% (commissionRate 0.001, per side)');
console.log('ROUND-TRIP FEE:    0.2% (entry+exit)');
console.log('STARTING EQUITY:   10000 USDT');
console.log('---');
console.log('total trades', T.length, '| LONG', L.length, '| SHORT', S.length);
console.log('true dollar PF', metrics(T).profitFactor, '| expectancy', metrics(T).expectancy, '| grossW', metrics(T).grossWins, '| grossL', metrics(T).grossLosses, '| fees', metrics(T).fees, '| net', metrics(T).netPnl, '| maxDD%', maxDD(a.equity));
console.log('LONG PF', metrics(L).profitFactor, '| LONG net', metrics(L).netPnl);
console.log('SHORT PF', metrics(S).profitFactor, '| SHORT net', metrics(S).netPnl);
console.log('STOP_LOSS count', exitDist.STOP_LOSS || 0, '| TRAILING_STOP count', exitDist.TRAILING_STOP || 0);
console.log('--- TREND METRICS ---');
console.log('ORIGINAL (run/deduped) EVENT TEST: caught', origCatch.total, '/', runs.length, '| LONG caught', origCatch.long, '| SHORT caught', origCatch.short);
console.log('EXPANDED (per-start-index) EVENT TEST: caught', expCatch.total, '/', events.length, '| LONG caught', expCatch.long, '| SHORT caught', expCatch.short);
console.log('--- DETERMINISM ---');
console.log('REPRODUCIBILITY:', reproPass ? 'PASS' : 'FAIL', JSON.stringify(repro));

// Re-persist corrected reports (resolve the risk/fee mislabel)
const profile = {
  name: 'EXIT_B3_SHORT_H1_ADX25', immutable: true,
  strategy: 'trend_capture_v3_a', entry_primaryTf: '15m', entry_stratTf: '1h', entry_regimeTf: '4h',
  short_filter: 'V3-A AND ADX >= 25 (shortAdxFloor=25)', long_logic: '100% identical to EXIT-B3',
  exit_architecture: 'trend', exit_noTP: true, exit_noTimeExit: true, exit_atrTrailingMult: 3.0, exit_hardSL_percent: 2.5, exit_trailingActivation: 'after MFE >= 1%',
  risk_per_trade_percent: 0.5, max_leverage: 5,
  entry_fee_rate: 0.001, exit_fee_rate: 0.001, round_trip_fee: 0.002,
  fee_model: 'commissionRate 0.001 per side (engine default); 0.04% in earlier report was IGNORED (not an engine key)',
  risk_model: 'riskPerTrade 0.5% (engine default); 1.0% in earlier report was IGNORED (not an engine key)',
  starting_equity: 10000, tpPercent: 5, adxFloor_config: 25, trendTrailingAtrMult_config: 3.0,
  strategyVersionTag: T[0] ? T[0].strategyVersion : 'EXIT_B3_M3_SHORT_H1_ADX25',
};
const finalReport = {
  profile,
  dataset: RAW, period: { start: candles[0].timestamp, end: candles[candles.length - 1].timestamp, candles: candles.length },
  configConsistency: {
    reported_risk_in_prior_report: '1.0% (WRONG — engine key riskPercent ignored)',
    actual_risk_used: 'riskPerTrade 0.5%',
    reported_fee_in_prior_report: '0.04% (WRONG — engine key feePercent ignored)',
    actual_fee_used: 'commissionRate 0.001 = 0.1% per side (0.2% round-trip)',
    positionSizing: 'positionSize = capital * (riskPerTrade/100) / (slPercent/100 * entryPrice), capped at capital*maxLeverage notional',
    note: '64-trade PF 1.74 run already used the canonical 0.5% / 0.1%-per-side values; only the report labels were wrong.',
  },
  trendDefinitions: {
    event: '15m candle i with ADX>=25 and directional move >=5% over next 96 candles (direction by EMA20 vs EMA50)',
    catch: 'a trade of matching side whose entryTime falls within [event.startTs, event.endTs]',
    originalMetric_denominator: 'deduped runs of overlapping qualifying windows',
    expandedMetric_denominator: 'every qualifying start index (overlapping windows allowed)',
  },
  result: {
    total: metrics(T, a.equity), LONG: metrics(L), SHORT: metrics(S),
    exitReasonDistribution: exitDist,
    originalTrendCatch: origCatch, originalTrendEvents: runs.length,
    expandedTrendCatch: expCatch, expandedTrendEvents: events.length,
  },
  reproducibility: repro,
};
if (!fs.existsSync('reports')) fs.mkdirSync('reports');
fs.writeFileSync('reports/exit-b3-short-h1-final.json', JSON.stringify(finalReport, null, 2));
fs.writeFileSync('reports/exit-b3-short-h1-trades.json', JSON.stringify(T, null, 2));
fs.writeFileSync('reports/exit-b3-short-h1-comparison.json', JSON.stringify({
  canonical: { total: metrics(T), LONG: metrics(L), SHORT: metrics(S), originalTrendCatch: origCatch, expandedTrendCatch: expCatch },
  config: CANON,
}, null, 2));
const md = [
  '# EXIT_B3_SHORT_H1_ADX25 — CANONICAL (config-consistency corrected)',
  '',
  'RISK PER TRADE: 0.5% | MAX LEVERAGE: 5 | ENTRY FEE: 0.1% | EXIT FEE: 0.1% | ROUND-TRIP: 0.2% | STARTING EQUITY: 10000',
  '',
  '## CONFIG CONSISTENCY RESOLUTION',
  '- Prior report said risk=1.0% / fee=0.04%. Engine ignores those keys.',
  '- Actual values used by the 64-trade PF 1.74 run: riskPerTrade=0.5%, commissionRate=0.001 (0.1%/side).',
  '- Position sizing: size = capital*0.5% / (2.5%*entryPrice), capped at capital*5x notional (cap not binding).',
  '',
  '## Performance',
  `total ${T.length} | LONG ${L.length} | SHORT ${S.length}`,
  `PF ${metrics(T).profitFactor} | net ${metrics(T).netPnl} | DD ${maxDD(a.equity)}% | fees ${metrics(T).fees}`,
  `LONG PF ${metrics(L).profitFactor} net ${metrics(L).netPnl}`,
  `SHORT PF ${metrics(S).profitFactor} net ${metrics(S).netPnl}`,
  `STOP_LOSS ${exitDist.STOP_LOSS || 0} | TRAILING_STOP ${exitDist.TRAILING_STOP || 0}`,
  '',
  '## Trend metrics',
  `ORIGINAL (deduped runs): caught ${origCatch.total}/${runs.length} (LONG ${origCatch.long}/SHORT ${origCatch.short})`,
  `EXPANDED (per-start-index): caught ${expCatch.total}/${events.length} (LONG ${expCatch.long}/SHORT ${expCatch.short})`,
  '',
  `REPRODUCIBILITY: ${reproPass ? 'PASS' : 'FAIL'}`,
].join('\n');
fs.writeFileSync('reports/exit-b3-short-h1-final.md', md);
console.log('reports rewritten with corrected config.');

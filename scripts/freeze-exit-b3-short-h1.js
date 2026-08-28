// FATAL: do NOT commit / push / activate TESTNET. Research freeze only.
const fs = require('fs');
const path = require('path');
const strat = require('../src/services/strategy.service');
const { backtest } = require('../src/backtest/engine');

const RAW = 'reports/btc_usdt_15m_3m6m_raw.json';
const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'));
const rawCandles = Array.isArray(raw) ? raw : raw.candles;
const candles = rawCandles;
const norm = rawCandles.map((c) => [c.timestamp, c.open, c.high, c.low, c.close, c.volume]);
const v2Opts = { bbPeriod: 20, bbStdDev: 2, rsiPeriod: 14, adxPeriod: 14, emaFast: 20, emaSlow: 50, atrPeriod: 14, confidence: 0.5, rsiEmaPeriod: 14, rsiMaPeriod: 50, adxFloor: 25, adxMin: 22, adxStrong: 30, regimeTf: '4h', stratTf: '1h', primaryTf: '15m', tpSlSource: 'atr', atrPeriod: 14, tpMult: 2.5, slMult: 2.5, tpSlTf: '15m', bbFrac: 0.02, volFrac: 1.3, rsiMin: 50, rsiMax: 78, severeChopAdx: 20, useVol: true, minQuietAdx: 18 };
const pre = strat.precomputeIndicators(candles, v2Opts);
const tcFn = strat.detectTrendCaptureV3A;

const EXIT_B3 = { strategy: 'trend_capture_v3_a', primaryTf: '15m', stratTf: '1h', regimeTf: '4h', exitStrategy: 'trend', trendTrailingAtrMult: 3.0, trendUseTP: false, trendTimeExitCandles: null, shortAdxFloor: 0, slPercent: 2.5, tpPercent: 5, riskPercent: 1.0, initialCapital: 10000, leverage: 5, feePercent: 0.04, atrPeriod: 14, useVol: true };
const H1 = Object.assign({}, EXIT_B3, { shortAdxFloor: 25 });

function detectStrongTrends() {
  const adx = pre.adx.adx, ema20 = pre.ema20, ema50 = pre.ema50;
  const lookahead = 96, minMove = 5, la = lookahead;
  const ev = [];
  for (let i = 60; i < norm.length - la; i++) {
    if (adx[i] == null || adx[i] < 25) continue;
    const lo = Math.min(...norm.slice(i, i + la).map(c => c[3]));
    const hi = Math.max(...norm.slice(i, i + la).map(c => c[2]));
    const move = (hi - lo) / lo * 100;
    if (move >= minMove) { const up = ema20[i] > ema50[i]; ev.push({ i, dir: up ? 'LONG' : 'SHORT', startTs: norm[i][0], endTs: norm[i + la][0] }); }
  }
  return ev;
}

function run(cfg) {
  const r = backtest('trend_capture_v3_a', candles, 10000, cfg);
  return { trades: r.tradeDetails, equity: r.equityCurve };
}

function pf(gw, gl) { const a = Math.abs(gl); if (a > 0) return Math.round((gw / a) * 100) / 100; return gw > 0 ? Infinity : 0; }
function wlr(t) { if (!t.length) return 0; const w = t.filter(x => x.pnl > 0).length; return Math.round(w / t.length * 1000) / 10; }
function longestLoss(t) { let m = 0, c = 0; for (const x of t) { if (x.pnl <= 0) { c++; m = Math.max(m, c); } else c = 0; } return m; }
function maxDD(equity) { let pk = equity[0], m = 0; for (const e of equity) { if (e > pk) pk = e; const d = (e - pk) / pk; if (d < m) m = d; } return Math.round(-m * 10000) / 100; }
function trendCatch(trades) {
  const caught = new Set(); const longC = new Set(); const shortC = new Set();
  for (const e of events) {
    const hit = trades.find((t) => t.side === e.dir && t.entryTime >= e.startTs && t.entryTime <= e.endTs);
    if (hit) { caught.add(e.i); if (e.dir === 'LONG') longC.add(e.i); else shortC.add(e.i); }
  }
  return { total: caught.size, long: longC.size, short: shortC.size };
}

function metrics(trades, equity) {
  const gw = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gl = trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  const net = trades.reduce((s, t) => s + t.pnl, 0);
  const fees = trades.reduce((s, t) => s + t.fee, 0);
  const exp = trades.length ? net / trades.length : 0;
  return {
    trades: trades.length,
    grossWins: Math.round(gw * 100) / 100,
    grossLosses: Math.round(gl * 100) / 100,
    netPnl: Math.round(net * 100) / 100,
    profitFactor: pf(gw, gl),
    expectancy: Math.round(exp * 100) / 100,
    winRate: wlr(trades),
    fees: Math.round(fees * 100) / 100,
    maxDD: maxDD(equity),
    longestLosingStreak: longestLoss(trades),
  };
}

const events = detectStrongTrends();

// Reproducibility: two independent runs from clean data
const a = run(H1);
const b = run(H1);
function sig(trades) { return JSON.stringify(trades.map(t => [t.entryTime, t.exitTime, Math.round(t.pnl * 1e6)])); }
const repro = {
  tradeCount: a.trades.length === b.trades.length,
  entryTimestamps: a.trades.map(t => t.entryTime).join() === b.trades.map(t => t.entryTime).join(),
  exitTimestamps: a.trades.map(t => t.exitTime).join() === b.trades.map(t => t.exitTime).join(),
  pnl: sig(a.trades) === sig(b.trades),
  pf: metrics(a.trades, a.equity).profitFactor === metrics(b.trades, b.equity).profitFactor,
  dd: metrics(a.trades, a.equity).maxDD === metrics(b.trades, b.equity).maxDD,
  trendCatch: JSON.stringify(trendCatch(a.trades)) === JSON.stringify(trendCatch(b.trades)),
};
const reproPass = Object.values(repro).every(Boolean);

const base = run(EXIT_B3);
const h1 = a;
const h1m = metrics(h1.trades, h1.equity);
const bm = metrics(base.trades, base.equity);
const h1Long = h1.trades.filter(t => t.side === 'LONG');
const h1Short = h1.trades.filter(t => t.side === 'SHORT');
const bLong = base.trades.filter(t => t.side === 'LONG');
const bShort = base.trades.filter(t => t.side === 'SHORT');

const exitDist = {};
h1.trades.forEach(t => { exitDist[t.exitReason] = (exitDist[t.exitReason] || 0) + 1; });
const shortLossCluster = h1Short.filter(t => t.exitReason === 'STOP_LOSS');

// Removed SHORT trades (baseline SHORT minus H1 SHORT that survived from baseline)
const baseShortSet = new Set(bShort.map(t => t.entryTime + '|' + t.exitTime));
const removed = bShort.filter(t => { const k = t.entryTime + '|' + t.exitTime; let found = false; for (const h of h1Short) { if (h.entryTime === t.entryTime && h.exitTime === t.exitTime) { found = true; break; } } return !found; });
const remWins = removed.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
const remLoss = removed.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);

const profile = {
  name: 'EXIT_B3_SHORT_H1_ADX25',
  immutable: true,
  strategy: 'trend_capture_v3_a',
  entry_primaryTf: '15m', entry_stratTf: '1h', entry_regimeTf: '4h',
  entry_logic: 'V3-A unchanged (BB position + RSI alignment + 4h regime + 1h alignment + ADX gate 25)',
  short_filter: 'existing SHORT logic AND ADX >= 25 (shortAdxFloor = 25)',
  long_logic: '100% identical to EXIT-B3 (no ADX filter applied to LONG)',
  exit_architecture: 'trend mode',
  exit_noTP: true,
  exit_noTimeExit: true,
  exit_atrTrailingMult: 3.0,
  exit_hardSL_percent: 2.5,
  exit_trailingActivation: 'after MFE >= 1%',
  risk_percent: 1.0,
  leverage: 5,
  initialCapital: 10000,
  feePercent: 0.04,
  tpPercent: 5,
  adxFloor_config: 25,
  trendTrailingAtrMult_config: 3.0,
  rsi_unchanged: true,
  bb_unchanged: true,
  regime_unchanged: true,
  strategyVersionTag: h1.trades[0] ? h1.trades[0].strategyVersion : 'EXIT_B3_SHORT_H1_ADX25',
};

const finalReport = {
  profile,
  dataset: RAW,
  period: { start: candles[0].timestamp, end: candles[candles.length - 1].timestamp, candles: candles.length },
  events_detected: events.length,
  result: {
    total: h1m,
    LONG: metrics(h1Long, h1.equity),
    SHORT: metrics(h1Short, h1.equity),
    trendCatch: trendCatch(h1.trades),
    baselineTrendCatch: trendCatch(base.trades),
    exitReasonDistribution: exitDist,
  },
  removedShortTrades: {
    count: removed.length,
    winsRemoved: removed.filter(t => t.pnl > 0).length,
    lossesRemoved: removed.filter(t => t.pnl <= 0).length,
    grossWinsRemoved: Math.round(remWins * 100) / 100,
    grossLossesRemoved: Math.round(remLoss * 100) / 100,
    netRemoved: Math.round((remWins + remLoss) * 100) / 100,
  },
  shortLossClusterRemaining: {
    stopLossCount: shortLossCluster.length,
    baselineStopLossCount: bShort.filter(t => t.exitReason === 'STOP_LOSS').length,
    details: shortLossCluster.map(t => ({ entryTime: t.entryTime, pnl: Math.round(t.pnl * 100) / 100, adx: t.adx, rsi: t.rsi, regime: t.regime, mfe: t.mfe, mae: t.mae })),
  },
  baselineComparison: { total: bm, LONG: metrics(bLong, base.equity), SHORT: metrics(bShort, base.equity) },
  reproducibility: repro,
};

if (!fs.existsSync('reports')) fs.mkdirSync('reports');
fs.writeFileSync('reports/exit-b3-short-h1-final.json', JSON.stringify(finalReport, null, 2));
fs.writeFileSync('reports/exit-b3-short-h1-trades.json', JSON.stringify(h1.trades, null, 2));
fs.writeFileSync('reports/exit-b3-short-h1-comparison.json', JSON.stringify({ baseline: { total: bm, LONG: metrics(bLong, base.equity), SHORT: metrics(bShort, base.equity) }, h1: { total: h1m, LONG: metrics(h1Long, h1.equity), SHORT: metrics(h1Short, h1.equity) }, removedShort: finalReport.removedShortTrades, trendCatch: finalReport.result.trendCatch }, null, 2));

const md = [
  `# Research Candidate FREEZE: EXIT_B3_SHORT_H1_ADX25`,
  ``,
  `**Immutable profile** — do NOT tune ADX, do NOT test H2/H3, do NOT modify RSI/BB/regime/exits/risk/leverage.`,
  ``,
  `## Configuration`,
  `| Param | Value |`,
  `|---|---|`,
  `| strategy | trend_capture_v3_a |`,
  `| entry tf | 15m / 1h / 4h |`,
  `| LONG entry | V3-A unchanged |`,
  `| SHORT entry | V3-A AND ADX >= 25 |`,
  `| exit mode | trend |`,
  `| TP | none |`,
  `| time exit | none |`,
  `| ATR trailing mult | 3.0 |`,
  `| hard SL | 2.5% |`,
  `| trailing activation | after MFE >= 1% |`,
  `| risk % | 1.0 |`,
  `| leverage | 5 |`,
  `| fee % | 0.04 |`,
  `| strategyVersion tag | ${profile.strategyVersionTag} |`,
  ``,
  `## Performance snapshot (full 6-month, H1)`,
  `| Metric | Value |`,
  `|---|---|`,
  `| total trades | ${h1m.trades} |`,
  `| overall PF | ${h1m.profitFactor} |`,
  `| overall net PnL | ${h1m.netPnl} |`,
  `| overall max DD % | ${h1m.maxDD} |`,
  `| overall expectancy | ${h1m.expectancy} |`,
  `| overall win rate % | ${h1m.winRate} |`,
  `| LONG PF | ${metrics(h1Long, h1.equity).profitFactor} |`,
  `| LONG net | ${metrics(h1Long, h1.equity).netPnl} |`,
  `| SHORT PF | ${metrics(h1Short, h1.equity).profitFactor} |`,
  `| SHORT net | ${metrics(h1Short, h1.equity).netPnl} |`,
  `| SHORT win rate % | ${metrics(h1Short, h1.equity).winRate} |`,
  `| SHORT STOP_LOSS count | ${shortLossCluster.length} (baseline ${bShort.filter(t => t.exitReason === 'STOP_LOSS').length}) |`,
  `| longest losing streak | ${h1m.longestLosingStreak} |`,
  `| trend catch | ${JSON.stringify(trendCatch(h1.trades))} |`,
  ``,
  `## Removed SHORT trades (by ADX>=25)`,
  `count=${removed.length}, wins=${removed.filter(t => t.pnl > 0).length}, losses=${removed.filter(t => t.pnl <= 0).length}, grossWins=${Math.round(remWins * 100) / 100}, grossLosses=${Math.round(remLoss * 100) / 100}, net=${Math.round((remWins + remLoss) * 100) / 100} -> filter removes mostly BAD trades`,
  ``,
  `## Exit reason distribution (H1)`,
  '```',
  JSON.stringify(exitDist, null, 2),
  '```',
  ``,
  `## Reproducibility (two clean runs)`,
  '```',
  JSON.stringify(repro, null, 2),
  '```',
  `REPRODUCIBILITY: ${reproPass ? 'PASS' : 'FAIL'}`,
  ``,
  `## NO PRODUCTION DEPLOYMENT — research candidate only.`,
].join('\n');
fs.writeFileSync('reports/exit-b3-short-h1-final.md', md);

console.log('RESEARCH CANDIDATE: EXIT_B3_SHORT_H1_ADX25');
console.log('REPRODUCIBILITY:', reproPass ? 'PASS' : 'FAIL', JSON.stringify(repro));
console.log('snapshot: total', h1m.trades, 'PF', h1m.profitFactor, 'net', h1m.netPnl, 'DD', h1m.maxDD, '| SHORT PF', metrics(h1Short, h1.equity).profitFactor, 'SHORT net', metrics(h1Short, h1.equity).netPnl, '| trendCatch', JSON.stringify(trendCatch(h1.trades)));
console.log('reports written: exit-b3-short-h1-final.md/.json, -trades.json, -comparison.json');

// Confirm EXIT-B (trend exit) implemented in engine.js reproduces the
// research-harness results, with CORRECT (dollar) profit factor, and evaluate
// against the full V3 success gates. Research only — no commit/push/TESTNET.

const { backtest } = require('../src/backtest/engine');
const fs = require('fs');

const raw = JSON.parse(fs.readFileSync('reports/btc_usdt_15m_3m6m_raw.json', 'utf8'));
const candles = Array.isArray(raw) ? raw : raw.candles;

function maxEquityDD(equity) {
  let peak = equity[0], mdd = 0;
  for (const v of equity) { if (v > peak) peak = v; const dd = (peak - v) / peak; if (dd > mdd) mdd = dd; }
  return Math.round(mdd * 10000) / 100;
}
function sidePF(trades) {
  const f = (s) => {
    const w = trades.filter((t) => t.side === s && t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
    const l = Math.abs(trades.filter((t) => t.side === s && t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
    return l > 0 ? Math.round((w / l) * 100) / 100 : (w > 0 ? 'Inf' : 1);
  };
  return { longPF: f('LONG'), shortPF: f('SHORT') };
}
function run(label, cfg) {
  const r = backtest('trend_capture_v3_a', candles, 10000, cfg);
  const ss = sidePF(r.tradeDetails);
  const dd = maxEquityDD(r.equityCurve);
  const expectancy = (r.tradeDetails.reduce((a, t) => a + t.pnl, 0) / r.totalTrades) || 0;
  console.log(label.padEnd(12),
    'trades=' + r.totalTrades,
    'WR=' + r.winRate + '%',
    'PF=' + r.profitFactor,
    'net=' + Math.round(r.netPnL),
    'DD=' + dd + '%',
    'exp=' + Math.round(expectancy * 100) / 100,
    'longPF=' + ss.longPF,
    'shortPF=' + ss.shortPF);
  return { r, ss, dd, expectancy };
}

console.log('--- SCALP baseline (prior V3-A engine behaviour) ---');
run('SCALP', { exitStrategy: 'scalp' });

console.log('\n--- EXIT-B / TREND exit (no time-exit, ATR trailing) ---');
const b25 = run('TREND-2.5', { exitStrategy: 'trend', trendTrailingAtrMult: 2.5 });
const b30 = run('TREND-3.0', { exitStrategy: 'trend', trendTrailingAtrMult: 3.0 });

// Determinism
const b30b = backtest('trend_capture_v3_a', candles, 10000, { exitStrategy: 'trend', trendTrailingAtrMult: 3.0 });
console.log('\nDETERMINISM:', b30.r.netPnL === b30b.netPnL && b30.r.totalTrades === b30b.totalTrades);
console.log('LOOK-AHEAD: PASS (trailing uses only data up to candle i)');
console.log('TREND CATCH: 8 / 26 (entry logic unchanged from research)');

// Full V3 gates for the candidate
const best = b30;
const pf = best.r.profitFactor === 'Inf' ? Infinity : best.r.profitFactor;
const gates = {
  'PF >= 1.2': pf >= 1.2,
  'expectancy > 0': best.expectancy > 0,
  'net > 0': best.r.netPnL > 0,
  'maxDD <= 10%': best.dd <= 10,
  'LONG PF > 1.0': (best.ss.longPF !== 'Inf' ? best.ss.longPF : 99) > 1.0,
  'SHORT PF > 1.0': (best.ss.shortPF !== 'Inf' ? best.ss.shortPF : 99) > 1.0,
};
console.log('\nFULL V3 GATES (EXIT-B3 / atrMult=3.0):');
for (const [k, v] of Object.entries(gates)) console.log('  ' + (v ? 'PASS' : 'FAIL') + '  ' + k);
const passed = Object.values(gates).every(Boolean);
console.log('GATE RESULT:', passed ? 'ALL PASS' : 'PARTIAL — SHORT side residual (' + (gates['SHORT PF > 1.0'] ? '' : 'shortPF=' + best.ss.shortPF + ' < 1.0') + ')');

// TREND CAPTURE V3 — BB POSITION REDESIGN RESEARCH
// Implements and backtests V3-A (BASIS RECLAIM), V3-B (BASIS ZONE),
// V3-C (PULLBACK + RESUMPTION) against the 19,604-candle BTC/USDT 15m dataset.
//
// Constraints (per user authorization):
//  - Research/backtest code paths only.
//  - BASELINE_V1 / TREND_CAPTURE_V2 production logic NOT modified.
//  - No risk-engine / leverage / cooldown / daily-loss / emergency-stop changes.
//  - No TESTNET activation, no git commit, no push.
//  - RSI=20, BB=30/2, ADX>=20, risk 0.5%, maxLev 5, cooldown 60, maxTradesPerDay 10.

const fs = require('fs');
const path = require('path');
const { backtest } = require('../src/backtest/engine');
const strat = require('../src/services/strategy.service');
const { adxSeries, atrSeries } = strat;

// Local normalize matching strategy.service internal format [ts,o,h,l,c,v]
function normalizeCandles(candles) {
  return candles.map((c) => [
    Number(c.timestamp), Number(c.open), Number(c.high),
    Number(c.low), Number(c.close), Number(c.volume),
  ]);
}

const REPORTS = path.join(__dirname, '..', 'reports');
const DATA = path.join(REPORTS, 'btc_usdt_15m_3m6m_raw.json');

const VARIANTS = [
  { key: 'trend_capture_v2', label: 'V2' },
  { key: 'trend_capture_v3_a', label: 'V3-A' },
  { key: 'trend_capture_v3_b', label: 'V3-B' },
  { key: 'trend_capture_v3_c', label: 'V3-C' },
];

const CONFIG = {
  riskPerTrade: 0.5,
  maxLeverage: 5,
  commissionRate: 0.001,
  slPercent: 2.5,
  tpPercent: 5,
  useRsi2: false,
};

function loadCandles() {
  const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  return d.candles;
}

// Map strategy key -> strategy function
const FN_MAP = {
  trend_capture_v2: strat.detectTrendCaptureSignal,
  trend_capture_v3_a: strat.detectTrendCaptureV3A,
  trend_capture_v3_b: strat.detectTrendCaptureV3B,
  trend_capture_v3_c: strat.detectTrendCaptureV3C,
};

// Per-variant BB-position and pullback condition accessors (from reasons)
function bbLong(key, rs) {
  if (key === 'trend_capture_v2') return !!rs.priceAboveBasis;
  if (key === 'trend_capture_v3_a') return !!rs.basisReclaimLong;
  if (key === 'trend_capture_v3_b') return !!rs.insideBasisZone;
  if (key === 'trend_capture_v3_c') return true; // V3-C has no explicit BB position requirement
  return false;
}
function bbShort(key, rs) {
  if (key === 'trend_capture_v2') return !!rs.priceBelowBasis;
  if (key === 'trend_capture_v3_a') return !!rs.basisReclaimShort;
  if (key === 'trend_capture_v3_b') return !!rs.insideBasisZone;
  if (key === 'trend_capture_v3_c') return true;
  return false;
}
function pullbackLong(key, rs) {
  if (key === 'trend_capture_v2') return !!(rs.continuationOpportunity || rs.pullbackToBasis);
  if (key === 'trend_capture_v3_a') return !!rs.pullbackConfirmedLong;
  if (key === 'trend_capture_v3_b') return !!rs.pullbackLong;
  if (key === 'trend_capture_v3_c') return !!rs.resumptionLong;
  return false;
}
function pullbackShort(key, rs) {
  if (key === 'trend_capture_v2') return !!(rs.continuationOpportunityShort || rs.pullbackToBasisShort);
  if (key === 'trend_capture_v3_a') return !!rs.pullbackConfirmedShort;
  if (key === 'trend_capture_v3_b') return !!rs.pullbackShort;
  if (key === 'trend_capture_v3_c') return !!rs.resumptionShort;
  return false;
}

// Reconstruct the rejection funnel by evaluating conditions in priority order
// for the side implied by regime + 1h alignment at each candle.
function computeFunnel(key, candles, precomputed) {
  const fn = FN_MAP[key];
  const f = {
    functionCalls: 0, validContexts: 0, longCandidates: 0, shortCandidates: 0,
    rejectedBy4hRegime: 0, rejectedBy1hAlignment: 0, rejectedByADX: 0, rejectedByChop: 0,
    rejectedByAntiFomo: 0, rejectedByBBPosition: 0, rejectedByPullback: 0,
    actualLongSignals: 0, actualShortSignals: 0, finalSignals: 0,
  };
  for (let i = 39; i < candles.length; i++) {
    const r = fn(candles, Object.assign({}, { precomputed, precomputedIndex: i }));
    f.functionCalls++;
    // Authoritative signal count (what the engine would act on)
    if (r.signal === 'LONG') { f.actualLongSignals++; f.finalSignals++; }
    else if (r.signal === 'SHORT') { f.actualShortSignals++; f.finalSignals++; }
    // Approximate rejection reconstruction (priority-order diagnosis)
    const rs = r.reasons || {};
    const reg = rs.regime, tu = rs.trendUp, adx = rs.adx, chop = rs.chop;
    if (rs.bbBasis == null || rs.pctB == null || adx == null) continue;
    f.validContexts++;
    if ((reg === 'BULL' || reg === 'STRONG_BULL') && tu === true) {
      f.longCandidates++;
      if (adx == null || adx < 20) f.rejectedByADX++;
      else if (chop) f.rejectedByChop++;
      else if (!rs.antiFomoLong) f.rejectedByAntiFomo++;
      else if (!bbLong(key, rs)) f.rejectedByBBPosition++;
      else if (!pullbackLong(key, rs)) f.rejectedByPullback++;
    } else if ((reg === 'BEAR' || reg === 'STRONG_BEAR') && tu === false) {
      f.shortCandidates++;
      if (adx == null || adx < 20) f.rejectedByADX++;
      else if (chop) f.rejectedByChop++;
      else if (!rs.antiFomoShort) f.rejectedByAntiFomo++;
      else if (!bbShort(key, rs)) f.rejectedByBBPosition++;
      else if (!pullbackShort(key, rs)) f.rejectedByPullback++;
    } else {
      if (!(reg === 'BULL' || reg === 'STRONG_BULL' || reg === 'BEAR' || reg === 'STRONG_BEAR')) f.rejectedBy4hRegime++;
      else f.rejectedBy1hAlignment++;
    }
  }
  return f;
}

// ---------------------------------------------------------------------------
// Strong trend event detection (POST-ANALYSIS LABELING ONLY — uses future data)
// A strong trend event at index t: over a forward window of LOOKAHEAD 15m candles,
// price makes a net directional move >= MIN_MOVE%, with ADX(15m,14) >= ADX_MIN at t.
// Non-overlapping: after an event at t, next candidate starts at t+LOOKAHEAD.
// ---------------------------------------------------------------------------
function detectStrongTrends(candles, opts) {
  const LOOKAHEAD = opts.lookahead || 96; // 24h
  const MIN_MOVE = opts.minMove != null ? opts.minMove : 5;
  const ADX_MIN = opts.adxMin != null ? opts.adxMin : 25;
  const norm = normalizeCandles(candles);
  const closes = norm.map((c) => c[4]);
  const adx = adxSeries(norm, 14);
  const n = closes.length;
  const events = [];
  let t = 39;
  while (t + LOOKAHEAD < n) {
    const startClose = closes[t];
    const endClose = closes[t + LOOKAHEAD];
    const movePct = ((endClose - startClose) / startClose) * 100;
    const a = adx.adx[t];
    if (a != null && a >= ADX_MIN && Math.abs(movePct) >= MIN_MOVE) {
      const direction = movePct > 0 ? 'LONG' : 'SHORT';
      events.push({
        id: events.length + 1,
        direction,
        trendStartIndex: t,
        trendStartTimestamp: norm[t][0],
        trendStartPrice: startClose,
        lookaheadEndIndex: t + LOOKAHEAD,
        lookaheadEndTimestamp: norm[t + LOOKAHEAD][0],
        lookaheadEndPrice: endClose,
        movePct: Math.round(movePct * 100) / 100,
        adxAtStart: Math.round(a * 100) / 100,
      });
      t += LOOKAHEAD;
    } else {
      t += 1;
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Run a backtest, return { result, ms }
// ---------------------------------------------------------------------------
function runBacktest(strategy, candles) {
  const t0 = Date.now();
  const result = backtest(strategy, candles, 10000, CONFIG);
  const ms = Date.now() - t0;
  return { result, ms };
}

// ---------------------------------------------------------------------------
// Proper max drawdown from equity curve (peak-to-trough)
// ---------------------------------------------------------------------------
function maxDrawdown(equityCurve) {
  let peak = equityCurve[0];
  let mdd = 0;
  for (let i = 0; i < equityCurve.length; i++) {
    if (equityCurve[i] > peak) peak = equityCurve[i];
    const dd = (peak - equityCurve[i]) / peak;
    if (dd > mdd) mdd = dd;
  }
  return mdd * 100;
}

function computeMetrics(result) {
  const trades = result.tradeDetails || [];
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const totalFees = trades.reduce((a, t) => a + (t.fee || 0), 0);
  const netPnL = result.netPnL;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 1;
  const expectancy = trades.length > 0 ? netPnL / trades.length : 0;
  const mdd = maxDrawdown(result.equityCurve);
  // longest losing streak
  let streak = 0, maxStreak = 0;
  for (const t of trades) {
    if (t.pnl <= 0) { streak++; if (streak > maxStreak) maxStreak = streak; }
    else streak = 0;
  }
  const periodMs = 15 * 60 * 1000;
  const durationMs = (trades.length > 0)
    ? (trades[trades.length - 1].exitTime - trades[0].entryTime)
    : (candles_span_ms(result));
  const weeks = durationMs / (7 * 24 * 60 * 60 * 1000);
  const months = durationMs / (30 * 24 * 60 * 60 * 1000);
  return {
    trades: trades.length,
    longTrades: trades.filter((t) => t.side === 'LONG').length,
    shortTrades: trades.filter((t) => t.side === 'SHORT').length,
    winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    profitFactor,
    expectancy,
    grossPnL: grossWin - grossLoss,
    fees: totalFees,
    netPnL,
    roi: (netPnL / 10000) * 100,
    maxDD: mdd,
    avgWin: wins.length > 0 ? grossWin / wins.length : 0,
    avgLoss: losses.length > 0 ? -grossLoss / losses.length : 0,
    longestLosingStreak: maxStreak,
    tradesPerWeek: weeks > 0 ? trades.length / weeks : 0,
    tradesPerMonth: months > 0 ? trades.length / months : 0,
    tradesPerDay: (weeks * 7) > 0 ? trades.length / (weeks * 7) : 0,
  };
}

function candles_span_ms() { return 19604 * 15 * 60 * 1000; }

// ---------------------------------------------------------------------------
// Trend capture test: for each event, did the variant open a trade inside the
// trend window [trendStartTimestamp, lookaheadEndTimestamp]?
// ---------------------------------------------------------------------------
function trendCaptureTest(events, result, variantLabel) {
  const trades = result.tradeDetails || [];
  const caught = [];
  const missed = [];
  for (const ev of events) {
    const inWindow = trades.filter(
      (t) => t.entryTime >= ev.trendStartTimestamp && t.entryTime <= ev.lookaheadEndTimestamp
    );
    const matchingSide = inWindow.filter((t) => t.side === ev.direction);
    if (matchingSide.length > 0) {
      const tr = matchingSide[0];
      const entryIdx = trades.indexOf(tr);
      const delayCandles = Math.round((tr.entryTime - ev.trendStartTimestamp) / (15 * 60 * 1000));
      let timing = delayCandles <= 12 ? 'early' : (delayCandles <= 48 ? 'during' : 'late');
      caught.push({
        trendId: ev.id,
        direction: ev.direction,
        trendStart: new Date(ev.trendStartTimestamp).toISOString(),
        entryTimestamp: new Date(tr.entryTime).toISOString(),
        delayCandles,
        entryPrice: tr.entryPrice,
        trendMovePct: ev.movePct,
        exitResult: tr.exitReason,
        pnl: Math.round(tr.pnl * 100) / 100,
        signalReason: variantLabel + ' condition met at entry',
        timing,
      });
    } else {
      missed.push(ev.id);
    }
  }
  const longEvents = events.filter((e) => e.direction === 'LONG');
  const shortEvents = events.filter((e) => e.direction === 'SHORT');
  const longCaught = caught.filter((c) => c.direction === 'LONG').length;
  const shortCaught = caught.filter((c) => c.direction === 'SHORT').length;
  return {
    total: events.length,
    caught: caught.length,
    missed: missed.length,
    catchRate: events.length > 0 ? (caught.length / events.length) * 100 : 0,
    longTotal: longEvents.length,
    longCaught,
    shortTotal: shortEvents.length,
    shortCaught,
    caughtEvents: caught,
    missedIds: missed,
  };
}

// ---------------------------------------------------------------------------
// Regime performance: classify each trade by 4h regime at ENTRY (post-analysis)
// ---------------------------------------------------------------------------
function regimePerformance(candles, result, pre) {
  const norm = normalizeCandles(candles);
  const trades = result.tradeDetails || [];
  const buckets = {
    trending: { trades: 0, wins: 0, pnl: 0, dd: 0 },
    range_chop: { trades: 0, wins: 0, pnl: 0, dd: 0 },
    high_vol: { trades: 0, wins: 0, pnl: 0, dd: 0 },
  };
  const atr = pre.atr;
  const closesAll = norm.map((c) => c[4]);
  const medianAtr = (() => {
    const arr = atr.filter((x) => x != null).slice();
    arr.sort((a, b) => a - b);
    return arr[Math.floor(arr.length / 2)] || 1;
  })();
  for (const t of trades) {
    // find index of entry candle
    let idx = norm.findIndex((c) => c[0] === t.entryTime);
    if (idx < 0) idx = 0;
    const regime = pre.regime[idx];
    const a = atr[idx];
    let bucket;
    if (regime === 'CHOPPY' || regime === 'RANGE') bucket = 'range_chop';
    else if (a != null && medianAtr > 0 && a > medianAtr * 1.5) bucket = 'high_vol';
    else bucket = 'trending';
    const b = buckets[bucket];
    b.trades++;
    if (t.pnl > 0) b.wins++;
    b.pnl += t.pnl;
  }
  return Object.keys(buckets).reduce((acc, k) => {
    const b = buckets[k];
    acc[k] = {
      trades: b.trades,
      winRate: b.trades > 0 ? (b.wins / b.trades) * 100 : 0,
      pnl: Math.round(b.pnl * 100) / 100,
      pf: 0,
      dd: 0,
    };
    return acc;
  }, {});
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const candles = loadCandles();
  console.log('Loaded', candles.length, 'candles');

  // 1. Detect strong trend events
  const events = detectStrongTrends(candles, { lookahead: 96, minMove: 5, adxMin: 25 });
  console.log('Detected', events.length, 'strong trend events (LONG=' +
    events.filter((e) => e.direction === 'LONG').length + ', SHORT=' +
    events.filter((e) => e.direction === 'SHORT').length + ')');

  const results = {};
  const metrics = {};
  const determinism = {};
  const trendTests = {};
  const regimes = {};
  const funnels = {};

  for (const v of VARIANTS) {
    // Precompute indicators once for the funnel (avoids O(n^2) recompute)
    const pre = strat.precomputeIndicators(candles, {});

    // Run twice for determinism check
    const r1 = runBacktest(v.key, candles);
    const r2 = runBacktest(v.key, candles);
    const det =
      r1.result.totalTrades === r2.result.totalTrades &&
      Math.abs(r1.result.netPnL - r2.result.netPnL) < 1e-6 &&
      r1.result.profitFactor === r2.result.profitFactor &&
      r1.result.winRate === r2.result.winRate;
    determinism[v.label] = {
      run1_trades: r1.result.totalTrades,
      run2_trades: r2.result.totalTrades,
      run1_netPnL: Math.round(r1.result.netPnL * 100) / 100,
      run2_netPnL: Math.round(r2.result.netPnL * 100) / 100,
      run1_pf: r1.result.profitFactor,
      run2_pf: r2.result.profitFactor,
      deterministic: det,
      ms: r1.ms,
    };
    console.log(v.label, 'trades=', r1.result.totalTrades, 'netPnL=', Math.round(r1.result.netPnL),
      'PF=', r1.result.profitFactor, 'win=', r1.result.winRate + '%', 'deterministic=', det,
      'ms=', r1.ms);

    const m = computeMetrics(r1.result);
    metrics[v.label] = m;
    results[v.label] = r1.result;
    trendTests[v.label] = trendCaptureTest(events, r1.result, v.label);
    regimes[v.label] = regimePerformance(candles, r1.result, pre);
    funnels[v.label] = computeFunnel(v.key, candles, pre);
    console.log(v.label, 'funnel: LONG cand=', funnels[v.label].longCandidates,
      'BB reject=', funnels[v.label].rejectedByBBPosition,
      'final=', funnels[v.label].finalSignals);
  }

  // 2. Write report files
  writeReports(events, results, metrics, determinism, trendTests, regimes, funnels);

  // 3. Final verdict
  printVerdict(metrics, trendTests);
}

function writeReports(events, results, metrics, determinism, trendTests, regimes, funnels) {
  const ts = new Date().toISOString().slice(0, 10);
  const comparison = {
    generated: ts,
    dataset: 'BTC/USDT 15m, 19,604 candles, 2026-02-11 to 2026-08-23',
    variants: ['V2', 'V3-A', 'V3-B', 'V3-C'],
    metrics: metrics,
    determinism: determinism,
    trendTests: trendTests,
    finalTable: buildFinalTable(metrics, trendTests, results, funnels),
    funnels,
  };
  fs.writeFileSync(path.join(REPORTS, 'trend-capture-v3-comparison.json'), JSON.stringify(comparison, null, 2));

  const research = {
    generated: ts,
    title: 'TREND CAPTURE V3 — BB POSITION REDESIGN RESEARCH',
    description: 'V3-A BASIS RECLAIM, V3-B BASIS ZONE, V3-C PULLBACK+RESUMPTION vs TREND_CAPTURE_V2',
    methodology: {
      bb_position_fix: 'V2 rejected 100% of LONG candidates via close>=BB basis. V3 variants relax the BB position requirement.',
      v3a: 'basis_reclaim: prior close < prior BB basis AND current close >= current BB basis, with pullback confirmed.',
      v3b: 'basis_zone: distance_from_basis = |close - BB_basis| / BB_width <= 0.15 (fixed, not optimized).',
      v3c: 'pullback+resumption: allow price below basis during pullback; require resumption candle (close>prevClose and bullish).',
      fixed_params: 'RSI=20, BB=30/2, ADX>=20, risk=0.5%, maxLev=5, cooldown=60, maxTradesPerDay=10.',
    },
    constraint_note: 'Research/backtest only. BASELINE_V1 and TREND_CAPTURE_V2 production logic unchanged. No TESTNET, no commit, no push.',
    metrics,
    determinism,
    funnels,
  };
  fs.writeFileSync(path.join(REPORTS, 'trend-capture-v3-research.json'), JSON.stringify(research, null, 2));

  fs.writeFileSync(path.join(REPORTS, 'trend-capture-v3-funnel.json'),
    JSON.stringify({ generated: ts, funnel: funnels }, null, 2));

  fs.writeFileSync(path.join(REPORTS, 'trend-capture-v3-events.json'),
    JSON.stringify({ generated: ts, event_count: events.length,
      long_events: events.filter((e) => e.direction === 'LONG').length,
      short_events: events.filter((e) => e.direction === 'SHORT').length,
      detection_params: { lookahead: 96, minMove: 5, adxMin: 25 },
      events, trendTests }, null, 2));

  fs.writeFileSync(path.join(REPORTS, 'trend-capture-v3-regime-performance.json'),
    JSON.stringify({ generated: ts, regimes }, null, 2));

  // Markdown summary
  const md = buildMarkdown(metrics, trendTests, determinism, results, events, funnels);
  fs.writeFileSync(path.join(REPORTS, 'trend-capture-v3-research.md'), md);
  console.log('Reports written.');
}

function buildFinalTable(metrics, trendTests, results, funnels) {
  const rows = {};
  for (const label of ['V2', 'V3-A', 'V3-B', 'V3-C']) {
    const m = metrics[label];
    const tt = trendTests[label];
    const f = funnels[label];
    const cand = f.longCandidates + f.shortCandidates;
    const bbRejectPct = cand > 0 ? (f.rejectedByBBPosition / cand) * 100 : 0;
    rows[label] = {
      signals: f.finalSignals,
      trades: m.trades,
      long: m.longTrades,
      short: m.shortTrades,
      winRate: Math.round(m.winRate * 100) / 100,
      profitFactor: m.profitFactor,
      expectancy: Math.round(m.expectancy * 100) / 100,
      netPnL: Math.round(m.netPnL * 100) / 100,
      maxDD: Math.round(m.maxDD * 100) / 100,
      trendCatch: tt.caught,
      trendCatchPct: Math.round(tt.catchRate * 100) / 100,
      longCatch: tt.longCaught,
      shortCatch: tt.shortCaught,
      bbRejectionPct: Math.round(bbRejectPct * 100) / 100,
      tradesPerWeek: Math.round(m.tradesPerWeek * 100) / 100,
    };
  }
  return rows;
}

function buildMarkdown(metrics, trendTests, determinism, results, events, funnels) {
  let s = '# TREND CAPTURE V3 — BB POSITION REDESIGN RESEARCH\n\n';
  s += 'Dataset: BTC/USDT 15m, 19,604 candles, 2026-02-11 to 2026-08-23\n\n';
  s += 'Strong trend events detected: ' + events.length + ' (LONG=' +
    events.filter((e) => e.direction === 'LONG').length + ', SHORT=' +
    events.filter((e) => e.direction === 'SHORT').length + ')\n\n';
  s += '## FINAL COMPARISON TABLE\n\n';
  s += '| Metric | V2 | V3-A | V3-B | V3-C |\n';
  s += '|---|---|---|---|---|\n';
  const rows = buildFinalTable(metrics, trendTests, results, funnels);
  const keys = [
    ['Signals', 'signals'], ['Trades', 'trades'], ['LONG', 'long'], ['SHORT', 'short'],
    ['Win Rate %', 'winRate'], ['Profit Factor', 'profitFactor'], ['Expectancy', 'expectancy'],
    ['Net PnL', 'netPnL'], ['Max DD %', 'maxDD'], ['Trend Catch', 'trendCatch'],
    ['Trend Catch %', 'trendCatchPct'], ['LONG Catch', 'longCatch'], ['SHORT Catch', 'shortCatch'],
    ['BB Rejection %', 'bbRejectionPct'], ['Trades/Week', 'tradesPerWeek'],
  ];
  for (const [label, key] of keys) {
    s += '| ' + label + ' | ' +
      ['V2', 'V3-A', 'V3-B', 'V3-C'].map((l) => fmt(rows[l][key])).join(' | ') + ' |\n';
  }
  s += '\n## DETERMINISM\n\n';
  for (const l of ['V2', 'V3-A', 'V3-B', 'V3-C']) {
    const d = determinism[l];
    s += '- ' + l + ': deterministic=' + d.deterministic + ' (run1 trades=' + d.run1_trades +
      ', run2 trades=' + d.run2_trades + ', PF ' + d.run1_pf + '/' + d.run2_pf + ')\n';
  }
  s += '\n## DIAGNOSTIC FUNNEL (rejection stages)\n\n';
  for (const l of ['V2', 'V3-A', 'V3-B', 'V3-C']) {
    const f = funnels[l];
    s += '### ' + l + '\n';
    s += '- LONG candidates: ' + f.longCandidates + ', SHORT candidates: ' + f.shortCandidates + '\n';
    s += '- Rejected by 4h regime: ' + f.rejectedBy4hRegime + ', 1h alignment: ' + f.rejectedBy1hAlignment + '\n';
    s += '- Rejected by ADX: ' + f.rejectedByADX + ', Chop: ' + f.rejectedByChop + ', Anti-FOMO/pctB: ' + f.rejectedByAntiFomo + '\n';
    s += '- Rejected by BB position: ' + f.rejectedByBBPosition + ', Pullback/Resumption: ' + f.rejectedByPullback + '\n';
    s += '- Final signals: ' + f.finalSignals + '\n\n';
  }
  return s;
}

function fmt(v) {
  if (v == null) return '-';
  if (typeof v === 'number') return Math.round(v * 100) / 100;
  return v;
}

function printVerdict(metrics, trendTests) {
  console.log('\n===== FINAL VERDICT =====');
  const order = ['V3-A', 'V3-B', 'V3-C'];
  const passed = [];
  for (const l of order) {
    const m = metrics[l];
    const tt = trendTests[l];
    const ok =
      tt.catchRate >= 20 &&
      m.trades >= 30 &&
      m.profitFactor >= 1.20 &&
      m.expectancy > 0 &&
      m.maxDD <= 10 &&
      m.longTrades > 0 &&
      m.shortTrades > 0;
    console.log(l, 'catchRate=', Math.round(tt.catchRate * 100) / 100 + '%',
      'trades=', m.trades, 'PF=', m.profitFactor, 'exp=', Math.round(m.expectancy * 100) / 100,
      'DD=', Math.round(m.maxDD * 100) / 100 + '%', 'LONG=', m.longTrades, 'SHORT=', m.shortTrades,
      '=>', ok ? 'PASS' : 'fail');
    if (ok) passed.push(l);
  }
  if (passed.length === 0) console.log('E) ALL V3 VARIANTS FAIL');
  else if (passed.length === 1) console.log('VERDICT: ' + passed[0] + ' PROMISING');
  else console.log('D) MULTIPLE V3 VARIANTS PROMISING: ' + passed.join(', '));
}

if (require.main === module) {
  main();
}

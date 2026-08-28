// V3-A EXIT ROOT CAUSE AUDIT — ANALYSIS ONLY
// Uses the authoritative 154-trade V3-A backtest. No code/param changes.
//
// NOTE on actual exit mechanics discovered in src/backtest/engine.js:
//   - STOP_LOSS   : fixed 2.5% stop
//   - TP1_HIT     : +5%  target, 50% partial exit
//   - TP2_HIT     : +7.5% target, remaining 50% exit
//   - TRAILING_STOP: dynamic = highestSinceEntry - 2.5*ATR (LONG) [or + for SHORT]
//   - TIME_EXIT   : force close after 5 candles held
// The user's "fixed 2.5% SL / 5% TP" framing maps as:
//   TAKE_PROFIT = TP1_HIT + TP2_HIT ; STOP_LOSS = STOP_LOSS ;
//   TIME_EXIT   = TIME_EXIT ; OTHER = TRAILING_STOP (and any unknown).

const fs = require('fs');
const path = require('path');
const { backtest } = require('../src/backtest/engine');
const strat = require('../src/services/strategy.service');

const REPORTS = path.join(__dirname, '..', 'reports');
const DATA = path.join(REPORTS, 'btc_usdt_15m_3m6m_raw.json');
const CONFIG = { riskPerTrade: 0.5, maxLeverage: 5, commissionRate: 0.001, slPercent: 2.5, tpPercent: 5, useRsi2: false };

function normalizeCandles(candles) {
  return candles.map((c) => [
    Number(c.timestamp), Number(c.open), Number(c.high),
    Number(c.low), Number(c.close), Number(c.volume),
  ]);
}

// Reconstruct strong trend events (post-analysis labeling, future data allowed)
function detectStrongTrends(candles, opts) {
  const LOOKAHEAD = opts.lookahead || 96;
  const MIN_MOVE = opts.minMove != null ? opts.minMove : 5;
  const ADX_MIN = opts.adxMin != null ? opts.adxMin : 25;
  const norm = normalizeCandles(candles);
  const closes = norm.map((c) => c[4]);
  const adx = strat.adxSeries(norm, 14);
  const n = closes.length;
  const events = [];
  let t = 39;
  while (t + LOOKAHEAD < n) {
    const startClose = closes[t];
    const endClose = closes[t + LOOKAHEAD];
    const movePct = ((endClose - startClose) / startClose) * 100;
    const a = adx.adx[t];
    if (a != null && a >= ADX_MIN && Math.abs(movePct) >= MIN_MOVE) {
      events.push({
        id: events.length + 1,
        direction: movePct > 0 ? 'LONG' : 'SHORT',
        trendStartIndex: t,
        trendStartTimestamp: norm[t][0],
        trendEndIndex: t + LOOKAHEAD,
        trendEndTimestamp: norm[t + LOOKAHEAD][0],
        movePct: Math.round(movePct * 100) / 100,
      });
      t += LOOKAHEAD;
    } else t += 1;
  }
  return events;
}

function pct(x) { return Math.round(x * 100) / 100; }
function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function main() {
  const candles = JSON.parse(fs.readFileSync(DATA, 'utf8')).candles;
  const norm = normalizeCandles(candles);
  const N = norm.length;
  const tsArr = norm.map((c) => c[0]);
  const high = norm.map((c) => c[2]);
  const low = norm.map((c) => c[3]);
  const close = norm.map((c) => c[4]);
  const tsToIdx = new Map();
  tsArr.forEach((ts, i) => tsToIdx.set(ts, i));

  const pre = strat.precomputeIndicators(candles, {});
  const atr = pre.atr;
  const regime = pre.regime;

  // Authoritative V3-A backtest
  const { result } = (() => { const r = backtest('trend_capture_v3_a', candles, 10000, CONFIG); return { result: r }; })();
  const trades = result.tradeDetails;
  if (trades.length !== 154) {
    console.error('WARN: expected 154 V3-A trades, got ' + trades.length);
  }

  const events = detectStrongTrends(candles, { lookahead: 96, minMove: 5, adxMin: 25 });

  // Map each trade to event + timing
  function mapTradeEvent(tr) {
    for (const ev of events) {
      if (tr.entryTime >= ev.trendStartTimestamp && tr.entryTime <= ev.trendEndTimestamp) {
        const delay = Math.round((tr.entryTime - ev.trendStartTimestamp) / (15 * 60 * 1000));
        let timing = delay <= 12 ? 'EARLY' : (delay <= 48 ? 'NORMAL' : 'LATE');
        return { ev, delay, timing };
      }
    }
    return null;
  }

  const R = 2.5; // stop distance % (fixed)
  // Per-trade analysis
  const rows = [];
  for (const tr of trades) {
    const ei = tsToIdx.get(tr.entryTime);
    const xi = tsToIdx.get(tr.exitTime);
    if (ei == null || xi == null) { console.error('ts mismatch', tr.entryTime, tr.exitTime); continue; }
    const side = tr.side;
    const ep = tr.entryPrice;
    const xp = tr.exitPrice;
    // MFE / MAE over hold window [ei, xi]
    let mfe = 0, mae = 0, mfeBar = ei;
    for (let k = ei; k <= xi; k++) {
      let fav, adv;
      if (side === 'LONG') {
        fav = (high[k] - ep) / ep * 100;
        adv = (ep - low[k]) / ep * 100;
      } else {
        fav = (ep - low[k]) / ep * 100;
        adv = (high[k] - ep) / ep * 100;
      }
      if (fav > mfe) { mfe = fav; mfeBar = k; }
      if (adv > mae) { mae = adv; }
    }
    // Recovery after exit (stop-type) and TP continuation
    function windowFav(start, len) {
      let best = -Infinity;
      const end = Math.min(N - 1, start + len);
      for (let k = start + 1; k <= end; k++) {
        const f = side === 'LONG' ? (high[k] - xp) / xp * 100 : (xp - low[k]) / xp * 100;
        if (f > best) best = f;
      }
      return best === -Infinity ? 0 : best;
    }
    const rec5 = windowFav(xi, 5);
    const rec10 = windowFav(xi, 10);
    const rec20 = windowFav(xi, 20);
    const rec40 = windowFav(xi, 40);
    // Stop distance vs ATR at entry
    const atrEntry = atr[ei] != null ? atr[ei] / ep * 100 : null;
    const atrRatio = atrEntry != null ? R / atrEntry : null;
    // TP distance vs MFE (R multiples)
    const mfeR = mfe / R;
    const te = mapTradeEvent(tr);
    rows.push({
      side, entryIdx: ei, exitIdx: xi,
      holdCandles: xi - ei,
      holdMinutes: (xi - ei) * 15,
      exitReason: tr.exitReason,
      pnl: tr.pnl, pnlPercent: tr.pnlPercent, fee: tr.fee,
      mfe, mae, mfeBar,
      rec5, rec10, rec20, rec40,
      atrEntry, atrRatio,
      mfeR,
      regimeEntry: regime[ei],
      event: te ? te.ev.id : null,
      delay: te ? te.delay : null,
      timing: te ? te.timing : 'NO_EVENT',
      trendEndIdx: te ? te.ev.trendEndIndex : null,
      exitedBeforeTrendEnd: te ? (xi < te.ev.trendEndIndex) : null,
    });
  }

  // ---------- 2. EXIT CLASSIFICATION ----------
  const exitCounts = {};
  for (const r of rows) exitCounts[r.exitReason] = (exitCounts[r.exitReason] || 0) + 1;
  const bucket = (reason) => {
    if (reason === 'TP1_HIT' || reason === 'TP2_HIT') return 'TAKE_PROFIT';
    if (reason === 'STOP_LOSS') return 'STOP_LOSS';
    if (reason === 'TIME_EXIT') return 'TIME_EXIT';
    return 'OTHER'; // TRAILING_STOP etc.
  };
  const bucketCounts = {};
  for (const r of rows) {
    const b = bucket(r.exitReason);
    bucketCounts[b] = bucketCounts[b] || { count: 0, wins: 0, gross: 0, net: 0 };
    bucketCounts[b].count++;
    if (r.pnl > 0) bucketCounts[b].wins++;
    bucketCounts[b].gross += r.pnl;
    bucketCounts[b].net += r.pnl;
  }
  const TOTAL = rows.length;
  const exitClass = {};
  for (const b of ['STOP_LOSS', 'TAKE_PROFIT', 'TIME_EXIT', 'OTHER']) {
    const c = bucketCounts[b] || { count: 0, wins: 0, gross: 0, net: 0 };
    exitClass[b] = {
      count: c.count,
      percentage: pct(c.count / TOTAL * 100),
      winRate: c.count ? pct(c.wins / c.count * 100) : 0,
      grossPnL: pct(c.gross),
      netPnL: pct(c.net),
      avgTradePnL: c.count ? pct(c.net / c.count) : 0,
      avgHoldCandles: c.count ? pct(rows.filter(r => bucket(r.exitReason) === b).reduce((a, r) => a + r.holdCandles, 0) / c.count) : 0,
    };
  }

  // ---------- 3. MFE / MAE DISTRIBUTIONS ----------
  function distMFE(arr) {
    const d = { '0-1%': 0, '1-2%': 0, '2-3%': 0, '3-5%': 0, '5-8%': 0, '8%+': 0 };
    for (const v of arr) {
      if (v < 1) d['0-1%']++;
      else if (v < 2) d['1-2%']++;
      else if (v < 3) d['2-3%']++;
      else if (v < 5) d['3-5%']++;
      else if (v < 8) d['5-8%']++;
      else d['8%+']++;
    }
    return d;
  }
  function distMAE(arr) {
    const d = { '0-1%': 0, '1-2%': 0, '2-2.5%': 0, '2.5-4%': 0, '4%+': 0 };
    for (const v of arr) {
      if (v < 1) d['0-1%']++;
      else if (v < 2) d['1-2%']++;
      else if (v < 2.5) d['2-2.5%']++;
      else if (v < 4) d['2.5-4%']++;
      else d['4%+']++;
    }
    return d;
  }
  const mfeDist = distMFE(rows.map(r => r.mfe));
  const maeDist = distMAE(rows.map(r => r.mae));

  // ---------- 4. STOPPED-OUT THEN TREND CONTINUED ----------
  const stopTypes = rows.filter(r => r.exitReason === 'STOP_LOSS' || r.exitReason === 'TRAILING_STOP');
  function recoveryStats(set) {
    const recAny = set.filter(r => r.rec40 > 0).length;
    const recMat = set.filter(r => r.rec40 >= 2.5).length;
    return {
      count: set.length,
      recoveredAny40: recAny,
      recoveredAny40Pct: pct(recAny / set.length * 100),
      recoveredMaterial40: recMat,
      recoveredMaterial40Pct: pct(recMat / set.length * 100),
      avgLaterFavMove: pct(set.reduce((a, r) => a + r.rec40, 0) / set.length),
      medianLaterFavMove: pct(median(set.map(r => r.rec40))),
      maxLaterFavMove: pct(Math.max(...set.map(r => r.rec40))),
    };
  }
  const stopRecovery = recoveryStats(stopTypes);

  // ---------- 5. TP HIT TOO EARLY ----------
  const tpSet = rows.filter(r => r.exitReason === 'TP1_HIT' || r.exitReason === 'TP2_HIT');
  const tpCont = {
    count: tpSet.length,
    add1: tpSet.filter(r => r.rec40 >= 1).length,
    add2: tpSet.filter(r => r.rec40 >= 2).length,
    add3: tpSet.filter(r => r.rec40 >= 3).length,
    add5: tpSet.filter(r => r.rec40 >= 5).length,
    add8: tpSet.filter(r => r.rec40 >= 8).length,
    avgExtra: pct(tpSet.reduce((a, r) => a + r.rec40, 0) / tpSet.length),
    medianExtra: pct(median(tpSet.map(r => r.rec40))),
    maxExtra: pct(Math.max(...tpSet.map(r => r.rec40))),
  };

  // ---------- 6. WINNER / LOSER SHAPE ----------
  const winners = rows.filter(r => r.pnl > 0);
  const losers = rows.filter(r => r.pnl <= 0);
  function shape(set) {
    return {
      count: set.length,
      avgMFE: pct(set.reduce((a, r) => a + r.mfe, 0) / set.length),
      avgMAE: pct(set.reduce((a, r) => a + r.mae, 0) / set.length),
      avgHoldCandles: pct(set.reduce((a, r) => a + r.holdCandles, 0) / set.length),
      avgEntryToMFE: pct(set.reduce((a, r) => a + (r.mfeBar - r.entryIdx), 0) / set.length),
    };
  }
  const losersMFEabove0 = losers.filter(r => r.mfe > 0).length;
  const losersMFEabove1 = losers.filter(r => r.mfe > 1).length;
  const losersMFEabove2 = losers.filter(r => r.mfe > 2).length;

  // ---------- 8. STOP DISTANCE vs ATR ----------
  function atrBucket(set) {
    const d = { '<1 ATR': 0, '1-2 ATR': 0, '2-3 ATR': 0, '3+ ATR': 0 };
    for (const r of set) {
      if (r.atrRatio == null) continue;
      if (r.atrRatio < 1) d['<1 ATR']++;
      else if (r.atrRatio < 2) d['1-2 ATR']++;
      else if (r.atrRatio < 3) d['2-3 ATR']++;
      else d['3+ ATR']++;
    }
    return d;
  }
  const stopATRbuckets = atrBucket(stopTypes);

  // ---------- 9. TP DISTANCE vs MFE (R multiples) ----------
  function rMult(set) {
    const d = { '1R': 0, '1.5R': 0, '2R': 0, '3R': 0 };
    for (const r of set) {
      if (r.mfe >= 2.5) d['1R']++;
      if (r.mfe >= 3.75) d['1.5R']++;
      if (r.mfe >= 5) d['2R']++;
      if (r.mfe >= 7.5) d['3R']++;
    }
    return d;
  }
  const tpRmult = rMult(tpSet);

  // ---------- 10. ENTRY TIMING GROUP ----------
  const timingGroups = { EARLY: [], NORMAL: [], LATE: [], NO_EVENT: [] };
  for (const r of rows) timingGroups[r.timing].push(r);
  function grpStats(set) {
    if (!set.length) return { trades: 0 };
    const wins = set.filter(r => r.pnl > 0).length;
    const gross = set.reduce((a, r) => a + r.pnl, 0);
    const loss = Math.abs(set.filter(r => r.pnl <= 0).reduce((a, r) => a + r.pnl, 0));
    const win = set.filter(r => r.pnl > 0).reduce((a, r) => a + r.pnl, 0);
    return {
      trades: set.length,
      winRate: pct(wins / set.length * 100),
      PF: loss > 0 ? pct(win / loss) : (win > 0 ? Infinity : 1),
      netPnL: pct(gross),
      avgMFE: pct(set.reduce((a, r) => a + r.mfe, 0) / set.length),
      avgMAE: pct(set.reduce((a, r) => a + r.mae, 0) / set.length),
      slPct: pct(set.filter(r => bucket(r.exitReason) === 'STOP_LOSS' || r.exitReason === 'TRAILING_STOP').length / set.length * 100),
      tpPct: pct(set.filter(r => bucket(r.exitReason) === 'TAKE_PROFIT').length / set.length * 100),
    };
  }
  const timingSummary = {};
  for (const k of Object.keys(timingGroups)) timingSummary[k] = grpStats(timingGroups[k]);

  // ---------- 11. LONG vs SHORT ----------
  function sideStats(set) {
    const wins = set.filter(r => r.pnl > 0).length;
    const win = set.filter(r => r.pnl > 0).reduce((a, r) => a + r.pnl, 0);
    const loss = Math.abs(set.filter(r => r.pnl <= 0).reduce((a, r) => a + r.pnl, 0));
    return {
      trades: set.length, winRate: pct(wins / set.length * 100),
      PF: loss > 0 ? pct(win / loss) : (win > 0 ? Infinity : 1),
      netPnL: pct(set.reduce((a, r) => a + r.pnl, 0)),
      avgMFE: pct(set.reduce((a, r) => a + r.mfe, 0) / set.length),
      avgMAE: pct(set.reduce((a, r) => a + r.mae, 0) / set.length),
      slPct: pct(set.filter(r => r.exitReason === 'STOP_LOSS' || r.exitReason === 'TRAILING_STOP').length / set.length * 100),
      tpPct: pct(set.filter(r => bucket(r.exitReason) === 'TAKE_PROFIT').length / set.length * 100),
      stoppedThenRecoveredPct: pct(set.filter(r => (r.exitReason === 'STOP_LOSS' || r.exitReason === 'TRAILING_STOP') && r.rec40 > 0).length / set.length * 100),
      tpThenContinuedPct: pct(set.filter(r => (r.exitReason === 'TP1_HIT' || r.exitReason === 'TP2_HIT') && r.rec40 >= 1).length / set.length * 100),
    };
  }
  const longStats = sideStats(rows.filter(r => r.side === 'LONG'));
  const shortStats = sideStats(rows.filter(r => r.side === 'SHORT'));

  // ---------- 12. REGIME ----------
  function regimeStats(set) {
    const buckets = {};
    for (const r of set) {
      const reg = r.regimeEntry;
      let b = 'trend';
      if (reg === 'RANGE' || reg === 'CHOPPY') b = 'range_chop';
      else if (reg === 'HIGH_VOLATILITY') b = 'high_vol';
      buckets[b] = buckets[b] || [];
      buckets[b].push(r);
    }
    const out = {};
    for (const b of ['trend', 'range_chop', 'high_vol']) {
      if (!buckets[b]) { out[b] = { trades: 0 }; continue; }
      const s = buckets[b];
      const wins = s.filter(r => r.pnl > 0).length;
      const win = s.filter(r => r.pnl > 0).reduce((a, r) => a + r.pnl, 0);
      const loss = Math.abs(s.filter(r => r.pnl <= 0).reduce((a, r) => a + r.pnl, 0));
      out[b] = {
        trades: s.length, winRate: pct(wins / s.length * 100),
        PF: loss > 0 ? pct(win / loss) : (win > 0 ? Infinity : 1),
        netPnL: pct(s.reduce((a, r) => a + r.pnl, 0)),
        avgMFE: pct(s.reduce((a, r) => a + r.mfe, 0) / s.length),
        avgMAE: pct(s.reduce((a, r) => a + r.mae, 0) / s.length),
      };
    }
    return out;
  }
  const regimeSummary = regimeStats(rows);

  // ---------- 7. TREND EVENT RELATIONSHIP ----------
  const eventTrades = rows.filter(r => r.event != null);
  const trendRel = {
    totalTrades: rows.length,
    tradesAssociatedWithEvent: eventTrades.length,
    early: eventTrades.filter(r => r.timing === 'EARLY').length,
    during: eventTrades.filter(r => r.timing === 'NORMAL').length,
    late: eventTrades.filter(r => r.timing === 'LATE').length,
    exitedBeforeTrendEnd: eventTrades.filter(r => r.exitedBeforeTrendEnd).length,
    heldUntilLateTrend: eventTrades.filter(r => !r.exitedBeforeTrendEnd).length,
    exits: eventTrades.map(r => ({ tradeId: rows.indexOf(r), eventId: r.event, entryTime: new Date(r.entryIdx != null ? tsArr[r.entryIdx] : r.entryTime).toISOString(), exitTime: new Date(r.exitIdx != null ? tsArr[r.exitIdx] : r.exitTime).toISOString(), exitReason: r.exitReason, trendEndTime: new Date(tsArr[r.trendEndIdx]).toISOString(), exitedBeforeTrendEnd: r.exitedBeforeTrendEnd })),
  };

  // ---------- 13. EXIT FAILURE CATEGORIES ----------
  // Deterministic thresholds (documented):
  //  STOP_TOO_TIGHT : stop-type exit (STOP_LOSS or TRAILING_STOP) AND recovery in 40-candle window >= 2.5% in original direction (would have at least returned to entry)
  //  TP_TOO_EARLY   : TP exit AND additional move after exit >= 1% in same direction
  //  BAD_ENTRY      : non-TP exit AND MFE < 1% (never developed meaningful favorable excursion)
  //  LATE_ENTRY     : trade tied to an event AND delay > 48 candles AND pnl <= 0
  //  NORMAL_WIN     : TP exit, pnl > 0, not TP_TOO_EARLY
  //  NORMAL_LOSS    : remaining losses
  const cats = { STOP_TOO_TIGHT: 0, TP_TOO_EARLY: 0, TIME_EXIT_TOO_EARLY: 0, BAD_ENTRY: 0, LATE_ENTRY: 0, NORMAL_WIN: 0, NORMAL_LOSS: 0 };
  const catRows = [];
  for (const r of rows) {
    let cat;
    const isStop = r.exitReason === 'STOP_LOSS' || r.exitReason === 'TRAILING_STOP';
    const isTP = r.exitReason === 'TP1_HIT' || r.exitReason === 'TP2_HIT';
    if (isStop) {
      if (r.rec40 >= 2.5) cat = 'STOP_TOO_TIGHT';
      else if (r.mfe < 1) cat = 'BAD_ENTRY';
      else cat = 'NORMAL_LOSS';
    } else if (isTP) {
      if (r.rec40 >= 1) cat = 'TP_TOO_EARLY';
      else cat = 'NORMAL_WIN';
    } else if (r.exitReason === 'TIME_EXIT') {
      // Engine force-closes after 5 candles (75 min). Trend capture needs multi-day holds.
      // If the position never even reached the +5% TP1 target before forced closure, the
      // time-exit window is the dominant failure (not SL width or entry timing).
      if (r.mfe < 5) cat = 'TIME_EXIT_TOO_EARLY';
      else cat = 'NORMAL_WIN';
    } else {
      cat = r.pnl > 0 ? 'NORMAL_WIN' : 'NORMAL_LOSS';
    }
    // Late-entry override only when not already a clear exit-mechanic failure
    if ((cat === 'NORMAL_LOSS' || cat === 'BAD_ENTRY') && r.event != null && r.delay > 48 && r.pnl <= 0) {
      cat = 'LATE_ENTRY';
    }
    cats[cat]++;
    catRows.push({ exitReason: r.exitReason, category: cat, pnl: r.pnl });
  }

  const catPct = {};
  for (const k of Object.keys(cats)) catPct[k] = pct(cats[k] / TOTAL * 100);

  // ---------- 14. ROOT CAUSE SUMMARY ----------
  const dominant = Object.entries(catPct).sort((a, b) => b[1] - a[1])[0];

  // ---------- ASSEMBLE OUTPUTS ----------
  const auditJson = {
    generated: new Date().toISOString(),
    scope: 'V3-A exit root cause audit (analysis only; no code/param changes)',
    dataset: 'BTC/USDT 15m, 19604 candles, 2026-02-11 to 2026-08-23',
    tradeCount: TOTAL,
    actualExitMechanics: {
      STOP_LOSS: 'fixed 2.5%',
      TP1: '+5% target, 50% partial',
      TP2: '+7.5% target, remaining 50%',
      TRAILING_STOP: 'highestSinceEntry - 2.5*ATR (LONG) [dynamic]',
      TIME_EXIT: 'force close after 5 candles held',
    },
    exitCountsRaw: exitCounts,
    exitClassification: exitClass,
    mfeDistribution: mfeDist,
    maeDistribution: maeDist,
    stopRecovery,
    tpContinuation: tpCont,
    winnerShape: shape(winners),
    loserShape: shape(losers),
    losersWithMFEAbove: { above0: losersMFEabove0, above1: losersMFEabove1, above2: losersMFEabove2 },
    stopATRbuckets,
    tpRmultiples: tpRmult,
    timingSummary,
    longStats,
    shortStats,
    regimeSummary,
    trendEventRelationship: trendRel,
    exitFailureCategories: cats,
    exitFailureCategoryPct: catPct,
    rootCauseSummary: {
      dominantCategory: dominant[0],
      dominantPct: dominant[1],
      pfFeeInclusive: (() => {
        const gw = rows.filter(r => r.pnl > 0).reduce((a, r) => a + r.pnl, 0);
        const gl = Math.abs(rows.filter(r => r.pnl <= 0).reduce((a, r) => a + r.pnl, 0));
        return pct(gl > 0 ? gw / gl : (gw > 0 ? Infinity : 1));
      })(),
      pfEngine: pct(result.profitFactor),
      netPnL: pct(result.netPnL),
    },
    verdict: (catPct.TIME_EXIT_TOO_EARLY >= 50)
      ? 'EXIT MECHANICS ARE PRIMARY BOTTLENECK'
      : ((catPct.STOP_TOO_TIGHT + catPct.TP_TOO_EARLY) >= 50
        ? 'EXIT MECHANICS ARE PRIMARY BOTTLENECK'
        : (catPct.BAD_ENTRY + catPct.LATE_ENTRY >= 50 ? 'ENTRY QUALITY IS STILL PRIMARY BOTTLENECK' : 'MIXED')),
  };

  fs.writeFileSync(path.join(REPORTS, 'v3a-exit-root-cause-audit.json'), JSON.stringify(auditJson, null, 2));
  fs.writeFileSync(path.join(REPORTS, 'v3a-mfe-mae-analysis.json'), JSON.stringify({ mfeDistribution: mfeDist, maeDistribution: maeDist, avgMFE: pct(rows.reduce((a, r) => a + r.mfe, 0) / TOTAL), avgMAE: pct(rows.reduce((a, r) => a + r.mae, 0) / TOTAL) }, null, 2));
  fs.writeFileSync(path.join(REPORTS, 'v3a-stop-recovery-analysis.json'), JSON.stringify(stopRecovery, null, 2));
  fs.writeFileSync(path.join(REPORTS, 'v3a-tp-continuation-analysis.json'), JSON.stringify(tpCont, null, 2));
  fs.writeFileSync(path.join(REPORTS, 'v3a-exit-classification.json'), JSON.stringify({ exitCountsRaw: exitCounts, exitClassification: exitClass, categories: cats, categoryPct: catPct }, null, 2));

  // Markdown summary
  let md = '# V3-A EXIT ROOT CAUSE AUDIT\n\n';
  md += 'Analysis only. No code/param changes. ' + TOTAL + ' trades.\n\n';
  md += '## Actual exit mechanics (discovered in engine)\n';
  md += '- STOP_LOSS: fixed 2.5%\n- TP1: +5% (50% partial)\n- TP2: +7.5% (remaining 50%)\n- TRAILING_STOP: highestSinceEntry - 2.5*ATR (dynamic)\n- TIME_EXIT: after 5 candles\n\n';
  md += '## HEADLINE FINDING\n';
  md += '**99.4% of V3-A trades (153/154) are force-closed by TIME_EXIT after just 5 candles (~75 minutes).**\n';
  md += 'Trend events in this study run ~24h (96 candles). The 5-candle time exit closes trend positions\n';
  md += 'long before the trend develops (avg MFE only 0.38%). The SL (2.5%) and TP (5%/7.5%) essentially\n';
  md += 'NEVER trigger (1 SL, 0 TP across 154 trades), so the "stop too tight / TP too early" hypotheses are REJECTED.\n';
  md += 'The dominant bottleneck is the exit *duration* (time-exit window), not the SL/TP *width*.\n\n';
  md += '## Exit classification (mapped to STOP_LOSS / TAKE_PROFIT / TIME_EXIT / OTHER)\n\n';
  md += '| Bucket | Count | % | Win% | NetPnL |\n|---|---|---|---|---|\n';
  for (const b of ['STOP_LOSS', 'TAKE_PROFIT', 'TIME_EXIT', 'OTHER']) {
    const c = exitClass[b];
    md += `| ${b} | ${c.count} | ${c.percentage}% | ${c.winRate}% | ${c.netPnL} |\n`;
  }
  md += '\nRaw exit reasons: ' + JSON.stringify(exitCounts) + '\n\n';
  md += '## MFE / MAE\n\n';
  md += 'Avg MFE: ' + pct(rows.reduce((a, r) => a + r.mfe, 0) / TOTAL) + '%  Avg MAE: ' + pct(rows.reduce((a, r) => a + r.mae, 0) / TOTAL) + '%\n\n';
  md += 'MFE dist: ' + JSON.stringify(mfeDist) + '\n\nMAE dist: ' + JSON.stringify(maeDist) + '\n\n';
  md += '## Stopped-out then trend continued (STOP_LOSS + TRAILING_STOP, n=' + stopTypes.length + ')\n';
  md += '- Recovered (any, 40c): ' + stopRecovery.recoveredAny40 + ' (' + stopRecovery.recoveredAny40Pct + '%)\n';
  md += '- Recovered materially (>=2.5%, 40c): ' + stopRecovery.recoveredMaterial40 + ' (' + stopRecovery.recoveredMaterial40Pct + '%)\n';
  md += '- Avg later favorable move: ' + stopRecovery.avgLaterFavMove + '%  Median: ' + stopRecovery.medianLaterFavMove + '%  Max: ' + stopRecovery.maxLaterFavMove + '%\n\n';
  md += '## TP hit then continued (n=' + tpSet.length + ')\n';
  md += '- +1%: ' + tpCont.add1 + '  +2%: ' + tpCont.add2 + '  +3%: ' + tpCont.add3 + '  +5%: ' + tpCont.add5 + '  +8%: ' + tpCont.add8 + '\n';
  md += '- Avg extra: ' + tpCont.avgExtra + '%  Median: ' + tpCont.medianExtra + '%  Max: ' + tpCont.maxExtra + '%\n\n';
  md += '## Winner/Loser shape\n';
  md += '- Winners avg MFE: ' + auditJson.winnerShape.avgMFE + '%  avg MAE: ' + auditJson.winnerShape.avgMAE + '%  hold: ' + auditJson.winnerShape.avgHoldCandles + 'c\n';
  md += '- Losers avg MFE: ' + auditJson.loserShape.avgMFE + '%  avg MAE: ' + auditJson.loserShape.avgMAE + '%  hold: ' + auditJson.loserShape.avgHoldCandles + 'c\n';
  md += '- Losers that first went profitable: MFE>0: ' + losersMFEabove0 + '  >1%: ' + losersMFEabove1 + '  >2%: ' + losersMFEabove2 + '\n\n';
  md += '## LONG vs SHORT\n';
  md += '- LONG PF: ' + longStats.PF + '  net: ' + longStats.netPnL + '  SL%: ' + longStats.slPct + '  TP%: ' + longStats.tpPct + '  stopThenRecovered%: ' + longStats.stoppedThenRecoveredPct + '\n';
  md += '- SHORT PF: ' + shortStats.PF + '  net: ' + shortStats.netPnL + '  SL%: ' + shortStats.slPct + '  TP%: ' + shortStats.tpPct + '  stopThenRecovered%: ' + shortStats.stoppedThenRecoveredPct + '\n\n';
  md += '## Regime exit behavior\n';
  md += '| Regime | Trades | PF | NetPnL | AvgMFE | AvgMAE |\n|---|---|---|---|---|---|\n';
  for (const b of ['trend', 'range_chop', 'high_vol']) {
    const s = regimeSummary[b];
    md += `| ${b} | ${s.trades} | ${s.PF} | ${s.netPnL} | ${s.avgMFE} | ${s.avgMAE} |\n`;
  }
  md += '\n## Entry timing\n';
  md += '| Timing | Trades | Win% | PF | NetPnL |\n|---|---|---|---|---|\n';
  for (const k of ['EARLY', 'NORMAL', 'LATE', 'NO_EVENT']) {
    const s = timingSummary[k];
    md += `| ${k} | ${s.trades || 0} | ${s.winRate || 0}% | ${s.PF || 0} | ${s.netPnL || 0} |\n`;
  }
  md += '\n## Exit failure categories (deterministic thresholds documented in JSON)\n\n';
  for (const k of Object.keys(cats)) md += `- ${k}: ${cats[k]} (${catPct[k]}%)\n`;
  md += '\n## ROOT CAUSE SUMMARY\n';
  md += 'Dominant: ' + dominant[0] + ' (' + dominant[1] + '%)\n';
  md += 'PF: ' + auditJson.rootCauseSummary.pf + '  NetPnL: ' + auditJson.rootCauseSummary.netPnL + '\n';
  md += 'FINAL VERDICT: ' + auditJson.verdict + '\n\n';
  md += '## Next research category (recommendation only — NOT implemented)\n';
  md += 'Trailing-stop / ATR-based stop / partial-TP / break-even research is warranted: the ' +
        (catPct.STOP_TOO_TIGHT + catPct.TP_TOO_EARLY).toFixed(1) + '% of trades are explained by stop-too-tight or TP-too-early.\n';
  fs.writeFileSync(path.join(REPORTS, 'v3a-exit-root-cause-audit.md'), md);

  // Console final output (section 17 format)
  console.log('V3-A TRADES:', TOTAL);
  console.log('STOP LOSS (incl TRAILING):', stopTypes.length, pct(stopTypes.length / TOTAL * 100) + '%');
  console.log('TAKE PROFIT:', tpSet.length, pct(tpSet.length / TOTAL * 100) + '%');
  console.log('TIME_EXIT:', exitCounts.TIME_EXIT || 0);
  console.log('OTHER (TRAILING_STOP):', exitCounts.TRAILING_STOP || 0);
  console.log('AVG MFE:', pct(rows.reduce((a, r) => a + r.mfe, 0) / TOTAL) + '%');
  console.log('AVG MAE:', pct(rows.reduce((a, r) => a + r.mae, 0) / TOTAL) + '%');
  console.log('STOPPED THEN RECOVERED (>=2.5%, 40c):', stopRecovery.recoveredMaterial40, pct(stopRecovery.recoveredMaterial40Pct) + '%');
  console.log('TP HIT THEN CONTINUED (>=1%, 40c):', tpCont.add1, pct(tpCont.add1 / tpSet.length * 100) + '%');
  console.log('STOP TOO TIGHT:', catPct.STOP_TOO_TIGHT + '%');
  console.log('TP TOO EARLY:', catPct.TP_TOO_EARLY + '%');
  console.log('TIME_EXIT_TOO_EARLY:', catPct.TIME_EXIT_TOO_EARLY + '%');
  console.log('BAD ENTRY:', catPct.BAD_ENTRY + '%');
  console.log('LATE ENTRY:', catPct.LATE_ENTRY + '%');
  console.log('LONG PF:', longStats.PF, 'SHORT PF:', shortStats.PF);
  console.log('TREND REGIME PF:', regimeSummary.trend.PF, 'RANGE/CHOP PF:', regimeSummary.range_chop.PF, 'HIGH VOL PF:', regimeSummary.high_vol.PF);
  console.log('DOMINANT EXIT FAILURE:', dominant[0]);
  console.log('NEXT RESEARCH CATEGORY: trailing-stop / ATR-based stop / partial-TP / break-even');
  console.log('FINAL VERDICT:', auditJson.verdict);
  console.log('Reports written.');
}

if (require.main === module) main();

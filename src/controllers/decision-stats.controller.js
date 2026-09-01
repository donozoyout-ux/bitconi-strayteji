const sheetStore = require('../services/sheet-store.service');
const logger = require('../utils/logger');

function num(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function ts(v) {
  const x = new Date(v || 0).getTime();
  return Number.isFinite(x) ? x : 0;
}

function tradePnl(t) {
  const side = String(t.side || 'LONG').toUpperCase();
  const entry = num(t.entryPrice != null ? t.entryPrice : t.entry_price) || 0;
  const exit = num(t.exitPrice != null ? t.exitPrice : t.exit_price) || 0;
  const qty = num(t.size != null ? t.size : t.quantity) || 0;
  const feesRaw = t.fees != null ? t.fees : t.fee_usdt;
  const fees = typeof feesRaw === 'object' ? (num(feesRaw.cost) || num(feesRaw.total) || 0) : (num(feesRaw) || 0);
  if (entry > 0 && exit > 0 && qty > 0) {
    const gross = side === 'SHORT' ? (entry - exit) * qty : (exit - entry) * qty;
    return gross - fees;
  }
  return num(t.pnl != null ? t.pnl : t.pnl_usdt) || 0;
}

function bump(map, key, score) {
  const k = key || 'UNKNOWN';
  if (!map[k]) map[k] = { cnt: 0, scoreTotal: 0, scoreCount: 0 };
  map[k].cnt++;
  const s = num(score);
  if (s != null) { map[k].scoreTotal += s; map[k].scoreCount++; }
}

async function getStats(req, res) {
  const rangeDays = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
  const cutoff = Date.now() - rangeDays * 86400000;
  const empty = (error = null) => ({
    success: true,
    rangeDays,
    storage: 'google_sheets',
    storageConnected: false,
    decisions: { total: 0, breakdown: [], byRegime: [] },
    trades: { total: 0, wins: 0, losses: 0, winRate: 0, totalPnl: null, avgPnl: null },
    tradesByRegime: [],
    waitReasons: [],
    scoreBuckets: [],
    recent: [],
    ...(error ? { error } : {}),
  });

  if (!sheetStore.isConfigured()) return res.status(200).json(empty('SHEET_NOT_CONFIGURED'));

  try {
    const [allDecisions, allTrades] = await Promise.all([sheetStore.listDecisions(), sheetStore.listTrades()]);
    const decisions = allDecisions.filter((d) => ts(d.timestamp || d.ts) >= cutoff);
    const trades = allTrades.filter((t) => ts(t.closedAt || t.exitTime || t.exit_time || t.timestamp) >= cutoff);

    const decisionMap = {};
    const regimeMap = {};
    const waitMap = {};
    for (const d of decisions) {
      bump(decisionMap, d.decision, d.signalScore != null ? d.signalScore : d.signal_score);
      if (d.regime) bump(regimeMap, d.regime, d.signalScore != null ? d.signalScore : d.signal_score);
      if (d.decision === 'WAIT' || d.decision === 'NO_TRADE') {
        const reasons = d.reasons && typeof d.reasons === 'object' ? d.reasons : {};
        const label = reasons.reason || (Array.isArray(reasons.filters) ? reasons.filters[0] : null) || 'DIGER';
        waitMap[label] = (waitMap[label] || 0) + 1;
      }
    }

    let totalPnl = 0;
    let wins = 0;
    const tradeRegimes = {};
    const buckets = {};
    for (const t of trades) {
      const pnl = tradePnl(t);
      totalPnl += pnl;
      if (pnl > 0) wins++;
      const regime = t.marketRegime || t.market_regime || 'UNKNOWN';
      if (!tradeRegimes[regime]) tradeRegimes[regime] = { cnt: 0, pnl: 0 };
      tradeRegimes[regime].cnt++;
      tradeRegimes[regime].pnl += pnl;

      const score = num(t.signalScore != null ? t.signalScore : t.signal_score);
      if (score != null) {
        const bucket = Math.max(1, Math.min(10, Math.floor(score / 10) + 1));
        if (!buckets[bucket]) buckets[bucket] = { cnt: 0, pnl: 0 };
        buckets[bucket].cnt++;
        buckets[bucket].pnl += pnl;
      }
    }

    const totalTrades = trades.length;
    const breakdown = Object.entries(decisionMap)
      .map(([decision, v]) => ({ decision, cnt: v.cnt, avgScore: v.scoreCount ? v.scoreTotal / v.scoreCount : null }))
      .sort((a, b) => b.cnt - a.cnt);
    const byRegime = Object.entries(regimeMap)
      .map(([regime, v]) => ({ regime, cnt: v.cnt, avgScore: v.scoreCount ? v.scoreTotal / v.scoreCount : null }))
      .sort((a, b) => b.cnt - a.cnt);

    res.status(200).json({
      success: true,
      rangeDays,
      storage: 'google_sheets',
      storageConnected: true,
      decisions: { total: decisions.length, breakdown, byRegime },
      trades: {
        total: totalTrades,
        wins,
        losses: totalTrades - wins,
        winRate: totalTrades ? Math.round((wins / totalTrades) * 1000) / 10 : 0,
        totalPnl,
        avgPnl: totalTrades ? totalPnl / totalTrades : null,
      },
      tradesByRegime: Object.entries(tradeRegimes)
        .map(([regime, v]) => ({ regime, cnt: v.cnt, pnl: v.pnl, avgPnl: v.cnt ? v.pnl / v.cnt : null }))
        .sort((a, b) => b.pnl - a.pnl),
      waitReasons: Object.entries(waitMap).map(([reason, cnt]) => ({ reason, cnt })).sort((a, b) => b.cnt - a.cnt),
      scoreBuckets: Object.entries(buckets).map(([bucket, v]) => ({ bucket: Number(bucket), cnt: v.cnt, avgPnl: v.cnt ? v.pnl / v.cnt : null })).sort((a, b) => a.bucket - b.bucket),
      recent: decisions
        .slice()
        .sort((a, b) => ts(b.timestamp || b.ts) - ts(a.timestamp || a.ts))
        .slice(0, 25)
        .map((d) => ({
          id: d.decisionKey || null,
          decision: d.decision,
          score: num(d.signalScore != null ? d.signalScore : d.signal_score),
          regime: d.regime || null,
          chop: Boolean(d.chop),
          reason: d.reasons && (d.reasons.reason || (Array.isArray(d.reasons.filters) ? d.reasons.filters[0] : null)),
          ts: d.timestamp || d.ts,
        })),
    });
  } catch (err) {
    logger.warn('[DECISION-STATS] Sheet okuma basarisiz: ' + err.message);
    res.status(200).json(empty(err.message));
  }
}

module.exports = { getStats };

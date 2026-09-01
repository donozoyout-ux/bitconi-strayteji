const crypto = require('crypto');
const db = require('../db');
const stateService = require('./state.service');
const settingsService = require('./settings.service');
const logger = require('../utils/logger');

const CHECKPOINT_SIZE = 7;
const CONFIRMATION_SIZE = 21;
const POLL_MS = 60 * 1000;

let timer = null;
let running = false;

function n(v, fallback = null) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function feeNumber(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'object') return n(v.cost, n(v.total, 0)) || 0;
  return n(v, 0) || 0;
}

function makeTradeKey(t) {
  const raw = [
    t.symbol || 'BTC/USDT',
    t.side || 'LONG',
    t.openedAt || t.entryTime || '',
    t.closedAt || t.exitTime || t.timestamp || '',
    t.entryPrice || 0,
    t.exitPrice || 0,
    t.size || t.quantity || 0,
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function nearestDecision(entryTime) {
  if (!entryTime) return null;
  try {
    const r = await db.query(
      `SELECT decision, reasons, signal_score, regime, chop, timestamp
       FROM strategy_decisions
       WHERE timestamp BETWEEN $1::timestamp - INTERVAL '45 minutes'
                           AND $1::timestamp + INTERVAL '45 minutes'
       ORDER BY ABS(EXTRACT(EPOCH FROM (timestamp - $1::timestamp))) ASC
       LIMIT 1`,
      [entryTime]
    );
    return r.rows[0] || null;
  } catch (_) {
    return null;
  }
}

async function persistTrade(t) {
  if (!t || !t.entryPrice || !t.exitPrice) return false;

  const entryTime = t.openedAt || t.entryTime;
  const exitTime = t.closedAt || t.exitTime || t.timestamp;
  if (!entryTime || !exitTime) return false;

  const decision = await nearestDecision(entryTime);
  const reasons = (decision && decision.reasons) || {};
  const side = String(t.side || reasons.side || 'LONG').toUpperCase();
  const qty = n(t.size, n(t.quantity, 0)) || 0;
  if (qty <= 0) return false;

  const entry = n(t.entryPrice, 0) || 0;
  const exit = n(t.exitPrice, 0) || 0;
  const gross = side === 'SHORT' ? (entry - exit) * qty : (exit - entry) * qty;
  const fees = feeNumber(t.fees);
  const net = gross - fees;
  const sizeUsdt = Math.abs(entry * qty);
  const pnlPct = sizeUsdt > 0 ? (net / sizeUsdt) * 100 : 0;
  const settings = settingsService.get();
  const tradeKey = makeTradeKey(t);

  const metadata = {
    source: 'state-trade-sync',
    originalPnl: t.pnl == null ? null : n(t.pnl),
    note: t.reason || null,
    decision: decision ? decision.decision : null,
    chop: decision ? decision.chop : null,
    rawReasons: reasons,
  };

  const params = [
    tradeKey,
    t.symbol || 'BTC/USDT',
    side,
    entry,
    exit,
    qty,
    entryTime,
    exitTime,
    sizeUsdt,
    Math.round(n(t.leverage, settings.maxLeverage || 1) || 1),
    fees,
    net,
    pnlPct,
    n(t.signalScore, decision && decision.signal_score),
    t.marketRegime || (decision && decision.regime) || reasons.regime || null,
    n(t.rsi, n(t.entryRsi, n(reasons.rsi))),
    n(t.bbLower, n(reasons.bbLower)),
    n(t.bbUpper, n(reasons.bbUpper)),
    t.exitReason || t.reason || null,
    t.mode || 'TESTNET',
    t.strategyVersion || reasons.strategyVersion || settings.strategyVersion || null,
    t.setupType || t.entryType || reasons.entryType || null,
    n(t.adx, n(t.entryAdx, n(reasons.adx))),
    n(t.atr, n(reasons.atr)),
    n(t.bbBasis, n(reasons.bbBasis)),
    n(t.pctB, n(reasons.pctB)),
    n(t.newsScore, n(reasons.newsScore)),
    n(t.fearGreed, n(reasons.fearGreed)),
    n(t.mfe, n(t.mfePercent)),
    n(t.mae, n(t.maePercent)),
    t.entryReason || reasons.entryReason || null,
    JSON.stringify(metadata),
  ];

  const result = await db.query(
    `INSERT INTO trades (
       trade_key, symbol, side, entry_price, exit_price, quantity,
       entry_time, exit_time, size_usdt, leverage, fee_usdt,
       pnl_usdt, pnl_percent, signal_score, market_regime,
       rsi_value, bb_lower, bb_upper, exit_reason, mode,
       strategy_version, setup_type, adx_value, atr_value, bb_basis,
       pct_b, news_score, fear_greed, mfe_percent, mae_percent,
       entry_reason, metadata
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
       $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32
     )
     ON CONFLICT (trade_key) DO NOTHING
     RETURNING id`,
    params
  );
  return result.rowCount > 0;
}

async function syncStateTradesToDb() {
  const trades = (stateService.get().trades || []).slice().reverse();
  let inserted = 0;
  for (const trade of trades) {
    try {
      if (await persistTrade(trade)) inserted++;
    } catch (e) {
      logger.warn('[LEARNING] trade sync atlandi: ' + e.message);
    }
  }
  return inserted;
}

function profitFactor(rows) {
  const wins = rows.reduce((s, r) => s + Math.max(0, n(r.pnl_usdt, 0) || 0), 0);
  const losses = rows.reduce((s, r) => s + Math.abs(Math.min(0, n(r.pnl_usdt, 0) || 0)), 0);
  if (losses === 0) return wins > 0 ? null : 0;
  return wins / losses;
}

function metrics(rows) {
  const count = rows.length;
  const wins = rows.filter((r) => n(r.pnl_usdt, 0) > 0);
  const losses = rows.filter((r) => n(r.pnl_usdt, 0) < 0);
  const longRows = rows.filter((r) => String(r.side).toUpperCase() === 'LONG');
  const shortRows = rows.filter((r) => String(r.side).toUpperCase() === 'SHORT');
  const net = rows.reduce((s, r) => s + (n(r.pnl_usdt, 0) || 0), 0);
  const fees = rows.reduce((s, r) => s + (n(r.fee_usdt, 0) || 0), 0);

  return {
    trades: count,
    wins: wins.length,
    losses: losses.length,
    winRate: count ? (wins.length / count) * 100 : 0,
    profitFactor: profitFactor(rows),
    expectancy: count ? net / count : 0,
    netPnl: net,
    fees,
    longTrades: longRows.length,
    longPf: profitFactor(longRows),
    shortTrades: shortRows.length,
    shortPf: profitFactor(shortRows),
  };
}

function errorCode(r) {
  if ((n(r.pnl_usdt, 0) || 0) >= 0) return null;
  const side = String(r.side || '').toUpperCase();
  const regime = String(r.market_regime || '').toUpperCase();
  const adx = n(r.adx_value);
  const pctB = n(r.pct_b);
  const mfe = n(r.mfe_percent);
  const exitReason = String(r.exit_reason || '').toUpperCase();
  const metadata = r.metadata || {};

  if (regime.includes('CHOP') || regime === 'RANGE' || metadata.chop === true) return 'CHOP_ENTRY';
  if (adx != null && adx < 25) return 'WEAK_TREND';
  if (side === 'LONG' && pctB != null && pctB > 85) return 'OVEREXTENDED_ENTRY';
  if (side === 'SHORT' && pctB != null && pctB < 15) return 'OVEREXTENDED_ENTRY';
  if (exitReason.includes('STOP') && mfe != null && mfe >= 1) return 'STOP_AFTER_PROFIT';
  if (exitReason.includes('TRAIL') && mfe != null && mfe >= 2) return 'TRAIL_EXIT_REVIEW';
  if (side === 'SHORT') return 'BAD_SHORT';
  return 'TREND_REVERSAL_OR_UNKNOWN';
}

function classify(rows) {
  const counts = {};
  for (const r of rows) {
    const code = errorCode(r);
    if (!code) continue;
    counts[code] = (counts[code] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);
}

function candidateFor(batchRows, batchMetrics, globalMetrics, findings) {
  const settings = settingsService.get();
  const top = findings[0] || null;
  const shortRows = batchRows.filter((r) => String(r.side).toUpperCase() === 'SHORT');
  const weakShorts = shortRows.filter((r) => {
    const adx = n(r.adx_value);
    return (n(r.pnl_usdt, 0) || 0) < 0 && adx != null && adx >= 25 && adx < 29;
  });

  if (weakShorts.length >= 2 && batchMetrics.shortPf != null && batchMetrics.shortPf < 1) {
    return {
      key: 'SHORT_ADX_FLOOR_REVIEW',
      problem: 'Low-ADX SHORT trades are underperforming.',
      current: { shortAdxFloor: settings.shortAdxFloor },
      proposed: { shortAdxFloor: Math.min(35, (n(settings.shortAdxFloor, 25) || 25) + 2) },
      evidence: { batchWeakShortLosses: weakShorts.length, batchShortPf: batchMetrics.shortPf, globalShortPf: globalMetrics.shortPf },
      action: 'BACKTEST_AND_SHADOW_TEST',
      autoApply: false,
    };
  }

  if (top && top.code === 'CHOP_ENTRY' && top.count >= 2) {
    return {
      key: 'CHOP_FILTER_REVIEW',
      problem: 'Losses are clustering in range/choppy conditions.',
      current: { chopThreshold: settings.chopThreshold },
      proposed: { reviewChopFilter: true },
      evidence: { batchLosses: top.count },
      action: 'BACKTEST_FILTER_VARIANTS',
      autoApply: false,
    };
  }

  if (top && top.code === 'OVEREXTENDED_ENTRY' && top.count >= 2) {
    return {
      key: 'ANTI_FOMO_REVIEW',
      problem: 'Entries are clustering at extended Bollinger locations.',
      current: {},
      proposed: { reviewPctBExtensionFilter: true },
      evidence: { batchLosses: top.count },
      action: 'BACKTEST_FILTER_VARIANTS',
      autoApply: false,
    };
  }

  if (top && top.count >= 3) {
    return {
      key: `${top.code}_REVIEW`,
      problem: `Repeated loss pattern: ${top.code}`,
      current: {},
      proposed: { investigate: top.code },
      evidence: { batchOccurrences: top.count },
      action: 'RESEARCH_REQUIRED',
      autoApply: false,
    };
  }

  return {
    key: 'NO_CHANGE',
    problem: null,
    proposed: {},
    evidence: { batchPf: batchMetrics.profitFactor, globalPf: globalMetrics.profitFactor },
    action: 'KEEP_COLLECTING_DATA',
    autoApply: false,
  };
}

async function previousCandidateKeys(limit = 2) {
  const r = await db.query(
    `SELECT candidate FROM learning_checkpoints
     ORDER BY checkpoint_number DESC LIMIT $1`,
    [limit]
  );
  return r.rows.map((x) => x.candidate && x.candidate.key).filter(Boolean);
}

async function createCheckpoint(tradeCount) {
  const all = await db.query(
    `SELECT * FROM trades ORDER BY exit_time ASC, id ASC LIMIT $1`,
    [tradeCount]
  );
  const rows = all.rows;
  if (rows.length < tradeCount) return null;

  const batch = rows.slice(-CHECKPOINT_SIZE);
  const batchMetrics = metrics(batch);
  const globalMetrics = metrics(rows);
  const findings = classify(batch);
  const candidate = candidateFor(batch, batchMetrics, globalMetrics, findings);
  const checkpointNumber = tradeCount / CHECKPOINT_SIZE;

  let confirmed = false;
  if (tradeCount % CONFIRMATION_SIZE === 0 && candidate.key !== 'NO_CHANGE') {
    const previous = await previousCandidateKeys(2);
    const same = previous.filter((k) => k === candidate.key).length + 1;
    confirmed = same >= 2;
  }

  const status = confirmed ? 'VALIDATION_REQUIRED' : candidate.key === 'NO_CHANGE' ? 'STABLE' : 'OBSERVE';
  const settings = settingsService.get();

  const inserted = await db.query(
    `INSERT INTO learning_checkpoints (
       checkpoint_number, trade_count, batch_start_trade_id, batch_end_trade_id,
       active_strategy_version, batch_metrics, global_metrics, findings,
       candidate, confirmed_pattern, status
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11)
     ON CONFLICT (checkpoint_number) DO NOTHING
     RETURNING *`,
    [
      checkpointNumber,
      tradeCount,
      batch[0] && batch[0].id,
      batch[batch.length - 1] && batch[batch.length - 1].id,
      settings.strategyVersion,
      JSON.stringify(batchMetrics),
      JSON.stringify(globalMetrics),
      JSON.stringify(findings),
      JSON.stringify(candidate),
      confirmed,
      status,
    ]
  );

  const row = inserted.rows[0] || null;
  if (row) {
    await db.query(
      `INSERT INTO system_events(event_type, event_data, severity)
       VALUES('LEARNING_CHECKPOINT', $1::jsonb, 'INFO')`,
      [JSON.stringify({ checkpointNumber, tradeCount, status, candidateKey: candidate.key, confirmed })]
    );
    logger.info(`[LEARNING] checkpoint #${checkpointNumber} tamamlandi`, {
      tradeCount,
      status,
      candidate: candidate.key,
      confirmed,
    });
  }
  return row;
}

async function maybeRunCheckpoint() {
  if (running) return { skipped: true, reason: 'already-running' };
  running = true;
  try {
    await syncStateTradesToDb();
    const countResult = await db.query('SELECT COUNT(*)::int AS count FROM trades');
    const total = countResult.rows[0] ? Number(countResult.rows[0].count) : 0;
    if (total < CHECKPOINT_SIZE) return { totalTrades: total, created: [] };

    const latestResult = await db.query('SELECT COALESCE(MAX(trade_count), 0)::int AS n FROM learning_checkpoints');
    let completed = latestResult.rows[0] ? Number(latestResult.rows[0].n) : 0;
    const target = Math.floor(total / CHECKPOINT_SIZE) * CHECKPOINT_SIZE;
    const created = [];

    while (completed + CHECKPOINT_SIZE <= target) {
      completed += CHECKPOINT_SIZE;
      const row = await createCheckpoint(completed);
      if (row) created.push(row);
    }

    return { totalTrades: total, target, created };
  } finally {
    running = false;
  }
}

async function getStatus() {
  await syncStateTradesToDb();
  const count = await db.query('SELECT COUNT(*)::int AS count FROM trades');
  const totalTrades = count.rows[0] ? Number(count.rows[0].count) : 0;
  const latest = await db.query('SELECT * FROM learning_checkpoints ORDER BY checkpoint_number DESC LIMIT 1');
  const checkpoints = await db.query('SELECT * FROM learning_checkpoints ORDER BY checkpoint_number DESC LIMIT 10');
  const nextCheckpoint = (Math.floor(totalTrades / CHECKPOINT_SIZE) + 1) * CHECKPOINT_SIZE;

  return {
    enabled: true,
    mode: 'ADVISORY_ONLY',
    autoApply: false,
    checkpointEvery: CHECKPOINT_SIZE,
    confirmationEvery: CONFIRMATION_SIZE,
    totalTrades,
    nextCheckpoint,
    tradesUntilNext: Math.max(0, nextCheckpoint - totalTrades),
    latest: latest.rows[0] || null,
    checkpoints: checkpoints.rows,
  };
}

function start() {
  if (timer) return;
  const tick = async () => {
    try {
      await maybeRunCheckpoint();
    } catch (e) {
      logger.warn('[LEARNING] checkpoint kontrolu basarisiz: ' + e.message);
    }
  };

  setTimeout(tick, 15000).unref?.();
  timer = setInterval(tick, POLL_MS);
  if (timer.unref) timer.unref();
  logger.info(`[LEARNING] Adaptive Learning V1 aktif: her ${CHECKPOINT_SIZE} trade analiz, ${CONFIRMATION_SIZE} trade dogrulama; AUTO-APPLY KAPALI.`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  CHECKPOINT_SIZE,
  CONFIRMATION_SIZE,
  syncStateTradesToDb,
  maybeRunCheckpoint,
  getStatus,
  metrics,
  classify,
  start,
  stop,
};

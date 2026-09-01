const stateService = require('./state.service');
const settingsService = require('./settings.service');
const sheetStore = require('./sheet-store.service');
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

function timestampOf(v) {
  const t = new Date(v || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

async function syncStateTradesToSheet() {
  if (!sheetStore.isConfigured()) return 0;
  const trades = (stateService.get().trades || []).slice().reverse();
  let inserted = 0;
  for (const trade of trades) {
    try {
      const r = await sheetStore.appendTrade(trade);
      if (r && r.appended) inserted++;
    } catch (e) {
      logger.warn('[LEARNING] trade Sheet sync atlandi: ' + e.message);
    }
  }
  return inserted;
}

function nearestDecision(entryTime, decisions) {
  const target = timestampOf(entryTime);
  if (!target) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const d of decisions || []) {
    const ts = timestampOf(d.timestamp || d.ts);
    const distance = Math.abs(ts - target);
    if (distance <= 45 * 60 * 1000 && distance < bestDistance) {
      best = d;
      bestDistance = distance;
    }
  }
  return best;
}

function normalizeTrade(t, decisions) {
  const entryTime = t.openedAt || t.entryTime;
  const exitTime = t.closedAt || t.exitTime || t.timestamp;
  const decision = nearestDecision(entryTime, decisions);
  const reasons = (decision && decision.reasons) || {};
  const side = String(t.side || reasons.side || 'LONG').toUpperCase();
  const qty = n(t.size, n(t.quantity, 0)) || 0;
  const entry = n(t.entryPrice, n(t.entry_price, 0)) || 0;
  const exit = n(t.exitPrice, n(t.exit_price, 0)) || 0;
  const gross = side === 'SHORT' ? (entry - exit) * qty : (exit - entry) * qty;
  const fees = feeNumber(t.fees != null ? t.fees : t.fee_usdt);
  const pnl = qty > 0 && entry > 0 ? gross - fees : n(t.pnl, n(t.pnl_usdt, 0)) || 0;
  const sizeUsdt = Math.abs(entry * qty);

  return {
    ...t,
    trade_key: t.tradeKey || t.trade_key || sheetStore.makeTradeKey(t),
    symbol: t.symbol || 'BTC/USDT',
    side,
    entry_price: entry,
    exit_price: exit,
    quantity: qty,
    entry_time: entryTime,
    exit_time: exitTime,
    fee_usdt: fees,
    pnl_usdt: pnl,
    pnl_percent: sizeUsdt ? (pnl / sizeUsdt) * 100 : n(t.pnlPercent, n(t.pnl_percent, 0)) || 0,
    signal_score: n(t.signalScore, n(t.signal_score, n(decision && (decision.signalScore || decision.signal_score)))),
    market_regime: t.marketRegime || t.market_regime || (decision && decision.regime) || reasons.regime || null,
    rsi_value: n(t.rsi, n(t.entryRsi, n(t.rsi_value, n(reasons.rsi)))),
    bb_lower: n(t.bbLower, n(t.bb_lower, n(reasons.bbLower))),
    bb_upper: n(t.bbUpper, n(t.bb_upper, n(reasons.bbUpper))),
    bb_basis: n(t.bbBasis, n(t.bb_basis, n(reasons.bbBasis))),
    pct_b: n(t.pctB, n(t.pct_b, n(reasons.pctB))),
    adx_value: n(t.adx, n(t.entryAdx, n(t.adx_value, n(reasons.adx)))),
    atr_value: n(t.atr, n(t.atr_value, n(reasons.atr))),
    news_score: n(t.newsScore, n(t.news_score, n(reasons.newsScore))),
    fear_greed: n(t.fearGreed, n(t.fear_greed, n(reasons.fearGreed))),
    mfe_percent: n(t.mfe, n(t.mfePercent, n(t.mfe_percent))),
    mae_percent: n(t.mae, n(t.maePercent, n(t.mae_percent))),
    exit_reason: t.exitReason || t.exit_reason || t.reason || null,
    entry_reason: t.entryReason || t.entry_reason || reasons.entryReason || null,
    strategy_version: t.strategyVersion || t.strategy_version || reasons.strategyVersion || settingsService.get().strategyVersion,
    setup_type: t.setupType || t.setup_type || t.entryType || reasons.entryType || null,
    metadata: {
      ...(t.metadata && typeof t.metadata === 'object' ? t.metadata : {}),
      decision: decision ? decision.decision : null,
      chop: decision ? Boolean(decision.chop) : Boolean(reasons.chop),
      rawReasons: reasons,
    },
  };
}

async function normalizedTrades() {
  await syncStateTradesToSheet();
  const [trades, decisions] = await Promise.all([
    sheetStore.listTrades(),
    sheetStore.listDecisions().catch(() => []),
  ]);
  return trades
    .map((t) => normalizeTrade(t, decisions))
    .filter((t) => t.entry_price > 0 && t.exit_price > 0 && t.quantity > 0 && t.exit_time)
    .sort((a, b) => timestampOf(a.exit_time) - timestampOf(b.exit_time));
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
  const rows = await sheetStore.listCheckpoints();
  return rows
    .slice()
    .sort((a, b) => Number(b.checkpointNumber || 0) - Number(a.checkpointNumber || 0))
    .slice(0, limit)
    .map((x) => x.candidate && x.candidate.key)
    .filter(Boolean);
}

async function createCheckpoint(tradeCount, allRows) {
  const rows = allRows.slice(0, tradeCount);
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
  const checkpoint = {
    checkpointNumber,
    tradeCount,
    batchStartTradeKey: batch[0] && batch[0].trade_key,
    batchEndTradeKey: batch[batch.length - 1] && batch[batch.length - 1].trade_key,
    activeStrategyVersion: settings.strategyVersion,
    batchMetrics,
    globalMetrics,
    findings,
    candidate,
    confirmedPattern: confirmed,
    status,
    createdAt: new Date().toISOString(),
  };

  const result = await sheetStore.appendCheckpoint(checkpoint);
  if (result && result.appended) {
    logger.info(`[LEARNING] Sheet checkpoint #${checkpointNumber} tamamlandi`, {
      tradeCount,
      status,
      candidate: candidate.key,
      confirmed,
    });
    return checkpoint;
  }
  return null;
}

async function maybeRunCheckpoint() {
  if (running) return { skipped: true, reason: 'already-running' };
  running = true;
  try {
    if (!sheetStore.isConfigured()) return { skipped: true, reason: 'sheet-not-configured' };
    const trades = await normalizedTrades();
    const total = trades.length;
    if (total < CHECKPOINT_SIZE) return { totalTrades: total, created: [] };

    const checkpoints = await sheetStore.listCheckpoints();
    let completed = checkpoints.reduce((m, x) => Math.max(m, Number(x.tradeCount || 0)), 0);
    const target = Math.floor(total / CHECKPOINT_SIZE) * CHECKPOINT_SIZE;
    const created = [];

    while (completed + CHECKPOINT_SIZE <= target) {
      completed += CHECKPOINT_SIZE;
      const cp = await createCheckpoint(completed, trades);
      if (cp) created.push(cp);
    }

    return { totalTrades: total, target, created };
  } finally {
    running = false;
  }
}

async function getStatus() {
  if (!sheetStore.isConfigured()) {
    return {
      enabled: false,
      mode: 'ADVISORY_ONLY',
      autoApply: false,
      checkpointEvery: CHECKPOINT_SIZE,
      confirmationEvery: CONFIRMATION_SIZE,
      totalTrades: (stateService.get().trades || []).length,
      nextCheckpoint: CHECKPOINT_SIZE,
      tradesUntilNext: Math.max(0, CHECKPOINT_SIZE - (stateService.get().trades || []).length),
      latest: null,
      checkpoints: [],
      storage: 'google_sheets',
      error: 'SHEET_NOT_CONFIGURED',
    };
  }

  const [trades, checkpoints] = await Promise.all([normalizedTrades(), sheetStore.listCheckpoints()]);
  const ordered = checkpoints.slice().sort((a, b) => Number(b.checkpointNumber || 0) - Number(a.checkpointNumber || 0));
  const totalTrades = trades.length;
  const nextCheckpoint = (Math.floor(totalTrades / CHECKPOINT_SIZE) + 1) * CHECKPOINT_SIZE;

  return {
    enabled: true,
    storage: 'google_sheets',
    mode: 'ADVISORY_ONLY',
    autoApply: false,
    checkpointEvery: CHECKPOINT_SIZE,
    confirmationEvery: CONFIRMATION_SIZE,
    totalTrades,
    nextCheckpoint,
    tradesUntilNext: Math.max(0, nextCheckpoint - totalTrades),
    latest: ordered[0] || null,
    checkpoints: ordered.slice(0, 10),
  };
}

function start() {
  if (timer) return;
  const tick = async () => {
    try {
      await maybeRunCheckpoint();
    } catch (e) {
      logger.warn('[LEARNING] Sheet checkpoint kontrolu basarisiz: ' + e.message);
    }
  };
  const first = setTimeout(tick, 15000);
  if (first.unref) first.unref();
  timer = setInterval(tick, POLL_MS);
  if (timer.unref) timer.unref();
  logger.info(`[LEARNING] Adaptive Learning V1: Google Sheets hafiza, her ${CHECKPOINT_SIZE} trade analiz, ${CONFIRMATION_SIZE} trade dogrulama; AUTO-APPLY KAPALI.`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  CHECKPOINT_SIZE,
  CONFIRMATION_SIZE,
  syncStateTradesToSheet,
  syncStateTradesToDb: syncStateTradesToSheet,
  maybeRunCheckpoint,
  getStatus,
  metrics,
  classify,
  start,
  stop,
};

// Legacy compatibility adapter.
// PostgreSQL is no longer part of the runtime. Older callers may still import ../db,
// but persistence failures must NEVER block Binance TESTNET execution.
// Google Sheets remains best-effort only; local runtime state is the fallback.
const sheetStore = require('../services/sheet-store.service');
const logger = require('../utils/logger');

function result(rows = [], rowCount = null) {
  return { rows, rowCount: rowCount == null ? rows.length : rowCount };
}

async function initialize() {
  try {
    const health = await sheetStore.healthCheck();
    return { ...health, ok: true, degraded: !health.ok };
  } catch (e) {
    logger.warn('[STORAGE] Google Sheets unavailable; local fallback active: ' + e.message);
    return { ok: true, degraded: true, error: e.message };
  }
}

async function close() {
  return true;
}

async function runMigrations() {
  try {
    const health = await sheetStore.healthCheck();
    return {
      ok: true,
      applied: false,
      degraded: !health.ok,
      reason: health.ok
        ? 'PostgreSQL removed; Google Sheets backend ready'
        : 'PostgreSQL removed; local fallback active',
    };
  } catch (e) {
    return { ok: true, applied: false, degraded: true, reason: 'local fallback active', error: e.message };
  }
}

async function healthCheck() {
  try {
    const h = await sheetStore.healthCheck();
    return {
      // Legacy DB health is intentionally always OK because DB/Sheets is not an order prerequisite.
      ok: true,
      degraded: !h.ok,
      details: {
        storageMode: h.ok ? 'google_sheets' : 'local_fallback',
        configured: Boolean(h.configured),
        connect: Boolean(h.ok),
        writeOk: Boolean(h.ok),
        spreadsheetName: h.spreadsheetName || null,
        error: h.error || null,
      },
    };
  } catch (e) {
    return {
      ok: true,
      degraded: true,
      details: {
        storageMode: 'local_fallback',
        configured: false,
        connect: false,
        writeOk: false,
        spreadsheetName: null,
        error: e.message,
      },
    };
  }
}

async function query(text, params = []) {
  const sql = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();

  // Connectivity probes from old startup/pre-trade code are compatibility no-ops.
  // Persistence is optional, so SELECT 1 must never become a trading blocker.
  if (sql === 'select 1' || sql.startsWith('select now()')) {
    return result([{ ok: 1, storageMode: 'optional' }], 1);
  }

  // Old order recovery path. If Sheets is unavailable, behave as an empty journal.
  if (sql.includes('select * from orders') && sql.includes("status = 'open'")) {
    try {
      if (!sheetStore.isConfigured()) return result([]);
      const rows = await sheetStore.list('ORDERS');
      return result(rows.filter((r) => String(r.status || '').toUpperCase() === 'OPEN' && !r.closed_at && !r.closedAt));
    } catch (e) {
      logger.warn('[STORAGE] Order journal unavailable; exchange remains source of truth: ' + e.message);
      return result([]);
    }
  }

  if (sql.startsWith('update orders set status')) {
    return result([], 0);
  }

  // Strategy-decision journaling is best-effort and can never break the trading loop.
  if (sql.startsWith('insert into strategy_decisions')) {
    try {
      if (!sheetStore.isConfigured()) return result([], 0);
      let reasons = params[1];
      if (typeof reasons === 'string') {
        try { reasons = JSON.parse(reasons); } catch (_) {}
      }
      await sheetStore.appendDecision({
        decision: params[0],
        reasons: reasons || {},
        signalScore: params[2] == null ? null : Number(params[2]),
        regime: params[3] || null,
        chop: Boolean(params[4]),
        timestamp: params[5] ? new Date(params[5]).toISOString() : new Date().toISOString(),
        symbol: reasons && reasons.symbol,
        price: reasons && reasons.price,
      });
      return result([], 1);
    } catch (e) {
      logger.warn('[STORAGE] Decision journal skipped: ' + e.message);
      return result([], 0);
    }
  }

  if (sql.startsWith('delete from strategy_decisions')) {
    try {
      if (!sheetStore.isConfigured()) return result([], 0);
      const days = Number(params[0] || 30);
      const r = await sheetStore.trimDecisions(days);
      return result([], Number(r.deleted || 0));
    } catch (e) {
      return result([], 0);
    }
  }

  // Old recovery queries no longer have SQL-backed tables.
  if (sql.startsWith('select ')) return result([]);
  return result([], 0);
}

module.exports = { query, initialize, close, healthCheck, runMigrations };

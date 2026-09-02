// Legacy compatibility adapter.
// PostgreSQL is no longer part of the runtime. A few older trading-engine calls still
// import ../db; this module translates those calls to Google Sheets until the callers
// are fully renamed to the storage abstraction.
const sheetStore = require('../services/sheet-store.service');

function result(rows = [], rowCount = null) {
  return { rows, rowCount: rowCount == null ? rows.length : rowCount };
}

async function initialize() {
  const health = await sheetStore.healthCheck();
  if (!health.ok) throw new Error(health.error || 'Google Sheets storage unavailable');
  return health;
}

async function close() {
  return true;
}

async function runMigrations() {
  const health = await sheetStore.healthCheck();
  return health.ok
    ? { ok: true, applied: false, reason: 'PostgreSQL removed; Google Sheets backend ready' }
    : { ok: false, applied: false, reason: health.error || 'Google Sheets unavailable' };
}

async function healthCheck() {
  const h = await sheetStore.healthCheck();
  return {
    ok: h.ok,
    details: {
      storageMode: 'google_sheets',
      configured: h.configured,
      connect: h.ok,
      writeOk: h.ok,
      spreadsheetName: h.spreadsheetName || null,
      error: h.error || null,
    },
  };
}

async function query(text, params = []) {
  const sql = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();

  // Connectivity probes used by old pre-trade/startup code.
  if (sql === 'select 1' || sql.startsWith('select now()')) {
    const h = await sheetStore.healthCheck();
    if (!h.ok) throw new Error(h.error || 'Google Sheets storage unavailable');
    return result([{ ok: 1 }], 1);
  }

  // Old order recovery path. Orders are now append-only Sheet records.
  if (sql.includes('select * from orders') && sql.includes("status = 'open'")) {
    const rows = await sheetStore.list('ORDERS');
    return result(rows.filter((r) => String(r.status || '').toUpperCase() === 'OPEN' && !r.closed_at && !r.closedAt));
  }

  if (sql.startsWith('update orders set status')) {
    // Exchange reconciliation remains the source of truth. Sheet order journal is append-only.
    return result([], 0);
  }

  // Strategy decision journal from trading.engine.js.
  if (sql.startsWith('insert into strategy_decisions')) {
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
  }

  if (sql.startsWith('delete from strategy_decisions')) {
    const days = Number(params[0] || 30);
    const r = await sheetStore.trimDecisions(days);
    return result([], Number(r.deleted || 0));
  }

  // Old recovery code may ask for data that is no longer represented as SQL tables.
  // Return an empty result instead of creating a hidden PostgreSQL dependency.
  if (sql.startsWith('select ')) return result([]);
  return result([], 0);
}

module.exports = { query, initialize, close, healthCheck, runMigrations };

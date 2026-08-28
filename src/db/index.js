let Pool = null;
try {
  Pool = require('pg').Pool;
} catch (e) {
  // pg module optional fallback
}

const env = require('../config/env');

let pool = null;

function getPool() {
  if (!Pool) {
    throw new Error('pg modulu yuklu degil.');
  }
  if (!pool) {
    const connectionString = process.env.DATABASE_URL || 'postgresql://localhost:5432/dip_hunter';
    pool = new Pool({
      connectionString,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    });
  }
  return pool;
}

async function query(text, params) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

async function initialize() {
  const pool = getPool();
  await pool.query('SELECT NOW()');
  return pool;
}

async function close() {
  if (pool) {
    await pool.end();
  }
}

// Harmless read/write health check used by the startup gate. Verifies DATABASE_URL,
// connectivity, required tables, settings/bot_state readability, and a throwaway
// write to a journal-style table. Returns { ok, details } without throwing.
async function healthCheck() {
  const details = {
    databaseUrlPresent: !!process.env.DATABASE_URL,
    connect: false,
    select1: false,
    tables: {},
    settingsReadable: false,
    botStateReadable: false,
    writeOk: false,
  };
  if (!process.env.DATABASE_URL) return { ok: false, details };
  let client;
  try {
    const p = getPool();
    client = await p.connect();
    details.connect = true;
    await client.query('SELECT 1');
    details.select1 = true;

    const tables = ['settings', 'bot_state', 'trades', 'strategy_decisions', 'system_events', 'orders', 'positions'];
    for (const t of tables) {
      const r = await client.query('SELECT to_regclass($1) AS t', [t]);
      details.tables[t] = !!(r.rows[0] && r.rows[0].t);
    }

    await client.query('SELECT value FROM settings LIMIT 1');
    details.settingsReadable = true;
    await client.query('SELECT value FROM bot_state LIMIT 1');
    details.botStateReadable = true;

    const ins = await client.query(
      "INSERT INTO system_events (event_type, event_data, severity) VALUES ('HEALTH_CHECK', $1, 'INFO') RETURNING id",
      [JSON.stringify({ probe: true, ts: Date.now() })]
    );
    const id = ins.rows[0].id;
    await client.query('DELETE FROM system_events WHERE id=$1', [id]);
    details.writeOk = true;
  } catch (e) {
    details.error = e.message;
  } finally {
    if (client) client.release();
  }
  details.allTablesPresent = Object.values(details.tables).every(Boolean);
  const ok = details.connect && details.select1 && details.settingsReadable && details.botStateReadable && details.writeOk && details.allTablesPresent;
  return { ok, details };
}

module.exports = { query, initialize, close, healthCheck };
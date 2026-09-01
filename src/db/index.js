let Pool = null;
try {
  Pool = require('pg').Pool;
} catch (e) {
  // pg module optional fallback
}

const env = require('../config/env');

let pool = null;

function getPool() {
  if (!Pool) throw new Error('pg modulu yuklu degil.');
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
  const client = await getPool().connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function initialize() {
  const p = getPool();
  await p.query('SELECT NOW()');
  return p;
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// Ordered migration runner. Existing installations are upgraded without wiping data;
// fresh Railway databases execute the same files from zero.
async function runMigrations() {
  if (!process.env.DATABASE_URL) return { ok: false, reason: 'DATABASE_URL yok' };

  const fs = require('fs');
  const path = require('path');
  let client;
  try {
    client = await getPool().connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    const dir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(dir).filter((f) => /^\d+.*\.sql$/i.test(f)).sort();
    const applied = [];

    for (const filename of files) {
      const seen = await client.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [filename]);
      if (seen.rowCount) continue;

      const sql = fs.readFileSync(path.join(dir, filename), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(filename) VALUES($1)', [filename]);
        await client.query('COMMIT');
        applied.push(filename);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`${filename}: ${e.message}`);
      }
    }

    return {
      ok: true,
      applied: applied.length > 0,
      appliedFiles: applied,
      reason: applied.length ? `${applied.length} migration uygulandi` : 'migrationlar guncel',
    };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (client) client.release();
  }
}

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
    client = await getPool().connect();
    details.connect = true;
    await client.query('SELECT 1');
    details.select1 = true;

    const tables = [
      'settings', 'bot_state', 'trades', 'strategy_decisions', 'system_events',
      'orders', 'positions', 'learning_checkpoints'
    ];
    for (const t of tables) {
      const r = await client.query('SELECT to_regclass($1) AS t', [`public.${t}`]);
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
    await client.query('DELETE FROM system_events WHERE id=$1', [ins.rows[0].id]);
    details.writeOk = true;
  } catch (e) {
    details.error = e.message;
  } finally {
    if (client) client.release();
  }

  details.allTablesPresent = Object.values(details.tables).every(Boolean);
  const ok = details.connect && details.select1 && details.settingsReadable &&
    details.botStateReadable && details.writeOk && details.allTablesPresent;
  return { ok, details };
}

module.exports = { query, initialize, close, healthCheck, runMigrations };

const { Pool } = require('pg');
const env = require('../config/env');

let pool = null;

function getPool() {
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

module.exports = { query, initialize, close };
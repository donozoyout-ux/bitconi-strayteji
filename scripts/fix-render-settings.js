// Safe, idempotent canonicalization of the Render DB `settings` table for the
// EXIT_B3_M3_SHORT_H1_ADX25 TESTNET forward test. Run ONCE on Render (where
// DATABASE_URL is set). Touches ONLY the 16 candidate keys; leaves all other
// rows untouched. No strategy code is modified. No orders are placed.
// Prints BEFORE and AFTER parity so the operator can confirm.
const db = require('../src/db');
const settingsService = require('../src/services/settings.service');

// canonical camelCase key -> DB snake_case column
const CANONICAL_TO_DB = {
  strategy: 'strategy',
  strategyVersion: 'strategy_version',
  riskPerTrade: 'risk_per_trade',
  executionTimeframe: 'execution_timeframe',
  higherTimeframe: 'higher_timeframe',
  regimeTimeframe: 'regime_timeframe',
  bbLength: 'bb_length',
  bbStd: 'bb_stddev',
  shortAdxFloor: 'short_adx_floor',
  exitStrategy: 'exit_strategy',
  trendTrailingAtrMult: 'trend_trailing_atr_mult',
  trendUseTP: 'trend_use_tp',
  trendTimeExitCandles: 'trend_time_exit_candles',
  slPercent: 'sl_percent',
  maxLeverage: 'max_leverage',
  commissionRate: 'commission_rate',
};

function serialize(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

(async () => {
  const canonical = settingsService.getCanonical();
  const rows = Object.entries(CANONICAL_TO_DB).map(([camel, col]) => ({
    col, value: serialize(canonical[camel]), canonical: canonical[camel],
  }));

  const read = async () => {
    const res = await db.query('SELECT key, value FROM settings');
    const m = {};
    for (const r of res.rows) m[r.key] = r.value;
    return m;
  };

  let before;
  try { before = await read(); }
  catch (e) { console.error('Cannot read settings table:', e.message); process.exit(2); }

  console.log('=== SETTINGS PARITY BEFORE (DB vs canonical) ===');
  let beforeAllMatch = true;
  for (const r of rows) {
    const dbv = before[r.col];
    const match = dbv === r.value;
    if (!match) beforeAllMatch = false;
    console.log(r.col.padEnd(26) + ' db=' + String(dbv).padEnd(22) + ' canonical=' + r.value.padEnd(12) + (match ? ' MATCH' : ' MISMATCH'));
  }
  console.log('SETTINGS PARITY BEFORE: ' + (beforeAllMatch ? 'PASS' : 'FAIL'));

  // Idempotent UPSERT of ONLY the candidate keys to canonical values.
  for (const r of rows) {
    await db.query(
      `INSERT INTO settings (key, value, description, updated_at)
       VALUES ($1, $2, 'candidate-forward-test', NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [r.col, r.value]
    );
  }

  const after = await read();
  console.log('\n=== SETTINGS PARITY AFTER (canonical applied) ===');
  let afterAllMatch = true;
  for (const r of rows) {
    const dbv = after[r.col];
    const match = dbv === r.value;
    if (!match) afterAllMatch = false;
    console.log(r.col.padEnd(26) + ' db=' + String(dbv).padEnd(22) + ' canonical=' + r.value.padEnd(12) + (match ? ' MATCH' : ' MISMATCH'));
  }
  console.log('SETTINGS PARITY AFTER: ' + (afterAllMatch ? 'PASS' : 'FAIL'));
  console.log('DB SETTINGS BOOTSTRAP : ' + (afterAllMatch ? 'PASS' : 'FAIL'));
  console.log('\nDone. Only the 16 candidate keys were written; no strategy code or unrelated rows changed.');
  process.exit(afterAllMatch ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });

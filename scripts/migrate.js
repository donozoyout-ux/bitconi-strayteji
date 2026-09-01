const db = require('../src/db');

(async () => {
  const result = await db.runMigrations();
  if (!result.ok) {
    console.error('[MIGRATION] FAIL:', result.error || result.reason || 'unknown');
    process.exit(1);
  }
  console.log('[MIGRATION] PASS:', result.reason || 'ok');
  if (result.appliedFiles && result.appliedFiles.length) {
    console.log('[MIGRATION] applied:', result.appliedFiles.join(', '));
  }
  await db.close();
  process.exit(0);
})().catch(async (err) => {
  console.error('[MIGRATION] FATAL:', err.message);
  try { await db.close(); } catch (_) {}
  process.exit(1);
});

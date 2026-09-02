const sheetStore = require('../src/services/sheet-store.service');
const env = require('../src/config/env');

(async () => {
  const health = await sheetStore.healthCheck();

  if (health.ok) {
    console.log('[STORAGE] Google Sheets hazir:', health.spreadsheetName || 'connected');
    return;
  }

  if (!env.sheetRequired) {
    console.warn('[STORAGE] Google Sheets hazir degil; SHEET_REQUIRED=false -> local/degraded persistence ile devam ediliyor:', health.error || 'unknown error');
    return;
  }

  console.error('[STORAGE] Google Sheets zorunlu ama hazir degil:', health.error || 'unknown error');
  process.exit(1);
})().catch((err) => {
  console.error('[STORAGE] Kontrol hatasi:', err.message);
  process.exit(1);
});

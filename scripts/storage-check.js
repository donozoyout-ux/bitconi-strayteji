const sheetStore = require('../src/services/sheet-store.service');

(async () => {
  const health = await sheetStore.healthCheck();
  if (!health.ok) {
    console.error('[STORAGE] Google Sheets hazir degil:', health.error || 'unknown error');
    process.exit(1);
  }
  console.log('[STORAGE] Google Sheets hazir:', health.spreadsheetName || 'connected');
})().catch((err) => {
  console.error('[STORAGE] Kontrol hatasi:', err.message);
  process.exit(1);
});

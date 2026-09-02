const path = require('path');
const express = require('express');
const cors = require('cors');
const webhookRoutes = require('./routes/webhook.routes');
const statusController = require('./controllers/status.controller');
const telegramController = require('./controllers/telegram.controller');
const traderController = require('./controllers/trader.controller');
const chartController = require('./controllers/chart.controller');
const analysisController = require('./controllers/analysis.controller');
const decisionStatsController = require('./controllers/decision-stats.controller');
const learningController = require('./controllers/learning.controller');
const settingsRoutes = require('./routes/settings.routes');
const startup = require('./services/startup');
const env = require('./config/env');
const { requireAdmin } = require('./middleware/admin-auth');
const logger = require('./utils/logger');

const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => {
  res.status(200).json({ success: true, status: 'OK', uptime: process.uptime() });
});

// Railway readiness: canonical config + Sheet persistence (when required) + TESTNET safety.
app.get('/ready', (req, res) => {
  const gate = startup.getGate();
  const storageReady = Boolean(gate && (!gate.sheetRequired || gate.storageOk));
  const ready = Boolean(
    gate &&
    storageReady &&
    gate.configOk &&
    !gate.blockReason &&
    env.useTestnet &&
    !env.emergencyStop
  );

  const body = {
    success: ready,
    ready,
    platform: env.platform,
    useTestnet: env.useTestnet,
    dryRun: env.dryRun,
    tradingEnabled: env.tradingEnabled,
    storage: gate
      ? {
          mode: gate.storageMode || 'google_sheets',
          connected: Boolean(gate.storageOk),
          required: Boolean(gate.sheetRequired),
          error: gate.storage && gate.storage.error ? gate.storage.error : null,
        }
      : { mode: 'google_sheets', connected: false, required: Boolean(env.sheetRequired), error: 'STARTUP_PENDING' },
    startupGate: gate
      ? {
          storageOk: Boolean(gate.storageOk),
          configOk: gate.configOk,
          blockReason: gate.blockReason || null,
        }
      : { storageOk: false, configOk: false, blockReason: 'STARTUP_PENDING' },
  };

  res.status(ready ? 200 : 503).json(body);
});

app.get('/api/status', statusController.getStatus);
app.get('/api/runtime', statusController.getRuntime);
app.get('/api/logs', statusController.getLogs);
app.get('/api/trader', traderController.getStatus);
app.get('/api/trader/analyze', traderController.analyze);
app.get('/api/trader/price', traderController.getLivePrice);
app.get('/api/trader/history', traderController.getHistory);
app.get('/api/chart', chartController.getChart);
app.get('/api/analysis', analysisController.getAnalysis);
app.get('/api/decisions/stats', decisionStatsController.getStats);
app.get('/api/learning', learningController.getStatus);

app.post('/api/test-telegram', requireAdmin, telegramController.sendTest);
app.post('/api/trader/check', requireAdmin, traderController.checkNow);
app.post('/api/trader/analyze', requireAdmin, traderController.analyze);
app.post('/api/trader/reset', requireAdmin, traderController.resetState);
app.post('/api/trader/close', requireAdmin, traderController.closePosition);
app.post('/api/trader/open', requireAdmin, traderController.openManual);
app.post('/api/learning/check', requireAdmin, learningController.checkNow);
app.use('/api/settings', requireAdmin, settingsRoutes);

app.use('/webhook', webhookRoutes);

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint bulunamadi' });
});

app.use((err, req, res, next) => {
  logger.error('Yakalanmamis hata', { error: err.message, stack: err.stack });
  res.status(500).json({ success: false, error: 'Sunucu hatasi' });
});

module.exports = app;

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
const settingsRoutes = require('./routes/settings.routes');
const startup = require('./services/startup');
const env = require('./config/env');
const { requireAdmin } = require('./middleware/admin-auth');
const logger = require('./utils/logger');

const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Liveness: process is accepting HTTP traffic.
app.get('/health', (req, res) => {
  res.status(200).json({ success: true, status: 'OK', uptime: process.uptime() });
});

// Readiness: trading startup gate completed successfully.
// Railway should use this endpoint as the deployment healthcheck.
app.get('/ready', (req, res) => {
  const gate = startup.getGate();
  const ready = Boolean(
    gate &&
    gate.dbOk &&
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
    startupGate: gate
      ? {
          dbOk: gate.dbOk,
          configOk: gate.configOk,
          blockReason: gate.blockReason || null,
        }
      : { dbOk: false, configOk: false, blockReason: 'STARTUP_PENDING' },
  };

  res.status(ready ? 200 : 503).json(body);
});

// Public read-only operational endpoints.
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

// Mutating/admin endpoints require X-Admin-Token.
app.post('/api/test-telegram', requireAdmin, telegramController.sendTest);
app.post('/api/trader/check', requireAdmin, traderController.checkNow);
app.post('/api/trader/analyze', requireAdmin, traderController.analyze);
app.post('/api/trader/reset', requireAdmin, traderController.resetState);
app.post('/api/trader/close', requireAdmin, traderController.closePosition);
app.post('/api/trader/open', requireAdmin, traderController.openManual);
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

const path = require('path');
const express = require('express');
const cors = require('cors');
const webhookRoutes = require('./routes/webhook.routes');
const statusController = require('./controllers/status.controller');
const telegramController = require('./controllers/telegram.controller');
const traderController = require('./controllers/trader.controller');
const chartController = require('./controllers/chart.controller');
const logger = require('./utils/logger');

const app = express();

app.use(express.json());
app.use(cors());

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => {
  res.status(200).json({ success: true, status: 'OK', uptime: process.uptime() });
});

app.get('/api/status', statusController.getStatus);
app.post('/api/test-telegram', telegramController.sendTest);
app.get('/api/trader', traderController.getStatus);
app.post('/api/trader/check', traderController.checkNow);
app.post('/api/trader/reset', traderController.resetState);
app.get('/api/chart', chartController.getChart);

app.use('/webhook', webhookRoutes);

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint bulunamadi' });
});

app.use((err, req, res, next) => {
  logger.error('Yakalanmamis hata', { error: err.message, stack: err.stack });
  res.status(500).json({ success: false, error: 'Sunucu hatasi' });
});

module.exports = app;

const path = require('path');
const express = require('express');
const cors = require('cors');
const webhookRoutes = require('./routes/webhook.routes');
const statusController = require('./controllers/status.controller');
const logger = require('./utils/logger');

const app = express();

app.use(express.json());
app.use(cors());

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => {
  res.status(200).json({ success: true, status: 'OK', uptime: process.uptime() });
});

app.get('/api/status', statusController.getStatus);

app.use('/webhook', webhookRoutes);

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint bulunamadi' });
});

app.use((err, req, res, next) => {
  logger.error('Yakalanmamis hata', { error: err.message, stack: err.stack });
  res.status(500).json({ success: false, error: 'Sunucu hatasi' });
});

module.exports = app;

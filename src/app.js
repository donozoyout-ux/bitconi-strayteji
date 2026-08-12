const express = require('express');
const cors = require('cors');
const webhookRoutes = require('./routes/webhook.routes');
const logger = require('./utils/logger');

const app = express();

app.use(express.json());
app.use(cors());

app.get('/health', (req, res) => {
  res.status(200).json({ success: true, status: 'OK', uptime: process.uptime() });
});

app.use('/webhook', webhookRoutes);

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint bulunamadi' });
});

app.use((err, req, res, next) => {
  logger.error('Yakalanmamis hata', { error: err.message, stack: err.stack });
  res.status(500).json({ success: false, error: 'Sunucu hatasi' });
});

module.exports = app;

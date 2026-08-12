const orderService = require('../services/order.service');
const logger = require('../utils/logger');

async function handleWebhook(req, res) {
  const { action, symbol, quantity } = req.body || {};

  logger.info('Webhook alindi', { action, symbol, quantity });

  try {
    const result = await orderService.placeOrder(action, symbol, quantity);
    return res.status(200).json(result);
  } catch (err) {
    const statusCode = err.statusCode || 500;
    logger.error('Webhook isleme hatasi', { error: err.message });
    return res.status(statusCode).json({ success: false, error: err.message });
  }
}

module.exports = { handleWebhook };

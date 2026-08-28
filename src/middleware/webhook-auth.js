const crypto = require('crypto');
const env = require('../config/env');

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (aa.length !== bb.length || aa.length === 0) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function requireWebhookSecret(req, res, next) {
  const expected = env.webhookSecret;
  if (!expected) {
    return res.status(503).json({
      success: false,
      error: 'WEBHOOK_LOCKED',
      message: 'WEBHOOK_SECRET is not configured; trading webhook is disabled.',
    });
  }

  const presented = req.get('x-webhook-secret') || (req.body && req.body.secret) || '';
  if (!safeEqual(presented, expected)) {
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
  }

  return next();
}

module.exports = { requireWebhookSecret };

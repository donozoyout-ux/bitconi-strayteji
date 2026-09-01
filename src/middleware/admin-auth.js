const crypto = require('crypto');

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_API_TOKEN || '';
  if (!expected) {
    return res.status(503).json({ success: false, error: 'ADMIN_API_TOKEN_NOT_CONFIGURED' });
  }

  const supplied = req.get('X-Admin-Token') || '';
  if (!safeEqual(supplied, expected)) {
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
  }

  next();
}

function requireWebhookSecret(req, res, next) {
  const expected = process.env.WEBHOOK_SECRET || '';
  if (!expected) {
    return res.status(503).json({ success: false, error: 'WEBHOOK_SECRET_NOT_CONFIGURED' });
  }

  const supplied = req.get('X-Webhook-Secret') || (req.body && req.body.secret) || '';
  if (!safeEqual(supplied, expected)) {
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
  }

  next();
}

module.exports = { requireAdmin, requireWebhookSecret };

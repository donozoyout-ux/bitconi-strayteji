const crypto = require('crypto');
const env = require('../config/env');

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (aa.length !== bb.length || aa.length === 0) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function requireAdmin(req, res, next) {
  const expected = env.adminApiToken;
  if (!expected) {
    return res.status(503).json({
      success: false,
      error: 'ADMIN_API_LOCKED',
      message: 'ADMIN_API_TOKEN is not configured; mutating API endpoints are disabled.',
    });
  }

  const presented = req.get('x-admin-token') || '';
  if (!safeEqual(presented, expected)) {
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
  }

  return next();
}

module.exports = { requireAdmin };

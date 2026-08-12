const env = require('../config/env');
const logger = require('../utils/logger');

function passphraseGuard(req, res, next) {
  const received = req.body && req.body.passphrase;
  const expected = env.webhookPassphrase;

  if (!expected) {
    logger.warn('WEBHOOK_PASSPHRASE tanimli degil; dogrulama atlaniyor.');
    return next();
  }

  if (!received || received !== expected) {
    logger.warn(`Gecersiz webhook passphrase. IP: ${req.ip}`);
    return res.status(401).json({ success: false, error: 'Unauthorized: invalid passphrase' });
  }

  next();
}

module.exports = passphraseGuard;

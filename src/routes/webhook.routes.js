const express = require('express');
const passphraseGuard = require('../middleware/passphrase.guard');
const webhookController = require('../controllers/webhook.controller');

const router = express.Router();

router.post('/', passphraseGuard, webhookController.handleWebhook);

module.exports = router;

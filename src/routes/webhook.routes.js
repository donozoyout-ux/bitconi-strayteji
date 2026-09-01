const express = require('express');
const webhookController = require('../controllers/webhook.controller');
const { requireWebhookSecret } = require('../middleware/admin-auth');

const router = express.Router();

router.post('/', requireWebhookSecret, webhookController.handleWebhook);

module.exports = router;

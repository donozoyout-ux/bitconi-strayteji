const telegramService = require('../services/telegram.service');
const logger = require('../utils/logger');

async function sendTest(req, res) {
  try {
    const result = await telegramService.sendTelegramMessage(
      '<b>Dip Hunter Crypto Bot</b>\nTelegram baglantisi basarili! Test mesaji.'
    );

    if (result.success) {
      return res.status(200).json({ success: true, message: 'Test mesaji gonderildi.' });
    }
    if (result.reason === 'not_configured') {
      return res
        .status(400)
        .json({ success: false, error: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID .env icerisinde tanimli degil.' });
    }
    return res.status(500).json({ success: false, error: result.error });
  } catch (err) {
    logger.error('Telegram test hatasi', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { sendTest };
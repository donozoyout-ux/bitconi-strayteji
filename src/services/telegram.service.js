const env = require('../config/env');
const logger = require('../utils/logger');

const TELEGRAM_API = 'https://api.telegram.org';

async function sendTelegramMessage(text) {
  const token = env.telegramBotToken;
  const chatId = env.telegramChatId;

  if (!token || !chatId) {
    logger.warn('Telegram bilgileri eksik; bildirim atlaniyor.');
    return { success: false, reason: 'not_configured' };
  }

  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    const data = await res.json();
    if (!data.ok) {
      logger.error('Telegram bildirimi basarisiz', { error: data.description });
      return { success: false, error: data.description };
    }

    logger.info('Telegram bildirimi gonderildi.');
    return { success: true };
  } catch (err) {
    logger.error('Telegram baglanti hatasi', { error: err.message });
    return { success: false, error: err.message };
  }
}

function formatOrderNotification(order) {
  const ts = new Date(order.timestamp).toLocaleString('tr-TR');
  const price = order.averagePrice ? Number(order.averagePrice).toFixed(2) : '-';
  const filled = order.filled != null ? order.filled : '-';
  const cost = order.cost != null ? Number(order.cost).toFixed(2) : '-';
  const fee = order.fee
    ? `${Number(order.fee.cost).toFixed(6)} ${order.fee.currency}`
    : '-';
  const statusLabel =
    order.status === 'closed' ? 'GERCEKLESTI' : String(order.status).toUpperCase();

  const symbolParts = order.symbol.split('/');
  const quote = symbolParts[1] || 'USDT';
  const base = symbolParts[0] || order.symbol;

  return [
    `<b>${order.action} EMRI ${statusLabel}</b>`,
    '==========================',
    `Parite  : ${order.symbol}`,
    `Butce   : ${cost} ${quote}`,
    `Miktar  : ${filled} ${base}`,
    `Fiyat   : ${price} ${quote}`,
    `Komisyon: ${fee}`,
    `Order ID: ${order.orderId}`,
    `Durum   : ${order.status}`,
    `Zaman   : ${ts}`,
  ].join('\n');
}

module.exports = { sendTelegramMessage, formatOrderNotification };

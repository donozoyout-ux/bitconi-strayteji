const env = require('../config/env');
const logger = require('../utils/logger');

const TELEGRAM_API = 'https://api.telegram.org/bot';

function isConfigured() {
  return Boolean(env.telegramBotToken && env.telegramChatId);
}

async function sendTelegramMessage(message, options = {}) {
  if (!isConfigured()) {
    logger.warn('[TELEGRAM] Token veya Chat ID ayarlanmamis; bildirim gonderilemedi.');
    return { success: false, reason: 'not_configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${TELEGRAM_API}${env.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        chat_id: options.chatId || env.telegramChatId,
        text: String(message),
        parse_mode: options.parseMode || 'HTML',
        disable_web_page_preview: true,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      const reason = data.description || `HTTP ${response.status}`;
      throw new Error(reason);
    }

    logger.info('[TELEGRAM] Bildirim gonderildi.');
    return { success: true, messageId: data.result && data.result.message_id };
  } catch (err) {
    logger.error('[TELEGRAM] Bildirim gonderilemedi', { error: err.message });
    return { success: false, reason: err.message };
  } finally {
    clearTimeout(timer);
  }
}

function fmt(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '-';
}

function formatOrderNotification(order = {}) {
  const action = String(order.action || 'ORDER').toUpperCase();
  const icon = action === 'BUY' ? '🟢' : action === 'SELL' ? '🔴' : '🔔';
  const lines = [
    `${icon} <b>${action} ${order.symbol || 'BTC/USDT'}</b>`,
    `<b>Mod:</b> ${order.mode || (env.useTestnet ? 'TESTNET' : 'LIVE')}`,
    `<b>Fiyat:</b> ${fmt(order.averagePrice, 2)} USDT`,
    `<b>Miktar:</b> ${fmt(order.filled || order.quantity, 6)} BTC`,
  ];

  if (order.spent != null) lines.push(`<b>Toplam:</b> ${fmt(order.spent, 2)} USDT`);
  if (order.orderId != null) lines.push(`<b>Order ID:</b> ${order.orderId}`);
  if (order.status) lines.push(`<b>Durum:</b> ${order.status}`);
  lines.push(`<b>Zaman:</b> ${new Date(order.timestamp || Date.now()).toLocaleString('tr-TR')}`);
  return lines.join('\n');
}

function formatStartupNotification() {
  return [
    '🚀 <b>BITCONI BOT BASLADI</b>',
    `<b>Ortam:</b> ${env.useTestnet ? 'BINANCE FUTURES TESTNET' : 'LIVE'}`,
    `<b>Emir modu:</b> ${env.dryRun ? 'DRY-RUN' : 'AKTIF'}`,
    `<b>Trading:</b> ${env.tradingEnabled ? 'ACIK' : 'KAPALI'}`,
    '<b>Sheets:</b> opsiyonel',
  ].join('\n');
}

function initBot() {
  return isConfigured();
}

function handleTelegramCommand(command) {
  switch (command) {
    case '/start': return 'Bot baslatildi';
    case '/status': return 'Sistem durumu: ' + (env.tradingEnabled ? 'AKTIF' : 'KAPALI');
    case '/help': return 'Komutlar: /start, /status, /analiz, /fiyat';
    default: return 'Bilinmeyen komut';
  }
}

function getAvailableCommands() {
  return ['/start', '/status', '/analiz', '/fiyat', '/help'];
}

module.exports = {
  isConfigured,
  sendTelegramMessage,
  formatOrderNotification,
  formatStartupNotification,
  handleTelegramCommand,
  getAvailableCommands,
  initBot,
};
